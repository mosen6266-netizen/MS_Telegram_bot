import test from "node:test";
import assert from "node:assert/strict";
import {buildSync} from "esbuild";
import {Miniflare,convertV4MiniflareOptions} from "miniflare";

const out=buildSync({stdin:{contents:'export {flushOutbox} from "./src/notifications";',resolveDir:process.cwd(),loader:"ts"},
 bundle:true,platform:"node",format:"esm",write:false}).outputFiles[0].text;
const {flushOutbox}=await import("data:text/javascript;base64,"+Buffer.from(out).toString("base64"));

async function database(name){
 const mf=new Miniflare(convertV4MiniflareOptions({name,modules:true,
 script:'export default {fetch(){return new Response("ok")}}',d1Databases:{DB:name}}));
 const DB=await mf.getD1Database("DB");
 await DB.prepare("CREATE TABLE outbox(id INTEGER PRIMARY KEY,dedup_key TEXT UNIQUE,chat_id TEXT NOT NULL,address TEXT,template_key TEXT,payload_json TEXT,state TEXT DEFAULT 'pending',attempts INTEGER DEFAULT 0,due_at TEXT DEFAULT CURRENT_TIMESTAMP,last_error TEXT,sending_started_at TEXT,telegram_message_id INTEGER,sent_at TEXT,created_at TEXT DEFAULT CURRENT_TIMESTAMP)").run();
 await DB.prepare("CREATE TABLE templates(template_key TEXT,chat_id TEXT,body TEXT,PRIMARY KEY(template_key,chat_id))").run();
 return {mf,DB};
}
test("competing Cron and usage flush workers cannot deliver 48 messages more than once",async()=>{
 const {mf,DB}=await database("outbox-concurrent-load");
 const saved=globalThis.fetch;
 try{
  // One SQL statement seeds a large enough backlog to exercise claim races.
  await DB.prepare("WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i+1 FROM n WHERE i<48) "+
    "INSERT INTO outbox(id,dedup_key,chat_id,template_key,payload_json) SELECT i,'bulk-'||i,'-1000001','usage_alert','{}' FROM n").run();
  const sent=new Map();
  globalThis.fetch=async(url,options)=>{
   assert.match(String(url),/api\.telegram\.org\/bot/);
   const body=JSON.parse(options.body);
   const id=Number(body.chat_id);
   assert.equal(id,-1000001);
   const key=body.text;sent.set(key,(sent.get(key)||0)+1);
   return Response.json({ok:true,result:{message_id:sent.size}});
  };
  const env={DB,TELEGRAM_BOT_TOKEN:"synthetic"};
  // Simultaneously selecting the same pending rows is expected. Only one
  // consumer can atomically claim each row.
  await Promise.all([flushOutbox(env,48,false),flushOutbox(env,48,true)]);
  const status=await DB.prepare("SELECT state,attempts,COUNT(*) n FROM outbox GROUP BY state,attempts").all();
  assert.deepEqual(status.results.map(x=>[x.state,x.attempts,x.n]),[["sent",1,48]]);
  const ids=(await DB.prepare("SELECT telegram_message_id FROM outbox").all()).results;
  assert.equal(ids.length,48);
  assert.ok(ids.every(x=>x.telegram_message_id!==null));
  assert.equal([...sent.values()].reduce((a,b)=>a+b,0),48);
  assert.equal(Math.max(...sent.values()),48,"identical message content is expected across templates; each row has one attempt");
  await Promise.all([flushOutbox(env,48),flushOutbox(env,48,true)]);
  assert.equal([...sent.values()].reduce((a,b)=>a+b,0),48);
 }finally{globalThis.fetch=saved;await mf.dispose()}
});
test("a stale pending result cannot bypass a newly scheduled Retry-After",async()=>{
 const {mf,DB}=await database("outbox-due-date-claim");
 const saved=globalThis.fetch;
 try{
  await DB.prepare("INSERT INTO outbox(id,dedup_key,chat_id,template_key,payload_json) VALUES(1,'one','-100','usage_alert','{}')").run();
  let calls=0;
  globalThis.fetch=async()=>{calls++;return Response.json({ok:true,result:{message_id:1}})};
  // Mimic a parallel worker applying a future due_at just after this
  // invocation reads its initial pending list, but before it claims it.
  const wrapper={
   prepare(sql){
    const statement=DB.prepare(sql);
    if(sql.startsWith("SELECT * FROM outbox WHERE state='pending'")){
      const originalAll=statement.all.bind(statement);
      statement.all=async()=>{
       const rows=await originalAll();
       await DB.prepare("UPDATE outbox SET due_at=datetime('now','+120 seconds') WHERE id=1").run();
       return rows;
      };
    }
    return statement;
   }
  };
  await flushOutbox({DB:wrapper,TELEGRAM_BOT_TOKEN:"synthetic"},1,true);
  assert.equal(calls,0);
  const row=await DB.prepare("SELECT state,attempts FROM outbox WHERE id=1").first();
  assert.equal(row.state,"pending");assert.equal(row.attempts,0);
 }finally{globalThis.fetch=saved;await mf.dispose()}
});
