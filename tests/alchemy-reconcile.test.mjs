import test from "node:test";
import assert from "node:assert/strict";
import {buildSync} from "esbuild";
import {Miniflare,convertV4MiniflareOptions} from "miniflare";

const src=buildSync({stdin:{contents:'export {fetchAlchemyAddresses,compareAlchemyAddressLists,maybeReconcileAlchemy,lastAlchemyReconciliation} from "./src/alchemy-reconcile";',
 resolveDir:process.cwd(),loader:"ts"},bundle:true,format:"esm",platform:"node",write:false}).outputFiles[0].text;
const api=await import("data:text/javascript;base64,"+Buffer.from(src).toString("base64"));
const a=i=>"0x"+i.toString(16).padStart(40,"0");
const envBase={ALCHEMY_NOTIFY_TOKEN:"test-token",ALCHEMY_ACTIVITY_WEBHOOK_ID:"wh_test"};
function provider(pages){
 let index=0;
 return async (raw,options)=>{
  const url=new URL(raw);
  assert.equal(url.pathname,"/api/webhook-addresses");
  assert.equal(url.searchParams.get("webhook_id"),"wh_test");
  assert.equal(options.headers["X-Alchemy-Token"],"test-token");
  assert.equal(url.searchParams.get("after"),index===0?null:"next");
  return Response.json(pages[index++]);
 };
}
const p=(addresses,total,next)=>({data:addresses,pagination:{total_count:total,cursors:{...(next?{after:next}:{})}}});

test("Alchemy address pages are fully read before a reliable comparison",async()=>{
 const fetcher=provider([p([a(1),a(2)],3,"next"),p([a(3)],3)]);
 const fetched=await api.fetchAlchemyAddresses(envBase,{fetcher,pageSize:2});
 assert.equal(fetched.total_count,3);
 assert.equal(fetched.pages,2);
 assert.deepEqual([...fetched.addresses].sort(),[a(1),a(2),a(3)]);
});

test("reconciliation fails closed on truncated lists, looping cursors, invalid data, 429 and count changes",async()=>{
 const cases=[
  [async()=>Response.json(p([a(1)],3)),/ended before advertised total/],
  [async()=>Response.json(p([a(1)],2,"same")),/cursor did not advance|duplicate address/],
  [async()=>Response.json(p(["invalid"],1)),/invalid address/],
  [async()=>new Response("rate limited",{status:429}),/HTTP 429/],
  [async()=>Response.json({data:[a(1)]}),/trustworthy total count/]
 ];
 for(const [fetcher,pattern] of cases){
  await assert.rejects(api.fetchAlchemyAddresses(envBase,{fetcher,pageSize:2,maxPages:4}),pattern);
 }
 let count=0;
 await assert.rejects(api.fetchAlchemyAddresses(envBase,{pageSize:2,
  fetcher:async()=>Response.json(count++===0?p([a(1)],3,"next"):p([a(2)],5))
 }),/changed during pagination/);
});

test("read-only comparison reports missing, extra, pending and removal states without D1 mutation",async()=>{
 const mf=new Miniflare(convertV4MiniflareOptions({name:"alchemy-compare-test",modules:true,
  script:'export default {fetch(){return new Response("ok")}}',d1Databases:{DB:"alchemy-compare"}}));
 try{
  const DB=await mf.getD1Database("DB");
  await DB.prepare("CREATE TABLE wallet_watches(address TEXT PRIMARY KEY,state TEXT NOT NULL)").run();
  for(const [id,state] of [[1,"active"],[2,"active"],[3,"pending"],[4,"removal_pending"]]){
   await DB.prepare("INSERT INTO wallet_watches(address,state) VALUES(?,?)").bind(a(id),state).run();
  }
  const result=await api.compareAlchemyAddressLists({...envBase,DB},{
   fetcher:async()=>Response.json(p([a(2),a(3),a(4),a(5)],4))
  });
  assert.equal(result.missing_remote,1);
  assert.deepEqual(result.missing_sample,[a(1)]);
  assert.equal(result.matched_active,1);
  assert.equal(result.pending_already_remote,1);
  assert.equal(result.removal_still_remote,1);
  assert.equal(result.remote_not_in_local,1);
  assert.equal(result.status,"needs_review");
  assert.equal((await DB.prepare("SELECT COUNT(*) n FROM wallet_watches WHERE state='active'").first()).n,2);
 }finally{await mf.dispose()}
});

test("failed snapshots never overwrite last complete result; maintenance enforces retry cooldown",async()=>{
 const mf=new Miniflare(convertV4MiniflareOptions({name:"alchemy-maintenance-test",modules:true,
  script:'export default {fetch(){return new Response("ok")}}',d1Databases:{DB:"alchemy-maintenance"}}));
 try{
  const DB=await mf.getD1Database("DB");
  await DB.prepare("CREATE TABLE wallet_watches(address TEXT PRIMARY KEY,state TEXT NOT NULL)").run();
  await DB.prepare("CREATE TABLE runtime_state(key TEXT PRIMARY KEY,value TEXT NOT NULL,updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP)").run();
  await DB.prepare("INSERT INTO wallet_watches(address,state) VALUES(?,'active')").bind(a(1)).run();
  const initial=1_800_000_000_000;
  const good=await api.maybeReconcileAlchemy({...envBase,DB},{clock:()=>initial,fetcher:async()=>Response.json(p([a(1)],1))});
  assert.deepEqual({status:good.status,missing_remote:good.missing_remote},{status:"consistent",missing_remote:0});
  assert.deepEqual(await api.maybeReconcileAlchemy({...envBase,DB},{clock:()=>initial+5000,fetcher:async()=>{throw Error("must not run")}}),{skipped:"recent_success"});
  const bad=await api.maybeReconcileAlchemy({...envBase,DB},{clock:()=>initial+25*3600*1000,fetcher:async()=>new Response("rate limit",{status:429})});
  assert.match(bad.error,/HTTP 429/);
  const previous=await api.lastAlchemyReconciliation(DB);
  assert.equal(previous.report.missing_remote,0);
  assert.equal(previous.report.status,"consistent");
  assert.match(previous.last_error,/429/);
  const retry=await api.maybeReconcileAlchemy({...envBase,DB},{clock:()=>initial+25*3600*1000+10000,
   fetcher:async()=>{throw Error("called too soon")}});
  assert.deepEqual(retry,{skipped:"backoff"});
 }finally{await mf.dispose()}
});
