import test from "node:test";
import assert from "node:assert/strict";
import {build} from "esbuild";

const mockCore=[
  'export const USDT="0xdac17f958d2ee523a2206206994597c13d831ec7";',
  'export const USDC="0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48";',
  'export const addr=s=>/^0x[a-fA-F0-9]{40}$/.test(String(s))?String(s).toLowerCase():null;',
  'export const receiptSuccess=async(_env,hash)=>globalThis.__transferFixture.receipt(hash);',
  'export const queueNotice=async(_env,obj)=>globalThis.__transferFixture.notice(obj);',
  'export const increment=async()=>{globalThis.__transferFixture.increments++};'
].join("\n");
const bundled=await build({
  entryPoints:["src/transfers.ts"],bundle:true,platform:"node",format:"esm",write:false,logLevel:"silent",
  plugins:[{name:"chain-fixture",setup(b){
    b.onResolve({filter:/^\.\/core$/},()=>({path:"core",namespace:"fixture"}));
    b.onLoad({filter:/.*/,namespace:"fixture"},()=>({loader:"js",contents:mockCore}));
  }}]
});
const {processActivity}=await import("data:text/javascript;base64,"+Buffer.from(bundled.outputFiles[0].text).toString("base64"));
const w=i=>"0x"+i.toString(16).padStart(40,"0");
const h="0x"+"a".repeat(64),A=w(10),B=w(20);
const USDT="0xdac17f958d2ee523a2206206994597c13d831ec7";
const USDC="0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48";

function fixture(watched=[A]){
  const db={events:new Map(),notices:new Map(),failNotice:false};
  const context={
    DB:{
      prepare(sql){let args=[];return{
        bind(...values){args=values;return this;},
        async first(){
          if(sql.startsWith("SELECT state FROM wallet_watches"))return watched.includes(args[0])?{state:"active"}:null;
          throw Error("Unexpected first: "+sql);
        },
        async all(){
          if(sql.startsWith("SELECT chat_id FROM subscriptions"))return{results:watched.includes(args[0])?[{chat_id:"-1001"}]:[]};
          throw Error("Unexpected all: "+sql);
        },
        async run(){
          if(sql.startsWith("INSERT OR IGNORE INTO transfer_events")){
            if(db.events.has(args[0]))return{meta:{changes:0}};
            db.events.set(args[0],{address:args[1],asset:args[2],direction:args[3],amount:args[4]});
            return{meta:{changes:1}};
          }
          throw Error("Unexpected write: "+sql);
        }
      }}
    }
  };
  globalThis.__transferFixture={
    increments:0,receipt:async()=>true,
    notice:async obj=>{
      if(db.failNotice){db.failNotice=false;throw Error("Simulated D1 outbox failure");}
      if(!db.notices.has(obj.dedup))db.notices.set(obj.dedup,obj);
    }
  };
  return {db,context};
}
const eth=(from=A,to=B)=>({category:"external",fromAddress:from,toAddress:to,hash:h,blockNum:"0x100",value:1.5});
const token=(contract=USDT,category="token")=>({category,fromAddress:B,toAddress:A,hash:h,blockNum:"0x100",value:7.5,rawContract:{address:contract,rawValue:"0x7270e0"},log:{logIndex:"0x2",blockHash:"0x"+"b".repeat(64)}});

test("Alchemy token-form USDT and USDC activity produce transfer notices",async()=>{
  const {db,context}=fixture();
  await processActivity(context,{event:{network:"ETH_MAINNET",activity:[token(USDT),{...token(USDC),log:{logIndex:"0x3"}}]}});
  assert.equal(db.events.size,2);
  assert.deepEqual([...db.events.values()].map(e=>e.asset).sort(),["USDC","USDT"]);
  assert.ok([...db.notices.values()].every(n=>n.template==="transfer"&&n.address===A));
  assert.ok([...db.notices.values()].every(n=>n.payload.amount==="7.5"));
  delete globalThis.__transferFixture;
});

test("receipt indexing delay retries instead of discarding activity",async()=>{
  const {db,context}=fixture();
  globalThis.__transferFixture.receipt=async()=>null;
  await assert.rejects(()=>processActivity(context,{event:{network:"ETH_MAINNET",activity:[eth()]}}),/receipt not indexed yet/);
  assert.equal(db.events.size,0);
  delete globalThis.__transferFixture;
});

test("outbox insert failure is repaired on retry after event was saved",async()=>{
  const {db,context}=fixture();
  db.failNotice=true;
  const payload={event:{network:"ETH_MAINNET",activity:[eth()]}};
  await assert.rejects(()=>processActivity(context,payload),/Simulated D1/);
  assert.equal(db.events.size,1);assert.equal(db.notices.size,0);
  await processActivity(context,payload);
  await processActivity(context,payload);
  assert.equal(db.events.size,1);assert.equal(db.notices.size,1);
  assert.equal(globalThis.__transferFixture.increments,1);
  delete globalThis.__transferFixture;
});

test("same USDT log from webhook and recovery receives one notice",async()=>{
  const {db,context}=fixture();
  const webhook=token(USDT,"token");
  const replay={...token(USDT,"erc20"),log:undefined,uniqueId:h+":log:2",rawContract:{address:USDT,value:"0x7270e0"}};
  await processActivity(context,{event:{network:"ETH_MAINNET",activity:[webhook]}});
  await processActivity(context,{network:"ETH_MAINNET",event:{activity:[replay]}});
  assert.equal(db.events.size,1);
  assert.equal(db.notices.size,1);
  delete globalThis.__transferFixture;
});

test("ETH incoming/outgoing split; self transfers once; unrelated tokens ignored",async()=>{
  const {db,context}=fixture([A,B]);
  await processActivity(context,{event:{network:"ETH_MAINNET",activity:[eth(),{...eth(A,A),hash:"0x"+"b".repeat(64)},token(w(99))]}});
  assert.equal(db.events.size,3);
  assert.deepEqual([...db.events.values()].map(e=>e.direction).sort(),["自转","转入","转出"]);
  assert.equal(db.notices.size,3);
  delete globalThis.__transferFixture;
});

test("failed receipts and wrong-chain activity never create a transfer",async()=>{
  const {db,context}=fixture();
  globalThis.__transferFixture.receipt=async()=>false;
  await processActivity(context,{event:{network:"ETH_MAINNET",activity:[eth()]}});
  assert.equal(db.events.size,0);
  await assert.rejects(()=>processActivity(context,{network:"BASE_MAINNET",event:{activity:[eth()]}}),/source network/);
  delete globalThis.__transferFixture;
});

test("wallet gap scanning is paced for 212 wallets",async()=>{
  const {readFileSync}=await import("node:fs");
  const recovery=readFileSync("src/recovery.ts","utf8");
  const index=readFileSync("src/index.ts","utf8");
  assert.match(recovery,/maxWallets=8/);
  assert.match(recovery,/last_block\+600/);
  assert.match(recovery,/last_error IS NULL OR c\.checked_at IS NULL/);
  assert.match(index,/scanWalletGaps\(env,8\)/);
});
