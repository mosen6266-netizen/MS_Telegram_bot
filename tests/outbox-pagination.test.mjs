import test from "node:test";
import assert from "node:assert/strict";
import {buildSync} from "esbuild";
import {Miniflare,convertV4MiniflareOptions} from "miniflare";

const js=buildSync({stdin:{contents:'export {listOutboxPage} from "./src/outbox-operations";',
resolveDir:process.cwd(),loader:"ts"},bundle:true,platform:"node",format:"esm",write:false}).outputFiles[0].text;
const {listOutboxPage}=await import("data:text/javascript;base64,"+Buffer.from(js).toString("base64"));

test("notification history pages and filters include older failed rows beyond first 200 without full-table responses",async()=>{
 const mf=new Miniflare(convertV4MiniflareOptions({name:"outbox-page-test",modules:true,
 script:'export default {fetch(){return new Response("ok")}}',d1Databases:{DB:"outbox-page"}}));
 try{
  const DB=await mf.getD1Database("DB");
  await DB.prepare("CREATE TABLE outbox(id INTEGER PRIMARY KEY,chat_id TEXT,address TEXT,template_key TEXT,state TEXT,attempts INTEGER,last_error TEXT,created_at TEXT,due_at TEXT)").run();
  await DB.prepare("CREATE INDEX idx_outbox_state_id_desc ON outbox(state,id DESC)").run();
  const records=[];
  for(let id=1;id<=241;id++){
   records.push(DB.prepare("INSERT INTO outbox(id,chat_id,template_key,state,attempts) VALUES(?,?,'transfer',?,?)")
     .bind(id,id%2?"-1001111111111":"-1002222222222",id<=5?"failed":"sent",id<=5?5:1));
  }
  // D1 batches write data in small groups.
  for(let i=0;i<records.length;i+=30)await DB.batch(records.slice(i,i+30));
  const first=await listOutboxPage(DB,{page:0,status:"all"});
  assert.equal(first.total,241);
  assert.equal(first.total_pages,5);
  assert.equal(first.rows.length,50);
  assert.equal(first.rows[0].id,241);
  const oldFailures=await listOutboxPage(DB,{page:0,status:"failed"});
  assert.equal(oldFailures.total,5);
  assert.deepEqual(oldFailures.rows.map(x=>x.id),[5,4,3,2,1]);
  assert.equal(oldFailures.summary.find(x=>x.state==="sent").n,236);
  const last=await listOutboxPage(DB,{page:4});
  assert.equal(last.rows.length,41);
  assert.equal(last.rows.at(-1).id,1);
  const group=await listOutboxPage(DB,{search:"-1002222222222",status:"failed"});
  assert.deepEqual(group.rows.map(x=>x.id),[4,2]);
  const exact=await listOutboxPage(DB,{search:"5"});
  assert.equal(exact.total,1);
  assert.equal(exact.rows[0].id,5);
  assert.deepEqual(await listOutboxPage(DB,{status:"unknown"}),{error:"invalid_status",status:400});
  assert.deepEqual(await listOutboxPage(DB,{search:"%"}),{error:"invalid_search",status:400});
 }finally{await mf.dispose()}
});
