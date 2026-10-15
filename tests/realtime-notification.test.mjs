import test from "node:test";
import assert from "node:assert/strict";
import {build} from "esbuild";
const USDT="0xdac17f958d2ee523a2206206994597c13d831ec7";
const TOPIC="0x8c5be1e5ebec7d5bd14f71427d1e84f3dd0314c0f7b2291e5b200ac8c7c3b925";
const s1="0x"+"1".repeat(40),s2="0x"+"2".repeat(40),owner="0x"+"3".repeat(40);
const core=[
 'export const USDT="'+USDT+'",APPROVAL_TOPIC="'+TOPIC+'";',
 'export const now=()=>new Date().toISOString();',
 'export const addr=x=>/^0x[0-9a-f]{40}$/i.test(String(x||""))?x.toLowerCase():null;',
 'export const fromTopic=x=>x&&"0x"+x.slice(-40).toLowerCase();',
 'export const toTopic=x=>"0x"+x.slice(2).toLowerCase().padStart(64,"0");'
].join("\n");
const out=await build({entryPoints:["src/approval-realtime.ts"],bundle:true,format:"esm",platform:"node",write:false,logLevel:"silent",
 plugins:[{name:"realtime-mocks",setup(b){
   b.onResolve({filter:/^\.\/(core|approval|setup)$/},args=>({path:args.path,namespace:"mock"}));
   b.onLoad({filter:/.*/,namespace:"mock"},args=>({loader:"js",contents:args.path==="./core"?core:
     args.path==="./approval"?'export const processRealtimeApproval=async(...args)=>globalThis.__approvalEvents.push(args);':
     'export const persistSecret=async(...args)=>globalThis.__storedSecrets.push(args);'}));
 }}]});
const {approvalQuery,parseApprovalWebhook,processRealtimeApprovalWebhook,provisionRealtimeApprovals}
 =await import("data:text/javascript;base64,"+Buffer.from(out.outputFiles[0].text).toString("base64"));
const payload={id:"whevt_test",type:"GRAPHQL",webhookId:"wh_test",
 event:{data:{block:{number:26200523,logs:[
  {account:{address:USDT},topics:[TOPIC,"0x"+owner.slice(2).padStart(64,"0"),"0x"+s1.slice(2).padStart(64,"0")],
   data:"0x01",index:7,transaction:{hash:"0x"+"a".repeat(64),status:1}}
 ]}}}};
test("GraphQL filter includes exactly ETH USDT Approval and enabled spender topic2 choices",()=>{
 const q=approvalQuery([s1,s2]);
 assert.ok(q.includes(USDT));assert.ok(q.includes(TOPIC));
 assert.ok(q.includes(s1.slice(2).padStart(64,"0")));
 assert.ok(q.includes(s2.slice(2).padStart(64,"0")));
 assert.ok(!q.includes("transactions(filter:"));
});
test("GraphQL event is decoded with canonical Ethereum RPC log indices",()=>{
 const events=parseApprovalWebhook(payload);
 assert.equal(events.length,1);assert.equal(events[0].spender,s1);
 assert.equal(events[0].log.logIndex,"0x7");
 assert.equal(events[0].log.blockNumber,"0x"+(26200523).toString(16));
 assert.equal(events[0].log.topics.length,3);
});
test("realtime handler checks webhook identity and dispatches authorized log",async()=>{
 globalThis.__approvalEvents=[];
 try{
   await assert.rejects(()=>processRealtimeApprovalWebhook({ALCHEMY_APPROVAL_WEBHOOK_ID:"wh_else"},payload),/Unexpected approval webhook ID/);
   assert.equal(await processRealtimeApprovalWebhook({ALCHEMY_APPROVAL_WEBHOOK_ID:"wh_test"},payload),1);
   assert.equal(globalThis.__approvalEvents[0][1],s1);
 }finally{delete globalThis.__approvalEvents}
});
test("custom webhook provisioner creates a targeted GRAPHQL webhook and persists its signature",async()=>{
 let createBody,callLog=[];
 const previous=globalThis.fetch;
 globalThis.__storedSecrets=[];
 const db=new Map();
 const e={ALCHEMY_NOTIFY_TOKEN:"test",PUBLIC_BASE_URL:"https://bot.example",DB:{prepare(sql){
   let args=[];return{bind(...v){args=v;return this},
   async all(){if(sql.startsWith("SELECT spender FROM spender_rules"))return{results:[{spender:s1},{spender:s2}]};throw Error(sql)},
   async first(){if(sql.startsWith("SELECT value FROM runtime_state"))return db.has(args[0])?{value:db.get(args[0])}:null;throw Error(sql)},
   async run(){
     if(sql.startsWith("INSERT OR IGNORE INTO runtime_state")){if(db.has(args[0]))return{meta:{changes:0}};db.set(args[0],args[1]);return{meta:{changes:1}}}
     if(sql.startsWith("INSERT INTO runtime_state")){db.set(args[0],args[1]);return{meta:{changes:1}}}
     if(sql.startsWith("DELETE FROM runtime_state")){db.delete(args[0]);return{meta:{changes:1}}}
     throw Error(sql);
   }};
 }}};
 globalThis.fetch=async (url,options={})=>{
   callLog.push({url:String(url),method:options.method||"GET"});
   if(String(url).includes("team-webhooks"))return{ok:true,json:async()=>({data:[]})};
   if(String(url).includes("create-webhook")){createBody=JSON.parse(options.body);return{ok:true,json:async()=>({data:{id:"wh_test",signing_key:"hidden",is_active:false}})}}
   if(String(url).includes("update-webhook"))return{ok:true,json:async()=>({data:{id:"wh_test",is_active:true}})};
   throw Error("Unknown URL");
 };
 try{
   const result=await provisionRealtimeApprovals(e);
   assert.equal(result.status,"created");assert.equal(result.active,true);
   assert.equal(createBody.network,"ETH_MAINNET");assert.equal(createBody.webhook_type,"GRAPHQL");
   assert.equal(createBody.graphql_query.skip_empty_messages,true);
   assert.equal(createBody.webhook_url,"https://bot.example/webhooks/alchemy-approvals");
   assert.equal(globalThis.__storedSecrets.length,2);
   assert.equal(JSON.parse(db.get("approval_realtime_status")).state,"active");
   assert.ok(callLog.some(x=>x.url.includes("update-webhook")));
 }finally{globalThis.fetch=previous;delete globalThis.__storedSecrets}
});
test("queue and outbox fast path are connected for approvals and ETH transfers",async()=>{
 const fs=await import("node:fs");
 const index=fs.readFileSync("src/index.ts","utf8"),wrangler=fs.readFileSync("wrangler.jsonc","utf8");
 assert.match(index,/path===\"\/webhooks\/alchemy-approvals\"/);
 assert.match(index,/await processRealtimeApprovalWebhook\(configured,item\.payload\)/);
 assert.match(index,/item\.kind===\"activity\"\|\|item\.kind===\"approval_webhook\"/);
 assert.match(index,/await flushOutbox\(configured,20\)/);
 assert.match(index,/kind:\"enroll_owner\"/);
 assert.match(wrangler,/"max_batch_timeout": 0/);
});
