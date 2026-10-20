import test from "node:test";
import assert from "node:assert/strict";
import {build} from "esbuild";

const built=await build({entryPoints:["src/alchemy-management.ts"],bundle:true,write:false,platform:"node",format:"esm",logLevel:"silent"});
const {alchemyManagementFetch}=await import("data:text/javascript;base64,"+Buffer.from(built.outputFiles[0].text).toString("base64"));

class StateDb {
  constructor(){this.rows=new Map();}
  prepare(sql){
    let args=[];const db=this;
    return {
      bind(...values){args=values;return this;},
      async first(){
        if(sql.startsWith("SELECT value FROM runtime_state"))return db.rows.has(args[0])?{value:db.rows.get(args[0])}:null;
        throw Error("Unexpected SELECT "+sql);
      },
      async run(){
        if(sql.startsWith("INSERT OR IGNORE INTO runtime_state")){
          if(db.rows.has(args[0]))return {meta:{changes:0}};
          db.rows.set(args[0],args[1]);return {meta:{changes:1}};
        }
        if(sql.startsWith("INSERT INTO runtime_state")){
          db.rows.set(args[0],args[1]);return {meta:{changes:1}};
        }
        if(sql.startsWith("UPDATE runtime_state SET value")){
          if(db.rows.get(args[1])!==args[2])return {meta:{changes:0}};
          db.rows.set(args[1],args[0]);return {meta:{changes:1}};
        }
        if(sql.startsWith("DELETE FROM runtime_state")){
          if(db.rows.get(args[0])!==args[1])return {meta:{changes:0}};
          db.rows.delete(args[0]);return {meta:{changes:1}};
        }
        throw Error("Unexpected write "+sql);
      }
    };
  }
}

test("Alchemy HTTP 429 opens a shared cooldown without blocking event processing",async()=>{
  const db=new StateDb(), originalFetch=globalThis.fetch;
  let calls=0;
  globalThis.fetch=async()=>{calls++;return new Response("error code: 1015",{status:429,headers:{"retry-after":"900"}});};
  try{
    await assert.rejects(alchemyManagementFetch({DB:db},"https://dashboard.alchemy.com/api/team-webhooks"),/HTTP 429/);
    assert.equal(calls,1);
    await assert.rejects(alchemyManagementFetch({DB:db},"https://dashboard.alchemy.com/api/update-webhook-addresses"),/cooldown/);
    assert.equal(calls,1,"all management endpoints share backoff");
    assert.ok(Number(db.rows.get("alchemy_management_cooldown_until"))>Date.now());
  }finally{globalThis.fetch=originalFetch;}
});

test("an in-flight management request is never duplicated by another job",async()=>{
  const db=new StateDb(), originalFetch=globalThis.fetch;
  let started,release;
  const startedPromise=new Promise(resolve=>started=resolve);
  const heldPromise=new Promise(resolve=>release=resolve);
  let calls=0;
  globalThis.fetch=async()=>{calls++;started();await heldPromise;return new Response("ok");};
  try{
    const a=alchemyManagementFetch({DB:db},"https://dashboard.alchemy.com/api/team-webhooks");
    await startedPromise;
    await assert.rejects(alchemyManagementFetch({DB:db},"https://dashboard.alchemy.com/api/team-webhooks"),/already in progress/);
    release();assert.equal((await a).status,200);assert.equal(calls,1);
    assert.equal(db.rows.has("alchemy_management_lock"),false);
  }finally{release?.();globalThis.fetch=originalFetch;}
});

test("realtime transaction and approval delivery remain outside management limiter",async()=>{
  const {readFileSync}=await import("node:fs");
  const index=readFileSync("src/index.ts","utf8");
  const approval=readFileSync("src/approval.ts","utf8");
  assert.match(index,/await processActivity\(configured,item.payload\)/);
  assert.match(index,/await processRealtimeApprovalWebhook\(configured,item.payload\)/);
  assert.match(index,/await flushOutbox\(configured,20\)/);
  assert.match(approval,/Queue it independently, with the existing cron as a fallback/);
});
