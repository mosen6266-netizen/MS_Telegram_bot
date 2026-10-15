import test from "node:test";
import assert from "node:assert/strict";
import {readFileSync,readdirSync} from "node:fs";
import {buildSync} from "esbuild";
import {Miniflare,convertV4MiniflareOptions} from "miniflare";

const compiled=buildSync({stdin:{contents:'export {scanSpenderHistories} from "./src/spender-history";',
 resolveDir:process.cwd(),loader:"ts"},bundle:true,format:"esm",platform:"node",write:false}).outputFiles[0].text;
const {scanSpenderHistories}=await import("data:text/javascript;base64,"+Buffer.from(compiled).toString("base64"));
const spender=n=>"0x"+n.toString(16).padStart(40,"0");

async function fixture(name,count){
 const mf=new Miniflare(convertV4MiniflareOptions({name,modules:true,
 script:'export default {fetch(){return new Response("ok")}}',d1Databases:{DB:name}}));
 const DB=await mf.getD1Database("DB");
 for(const file of readdirSync("migrations").filter(x=>x.endsWith(".sql")).sort()){
  for(const sql of readFileSync("migrations/"+file,"utf8").split(";").map(x=>x.trim()).filter(Boolean))
   await DB.prepare(sql).run();
 }
 const rules=[],jobs=[];
 for(let n=1;n<=count;n++){
  const s=spender(n);
  rules.push(DB.prepare("INSERT INTO spender_rules(spender,remark,start_block,cursor_block,enabled,generation) VALUES(?,'scan',101,101,1,?)").bind(s,"generation-"+n));
  jobs.push(DB.prepare("INSERT INTO spender_history_jobs(spender,next_block,cutoff_block,window_size,state,generation) VALUES(?,0,100,1000000,'scanning',?)").bind(s,"generation-"+n));
 }
 for(let i=0;i<rules.length;i+=20)await DB.batch(rules.slice(i,i+20));
 for(let i=0;i<jobs.length;i+=20)await DB.batch(jobs.slice(i,i+20));
 return {mf,DB,env:{DB,ETHERSCAN_API_KEY:"synthetic-test-key"}};
}

test("a failing Etherscan Spender is deferred while seven other Spenders finish in the same Cron cycle series",async()=>{
 const {mf,DB,env}=await fixture("spender-history-fair-cron",8);
 const saved=globalThis.fetch,requested=[];
 try{
  globalThis.fetch=async(url)=>{
   const topic2=new URL(url).searchParams.get("topic2");
   const n=Number(BigInt(topic2));
   requested.push(n);
   if(n===1&&requested.filter(x=>x===1).length===1)
    return Response.json({status:"0",message:"NOTOK",result:"synthetic provider error"});
   return Response.json({status:"0",message:"No records found",result:[]});
  };
  for(let i=0;i<8;i++)assert.equal(await scanSpenderHistories(env),true);
  const completed=await DB.prepare("SELECT COUNT(*) n FROM spender_history_jobs WHERE state='completed'").first();
  assert.equal(completed.n,7);
  const failed=await DB.prepare("SELECT state,retry_count FROM spender_history_jobs WHERE spender=?").bind(spender(1)).first();
  assert.equal(failed.state,"retrying");assert.equal(failed.retry_count,1);
  assert.equal(await scanSpenderHistories(env),false,"retrying errors are not retried again immediately");
  assert.equal(requested.length,8,"each Spender was attempted exactly once");

  await DB.prepare("UPDATE spender_history_jobs SET updated_at=datetime('now','-3 minutes') WHERE spender=?").bind(spender(1)).run();
  assert.equal(await scanSpenderHistories(env),true);
  assert.equal((await DB.prepare("SELECT state FROM spender_history_jobs WHERE spender=?").bind(spender(1)).first()).state,"completed");
  assert.equal(requested.length,9);
 }finally{globalThis.fetch=saved;await mf.dispose()}
});

test("global Etherscan HTTP 429 pauses history work instead of hammering other Spenders",async()=>{
 const {mf,DB,env}=await fixture("spender-history-429",3);
 const saved=globalThis.fetch;
 try{
  let called=0;
  globalThis.fetch=async()=>{called++;return Response.json({error:"rate limited"},{status:429})};
  assert.equal(await scanSpenderHistories(env),false);
  assert.equal(await scanSpenderHistories(env),false);
  assert.equal(called,1);
  assert.ok(Number((await DB.prepare("SELECT value FROM runtime_state WHERE key='spender_history_provider_backoff'").first()).value)>Date.now());
  assert.equal((await DB.prepare("SELECT COUNT(*) n FROM spender_history_jobs WHERE state='scanning'").first()).n,2);
 }finally{globalThis.fetch=saved;await mf.dispose()}
});
