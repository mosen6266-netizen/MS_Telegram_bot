import test from "node:test";
import assert from "node:assert/strict";
import {buildSync} from "esbuild";
import {Miniflare,convertV4MiniflareOptions} from "miniflare";

const compiled=buildSync({stdin:{
 contents:'export {withAlchemyMutationLease,AlchemyMutationBusy} from "./src/alchemy-mutation-lease"; export {ensureWatch,removeWatch} from "./src/core";',
 resolveDir:process.cwd(),loader:"ts"
},bundle:true,format:"esm",platform:"node",write:false}).outputFiles[0].text;
const {withAlchemyMutationLease,AlchemyMutationBusy,ensureWatch,removeWatch}
  =await import("data:text/javascript;base64,"+Buffer.from(compiled).toString("base64"));

async function temporaryDB(name){
 const mf=new Miniflare(convertV4MiniflareOptions({name,modules:true,
 script:'export default {fetch(){return new Response("ok")}}',d1Databases:{DB:name}}));
 const DB=await mf.getD1Database("DB");
 await DB.prepare("CREATE TABLE runtime_state(key TEXT PRIMARY KEY,value TEXT NOT NULL,updated_at TEXT DEFAULT CURRENT_TIMESTAMP)").run();
 return {mf,DB};
}

test("Alchemy D1 mutation lease rejects overlap, releases after failures and prevents stolen-token unlock",async()=>{
 const {mf,DB}=await temporaryDB("alchemy-mutation-lease");
 try{
  const env={DB};
  const epoch=1800000000000;
  let enterNew,releaseNew;
  const entered=new Promise(resolve=>enterNew=resolve);
  const holdNew=new Promise(resolve=>releaseNew=resolve);
  let newLease;
  await withAlchemyMutationLease(env,async()=>{
   await assert.rejects(withAlchemyMutationLease(env,async()=>{}, {clock:()=>epoch}),err=>err instanceof AlchemyMutationBusy);
   // The successor must still be holding its lease when the predecessor
   // tries releasing its stale token.
   newLease=withAlchemyMutationLease(env,async()=>{
    enterNew();
    await holdNew;
   },{clock:()=>epoch+200000});
   await entered;
  },{clock:()=>epoch});
  const stillHeld=await DB.prepare("SELECT value FROM runtime_state WHERE key='alchemy_mutation_lease'").first();
  assert.ok(stillHeld&&stillHeld.value.includes("|"),"successor must still own the lease");
  releaseNew();
  await newLease;
  assert.equal((await DB.prepare("SELECT COUNT(*) n FROM runtime_state WHERE key='alchemy_mutation_lease'").first()).n,0);
  await DB.prepare("DELETE FROM runtime_state WHERE key='alchemy_mutation_lease'").run();
  await assert.rejects(withAlchemyMutationLease(env,async()=>{throw Error("callback fails")}),/callback fails/);
  assert.equal((await DB.prepare("SELECT COUNT(*) n FROM runtime_state WHERE key='alchemy_mutation_lease'").first()).n,0);
  await withAlchemyMutationLease(env,async()=>42);
 }finally{await mf.dispose()}
});

test("adding and removing the same wallet cannot mutate Alchemy concurrently",async()=>{
 const {mf,DB}=await temporaryDB("alchemy-mutating-wallet");
 const savedFetch=globalThis.fetch;
 try{
  await DB.prepare("CREATE TABLE wallet_watches(address TEXT PRIMARY KEY,state TEXT NOT NULL,updated_at TEXT,last_error TEXT,synced_at TEXT)").run();
  await DB.prepare("CREATE TABLE wallet_checkpoints(address TEXT PRIMARY KEY,last_block INTEGER)").run();
  await DB.prepare("CREATE TABLE wallet_exclusions(address TEXT PRIMARY KEY)").run();
  await DB.prepare("CREATE TABLE subscriptions(chat_id TEXT,address TEXT,status TEXT)").run();
  const owner="0x"+"11".repeat(20);
  const env={DB,ALCHEMY_NOTIFY_TOKEN:"test-token",ALCHEMY_ACTIVITY_WEBHOOK_ID:"wh-test"};
  let started,finish;
  const startedPromise=new Promise(resolve=>started=resolve),hold=new Promise(resolve=>finish=resolve);
  const calls=[];
  globalThis.fetch=async(url,options)=>{
   assert.equal(url,"https://dashboard.alchemy.com/api/update-webhook-addresses");
   const payload=JSON.parse(options.body);
   calls.push(payload);
   if(payload.addresses_to_add.length){started();await hold}
   return Response.json({success:true});
  };
  const addPromise=ensureWatch(env,owner,1200);
  await startedPromise;
  assert.equal(await removeWatch(env,owner),false,"remove must wait for active add");
  assert.equal(calls.length,1,"removal must not reach Alchemy while add is pending");
  finish();
  assert.equal(await addPromise,true);
  assert.equal((await DB.prepare("SELECT state FROM wallet_watches WHERE address=?").bind(owner).first()).state,"active");
  assert.equal(await removeWatch(env,owner),true);
  assert.equal(calls.length,2);
  assert.deepEqual(calls.map(x=>[x.addresses_to_add.length,x.addresses_to_remove.length]),[[1,0],[0,1]]);
  assert.equal((await DB.prepare("SELECT state FROM wallet_watches WHERE address=?").bind(owner).first()).state,"removed");
 }finally{globalThis.fetch=savedFetch;await mf.dispose()}
});
