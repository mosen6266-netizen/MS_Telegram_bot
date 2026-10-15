import test from "node:test";
import assert from "node:assert/strict";
import {readFileSync,readdirSync} from "node:fs";
import {buildSync} from "esbuild";
import {Miniflare,convertV4MiniflareOptions} from "miniflare";

const script=buildSync({stdin:{contents:'export {enrollHistoricalOwners} from "./src/spender-enroll";',
 resolveDir:process.cwd(),loader:"ts"},bundle:true,format:"esm",platform:"node",write:false}).outputFiles[0].text;
const {enrollHistoricalOwners}=await import("data:text/javascript;base64,"+Buffer.from(script).toString("base64"));
const addr=n=>"0x"+n.toString(16).padStart(40,"0");

test("real D1 enrollment respects Alchemy Retry-After and backs off after repeated rate limits",async()=>{
 const mf=new Miniflare(convertV4MiniflareOptions({name:"enrollment-provider-429",modules:true,
 script:'export default {fetch(){return new Response("ok")}}',d1Databases:{DB:"enrollment-provider-429"}}));
 const original=globalThis.fetch;
 try{
  const DB=await mf.getD1Database("DB");
  for(const file of readdirSync("migrations").filter(x=>x.endsWith(".sql")).sort()){
   for(const stmt of readFileSync("migrations/"+file,"utf8").split(";").map(x=>x.trim()).filter(Boolean))
    await DB.prepare(stmt).run();
  }
  const spender=addr(501),owner=addr(601),chat="-1008888888888";
  await DB.prepare("INSERT INTO spender_rules(spender,remark,enabled,start_block,cursor_block,generation) VALUES(?,'test',1,50,50,'gen')").bind(spender).run();
  await DB.prepare("INSERT INTO spender_routes(spender,chat_id) VALUES(?,?)").bind(spender,chat).run();
  await DB.prepare("INSERT INTO telegram_chats(chat_id,title,chat_type,active) VALUES(?,'test','supergroup',1)").bind(chat).run();
  await DB.prepare("INSERT INTO spender_history_addresses(spender,owner,first_seen_block,latest_event_block) VALUES(?,?,10,10)").bind(spender,owner).run();
  const env={DB,ALCHEMY_ACTIVITY_WEBHOOK_ID:"staging-wh",ALCHEMY_NOTIFY_TOKEN:"staging-token",
   ALCHEMY_RPC_URL:"https://rpc.example.invalid"};
  let patches=0;
  globalThis.fetch=async(url)=>{
   if(url==="https://rpc.example.invalid")return Response.json({jsonrpc:"2.0",id:1,result:"0x100"});
   assert.equal(url,"https://dashboard.alchemy.com/api/update-webhook-addresses");
   patches++;
   return Response.json({error:"rate limited"},{status:429,headers:patches===1?{"retry-after":"120"}:{}});
  };
  const before=Date.now();
  const first=await enrollHistoricalOwners(env);
  assert.equal(first.cooldown,true);
  assert.equal(patches,1);
  const ms1=Number((await DB.prepare("SELECT value FROM runtime_state WHERE key='spender_enroll_retry_after'").first()).value)-before;
  assert.ok(ms1>=119000&&ms1<125000,"provider-provided two-minute Retry-After must be obeyed");
  assert.equal((await DB.prepare("SELECT state FROM spender_history_monitor_enrollments WHERE spender=? AND owner=?").bind(spender,owner).first()).state,"retrying");
  const second=await enrollHistoricalOwners(env);
  assert.equal(second.cooldown,true);
  assert.equal(patches,1,"repeated Cron must not call Alchemy during cooldown");
  await DB.prepare("UPDATE runtime_state SET value='1' WHERE key='spender_enroll_retry_after'").run();
  await DB.prepare("UPDATE spender_history_monitor_enrollments SET updated_at=datetime('now','-4 minutes')").run();
  const retried=await enrollHistoricalOwners(env);
  assert.equal(retried.cooldown,true);
  assert.equal(patches,2);
  const ms2=Number((await DB.prepare("SELECT value FROM runtime_state WHERE key='spender_enroll_retry_after'").first()).value)-Date.now();
  assert.ok(ms2>1700000&&ms2<1900000,"second unheaded 429 should use 30-minute exponential fallback");
  assert.equal((await DB.prepare("SELECT value FROM runtime_state WHERE key='spender_enroll_throttle_count'").first()).value,"2");
 }finally{globalThis.fetch=original;await mf.dispose()}
});
