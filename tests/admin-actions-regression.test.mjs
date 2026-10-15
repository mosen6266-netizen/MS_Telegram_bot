import test from "node:test";
import assert from "node:assert/strict";
import {build} from "esbuild";

const mocks={
 "./core": [
  'export const addr=x=>/^0x[0-9a-f]{40}$/i.test(String(x||""))?String(x).toLowerCase():null;',
  'export const json=(v,status=200)=>Response.json(v,{status});',
  'export const audit=async(_env,actor,action,target)=>{globalThis.__adminFixture.audits.push({actor,action,target})};',
  'export const short=x=>x.slice(0,8);',
  'export const now=()=>new Date().toISOString();',
  'export const ensureWatch=async()=>true;',
  'export const removeWatch=async()=>true;'
 ].join("\n"),
 "./approval": 'export const addSpender=async(_env,...args)=>{globalThis.__adminFixture.spenderAdds.push(args)};',
 "./wallet-remarks": [
  'export const walletRemark=async(_env,_a,fallback)=>fallback;',
  'export const saveWalletRemark=async(_env,a,v)=>{globalThis.__adminFixture.remarks.push({a,v});return v};'
 ].join("\n"),
 "./spender-history": 'export const startSpenderHistory=async()=>{globalThis.__adminFixture.historyStarts++};',
 "./usage": [
  'export const usageSnapshot=async()=>[],usageSettings=async()=>({}),',
  'saveUsageSettings=async()=>{},collectUsage=async()=>({}),runUsageAlerts=async()=>{},queueUsageTest=async()=>"",USAGE_METERS=[];'
 ].join("\n").replace(/,\s*saveUsageSettings/,",saveUsageSettings"),
 "./notifications": 'export const flushOutbox=async()=>{},defaults={},templateCatalog=[];',
 "./admin-ui": 'export const ADMIN_HTML="";',
 "./setup": 'export const isAdmin=async()=>true,configEnv=async env=>env;'
};
const built=await build({
 entryPoints:["src/admin.ts"],bundle:true,platform:"node",format:"esm",write:false,logLevel:"silent",
 plugins:[{name:"admin-backend-fixture",setup(b){
  b.onResolve({filter:/^\.\//},args=>args.path in mocks?{path:args.path,namespace:"stub"}:null);
  b.onLoad({filter:/.*/,namespace:"stub"},args=>({contents:mocks[args.path],loader:"js"}));
 }}]
});
const {handleAdmin}=await import("data:text/javascript;base64,"+Buffer.from(built.outputFiles[0].text).toString("base64"));
const address="0x"+"1".repeat(40),spender="0x"+"2".repeat(40),group="-1001234567890";
function fakeState(){
 const st={wallets:new Map(),exclusions:new Set(),chats:new Map([[group,{active:1,chat_type:"supergroup"}]]),
 subs:new Map(),spenderRules:new Set(),writes:[],audits:[],remarks:[],spenderAdds:[],historyStarts:0,queue:[]};
 const env={
  TASKS:{send:async x=>st.queue.push(x)},
  DB:{
   prepare(sql){
    let args=[];
    return{
     bind(...v){args=v;return this;},
     async first(){
      if(sql.startsWith("SELECT deleted_at FROM wallets"))return st.wallets.has(args[0])?{deleted_at:st.wallets.get(args[0]).deleted_at}:null;
      if(sql.startsWith("SELECT 1 FROM wallets WHERE"))return st.wallets.has(args[0])?{1:1}:null;
      if(sql.startsWith("SELECT 1 FROM wallet_exclusions"))return st.exclusions.has(args[0])?{1:1}:null;
      if(sql.startsWith("SELECT active,chat_type FROM telegram_chats"))return st.chats.get(args[0])||null;
      if(sql.startsWith("SELECT 1 FROM spender_rules"))return st.spenderRules.has(args[0])?{1:1}:null;
      if(sql.startsWith("SELECT * FROM subscriptions WHERE"))return st.subs.get(args[1]+":"+args[0])||null;
      if(sql.startsWith("SELECT state FROM wallet_watches"))return{state:"active"};
      throw Error("Unmocked read: "+sql);
     },
     async run(){
      st.writes.push({sql,args});
      if(sql.startsWith("INSERT OR IGNORE INTO wallets"))st.wallets.set(args[0],{deleted_at:null});
      if(sql.startsWith("INSERT INTO subscriptions(chat_id,address"))st.subs.set(args[0]+":"+args[1],{chat_id:args[0],address:args[1],status:"pending",remark:args[2]});
      if(sql.startsWith("UPDATE subscriptions SET status=?")){
       const sub=st.subs.get(args[2]+":"+args[3]);if(sub)sub.status=args[0];
      }
      if(sql.startsWith("DELETE FROM wallet_exclusions"))st.exclusions.delete(args[0]);
      if(sql.startsWith("UPDATE wallets SET deleted_at=NULL")){const w=st.wallets.get(args[0]);if(w)w.deleted_at=null;}
      return{meta:{changes:1}};
     }
    };
   },
   batch:async statements=>{for(const x of statements)await x.run();return[];}
  }
 };
 globalThis.__adminFixture=st;return{st,env};
}
async function call(env,path,method,data){
 const res=await handleAdmin(new Request("https://bot.example"+path,{
  method,headers:{"Content-Type":"application/json"},body:method==="GET"?undefined:JSON.stringify(data||{})
 }),env,path);
 return{status:res.status,body:await res.json()};
}

test("invalid/disabled Telegram groups cannot leave orphan wallets",async()=>{
 const {st,env}=fakeState();
 const wrong=await call(env,"/api/wallets","POST",{address,chat_id:"-1009999999999"});
 assert.equal(wrong.status,400);
 assert.equal(st.writes.length,0);
 st.chats.get(group).active=0;
 const disabled=await call(env,"/api/wallets","POST",{address,chat_id:group});
 assert.equal(disabled.status,400);
 assert.equal(st.writes.length,0);
});

test("wallet global exclusion blocks re-add; valid add queues exactly one verification",async()=>{
 const {st,env}=fakeState();
 st.exclusions.add(address);
 assert.equal((await call(env,"/api/wallets","POST",{address,chat_id:group})).status,409);
 assert.equal(st.writes.length,0);
 st.exclusions.clear();
 assert.equal((await call(env,"/api/wallets","POST",{address,chat_id:group})).status,200);
 assert.equal(st.wallets.has(address),true);
 assert.equal(st.subs.get(group+":"+address).status,"pending");
 assert.deepEqual(st.queue,[{kind:"verify_admin",owner:address,chat_id:group}]);
});

test("subscription change rejects invalid status and deleted wallets before changing remark",async()=>{
 const {st,env}=fakeState();
 st.subs.set(group+":"+address,{address,chat_id:group,status:"removed",remark:"old"});
 const bad=await call(env,"/api/subscriptions","PATCH",{address,chat_id:group,remark:"new",status:"invalid"});
 assert.equal(bad.status,400);assert.equal(st.remarks.length,0);assert.equal(st.writes.length,0);
 st.exclusions.add(address);
 const excluded=await call(env,"/api/subscriptions","PATCH",{address,chat_id:group,remark:"new",status:"active"});
 assert.equal(excluded.status,409);assert.equal(st.remarks.length,0);assert.equal(st.writes.length,0);
});

test("valid subscription remark/status update commits after validation",async()=>{
 const {st,env}=fakeState();
 st.wallets.set(address,{deleted_at:null});
 st.subs.set(group+":"+address,{address,chat_id:group,status:"paused",remark:"old"});
 const r=await call(env,"/api/subscriptions","PATCH",{address,chat_id:group,remark:"legal name",status:"active"});
 assert.equal(r.status,200);
 assert.equal(st.remarks.length,1);assert.equal(st.remarks[0].v,"legal name");
 assert.equal(st.subs.get(group+":"+address).status,"active");
});

test("duplicate Spender create and malformed groups are rejected without mutation",async()=>{
 const {st,env}=fakeState();
 const bad=await call(env,"/api/spenders","POST",{spender,chat_ids:["invalid"]});
 assert.equal(bad.status,400);assert.equal(st.spenderAdds.length,0);
 st.spenderRules.add(spender);
 const duplicate=await call(env,"/api/spenders","POST",{spender,chat_ids:[group],remark:"Existing"});
 assert.equal(duplicate.status,409);assert.equal(st.spenderAdds.length,0);
 st.spenderRules.clear();
 const good=await call(env,"/api/spenders","POST",{spender,chat_ids:[group],remark:"New"});
 assert.equal(good.status,200);assert.equal(st.spenderAdds.length,1);assert.equal(st.historyStarts,1);
});

test("wallet restore has not-found and idempotent responses with no write",async()=>{
 const {st,env}=fakeState();
 const nonexistent=await call(env,"/api/wallets/restore","POST",{address});
 assert.equal(nonexistent.status,404);assert.equal(st.writes.length,0);
 st.wallets.set(address,{deleted_at:null});
 const current=await call(env,"/api/wallets/restore","POST",{address});
 assert.equal(current.status,200);assert.equal(current.body.already_restored,true);
 assert.equal(st.writes.length,0);
});
