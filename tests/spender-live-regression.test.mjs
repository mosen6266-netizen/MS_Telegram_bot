import test from "node:test";
import assert from "node:assert/strict";
import {build} from "esbuild";

const core=[
'export const USDT="0xdac17f958d2ee523a2206206994597c13d831ec7";',
'export const APPROVAL_TOPIC="0x"+"a".repeat(64);',
'export const addr=x=>x;',
'export const toTopic=x=>x;',
'export const fromTopic=()=>globalThis.__spenderFixture.owner;',
'export const allowance=async()=>globalThis.__spenderFixture.amount;',
'export const blockNumber=async()=>globalThis.__spenderFixture.head;',
'export const rpc=async(_e,method,args)=>globalThis.__spenderFixture.rpc(method,args);',
'export const receiptSuccess=async()=>true;',
'export const formatUnits=v=>String(v),esc=x=>x,short=x=>x.slice(0,10),send=async()=>{},buttons=()=>{},recordUsage=async()=>{};',
'export const queueNotice=async(_e,obj)=>globalThis.__spenderFixture.queue(obj);',
'export const ensureWatch=async()=>globalThis.__spenderFixture.watch();',
'export const increment=async()=>{};',
'export const now=()=>new Date().toISOString();'
].join("\n");
const buildResult=await build({
 entryPoints:["src/approval.ts"],bundle:true,platform:"node",format:"esm",write:false,logLevel:"silent",
 plugins:[{name:"spender-chain-stubs",setup(b){
   b.onResolve({filter:/^\.\/core$/},()=>({path:"core",namespace:"f"}));
   b.onResolve({filter:/^\.\/spender-history$/},()=>({path:"history",namespace:"f"}));
   b.onResolve({filter:/^\.\/wallet-remarks$/},()=>({path:"remarks",namespace:"f"}));
   b.onResolve({filter:/^\.\/notifications$/},()=>({path:"notification",namespace:"f"}));
   b.onLoad({filter:/.*/,namespace:"f"},args=>({loader:"js",contents:args.path==="core"?core:args.path==="history"?"export const recordSpenderLiveApproval=async()=>{};":args.path==="remarks"?'export const walletRemark=async()=>"contact";':'export const renderTemplate=async()=>"";'}));
 }}]
});
const {pollSpenders}=await import("data:text/javascript;base64,"+Buffer.from(buildResult.outputFiles[0].text).toString("base64"));
const spender="0x"+"1".repeat(40),owner="0x"+"2".repeat(40),hash="0x"+"a".repeat(64),chat="-1001234567890";
const log={topics:["0x"+"a".repeat(64),"0x"+"b".repeat(64)],transactionHash:hash,logIndex:"0x2",blockNumber:"0x66",data:"0x1"};
function prepareFixture({head=110,provider=async()=>[],notifyFail=false,watchFail=false}={}){
 const state={rules:[{spender,enabled:1,cursor_block:100}],map:new Map(),events:new Map(),allowances:new Map(),subscriptions:new Map(),wallets:new Set(),outbox:new Map(),calls:[],noticesAttempted:0};
 const fixture={head,owner,amount:1000000n,
   rpc:async(method,args)=>{assert.equal(method,"eth_getLogs");const p=args[0],from=Number(BigInt(p.fromBlock)),to=Number(BigInt(p.toBlock));state.calls.push([from,to]);return provider(from,to)},
   watch:async()=>{if(watchFail)throw Error("Alchemy temporarily offline");return true},
   queue:async n=>{state.noticesAttempted++;if(notifyFail&&state.noticesAttempted===1)throw Error("Outbox temporary failure");state.outbox.set(n.dedup,n)}
 };
 globalThis.__spenderFixture=fixture;
 const DB={prepare(sql){let args=[];return{
   bind(...v){args=v;return this},
   async first(){
     if(sql.startsWith("SELECT value FROM runtime_state"))return state.map.has(args[0])?{value:state.map.get(args[0])}:null;
     if(sql.startsWith("SELECT event_type FROM approval_events"))return state.events.get(args[0])||null;
     if(sql.startsWith("SELECT amount_raw FROM allowances"))return state.allowances.get(args[0]+":"+args[1])||null;
     if(sql.startsWith("SELECT 1 FROM wallet_exclusions"))return null;
     if(sql.startsWith("SELECT deleted_at FROM wallets"))return state.wallets.has(args[0])?{deleted_at:null}:null;
     if(sql.startsWith("SELECT state FROM wallet_watches"))return null;
     if(sql.startsWith("SELECT 1 FROM telegram_chats"))return{active:1,chat_type:"supergroup"};
     if(sql.startsWith("SELECT 1 FROM wallets"))return state.wallets.has(args[0])?{ok:true}:null;
     throw Error("Unmocked first SQL: "+sql);
   },
   async all(){
     if(sql.startsWith("SELECT * FROM spender_rules"))return{results:state.rules};
     if(sql.startsWith("SELECT chat_id FROM spender_routes"))return{results:[{chat_id:chat}]};
     throw Error("Unmocked all SQL: "+sql);
   },
   async run(){
     if(sql.startsWith("INSERT INTO runtime_state")){state.map.set(args[0],args[1]);return{meta:{changes:1}}}
     if(sql.startsWith("UPDATE spender_rules SET cursor_block")){state.rules[0].cursor_block=args[0];return{meta:{changes:1}}}
     if(sql.startsWith("INSERT OR IGNORE INTO approval_events")){if(!state.events.has(args[0]))state.events.set(args[0],{event_type:args[6]});return{meta:{changes:1}}}
     if(sql.startsWith("INSERT INTO allowances")){state.allowances.set(args[0]+":"+args[1],{amount_raw:args[2]});return{meta:{changes:1}}}
     if(sql.startsWith("INSERT OR IGNORE INTO wallets")){state.wallets.add(args[0]);return{meta:{changes:1}}}
     if(sql.startsWith("INSERT OR IGNORE INTO subscriptions")){state.subscriptions.set(args[0]+":"+args[1],{status:"pending"});return{meta:{changes:1}}}
     if(sql.startsWith("UPDATE subscriptions SET status="))return{meta:{changes:1}};
     throw Error("Unmocked write SQL: "+sql);
   }
 }}};
 return {env:{DB,TASKS:{send:async item=>{state.enrollmentTasks??=[];state.enrollmentTasks.push(item)}}},state,fixture};
}
test("provider block-window limits reduce scan size without losing any blocks",async()=>{
 const {env,state}=prepareFixture({head:210,provider:async(from,to)=>{if(to-from>=16)throw Error("RPC block range limit");return []}});
 try{
   for(let i=0;i<4;i++)await pollSpenders(env);
   assert.equal(state.rules[0].cursor_block,210);
   assert.equal(state.calls[0][0],101);
   assert.ok(state.calls.some(([from,to])=>to-from<16));
   const report=JSON.parse(state.map.get("spender_poll_status:"+spender));
   assert.equal(report.status,"ok");
   assert.equal(report.cursor,210);
 }finally{delete globalThis.__spenderFixture}
});
test("event inserted but outbox fails: next replay still sends the NEW approval once",async()=>{
 const {env,state}=prepareFixture({head:102,provider:async()=>[log],notifyFail:true});
 try{
   await pollSpenders(env);
   assert.equal(state.rules[0].cursor_block,100,"failed event must hold scan cursor");
   assert.equal(state.events.size,1);
   assert.equal(state.outbox.size,0);
   assert.equal(JSON.parse(state.map.get("spender_poll_status:"+spender)).stage,"processApproval");
   await pollSpenders(env);
   assert.equal(state.rules[0].cursor_block,102);
   assert.equal(state.outbox.size,1);
   assert.equal([...state.outbox.values()][0].template,"new_approval");
   assert.equal(state.noticesAttempted,2);
 }finally{delete globalThis.__spenderFixture}
});
test("Alchemy enrollment error cannot suppress Telegram new-approval notice",async()=>{
 const {env,state}=prepareFixture({head:102,provider:async()=>[log],watchFail:true});
 try{
   await pollSpenders(env);
   assert.equal(state.rules[0].cursor_block,102);
   assert.equal(state.outbox.size,1);
   assert.equal([...state.outbox.values()][0].payload.watch_status,"pending");
 }finally{delete globalThis.__spenderFixture}
});
test("backend exposes realtime authorization polling failures",async()=>{
 const {readFileSync}=await import("node:fs");
 const admin=readFileSync("src/admin.ts","utf8");
 const notification=readFileSync("src/notifications.ts","utf8");
 assert.match(admin,/spender_poll_status:/);
 assert.match(notification,/approvalAlert\|\|backedUpTransfer/);
 assert.match(notification,/sub.status==="pending"/);
});

test("Etherscan fallback rescues Alchemy HTTP 400 and preserves scanning progress",async()=>{
 const {env,state}=prepareFixture({head:160,provider:async()=>{throw Error("Ethereum RPC HTTP 400")}});
 env.ETHERSCAN_API_KEY="test-only";
 const original=globalThis.fetch;
 let requests=0;
 globalThis.fetch=async url=>{
   requests++;
   const u=new URL(url);
   assert.equal(u.searchParams.get("chainid"),"1");
   assert.equal(u.searchParams.get("topic0_2_opr"),"and");
   return {ok:true,json:async()=>({status:"0",message:"No records found",result:[]})};
 };
 try{
   await pollSpenders(env);
   // Backup provider keeps twelve recent blocks buffered for indexing safety.
   assert.equal(state.rules[0].cursor_block,148);
   assert.ok(requests>0);
   assert.equal(state.map.get("spender_poll_provider:"+spender),"etherscan");
   const status=JSON.parse(state.map.get("spender_poll_status:"+spender));
   assert.equal(status.status,"ok");
   assert.equal(status.provider,"etherscan");
 }finally{globalThis.fetch=original;delete globalThis.__spenderFixture}
});

test("same-value Approval transaction still emits exactly one change notification",async()=>{
 const {env,state}=prepareFixture({head:102,provider:async()=>[log]});
 state.allowances.set(owner+":"+spender,{amount_raw:"1000000"});
 try{
   await pollSpenders(env);
   assert.equal(state.events.size,1);
   assert.equal([...state.events.values()][0].event_type,"reconfirmed");
   assert.equal(state.outbox.size,1);
   const n=[...state.outbox.values()][0];
   assert.equal(n.template,"approval_change");
   assert.equal(n.payload.event_type,"reconfirmed");
   await pollSpenders(env);
   assert.equal(state.outbox.size,1);
 }finally{delete globalThis.__spenderFixture}
});

test("late-indexed Approval is recovered by overlapping completed-block recheck",async()=>{
 const {env,state}=prepareFixture({head:160,provider:async()=>{throw Error("RPC HTTP 400")}});
 env.ETHERSCAN_API_KEY="stub";
 const originalFetch=globalThis.fetch;
 let indexed=false;
 globalThis.fetch=async url=>{
   const u=new URL(url);
   const from=Number(u.searchParams.get("fromBlock")),to=Number(u.searchParams.get("toBlock"));
   const logs=indexed&&from<=102&&to>=102?[log]:[];
   return {ok:true,json:async()=>logs.length?{status:"1",message:"OK",result:logs}:{status:"0",message:"No records found",result:[]}};
 };
 try{
   await pollSpenders(env);
   assert.equal(state.rules[0].cursor_block,148);
   assert.equal(state.events.size,0);
   indexed=true;
   await pollSpenders(env);
   assert.equal(state.events.size,1);
   assert.equal(state.outbox.size,1);
   assert.equal(state.rules[0].cursor_block,148);
   await pollSpenders(env);
   assert.equal(state.outbox.size,1,"same blockchain event must not be notified twice");
 }finally{globalThis.fetch=originalFetch;delete globalThis.__spenderFixture}
});
