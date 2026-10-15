import test from "node:test";
import assert from "node:assert/strict";
import {build} from "esbuild";

// Bundle the real verification function with only its chain/RPC dependency mocked.
// The SQL scheduling and cursor logic below is taken from the actual source.
const bundle=await build({
  entryPoints:["src/spender-history.ts"],bundle:true,write:false,platform:"node",format:"esm",logLevel:"silent",
  plugins:[{name:"mock-chain",setup(b){
    b.onResolve({filter:/^\.\/core$/},()=>({path:"chain",namespace:"mock-chain"}));
    b.onLoad({filter:/.*/,namespace:"mock-chain"},()=>({loader:"js",contents:`
      export const USDT="0x0000000000000000000000000000000000000000";
      export const APPROVAL_TOPIC="0x00";
      export const toTopic=()=>"",fromTopic=()=>"",addr=x=>x;
      export const blockNumber=async()=>1,recordUsage=async()=>{};
      export const allowance=(env,owner,spender)=>globalThis.__historyAllowance(owner,spender);
    `}));
  }}]
});
const {verifyHistoricalAllowances}=await import("data:text/javascript;base64,"+Buffer.from(bundle.outputFiles[0].text).toString("base64"));

class MemoryD1 {
  constructor(entries){this.entries=entries;this.state=new Map();}
  prepare(sql){
    const db=this;let args=[];
    return {
      bind(...values){args=values;return this;},
      async first(){
        if(sql.includes("FROM runtime_state"))return db.state.has(args[0])?{value:db.state.get(args[0])}:null;
        throw Error("Unexpected SELECT: "+sql);
      },
      async all(){
        if(!sql.startsWith("SELECT h.spender,h.owner,h.latest_event_block"))throw Error("Unexpected list query");
        let rows=db.entries.filter(x=>x.verify_status==="pending").sort((a,b)=>b.latest_event_block-a.latest_event_block||a.spender.localeCompare(b.spender)||a.owner.localeCompare(b.owner));
        if(sql.includes("h.latest_event_block<?")){
          const [block,,spender,,owner,limit]=args;
          rows=rows.filter(x=>x.latest_event_block<block||(x.latest_event_block===block&&(x.spender>spender||(x.spender===spender&&x.owner>owner))));
          return {results:rows.slice(0,limit)};
        }
        return {results:rows.slice(0,args[0])};
      },
      async run(){
        if(sql.startsWith("INSERT INTO runtime_state")){db.state.set(args[0],args[1]);return;}
        if(sql.startsWith("DELETE FROM runtime_state")){db.state.delete(args[0]);return;}
        if(sql.startsWith("UPDATE spender_history_addresses")){
          const row=db.entries.find(x=>x.spender===args[2]&&x.owner===args[3]);
          if(row&&row.verify_status==="pending")row.verify_status=args[1];
          return;
        }
        throw Error("Unexpected write: "+sql);
      }
    };
  }
}

test("one failing historical Owner cannot permanently block later Owners",async()=>{
  const spender="0x"+"a".repeat(40);
  const bad="0x"+"1".repeat(40),good="0x"+"2".repeat(40);
  const db=new MemoryD1([
    {spender,owner:bad,latest_event_block:130,verify_status:"pending"},
    {spender,owner:good,latest_event_block:120,verify_status:"pending"}
  ]);
  let failures=0;
  globalThis.__historyAllowance=async owner=>{
    if(owner===bad){failures++;throw Error("wallet-specific provider error");}
    return 1n;
  };
  try{
    assert.equal((await verifyHistoricalAllowances({DB:db},1)).verified,0);
    assert.equal((await verifyHistoricalAllowances({DB:db},1)).verified,1);
    assert.equal(db.entries[1].verify_status,"active");
    assert.equal(db.entries[0].verify_status,"pending");
    await verifyHistoricalAllowances({DB:db},1);
    assert.equal(failures,2,"failed addresses must be retried after one sweep");
  }finally{delete globalThis.__historyAllowance;}
});

test("live Spender scan treats temporarily missing receipts as retryable",async()=>{
  const {readFileSync}=await import("node:fs");
  const source=readFileSync("src/approval.ts","utf8");
  assert.match(source,/if\(ok===null\)throw Error/);
  assert.match(source,/if\(ok===false\)return/);
  assert.match(source,/UPDATE spender_rules SET cursor_block/);
});

test("generic watcher retry excludes manually removed and unsubscribed wallets",async()=>{
  const {readFileSync}=await import("node:fs");
  const source=readFileSync("src/index.ts","utf8");
  assert.match(source,/SELECT 1 FROM wallet_exclusions x WHERE x.address=w.address/);
  assert.match(source,/v.deleted_at IS NOT NULL/);
  assert.match(source,/s.status IN \('active','pending'\)/);
});
