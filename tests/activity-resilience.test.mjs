import test from "node:test";
import assert from "node:assert/strict";
import {build} from "esbuild";
import {readFileSync} from "node:fs";
import {runInNewContext} from "node:vm";

const mocked=await build({
  entryPoints:["src/activity-replay.ts"],bundle:true,platform:"node",format:"esm",write:false,logLevel:"silent",
  plugins:[{name:"mock-chain-activity",setup(b){
    b.onResolve({filter:/^\.\/transfers$/},()=>({path:"transfers",namespace:"mocked"}));
    b.onLoad({filter:/.*/,namespace:"mocked"},()=>({
      loader:"js",contents:"export const processActivity=async (_env,payload)=>globalThis.__replayAction(payload);"
    }));
  }}]
});
const {retainFailedActivity,replayFailedActivities}=await import("data:text/javascript;base64,"+Buffer.from(mocked.outputFiles[0].text).toString("base64"));

class StateDb{
  constructor(){this.map=new Map()}
  prepare(sql){
    const state=this.map;let args=[];
    return {
      bind(...v){args=v;return this},
      async all(){
        if(sql.startsWith("SELECT key,value FROM runtime_state")){
          return{results:[...state].map(([key,value])=>({key,value})).filter(x=>x.key.startsWith("failed_activity:")).slice(0,30)};
        }
        throw Error("Unexpected all: "+sql);
      },
      async run(){
        if(sql.startsWith("INSERT OR IGNORE INTO runtime_state")){
          if(!state.has(args[0]))state.set(args[0],args[1]);return{meta:{changes:1}};
        }
        if(sql.startsWith("UPDATE runtime_state SET value=")){state.set(args[1],args[0]);return{meta:{changes:1}}}
        if(sql.startsWith("DELETE FROM runtime_state")){state.delete(args[0]);return{meta:{changes:1}}}
        throw Error("Unexpected write: "+sql);
      }
    };
  }
}
const payload={event:{network:"ETH_MAINNET",activity:[{hash:"0x"+"a".repeat(64),category:"token"}]}};

test("failed chain activity is stored durably and deduplicated for replay",async()=>{
  const DB=new StateDb(),env={DB};
  const a=await retainFailedActivity(env,payload,Error("temporary RPC error"));
  const b=await retainFailedActivity(env,payload,Error("retry RPC error"));
  assert.equal(a,b);
  assert.equal(DB.map.size,1);
  const record=JSON.parse(DB.map.get(a));
  assert.deepEqual(record.payload,payload);
  assert.match(record.last_error,/temporary RPC error/);
});

test("a recovered activity is replayed then removed exactly once",async()=>{
  const DB=new StateDb(),env={DB},key=await retainFailedActivity(env,payload,Error("temporarily offline"));
  const seen=[];globalThis.__replayAction=async p=>seen.push(p);
  try{
    const result=await replayFailedActivities(env,3);
    assert.equal(result.recovered,1);
    assert.equal(DB.map.has(key),false);
    assert.equal(seen.length,1);
    await replayFailedActivities(env,3);
    assert.equal(seen.length,1);
  }finally{delete globalThis.__replayAction}
});

test("replay errors retain the original payload and enforce a delayed retry",async()=>{
  const DB=new StateDb(),env={DB},key=await retainFailedActivity(env,payload,Error("offline"));
  let calls=0;
  globalThis.__replayAction=async()=>{calls++;throw Error("provider offline")};
  try{
    const a=await replayFailedActivities(env,3);
    assert.equal(a.recovered,0);
    assert.equal(calls,1);
    const saved=JSON.parse(DB.map.get(key));
    assert.equal(saved.attempts,1);
    assert.ok(saved.next_at>Date.now());
    assert.deepEqual(saved.payload,payload);
    const b=await replayFailedActivities(env,3);
    assert.equal(b.checked,0);
    assert.equal(calls,1);
  }finally{delete globalThis.__replayAction}
});

test("cron isolates every monitoring phase and keeps outbox delivery running",async()=>{
  const file=readFileSync("src/index.ts","utf8");
  const start=file.indexOf("async function cron(env){");
  const end=file.indexOf("export default {",start);
  assert.ok(start>=0&&end>start);
  const fired=[];
  const failed=async name=>{fired.push(name);throw Error(name+" transient failure")};
  const ok=async name=>{fired.push(name)};
  let watchCount=0;
  const context={
    recoverStuck:()=>failed("recoverStuck"),
    ensureWatch:async()=>{watchCount++;if(watchCount===1)throw Error("bad wallet");return true},
    pollSpenders:()=>failed("pollSpenders"),
    scanSpenderHistories:async()=>false,
    verifyHistoricalAllowances:()=>failed("allowances"),
    enrollHistoricalOwners:()=>ok("enroll"),
    reconcileAlchemyAddresses:()=>failed("alchemy"),
    scanWalletGaps:()=>ok("recovery"),
    reconcileRecentReorgs:()=>ok("reorg"),
    replayFailedActivities:()=>ok("replay"),
    flushOutbox:()=>ok("outbox"),
    console:{error:()=>{}}
  };
  const cron=runInNewContext(file.slice(start,end)+"\ncron",context);
  const env={DB:{prepare(sql){return{
    async all(){return{results:[{address:"0x1"},{address:"0x2"}]}},
    bind(){return this},
    async run(){return{meta:{changes:1}}}
  }}}};
  await cron(env);
  assert.equal(watchCount,2);
  assert.ok(fired.includes("recovery"));
  assert.ok(fired.includes("replay"));
  assert.ok(fired.includes("outbox"));
});

test("production queue ACKs chain events only after durable failure retention",()=>{
  const file=readFileSync("src/index.ts","utf8");
  assert.match(file,/if\(item\.kind==="activity"\)\{\s*\/\/ Never ACK/);
  assert.match(file,/await retainFailedActivity\(env,item\.payload,e\)/);
  assert.match(file,/Activity failure retention failed/);
  assert.match(file,/message\.retry\(\{delaySeconds:120\}\)/);
});
