import test from "node:test";
import assert from "node:assert/strict";
import {readFileSync,readdirSync} from "node:fs";
import {buildSync} from "esbuild";
import {Miniflare,convertV4MiniflareOptions} from "miniflare";

const compiled=buildSync({stdin:{contents:
 'export {enrollHistoricalOwners} from "./src/spender-enroll"; export {withAlchemyMutationLease,AlchemyMutationBusy} from "./src/alchemy-mutation-lease";',
 resolveDir:process.cwd(),loader:"ts"},bundle:true,platform:"node",format:"esm",write:false}).outputFiles[0].text;
const {enrollHistoricalOwners,withAlchemyMutationLease,AlchemyMutationBusy}
 =await import("data:text/javascript;base64,"+Buffer.from(compiled).toString("base64"));
const wallet=i=>"0x"+i.toString(16).padStart(40,"0");

async function setup(name){
 const mf=new Miniflare(convertV4MiniflareOptions({name,modules:true,
 script:'export default {fetch(){return new Response("ok")}}',d1Databases:{DB:name}}));
 const DB=await mf.getD1Database("DB");
 for(const file of readdirSync("migrations").filter(x=>x.endsWith(".sql")).sort()){
  for(const statement of readFileSync("migrations/"+file,"utf8").split(";").map(x=>x.trim()).filter(Boolean))
   await DB.prepare(statement).run();
 }
 const spender=wallet(99),owner=wallet(1),chat="-1009999999999";
 await DB.prepare("INSERT INTO spender_rules(spender,remark,enabled,start_block,cursor_block,generation) VALUES(?,'race',1,50,50,'generation-1')").bind(spender).run();
 await DB.prepare("INSERT INTO spender_routes(spender,chat_id) VALUES(?,?)").bind(spender,chat).run();
 await DB.prepare("INSERT INTO telegram_chats(chat_id,title,chat_type,active) VALUES(?,'test','supergroup',1)").bind(chat).run();
 await DB.prepare("INSERT INTO spender_history_addresses(spender,owner,first_seen_block,latest_event_block) VALUES(?,?,10,10)").bind(spender,owner).run();
 const env={DB,ALCHEMY_ACTIVITY_WEBHOOK_ID:"wh_existing",ALCHEMY_NOTIFY_TOKEN:"notify-test",
  ALCHEMY_RPC_URL:"https://rpc.example.invalid"};
 return {mf,DB,env,spender,owner};
}

test("an in-flight historical Alchemy batch blocks concurrent deletion until remote/local commits finish",async()=>{
 const {mf,DB,env,spender,owner}=await setup("spender-sync-race");
 const saved=globalThis.fetch;
 let release,entered;
 const waiting=new Promise(r=>release=r),started=new Promise(r=>entered=r);
 let updates=0;
 try{
  globalThis.fetch=async(url,options)=>{
   if(url==="https://rpc.example.invalid")return Response.json({jsonrpc:"2.0",id:1,result:"0x100"});
   assert.equal(url,"https://dashboard.alchemy.com/api/update-webhook-addresses");
   updates++;entered();await waiting;
   return Response.json({success:true});
  };
  const pending=enrollHistoricalOwners(env,20);
  await started;
  await assert.rejects(withAlchemyMutationLease(env,async()=>{
    await DB.prepare("DELETE FROM spender_rules WHERE spender=?").bind(spender).run();
  }),error=>error instanceof AlchemyMutationBusy);
  assert.equal((await DB.prepare("SELECT COUNT(*) n FROM spender_rules").first()).n,1);
  release();
  const result=await pending;
  assert.equal(result.synced,1);
  assert.equal(updates,1);
  assert.equal((await DB.prepare("SELECT state FROM wallet_watches WHERE address=?").bind(owner).first()).state,"active");
  await withAlchemyMutationLease(env,async()=>{
   await DB.prepare("DELETE FROM spender_routes WHERE spender=?").bind(spender).run();
   await DB.prepare("DELETE FROM spender_rules WHERE spender=?").bind(spender).run();
  });
  assert.equal((await DB.prepare("SELECT COUNT(*) n FROM spender_rules").first()).n,0);
 }finally{globalThis.fetch=saved;release?.();await mf.dispose()}
});

test("deletion after history selection but before Alchemy PATCH prevents remote orphan enrollment",async()=>{
 const {mf,DB,env,spender,owner}=await setup("spender-preflight-race");
 const saved=globalThis.fetch;
 let patches=0,deleted=false;
 try{
  globalThis.fetch=async(url,options)=>{
   if(url==="https://rpc.example.invalid"){
    if(!deleted){
      deleted=true;
      await withAlchemyMutationLease(env,async()=>{
       await DB.prepare("DELETE FROM spender_routes WHERE spender=?").bind(spender).run();
       await DB.prepare("DELETE FROM spender_history_addresses WHERE spender=?").bind(spender).run();
       await DB.prepare("DELETE FROM spender_history_monitor_enrollments WHERE spender=?").bind(spender).run();
       await DB.prepare("DELETE FROM spender_rules WHERE spender=?").bind(spender).run();
      });
    }
    return Response.json({jsonrpc:"2.0",id:1,result:"0x100"});
   }
   patches++;
   return Response.json({success:true});
  };
  const outcome=await enrollHistoricalOwners(env,20);
  assert.equal(deleted,true);
  assert.equal(patches,0,"no PATCH is allowed after the rule was deleted");
  assert.equal(outcome.skipped,"spender_removed");
  assert.notEqual((await DB.prepare("SELECT state FROM wallet_watches WHERE address=?").bind(owner).first())?.state,"active");
 }finally{globalThis.fetch=saved;await mf.dispose()}
});
