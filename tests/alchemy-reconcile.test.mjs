import test from "node:test";
import assert from "node:assert/strict";
import {build} from "esbuild";

const output=await build({entryPoints:["src/alchemy-reconcile.ts"],bundle:true,platform:"node",format:"esm",write:false,logLevel:"silent"});
const {reconcileAlchemyAddresses}=await import("data:text/javascript;base64,"+Buffer.from(output.outputFiles[0].text).toString("base64"));

class FakeDb{
  constructor(addresses){this.state=new Map();this.addresses=addresses.map(address=>({address,state:"active",subscription:"active",enrollment:"active"}));}
  prepare(sql){
    let args=[];const db=this;
    return {
      bind(...v){args=v;return this;},
      async first(){
        if(sql.includes("SELECT value FROM runtime_state"))return db.state.has(args[0])?{value:db.state.get(args[0])}:null;
        throw Error("Unexpected first: "+sql);
      },
      async all(){
        if(sql.startsWith("SELECT w.address FROM wallet_watches"))return {results:db.addresses.filter(a=>a.state==="active"&&a.subscription==="active").map(a=>({address:a.address}))};
        throw Error("Unexpected all: "+sql);
      },
      async run(){
        if(sql.startsWith("INSERT OR IGNORE INTO runtime_state")){
          if(db.state.has(args[0]))return {meta:{changes:0}};
          db.state.set(args[0],args[1]);return {meta:{changes:1}};
        }
        if(sql.startsWith("INSERT INTO runtime_state")){db.state.set(args[0],args[1]);return {meta:{changes:1}};}
        if(sql.startsWith("DELETE FROM runtime_state")){db.state.delete(args[0]);return {meta:{changes:1}};}
        if(sql.startsWith("UPDATE wallet_watches")){
          const row=db.addresses.find(r=>r.address===args[0]);if(row&&row.state==="active")row.state="pending";return {meta:{changes:1}};
        }
        if(sql.startsWith("UPDATE subscriptions")){
          const row=db.addresses.find(r=>r.address===args[0]);if(row&&row.subscription==="active")row.subscription="pending";return {meta:{changes:1}};
        }
        if(sql.startsWith("UPDATE spender_history_monitor_enrollments")){
          const row=db.addresses.find(r=>r.address===args[0]);if(row&&row.enrollment==="active")row.enrollment="retrying";return {meta:{changes:1}};
        }
        throw Error("Unexpected run: "+sql);
      }
    };
  }
  async batch(statements){for(const s of statements)await s.run();}
}
const wallet=i=>"0x"+i.toString(16).padStart(40,"0");
const env=addresses=>({DB:new FakeDb(addresses),ALCHEMY_ACTIVITY_WEBHOOK_ID:"test-webhook",ALCHEMY_NOTIFY_TOKEN:"test-token",PUBLIC_BASE_URL:"https://bot.example"});
const meta=()=>({ok:true,json:async()=>({data:[{id:"test-webhook",is_active:true,network:"ETH_MAINNET",webhook_type:"ADDRESS_ACTIVITY",webhook_url:"https://bot.example/webhooks/alchemy"}]})});

test("Alchemy reconciliation detects missing addresses, PATCHes only those, and verifies again",async()=>{
  const addresses=[wallet(1),wallet(2),wallet(3)],local=env(addresses);
  let remote=new Set([addresses[0],addresses[1],wallet(99)]);
  const calls=[];const original=globalThis.fetch;
  globalThis.fetch=async (url,options={})=>{
    const method=options.method||"GET";calls.push({method,url:String(url),body:options.body});
    if(String(url).includes("/api/team-webhooks"))return meta();
    if(method==="GET")return {ok:true,json:async()=>({data:[...remote],pagination:{total_count:remote.size,cursors:{}}})};
    const body=JSON.parse(options.body);
    for(const address of body.addresses_to_add)remote.add(address);
    assert.deepEqual(body.addresses_to_remove,[]);
    return {ok:true};
  };
  try{
    const result=await reconcileAlchemyAddresses(local);
    assert.equal(result.status,"repaired");assert.equal(result.missing_before,1);assert.equal(result.missing_after,0);
    assert.equal(calls.filter(x=>x.method==="PATCH").length,1);
    assert.deepEqual(JSON.parse(calls.find(x=>x.method==="PATCH").body).addresses_to_add,[addresses[2]]);
    assert.ok(remote.has(wallet(99)),"must not delete unknown addresses");
    assert.equal(local.DB.addresses[2].state,"active");
    assert.equal(JSON.parse(local.DB.state.get("alchemy_address_reconcile_result")).status,"repaired");
    assert.deepEqual((await reconcileAlchemyAddresses(local)),{skipped:"not_due"});
  }finally{globalThis.fetch=original;}
});

test("uncertain Alchemy API errors do not switch currently monitored wallets off",async()=>{
  const local=env([wallet(1)]),old=globalThis.fetch;
  globalThis.fetch=async()=>({ok:false,status:503});
  try{
    const result=await reconcileAlchemyAddresses(local);
    assert.equal(result.status,"error");
    assert.equal(local.DB.addresses[0].state,"active");
    assert.equal(local.DB.addresses[0].subscription,"active");
  }finally{globalThis.fetch=old;}
});

test("Alchemy lag remains an incomplete warning without disabling RPC recovery",async()=>{
  const local=env([wallet(1)]),old=globalThis.fetch;
  globalThis.fetch=async (url,options={})=>String(url).includes("/api/team-webhooks")?meta():options.method==="PATCH"
    ? {ok:true}
    : {ok:true,json:async()=>({data:[],pagination:{total_count:0,cursors:{}}})};
  try{
    const result=await reconcileAlchemyAddresses(local);
    assert.equal(result.status,"incomplete");
    assert.equal(local.DB.addresses[0].state,"active");
    assert.equal(local.DB.addresses[0].subscription,"active");
    assert.equal(local.DB.addresses[0].enrollment,"active");
  }finally{globalThis.fetch=old;}
});
