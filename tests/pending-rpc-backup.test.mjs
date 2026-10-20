import test from "node:test";
import assert from "node:assert/strict";
import {build} from "esbuild";
import {readFileSync} from "node:fs";
const built=await build({entryPoints:["src/recovery.ts"],bundle:true,write:false,format:"esm",platform:"node",logLevel:"silent",
  plugins:[{name:"backup-mocks",setup(b){
    b.onResolve({filter:/^\.\/core$/},()=>({namespace:"mocks",path:"core"}));
    b.onResolve({filter:/^\.\/transfers$/},()=>({namespace:"mocks",path:"transfers"}));
    b.onLoad({filter:/.*/,namespace:"mocks"},args=>({loader:"js",contents:args.path==="core"?
      'export const USDT="0x"+ "1".repeat(40),USDC="0x"+"2".repeat(40);export const now=()=>new Date().toISOString();export const queueNotice=async()=>{};export const blockNumber=async()=>1000;export const rpc=async(env,method,params)=>globalThis.__rpc(method,params);':
      'export const processActivity=async(env,payload,options)=>globalThis.__process(payload,options);'
    }));
  }}]});
const {scanPendingRpcFallback}=await import("data:text/javascript;base64,"+Buffer.from(built.outputFiles[0].text).toString("base64"));
const address="0x"+"a".repeat(40);
class Db{
 constructor(){this.rows=new Map();}
 prepare(sql){
  const db=this;let args=[];
  return {bind(...x){args=x;return this;},
    async all(){if(sql.includes("SELECT w.address FROM wallet_watches w WHERE w.state='pending'"))return {results:[{address}]};throw Error("Unexpected select "+sql);},
    async first(){if(sql.includes("SELECT value FROM runtime_state"))return db.rows.has(args[0])?{value:db.rows.get(args[0])}:null;throw Error("Unexpected first "+sql);},
    async run(){if(sql.startsWith("INSERT INTO runtime_state")){db.rows.set(args[0],args[1]);return {meta:{changes:1}};}throw Error("Unexpected write "+sql);}
  };
 }
}
test("backup scans in and out without pretending Alchemy Webhook is subscribed",async()=>{
 const db=new Db(),calls=[],processing=[];
 globalThis.__rpc=async(m,p)=>{calls.push({m,p});return {transfers:[]}};
 globalThis.__process=async(p,o)=>processing.push(o.pendingRecoveryAddress);
 try{
  assert.equal((await scanPendingRpcFallback({DB:db})).succeeded,1);
  assert.equal(calls.length,2);assert.deepEqual(processing,[address,address]);
  assert.equal(JSON.parse(db.rows.get("pending_rpc_backup:"+address)).last_block,1000);
  await scanPendingRpcFallback({DB:db});
  assert.equal(parseInt(calls[2].p[0].fromBlock,16),995);
 }finally{delete globalThis.__rpc;delete globalThis.__process;}
});
test("failed scan leaves checkpoint unchanged",async()=>{
 const db=new Db();globalThis.__rpc=async()=>{throw Error("RPC timeout")};globalThis.__process=async()=>{};
 try{
  assert.equal((await scanPendingRpcFallback({DB:db})).failed,1);
  const row=JSON.parse(db.rows.get("pending_rpc_backup:"+address));
  assert.equal(row.status,"error");assert.equal(row.last_block,null);
 }finally{delete globalThis.__rpc;delete globalThis.__process;}
});
test("pending pipeline is opt-in and real-time paths keep their existing priority",()=>{
 const t=readFileSync("src/transfers.ts","utf8"),w=readFileSync("src/index.ts","utf8");
 assert.match(t,/options.pendingRecoveryAddress===o.address/);
 assert.match(t,/state='pending' AND \?=1/);
 assert.match(t,/watch.state==="pending"&&pendingRecovery/);
 assert.match(w,/item.kind==="scan_pending"/);
 assert.match(w,/await processRealtimeApprovalWebhook\(configured,item.payload\)/);
 assert.match(w,/await flushOutbox\(configured,20\)/);
});

test("backup transfer delivery requires RPC provenance and excludes removed wallets",()=>{
 const notification=readFileSync("src/notifications.ts","utf8");
 const transfer=readFileSync("src/transfers.ts","utf8");
 assert.match(transfer,/rpc_fallback:watch.state==="pending"&&pendingRecovery/);
 assert.match(notification,/row.template_key==="transfer"&&payload.rpc_fallback===true/);
 assert.match(notification,/w.state='pending'/);
 assert.match(notification,/wallet_exclusions/);
 assert.match(notification,/approvalAlert\|\|backedUpTransfer/);
});
