import test from "node:test";
import assert from "node:assert/strict";
import {buildSync} from "esbuild";
import {Miniflare,convertV4MiniflareOptions} from "miniflare";

const src=buildSync({stdin:{contents:
 'export {flushOutbox,recoverStuck} from "./src/notifications";'+
 'export {requeueFailedOutbox,acknowledgeUnknownOutbox,listOutboxPage} from "./src/outbox-operations";',
 resolveDir:process.cwd(),loader:"ts"},bundle:true,format:"esm",platform:"node",write:false}).outputFiles[0].text;
const {flushOutbox,recoverStuck,requeueFailedOutbox,acknowledgeUnknownOutbox,listOutboxPage}
 =await import("data:text/javascript;base64,"+Buffer.from(src).toString("base64"));

async function dbFor(name){
 const mf=new Miniflare(convertV4MiniflareOptions({
  name,modules:true,script:'export default {fetch(){return new Response("ok")}}',d1Databases:{DB:name}
 }));
 const DB=await mf.getD1Database("DB");
 await DB.prepare("CREATE TABLE outbox (id INTEGER PRIMARY KEY,dedup_key TEXT UNIQUE,chat_id TEXT NOT NULL,address TEXT,"+
  "template_key TEXT,payload_json TEXT,state TEXT DEFAULT 'pending',attempts INTEGER DEFAULT 0,"+
  "due_at TEXT DEFAULT CURRENT_TIMESTAMP,last_error TEXT,sending_started_at TEXT,telegram_message_id INTEGER,sent_at TEXT,"+
  "created_at TEXT DEFAULT CURRENT_TIMESTAMP)").run();
 await DB.prepare("CREATE TABLE templates (template_key TEXT,chat_id TEXT,body TEXT,PRIMARY KEY(template_key,chat_id))").run();
 await DB.prepare("INSERT INTO outbox(id,dedup_key,chat_id,template_key,payload_json) VALUES(1,'a','-10001','usage_alert','{}')").run();
 return {mf,DB,env:{DB,TELEGRAM_BOT_TOKEN:"synthetic-test-only",ADMIN_TELEGRAM_CHAT_ID:null}};
}
const query=db=>db.prepare("SELECT id,state,attempts,telegram_message_id,last_error FROM outbox WHERE id=1").first();

test("lost Telegram response is quarantined, not automatically resent; operator can explicitly requeue it",async()=>{
 const {mf,DB,env}=await dbFor("delivery-ambiguous-network");
 const saved=globalThis.fetch;let calls=0;
 try{
  globalThis.fetch=async()=>{calls++;throw Error("connection reset after request");};
  await flushOutbox(env,10,true);
  assert.equal((await query(DB)).state,"delivery_unknown");
  assert.equal(calls,1);
  await recoverStuck(env);
  await flushOutbox(env,10,true);
  assert.equal(calls,1,"unconfirmed delivery must never be retried by background processing");
  const unknown=await listOutboxPage(DB,{status:"delivery_unknown"});
  assert.equal(unknown.total,1);
  const queued=await requeueFailedOutbox(DB,1);
  assert.equal(queued.ok,true);
  assert.equal((await query(DB)).state,"pending");
  globalThis.fetch=async()=>{calls++;return Response.json({ok:true,result:{message_id:222}})};
  await flushOutbox(env,10,true);
  assert.equal((await query(DB)).state,"sent");
  assert.equal((await query(DB)).telegram_message_id,222);
  assert.equal(calls,2);
 }finally{globalThis.fetch=saved;await mf.dispose()}
});

test("a known Telegram 429 rejection still uses automatic backoff",async()=>{
 const {mf,DB,env}=await dbFor("delivery-explicit-429");
 const saved=globalThis.fetch;
 try{
  globalThis.fetch=async()=>Response.json({ok:false,description:"Too Many Requests",
   parameters:{retry_after:120}},{status:429});
  await flushOutbox(env,10,true);
  const result=await query(DB);
  assert.equal(result.state,"pending");
  assert.equal(result.attempts,1);
  assert.match(result.last_error,/Telegram/);
 }finally{globalThis.fetch=saved;await mf.dispose()}
});

test("a successful Telegram response followed by D1 sent-state failure stays uncertain, not duplicated",async()=>{
 const {mf,DB,env}=await dbFor("delivery-sent-commit-failure");
 const saved=globalThis.fetch;let calls=0;
 try{
  globalThis.fetch=async()=>{calls++;return Response.json({ok:true,result:{message_id:333}})};
  await DB.prepare("CREATE TRIGGER break_sent BEFORE UPDATE OF state ON outbox "+
    "WHEN NEW.state='sent' BEGIN SELECT RAISE(ABORT,'synthetic sent state failure'); END").run();
  await flushOutbox(env,10,true);
  assert.equal((await query(DB)).state,"delivery_unknown");
  assert.equal(calls,1);
  const acknowledged=await acknowledgeUnknownOutbox(DB,1);
  assert.equal(acknowledged.ok,true);
  assert.equal((await query(DB)).state,"acknowledged");
  assert.deepEqual(await acknowledgeUnknownOutbox(DB,1),{error:"not_unknown",status:409});
  await flushOutbox(env,10,true);
  assert.equal(calls,1);
  assert.deepEqual(await requeueFailedOutbox(DB,1),{error:"not_retryable",status:409});
 }finally{globalThis.fetch=saved;await mf.dispose()}
});
