import test from "node:test";
import assert from "node:assert/strict";
import {readFileSync,readdirSync} from "node:fs";
import {createHash} from "node:crypto";
import {buildSync} from "esbuild";
import {Miniflare,convertV4MiniflareOptions} from "miniflare";

const src=buildSync({entryPoints:["src/index.ts"],bundle:true,format:"esm",
 platform:"node",target:"es2022",write:false}).outputFiles[0].text;
const worker=(await import("data:text/javascript;base64,"+Buffer.from(src).toString("base64"))).default;
const makeMessage=(id,body)=>({
 id,body,attempts:5,events:[],
 ack(){this.events.push("ack")},
 retry(options){this.events.push({retry:options.delaySeconds})}
});

test("DLQ consumer archives permanently failing jobs before ACK, preserves unknown outcomes and requires admin review",async()=>{
 const mf=new Miniflare(convertV4MiniflareOptions({
  name:"durable-dlq-archive",modules:true,
  script:'export default {fetch(){return new Response("ok")}}',
  d1Databases:{DB:"durable-dlq-archive"}
 }));
 try{
  const DB=await mf.getD1Database("DB");
  for(const file of readdirSync("migrations").filter(x=>x.endsWith(".sql")).sort()){
   for(const sql of readFileSync("migrations/"+file,"utf8").split(";").map(x=>x.trim()).filter(Boolean))
    await DB.prepare(sql).run();
  }
  const env={DB},job={kind:"activity",payload:{network:"ETH_MAINNET",event:{activity:[]}}};
  const msg=makeMessage("dead-letter-1",job);
  await worker.queue({queue:"ethereum-usdt-monitor-dlq",messages:[msg]},env,{});
  assert.deepEqual(msg.events,["ack"]);
  const saved=await DB.prepare("SELECT kind,state,payload_json FROM queue_dead_letters WHERE queue_message_id='dead-letter-1'").first();
  assert.equal(saved.kind,"activity");
  assert.equal(saved.state,"needs_review");
  assert.deepEqual(JSON.parse(saved.payload_json),job);
  const again=makeMessage("dead-letter-1",job);
  await worker.queue({queue:"ethereum-usdt-monitor-dlq",messages:[again]},env,{});
  assert.deepEqual(again.events,["ack"],"Cloudflare redelivery must be deduplicated");
  assert.equal((await DB.prepare("SELECT COUNT(*) n FROM queue_dead_letters").first()).n,1);

  await DB.prepare("CREATE TRIGGER archive_offline BEFORE INSERT ON queue_dead_letters BEGIN SELECT RAISE(ABORT,'database offline'); END").run();
  const blocked=makeMessage("dead-letter-2",{kind:"verify_admin",owner:"0x"+"aa".repeat(20)});
  await worker.queue({queue:"ethereum-usdt-monitor-dlq",messages:[blocked]},env,{});
  assert.deepEqual(blocked.events,[{retry:120}],"failed archival must never ACK a dead letter");
  assert.equal((await DB.prepare("SELECT COUNT(*) n FROM queue_dead_letters").first()).n,1);
  await DB.prepare("DROP TRIGGER archive_offline").run();
  await worker.queue({queue:"ethereum-usdt-monitor-dlq",messages:[blocked]},env,{});
  assert.equal(blocked.events.at(-1),"ack");
  assert.equal((await DB.prepare("SELECT COUNT(*) n FROM queue_dead_letters").first()).n,2);

  const domain="https://preflight.example.invalid";
  const anon=await mf.dispatchFetch(domain+"/api/dead-letters?page=0");
  assert.equal(anon.status,200,"Miniflare default handler is intentionally not the tested Worker entrypoint");
  // Call the real Worker fetch with the same DB, including its admin-session guard.
  const req=(path,opts={})=>worker.fetch(new Request(domain+path,opts),env,{});
  assert.equal((await req("/api/dead-letters?page=0")).status,401);
  const sessionToken="local_dlq_admin_session";
  const hash=createHash("sha256").update(sessionToken).digest("hex");
  await DB.prepare("INSERT INTO admin_sessions(token_hash,expires_at) VALUES(?,?)")
    .bind(hash,new Date(Date.now()+3600000).toISOString()).run();
  const headers={cookie:"__Host-ethadmin="+sessionToken};
  const list=await req("/api/dead-letters?state=needs_review",{headers});
  assert.equal(list.status,200);
  const records=await list.json();
  assert.equal(records.total,2);
  assert.ok(records.rows.every(x=>!Object.hasOwn(x,"payload_json")),"list should not expose raw event payloads");

  const target=records.rows[0].id;
  const denied=await req("/api/dead-letters/review",{method:"POST",headers:{"content-type":"application/json"},
    body:JSON.stringify({id:target})});
  assert.equal(denied.status,401);
  const accepted=await req("/api/dead-letters/review",{method:"POST",
    headers:{...headers,origin:domain,"x-app-action":"1","content-type":"application/json"},
    body:JSON.stringify({id:target})});
  assert.equal(accepted.status,200);
  assert.equal((await DB.prepare("SELECT state FROM queue_dead_letters WHERE id=?").bind(target).first()).state,"reviewed");
  assert.equal((await DB.prepare("SELECT COUNT(*) n FROM admin_audit WHERE action='review_dead_letter'").first()).n,1);
  assert.equal((await req("/api/dead-letters?state=needs_review",{headers}).then(x=>x.json())).total,1);
 }finally{await mf.dispose()}
});

test("production and staging configuration both archive their own DLQ without recursive replay",()=>{
 for(const path of ["wrangler.jsonc","wrangler.staging.example.jsonc"]){
  const cfg=JSON.parse(readFileSync(path,"utf8"));
  const consumer=cfg.queues.consumers.find(x=>x.dead_letter_queue);
  assert.ok(consumer);
  const archive=cfg.queues.consumers.find(x=>x.queue===consumer.dead_letter_queue);
  assert.ok(archive,"DLQ must have its own archival consumer");
  assert.equal(archive.dead_letter_queue,undefined,"avoid recursive dead-letter routing");
  assert.notEqual(consumer.queue,archive.queue);
 }
});
