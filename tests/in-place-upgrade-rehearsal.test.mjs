import test from "node:test";
import assert from "node:assert/strict";
import {readFileSync,readdirSync} from "node:fs";
import {Miniflare,convertV4MiniflareOptions} from "miniflare";

// Rehearse an IN-PLACE upgrade from pre-stabilization production schema and
// records, not a clean DB. This exercises actual migration SQL in Wrangler's
// lexical order without ever connecting to production.
const migrationFiles=readdirSync("migrations").filter(x=>x.endsWith(".sql")).sort();
const newFiles=[
 "20261015_outbox_pagination_index.sql",
 "20261015_outbox_sending_lease.sql",
 "20261015_subscription_sources.sql",
 "20261016_spender_generation_fence.sql"
];
const baseFiles=migrationFiles.filter(x=>!newFiles.includes(x));
assert.equal(newFiles.length,4);
for(const file of newFiles)assert.ok(migrationFiles.includes(file),file+" is required");

async function applyFile(db,file){
 const sql=readFileSync("migrations/"+file,"utf8");
 // Mirror the project's other D1 migrations tests; all statements here are
 // plain SQL without semicolons within text or SQL trigger bodies.
 for(const stmt of sql.split(";").map(x=>x.trim()).filter(Boolean))
  await db.prepare(stmt).run();
}

test("upgrade preserves live wallet monitoring, Telegram subscriptions, pending outbox, scan progress and audit data",async()=>{
 const mf=new Miniflare(convertV4MiniflareOptions({
  name:"in-place-upgrade-rehearsal",modules:true,
  script:'export default {fetch(){return new Response("ok")}}',
  d1Databases:{DB:"upgrade-rehearsal"}
 }));
 try{
  const db=await mf.getD1Database("DB");
  for(const file of baseFiles)await applyFile(db,file);
  const owner="0x"+"12".repeat(20),spender="0x"+"a1".repeat(20),chat="-100123450001";
  await db.prepare("INSERT INTO telegram_chats(chat_id,title,chat_type,active) VALUES(?,'Legacy group','supergroup',1)").bind(chat).run();
  await db.prepare("INSERT INTO wallets(address,first_user_name,discovery_source) VALUES(?,'Original user','spender_history')").bind(owner).run();
  await db.prepare("INSERT INTO wallet_watches(address,state,synced_at) VALUES(?,'active',CURRENT_TIMESTAMP)").bind(owner).run();
  await db.prepare("INSERT INTO subscriptions(chat_id,address,remark,status) VALUES(?,?,'Original note','active')").bind(chat,owner).run();
  await db.prepare("INSERT INTO spender_rules(spender,remark,start_block,cursor_block,enabled) VALUES(?,'Original Spender',100,300,1)").bind(spender).run();
  await db.prepare("INSERT INTO spender_routes(spender,chat_id) VALUES(?,?)").bind(spender,chat).run();
  await db.prepare("UPDATE spender_history_jobs SET next_block=200,state='running',events_found=29 WHERE spender=?").bind(spender).run();
  await db.prepare("INSERT INTO spender_history_addresses(spender,owner,first_seen_block,latest_event_block,verify_status) VALUES(?,?,121,200,'active')").bind(spender,owner).run();
  await db.prepare("INSERT INTO spender_history_monitor_enrollments(spender,owner,state,attempts) VALUES(?,?,'active',1)").bind(spender,owner).run();
  await db.prepare("INSERT INTO outbox(dedup_key,chat_id,address,template_key,payload_json,state,attempts,created_at) VALUES('old:1',?,?,'transfer','{}','sending',2,datetime('now','-2 days'))").bind(chat,owner).run();
  await db.prepare("INSERT INTO outbox(dedup_key,chat_id,address,template_key,payload_json,state) VALUES('old:2',?,?,'transfer','{}','failed')").bind(chat,owner).run();
  await db.prepare("INSERT INTO admin_audit(actor,action,target) VALUES('admin','older_action','legacy_record')").run();

  const snapshot=async()=>({
   watches:(await db.prepare("SELECT address,state FROM wallet_watches").all()).results,
   subscriptions:(await db.prepare("SELECT chat_id,address,remark,status FROM subscriptions").all()).results,
   outbox:(await db.prepare("SELECT dedup_key,state,attempts FROM outbox ORDER BY id").all()).results,
   wallets:(await db.prepare("SELECT address,first_user_name FROM wallets").all()).results,
   audit:(await db.prepare("SELECT actor,action,target FROM admin_audit").all()).results
  });
  const before=await snapshot();
  for(const file of migrationFiles.filter(x=>newFiles.includes(x)))await applyFile(db,file);
  assert.deepEqual(await snapshot(),before,"migration must not rewrite existing business records");

  const oldRunning=await db.prepare("SELECT created_at,sending_started_at FROM outbox WHERE dedup_key='old:1'").first();
  assert.ok(oldRunning.sending_started_at,"old in-flight message gets a fresh attempt lease");
  const other=await db.prepare("SELECT sending_started_at FROM outbox WHERE dedup_key='old:2'").first();
  assert.equal(other.sending_started_at,null,"failed messages are not claimed");

  const source=await db.prepare("SELECT source_type,source_id FROM subscription_sources WHERE chat_id=? AND address=?").bind(chat,owner).first();
  assert.deepEqual({type:source.source_type,id:source.source_id},{type:"legacy",id:"pre_migration"});
  const rule=await db.prepare("SELECT generation,cursor_block FROM spender_rules WHERE spender=?").bind(spender).first();
  const job=await db.prepare("SELECT generation,next_block,events_found,state FROM spender_history_jobs WHERE spender=?").bind(spender).first();
  assert.ok(rule.generation.length>=32);
  assert.equal(job.generation,rule.generation,"existing scan keeps its generation");
  assert.equal(job.next_block,200);
  assert.equal(job.events_found,29);
  assert.equal(job.state,"running");

  const schema=async name=>(await db.prepare("PRAGMA table_info("+name+")").all()).results.map(r=>r.name);
  assert.ok((await schema("outbox")).includes("sending_started_at"));
  assert.ok((await schema("spender_rules")).includes("generation"));
  assert.ok((await schema("spender_history_jobs")).includes("generation"));
  assert.ok((await schema("subscription_sources")).includes("source_type"));
  const missingFks=(await db.prepare("PRAGMA foreign_key_check").all()).results||[];
  assert.deepEqual(missingFks,[],"upgrade must not break relational integrity");
  const indexes=(await db.prepare("SELECT name FROM sqlite_master WHERE type='index'").all()).results.map(x=>x.name);
  for(const name of ["idx_outbox_state_id_desc","idx_outbox_sending_lease","idx_subscription_sources_route"])
   assert.ok(indexes.includes(name),"missing index "+name);
 }finally{await mf.dispose()}
});
