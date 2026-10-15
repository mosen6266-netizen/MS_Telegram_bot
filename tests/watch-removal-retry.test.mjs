import test from "node:test";
import assert from "node:assert/strict";
import {buildSync} from "esbuild";
import {Miniflare,convertV4MiniflareOptions} from "miniflare";

const src=buildSync({stdin:{contents:'export {retryPendingWatchRemovals} from "./src/watch-maintenance";',
 resolveDir:process.cwd(),loader:"ts"},bundle:true,format:"esm",platform:"node",write:false}).outputFiles[0].text;
const {retryPendingWatchRemovals}=await import("data:text/javascript;base64,"+Buffer.from(src).toString("base64"));
const a=i=>"0x"+i.toString(16).padStart(40,"0");

test("only aged, unsubscribed removal jobs are retried and cooldown prevents calls",async()=>{
 const mf=new Miniflare(convertV4MiniflareOptions({name:"alchemy-removal-test",modules:true,
  script:'export default {fetch(){return new Response("ok")}}',d1Databases:{DB:"alchemy-removal"}}));
 const saved=globalThis.fetch;
 try{
  const DB=await mf.getD1Database("DB");
  await DB.prepare("CREATE TABLE wallet_watches(address TEXT PRIMARY KEY,state TEXT NOT NULL,updated_at TEXT DEFAULT CURRENT_TIMESTAMP,last_error TEXT)").run();
  await DB.prepare("CREATE TABLE subscriptions(chat_id TEXT,address TEXT,status TEXT)").run();
  await DB.prepare("CREATE TABLE runtime_state(key TEXT PRIMARY KEY,value TEXT)").run();
  await DB.prepare("INSERT INTO wallet_watches(address,state,updated_at) VALUES(?,'removal_pending',datetime('now','-40 minutes'))").bind(a(1)).run();
  await DB.prepare("INSERT INTO wallet_watches(address,state,updated_at) VALUES(?,'removal_pending',datetime('now','-40 minutes'))").bind(a(2)).run();
  await DB.prepare("INSERT INTO wallet_watches(address,state,updated_at) VALUES(?,'removal_pending',datetime('now','-10 minutes'))").bind(a(3)).run();
  await DB.prepare("INSERT INTO subscriptions(chat_id,address,status) VALUES('-10001',?,'active')").bind(a(2)).run();
  const calls=[];
  globalThis.fetch=async(url,request)=>{
   assert.equal(url,"https://dashboard.alchemy.com/api/update-webhook-addresses");
   const body=JSON.parse(request.body);calls.push(body.addresses_to_remove[0]);
   return Response.json({ok:true});
  };
  const env={DB,ALCHEMY_NOTIFY_TOKEN:"token",ALCHEMY_ACTIVITY_WEBHOOK_ID:"wh_1"};
  const first=await retryPendingWatchRemovals(env);
  assert.deepEqual(first,{selected:1,removed:1,retrying:0});
  assert.deepEqual(calls,[a(1)]);
  assert.equal((await DB.prepare("SELECT state FROM wallet_watches WHERE address=?").bind(a(1)).first()).state,"removed");
  assert.equal((await DB.prepare("SELECT state FROM wallet_watches WHERE address=?").bind(a(2)).first()).state,"removal_pending");
  assert.equal((await DB.prepare("SELECT state FROM wallet_watches WHERE address=?").bind(a(3)).first()).state,"removal_pending");

  await DB.prepare("INSERT INTO runtime_state(key,value) VALUES('spender_enroll_retry_after',?)").bind(String(Date.now()+600000)).run();
  const blocked=await retryPendingWatchRemovals(env);
  assert.deepEqual(blocked,{skipped:"alchemy_rate_limited"});
  assert.deepEqual(calls,[a(1)]);
 }finally{globalThis.fetch=saved;await mf.dispose()}
});

test("failed external deletion stays pending and is not marked removed",async()=>{
 const mf=new Miniflare(convertV4MiniflareOptions({name:"alchemy-removal-fail-test",modules:true,
  script:'export default {fetch(){return new Response("ok")}}',d1Databases:{DB:"alchemy-removal-fail"}}));
 const saved=globalThis.fetch;
 try{
  const DB=await mf.getD1Database("DB");
  await DB.prepare("CREATE TABLE wallet_watches(address TEXT PRIMARY KEY,state TEXT NOT NULL,updated_at TEXT DEFAULT CURRENT_TIMESTAMP,last_error TEXT)").run();
  await DB.prepare("CREATE TABLE subscriptions(chat_id TEXT,address TEXT,status TEXT)").run();
  await DB.prepare("CREATE TABLE runtime_state(key TEXT PRIMARY KEY,value TEXT)").run();
  await DB.prepare("INSERT INTO wallet_watches(address,state,updated_at) VALUES(?,'removal_pending',datetime('now','-40 minutes'))").bind(a(3)).run();
  globalThis.fetch=async()=>new Response("too many requests",{status:429});
  const res=await retryPendingWatchRemovals({DB,ALCHEMY_NOTIFY_TOKEN:"test",ALCHEMY_ACTIVITY_WEBHOOK_ID:"wh_1"});
  assert.deepEqual(res,{selected:1,removed:0,retrying:1});
  const row=await DB.prepare("SELECT state,last_error FROM wallet_watches WHERE address=?").bind(a(3)).first();
  assert.equal(row.state,"removal_pending");
  assert.match(row.last_error,/429/);
 }finally{globalThis.fetch=saved;await mf.dispose()}
});
