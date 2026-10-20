import test from "node:test";
import assert from "node:assert/strict";
import {build} from "esbuild";

const compiled=await build({entryPoints:["src/telegram.ts"],bundle:true,write:false,platform:"node",format:"esm",logLevel:"silent",
  plugins:[{name:"remark-mocks",setup(b){
    b.onResolve({filter:/^\.\/core$/},()=>({path:"core",namespace:"mock"}));
    b.onResolve({filter:/^\.\/approval$/},()=>({path:"approval",namespace:"mock"}));
    b.onResolve({filter:/^\.\/cleanup$/},()=>({path:"cleanup",namespace:"mock"}));
    b.onResolve({filter:/^\.\/notifications$/},()=>({path:"notifications",namespace:"mock"}));
    b.onResolve({filter:/^\.\/wallet-remarks$/},()=>({path:"wallet-remarks",namespace:"mock"}));
    b.onLoad({filter:/.*/,namespace:"mock"},(args)=>({loader:"js",contents:{
      core:'export const addr=x=>/^0x[0-9a-f]{40}$/.test(String(x))?String(x):null;export const telegram=async(e,m,b)=>globalThis.__tg(m,b);export const send=async(e,id,txt,buttons)=>globalThis.__send(id,txt,buttons);export const buttons=a=>({address:a});export const now=()=>new Date().toISOString();export const trunc=(s,n)=>String(s).slice(0,n);export const increment=async()=>{};export const esc=x=>x;',
      approval:'export const checkOwner=async()=>{};',
      cleanup:'export const scheduleMessageDeletion=async()=>{};export const finishRemarkCleanup=async()=>{};',
      notifications:'export const renderTemplate=async(e,k,chat,v)=>k+":"+JSON.stringify(v||{});',
      "wallet-remarks":'export const saveWalletRemark=async(e,a,r)=>{globalThis.__savedRemark=[a,r];};'
    }[args.path]}));
  }}]});
const {handleTelegram}=await import("data:text/javascript;base64,"+Buffer.from(compiled.outputFiles[0].text).toString("base64"));

class Db {
  constructor(status){this.status=status;this.remark="待备注";this.session=null;}
  prepare(sql){
    let args=[];const db=this;
    return {
      bind(...v){args=v;return this;},
      async first(){
        if(sql.includes("FROM subscriptions WHERE chat_id=? AND address=?"))return ["active","pending"].includes(db.status)?{remark:db.remark,remark_version:0}:null;
        if(sql.includes("FROM remark_sessions"))return db.session;
        if(sql.includes("FROM telegram_message_cleanup"))return null;
        throw Error("Unexpected SELECT: "+sql);
      },
      async run(){
        if(sql.startsWith("INSERT OR REPLACE INTO remark_sessions")){db.session={address:args[3]};return {meta:{changes:1}};}
        if(sql.startsWith("DELETE FROM remark_sessions")){db.session=null;return {meta:{changes:1}};}
        if(sql.startsWith("UPDATE subscriptions SET remark=")){
          if(!["active","pending"].includes(db.status))return {meta:{changes:0}};
          db.remark=args[0];return {meta:{changes:1}};
        }
        if(sql.startsWith("INSERT INTO telegram_users") || sql.startsWith("INSERT INTO telegram_chats"))return {meta:{changes:1}};
        if(sql.startsWith("INSERT INTO remark_edits"))return {meta:{changes:1}};
        throw Error("Unexpected write: "+sql);
      }
    };
  }
}
const wallet="0x"+"a".repeat(40),chat=-1003787029137;
test("pending and active subscriptions can open the remark editor and save without enabling monitoring",async()=>{
  let sends=[],replies=[];
  globalThis.__tg=async(method,body)=>{replies.push({method,body});return method==="getChatMember"?{status:"member"}:{};};
  globalThis.__send=async(...args)=>{sends.push(args);return {message_id:123};};
  try{
    for(const status of ["pending","active"]){
      sends=[];replies=[];const db=new Db(status);
      await handleTelegram({DB:db},{callback_query:{id:"callback",data:"remark:"+wallet,from:{id:7,first_name:"Test"},message:{chat:{id:chat,type:"supergroup"}}}});
      assert.ok(sends.some(x=>x[1].startsWith("remark_prompt:")),status+" should open editor");
      assert.ok(replies.some(x=>x.method==="answerCallbackQuery"));
      assert.equal(db.status,status,"remark updates must not change enrollment state");
      await handleTelegram({DB:db},{message:{from:{id:7,first_name:"Test"},chat:{id:chat,type:"supergroup"},text:"张三",message_id:201,reply_to_message:{message_id:123}}});
      assert.equal(db.remark,"张三");
      assert.equal(db.status,status);
    }
  }finally{delete globalThis.__tg;delete globalThis.__send;delete globalThis.__savedRemark;}
});

test("removed subscriptions show a useful Telegram error instead of silently ignoring clicks",async()=>{
  let responses=[],sends=0;
  globalThis.__tg=async(method,body)=>{if(method==="getChatMember")return {status:"member"};if(method==="answerCallbackQuery")responses.push(body);return {}};
  globalThis.__send=async()=>{sends++;return {message_id:1}};
  try{
    await handleTelegram({DB:new Db("removed")},{callback_query:{id:"callback",data:"remark:"+wallet,from:{id:7},message:{chat:{id:chat,type:"supergroup"}}}});
    assert.equal(sends,0);
    assert.equal(responses[0].show_alert,true);
    assert.match(responses[0].text,/未登记|移除/);
  }finally{delete globalThis.__tg;delete globalThis.__send;}
});

test("failure to verify Telegram membership clearly asks to promote the bot",async()=>{
  let responses=[];
  globalThis.__tg=async(method,body)=>{if(method==="getChatMember")throw Error("not enough rights");if(method==="answerCallbackQuery")responses.push(body);return {}};
  globalThis.__send=async()=>{throw Error("unexpected send")};
  try{
    await handleTelegram({DB:new Db("pending")},{callback_query:{id:"callback",data:"remark:"+wallet,from:{id:7},message:{chat:{id:chat,type:"supergroup"}}}});
    assert.equal(responses[0].show_alert,true);assert.match(responses[0].text,/群管理员/);
  }finally{delete globalThis.__tg;delete globalThis.__send;}
});
