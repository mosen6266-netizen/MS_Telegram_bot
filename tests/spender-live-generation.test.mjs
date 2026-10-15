import test from "node:test";
import assert from "node:assert/strict";
import {readFileSync,readdirSync} from "node:fs";
import {buildSync} from "esbuild";
import {Miniflare,convertV4MiniflareOptions} from "miniflare";

const compiled=buildSync({stdin:{contents:'export {pollSpenders} from "./src/approval"; export {APPROVAL_TOPIC,toTopic} from "./src/core";',
 resolveDir:process.cwd(),loader:"ts"},bundle:true,format:"esm",platform:"node",write:false}).outputFiles[0].text;
const {pollSpenders,APPROVAL_TOPIC,toTopic}=await import("data:text/javascript;base64,"+Buffer.from(compiled).toString("base64"));
const wallet=i=>"0x"+i.toString(16).padStart(40,"0");

test("an old realtime RPC callback cannot create approval records after the Spender was deleted and recreated",async()=>{
 const mf=new Miniflare(convertV4MiniflareOptions({name:"spender-live-generation-test",modules:true,
  script:'export default {fetch(){return new Response("ok")}}',d1Databases:{DB:"spender-live-generation"}}));
 const saved=globalThis.fetch;
 try{
  const DB=await mf.getD1Database("DB");
  for(const file of readdirSync("migrations").filter(x=>x.endsWith(".sql")).sort()){
   const sql=readFileSync("migrations/"+file,"utf8");
   for(const statement of sql.split(";").map(x=>x.trim()).filter(Boolean))await DB.prepare(statement).run();
  }
  const spender=wallet(100),owner=wallet(200),old="old-version",fresh="fresh-version",hash="0x"+"ab".repeat(32);
  await DB.prepare("INSERT INTO spender_rules(spender,remark,enabled,start_block,cursor_block,generation) VALUES(?,'test',1,50,50,?)").bind(spender,old).run();
  let rotated=false;
  globalThis.fetch=async(url,options)=>{
   assert.equal(String(url),"https://rpc.test.invalid");
   const {method}=JSON.parse(options.body);
   if(method==="eth_blockNumber")return Response.json({jsonrpc:"2.0",id:1,result:"0x34"});
   if(method==="eth_getLogs")return Response.json({jsonrpc:"2.0",id:1,result:[{
     topics:[APPROVAL_TOPIC,toTopic(owner),toTopic(spender)],transactionHash:hash,logIndex:"0x0",
     blockNumber:"0x33",data:"0x"+"0".repeat(63)+"1"
   }]});
   if(method==="eth_getTransactionReceipt")return Response.json({jsonrpc:"2.0",id:1,result:{status:"0x1"}});
   if(method==="eth_call"){
    if(!rotated){
     await DB.prepare("DELETE FROM spender_rules WHERE spender=?").bind(spender).run();
     await DB.prepare("INSERT INTO spender_rules(spender,remark,enabled,start_block,cursor_block,generation) VALUES(?,'new',1,80,80,?)").bind(spender,fresh).run();
     rotated=true;
    }
    return Response.json({jsonrpc:"2.0",id:1,result:"0x1"});
   }
   throw Error("unexpected RPC method "+method);
  };
  await pollSpenders({DB,ALCHEMY_RPC_URL:"https://rpc.test.invalid"});
  assert.ok(rotated,"the rule was replaced during the external allowance check");
  assert.equal((await DB.prepare("SELECT cursor_block FROM spender_rules WHERE spender=?").bind(spender).first()).cursor_block,80);
  assert.equal((await DB.prepare("SELECT count(*) n FROM approval_events").first()).n,0);
  assert.equal((await DB.prepare("SELECT count(*) n FROM allowances").first()).n,0);
  assert.equal((await DB.prepare("SELECT count(*) n FROM spender_history_addresses").first()).n,0);
 }finally{globalThis.fetch=saved;await mf.dispose()}
});
