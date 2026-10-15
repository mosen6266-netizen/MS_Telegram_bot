import test from "node:test";
import assert from "node:assert/strict";
import {buildSync} from "esbuild";
import {Miniflare,convertV4MiniflareOptions} from "miniflare";

const js=buildSync({stdin:{contents:'export {requeueFailedOutbox} from "./src/outbox-operations";',
resolveDir:process.cwd(),loader:"ts"},bundle:true,platform:"node",format:"esm",write:false}).outputFiles[0].text;
const {requeueFailedOutbox}=await import("data:text/javascript;base64,"+Buffer.from(js).toString("base64"));

test("only a terminal failure can be explicitly requeued, and the operation is idempotent under racing clicks",async()=>{
 const mf=new Miniflare(convertV4MiniflareOptions({name:"failed-outbox-recovery-test",modules:true,
 script:'export default {fetch(){return new Response("ok")}}',d1Databases:{DB:"failed-outbox-recovery"}}));
 try{
  const DB=await mf.getD1Database("DB");
  await DB.prepare("CREATE TABLE outbox(id INTEGER PRIMARY KEY,chat_id TEXT,address TEXT,template_key TEXT,state TEXT,attempts INTEGER,due_at TEXT,last_error TEXT,sending_started_at TEXT)").run();
  await DB.prepare("INSERT INTO outbox(id,chat_id,template_key,state,attempts,last_error) VALUES(1,'-1001','transfer','failed',5,'HTTP 429'),(2,'-1001','transfer','sent',1,NULL),(3,'-1002','transfer','pending',0,NULL)").run();
  assert.deepEqual(await requeueFailedOutbox(DB,-3),{error:"invalid_id",status:400});
  assert.deepEqual(await requeueFailedOutbox(DB,99),{error:"not_found",status:404});
  assert.deepEqual(await requeueFailedOutbox(DB,2),{error:"not_failed",status:409});
  assert.deepEqual(await requeueFailedOutbox(DB,3),{error:"not_failed",status:409});
  const ok=await requeueFailedOutbox(DB,1);
  assert.equal(ok.ok,true);
  assert.equal(ok.task.template_key,"transfer");
  const row=await DB.prepare("SELECT state,attempts,due_at,last_error,sending_started_at FROM outbox WHERE id=1").first();
  assert.equal(row.state,"pending");
  assert.equal(row.attempts,0);
  assert.ok(row.due_at);
  assert.equal(row.last_error,null);
  assert.equal(row.sending_started_at,null);
  assert.deepEqual(await requeueFailedOutbox(DB,1),{error:"not_failed",status:409});
  assert.equal((await DB.prepare("SELECT state FROM outbox WHERE id=2").first()).state,"sent");
 }finally{await mf.dispose()}
});
