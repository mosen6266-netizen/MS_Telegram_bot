import test from "node:test";
import assert from "node:assert/strict";
import {buildSync} from "esbuild";
import {Miniflare,convertV4MiniflareOptions} from "miniflare";

const code=buildSync({stdin:{contents:'export {selectEnrollmentCandidates,withEnrollmentLease,enrollmentRetryAfterSeconds} from "./src/spender-enroll";',
resolveDir:process.cwd(),loader:"ts"},bundle:true,format:"esm",platform:"node",write:false}).outputFiles[0].text;
const {selectEnrollmentCandidates,withEnrollmentLease,enrollmentRetryAfterSeconds}
 =await import("data:text/javascript;base64,"+Buffer.from(code).toString("base64"));
const wallet=n=>"0x"+n.toString(16).padStart(40,"0");

async function tempDb(name){
 const mf=new Miniflare(convertV4MiniflareOptions({name,modules:true,
  script:'export default {fetch(){return new Response("ok")}}',d1Databases:{DB:name}}));
 const DB=await mf.getD1Database("DB");
 for(const sql of [
  "CREATE TABLE runtime_state(key TEXT PRIMARY KEY,value TEXT,updated_at TEXT DEFAULT CURRENT_TIMESTAMP)",
  "CREATE TABLE spender_rules(spender TEXT PRIMARY KEY,enabled INTEGER,generation TEXT)",
  "CREATE TABLE spender_history_addresses(spender TEXT,owner TEXT,first_seen_block INTEGER,PRIMARY KEY(spender,owner))",
  "CREATE TABLE spender_history_monitor_enrollments(spender TEXT,owner TEXT,state TEXT,updated_at TEXT,attempts INTEGER,PRIMARY KEY(spender,owner))",
  "CREATE TABLE wallets(address TEXT PRIMARY KEY,deleted_at TEXT)",
  "CREATE TABLE wallet_exclusions(address TEXT PRIMARY KEY)"
 ])await DB.prepare(sql).run();
 return {mf,DB};
}
test("many fresh Owners cannot starve eligible failed Owners, and missing pool fills available slots",async()=>{
 const {mf,DB}=await tempDb("enrollment-fairness");
 try{
  const spender=wallet(900);
  await DB.prepare("INSERT INTO spender_rules(spender,enabled,generation) VALUES(?,1,'gen-a')").bind(spender).run();
  const rows=[];
  for(let i=1;i<=80;i++){
   rows.push(DB.prepare("INSERT INTO spender_history_addresses(spender,owner,first_seen_block) VALUES(?,?,?)").bind(spender,wallet(i),i));
   if(i<=16)rows.push(DB.prepare("INSERT INTO spender_history_monitor_enrollments(spender,owner,state,attempts,updated_at) VALUES(?,?,'retrying',5,datetime('now','-60 minutes'))").bind(spender,wallet(i)));
  }
  for(let i=0;i<rows.length;i+=25)await DB.batch(rows.slice(i,i+25));
  const batch=await selectEnrollmentCandidates(DB,20);
  assert.equal(batch.length,20);
  assert.equal(batch.filter(x=>Number(BigInt(x.owner))<=16).length,5,"reserve five retry slots");
  assert.equal(batch.filter(x=>Number(BigInt(x.owner))>16).length,15);
  const consumed=[];
  for(const x of batch){
   consumed.push(DB.prepare("INSERT INTO spender_history_monitor_enrollments(spender,owner,state,attempts,updated_at) VALUES(?,?,'running',1,CURRENT_TIMESTAMP) ON CONFLICT(spender,owner) DO UPDATE SET state='running',updated_at=CURRENT_TIMESTAMP").bind(x.spender,x.owner));
  }
  for(let i=0;i<consumed.length;i+=20)await DB.batch(consumed.slice(i,i+20));
  const next=await selectEnrollmentCandidates(DB,20);
  assert.equal(next.length,20);
  assert.equal(next.filter(x=>Number(BigInt(x.owner))<=16).length,5,"older failed rows still advance next cycle");
  assert.ok(next.every(x=>!batch.some(y=>x.owner===y.owner)),"fresh lease remains out of pool");
  await DB.prepare("UPDATE spender_history_monitor_enrollments SET state='running',updated_at=CURRENT_TIMESTAMP").run();
  const onlyFresh=await selectEnrollmentCandidates(DB,20);
  assert.equal(onlyFresh.length,20,"all unused retry slots are filled from fresh Owners");
 }finally{await mf.dispose()}
});
test("token-owned enrollment lock cannot be stolen or released by an expired invocation",async()=>{
 const {mf,DB}=await tempDb("enrollment-lock");
 try{
  const env={DB},t=1800000000000;
  let started,unlock;
  const startedPromise=new Promise(r=>started=r),hold=new Promise(r=>unlock=r);
  let replacement;
  const old=withEnrollmentLease(env,async()=>{
   assert.deepEqual(await withEnrollmentLease(env,async()=>42,{clock:()=>t}),{busy:true});
   replacement=withEnrollmentLease(env,async()=>{started();await hold;return "new"}, {clock:()=>t+1000000});
   await startedPromise;
   return "old";
  },{clock:()=>t});
  assert.equal(await old,"old");
  const active=await DB.prepare("SELECT value FROM runtime_state WHERE key='spender_enroll_batch_lock'").first();
  assert.ok(active?.value?.includes("|"),"new token survives predecessor cleanup");
  unlock();
  assert.equal(await replacement,"new");
  assert.equal((await DB.prepare("SELECT COUNT(*) n FROM runtime_state WHERE key='spender_enroll_batch_lock'").first()).n,0);
  const failed=await assert.rejects(withEnrollmentLease(env,async()=>{throw Error("failure")}),/failure/);
  assert.equal((await DB.prepare("SELECT COUNT(*) n FROM runtime_state WHERE key='spender_enroll_batch_lock'").first()).n,0);
 }finally{await mf.dispose()}
});
test("rate-limit Retry-After accepts seconds, HTTP dates and safely clamps very large delays",()=>{
 assert.equal(enrollmentRetryAfterSeconds("120"),120);
 assert.equal(enrollmentRetryAfterSeconds("0"),1);
 const now=Date.UTC(2026,9,15,12,0,0);
 assert.equal(enrollmentRetryAfterSeconds(new Date(now+95000).toUTCString(),now),95);
 assert.equal(enrollmentRetryAfterSeconds("999999"),4*3600);
 assert.equal(enrollmentRetryAfterSeconds("invalid"),null);
 assert.equal(enrollmentRetryAfterSeconds(null),null);
});

test("32 competing Spenders make progress in fresh and retry pools instead of one huge Spender monopolizing slots",async()=>{
 const {mf,DB}=await tempDb("spender-cross-fairness");
 try{
  await DB.prepare("WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i+1 FROM n WHERE i<32) "+
   "INSERT INTO spender_rules(spender,enabled,generation) SELECT printf('0x%040x',1000+i),1,'fair-gen' FROM n").run();
  await DB.prepare("WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i+1 FROM n WHERE i<32) "+
   "INSERT INTO spender_history_addresses(spender,owner,first_seen_block) "+
   "SELECT printf('0x%040x',1000+i),printf('0x%040x',2000+i),i FROM n").run();
  await DB.prepare("WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i+1 FROM n WHERE i<32) "+
   "INSERT INTO spender_history_addresses(spender,owner,first_seen_block) "+
   "SELECT printf('0x%040x',1000+i),printf('0x%040x',3000+i),i FROM n").run();
  await DB.prepare("WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i+1 FROM n WHERE i<32) "+
   "INSERT INTO spender_history_monitor_enrollments(spender,owner,state,updated_at,attempts) "+
   "SELECT printf('0x%040x',1000+i),printf('0x%040x',3000+i),'retrying',datetime('now','-2 hours'),5 FROM n").run();

  const seenFresh=new Set(),seenRetries=new Set();
  for(let cycle=0;cycle<7;cycle++){
    const batch=await selectEnrollmentCandidates(DB,20);
    assert.equal(batch.length,20);
    const fresh=batch.filter(x=>BigInt(x.owner)<3000n);
    const retries=batch.filter(x=>BigInt(x.owner)>=3000n);
    assert.equal(fresh.length,15);
    assert.equal(retries.length,5);
    assert.equal(new Set(fresh.map(x=>x.spender)).size,15,"no single Spender dominates fresh queue");
    assert.equal(new Set(retries.map(x=>x.spender)).size,5,"no single Spender dominates retry queue");
    for(const x of fresh)seenFresh.add(x.spender);
    for(const x of retries)seenRetries.add(x.spender);
  }
  assert.equal(seenFresh.size,32,"all Spenders get a fresh slot within three cycles");
  assert.equal(seenRetries.size,32,"all Spenders get retry attention within seven cycles");

  const round=await DB.prepare("SELECT key,value FROM runtime_state WHERE key LIKE 'spender_enroll_rr_%'").all();
  assert.ok(round.results.some(x=>x.key==="spender_enroll_rr_fresh"));
  assert.ok(round.results.some(x=>x.key==="spender_enroll_rr_retry"));
 }finally{await mf.dispose()}
});

test("single-slot enrollment alternates fresh and failed owners when both pools are backlogged",async()=>{
 const {mf,DB}=await tempDb("spender-single-slot");
 try{
  const spender=wallet(999),fresh=wallet(1),retry=wallet(2);
  await DB.prepare("INSERT INTO spender_rules(spender,enabled,generation) VALUES(?,1,'single-slot')").bind(spender).run();
  await DB.prepare("INSERT INTO spender_history_addresses(spender,owner,first_seen_block) VALUES(?,?,1)").bind(spender,fresh).run();
  await DB.prepare("INSERT INTO spender_history_addresses(spender,owner,first_seen_block) VALUES(?,?,2)").bind(spender,retry).run();
  await DB.prepare("INSERT INTO spender_history_monitor_enrollments(spender,owner,state,updated_at,attempts) VALUES(?,?,'retrying',datetime('now','-1 hour'),4)").bind(spender,retry).run();
  const first=(await selectEnrollmentCandidates(DB,1))[0].owner;
  const second=(await selectEnrollmentCandidates(DB,1))[0].owner;
  const third=(await selectEnrollmentCandidates(DB,1))[0].owner;
  assert.deepEqual([first,second,third],[fresh,retry,fresh]);
 }finally{await mf.dispose()}
});
