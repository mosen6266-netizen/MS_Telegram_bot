import test from "node:test";
import assert from "node:assert/strict";
import {build} from "esbuild";
const script=await build({entryPoints:["src/notifications.ts"],bundle:true,write:false,platform:"node",format:"esm",logLevel:"silent",
 plugins:[{name:"fake-core",setup(b){
  b.onResolve({filter:/^\.\/core$/},()=>({path:"core",namespace:"mock"}));
  b.onLoad({filter:/.*/,namespace:"mock"},()=>({loader:"js",contents:
   'export const send=async(env,id,text)=>{globalThis.__sent.push({id,text});return {message_id:100}};export const buttons=()=>({});export const esc=x=>String(x);export const short=x=>x;export const now=()=>new Date().toISOString();export const notifyAdmin=async()=>{};export const increment=async()=>{};' }));
 }}]});
const {flushOutbox}=await import("data:text/javascript;base64,"+Buffer.from(script.outputFiles[0].text).toString("base64"));
class MockDb{
 constructor({sub="pending",flag=false,eligibility=true}){
 this.sub=sub;this.flag=flag;this.eligibility=eligibility;this.state="pending";
 this.row={id:1,attempts:0,chat_id:"-100100",address:"0x"+"a".repeat(40),template_key:"transfer",payload_json:JSON.stringify({asset:"USDT",direction:"转入",amount:"1",from_address:"0x"+"b".repeat(40),to_address:"0x"+"a".repeat(40),tx_hash:"0x"+"c".repeat(64),block_number:1000,rpc_fallback:flag})};
 }
 prepare(sql){const db=this;let args=[];
 return {
  bind(...v){args=v;return this;},
  async all(){if(sql.startsWith("SELECT * FROM outbox"))return {results:db.state==="pending"?[db.row]:[]};throw Error("Unexpected SELECT "+sql)},
  async first(){
   if(sql.includes("FROM subscriptions WHERE address=?"))return {status:db.sub,remark:"test wallet"};
   if(sql.includes("FROM wallet_watches w WHERE w.address=?"))return db.eligibility?{valid:1}:null;
   if(sql.includes("SELECT body FROM templates"))return null;
   throw Error("Unexpected SELECT "+sql);
  },
  async run(){
   if(sql.startsWith("UPDATE outbox SET state='sending'")){db.state="sending";return {meta:{changes:1}};}
   if(sql.startsWith("UPDATE outbox SET state='skipped'")){db.state="skipped";return {meta:{changes:1}};}
   if(sql.startsWith("UPDATE outbox SET state='sent'")){db.state="sent";return {meta:{changes:1}};}
   if(sql.startsWith("UPDATE outbox SET state='pending'")){db.state="pending";return {meta:{changes:1}};}
   if(sql.startsWith("UPDATE outbox SET state='failed'")){db.state="failed";return {meta:{changes:1}};}
   throw Error("Unexpected UPDATE "+sql);
  }
 }}
}
test("verified RPC fallback sends pending wallet's transfer notice",async()=>{
 globalThis.__sent=[];
 try{
  const db=new MockDb({flag:true});
  await flushOutbox({DB:db},10);
  assert.equal(db.state,"sent");
  assert.equal(globalThis.__sent.length,1);
 }finally{delete globalThis.__sent;}
});
test("unflagged pending transfer and explicitly removed backup wallet stay blocked",async()=>{
 globalThis.__sent=[];
 try{
  for(const opts of [{flag:false,eligibility:true},{flag:true,eligibility:false}]){
   const db=new MockDb(opts);await flushOutbox({DB:db},10);
   assert.equal(db.state,"skipped");
  }
  assert.equal(globalThis.__sent.length,0);
 }finally{delete globalThis.__sent;}
});
