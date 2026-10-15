import test from "node:test";
import assert from "node:assert/strict";
import {readFileSync,readdirSync} from "node:fs";
import {buildSync} from "esbuild";
import {Miniflare,convertV4MiniflareOptions} from "miniflare";

const compiled=buildSync({stdin:{contents:'export {startSpenderHistory,scanSpenderHistories,recordSpenderLiveApproval} from "./src/spender-history"; export {APPROVAL_TOPIC,toTopic} from "./src/core";',
 resolveDir:process.cwd(),loader:"ts"},bundle:true,format:"esm",platform:"node",write:false}).outputFiles[0].text;
const {startSpenderHistory,scanSpenderHistories,recordSpenderLiveApproval,APPROVAL_TOPIC,toTopic}
 =await import("data:text/javascript;base64,"+Buffer.from(compiled).toString("base64"));
const addr=i=>"0x"+i.toString(16).padStart(40,"0");

test("deleting and re-adding the same Spender while Etherscan is pending cannot resurrect old history",async()=>{
 const mf=new Miniflare(convertV4MiniflareOptions({name:"spender-generation-test",modules:true,
 script:'export default {fetch(){return new Response("ok")}}',d1Databases:{DB:"spender-generation"}}));
 const originalFetch=globalThis.fetch;
 try{
  const DB=await mf.getD1Database("DB");
  for(const file of readdirSync("migrations").filter(x=>x.endsWith(".sql")).sort()){
   const sql=readFileSync("migrations/"+file,"utf8");
   for(const stmt of sql.split(";").map(x=>x.trim()).filter(Boolean))await DB.prepare(stmt).run();
  }
  const spender=addr(100),owner=addr(200),g1="generation-old",g2="generation-new";
  const tx="0x"+"aa".repeat(32),log={
   topics:[APPROVAL_TOPIC,toTopic(owner),toTopic(spender)],
   blockNumber:"0x15",transactionHash:tx,data:"0x"+"0".repeat(63)+"1",
   logIndex:"0x0"
  };
  await DB.prepare("INSERT INTO spender_rules(spender,remark,enabled,start_block,cursor_block,generation) VALUES(?,'old',1,50,50,?)").bind(spender,g1).run();
  await startSpenderHistory({DB},spender);
  assert.equal((await DB.prepare("SELECT generation FROM spender_history_jobs WHERE spender=?").bind(spender).first()).generation,g1);
  let hits=0;
  globalThis.fetch=async(url)=>{
   assert.ok(String(url).startsWith("https://api.etherscan.io/v2/api"));
   hits++;
   // Simulate deletion/re-creation while the request is in flight.
   await DB.batch([
    DB.prepare("DELETE FROM spender_history_jobs WHERE spender=?").bind(spender),
    DB.prepare("DELETE FROM spender_rules WHERE spender=?").bind(spender),
    DB.prepare("INSERT INTO spender_rules(spender,remark,enabled,start_block,cursor_block,generation) VALUES(?,'replacement',1,120,120,?)").bind(spender,g2)
   ]);
   await startSpenderHistory({DB},spender);
   return Response.json({status:"1",message:"OK",result:[log]});
  };
  await scanSpenderHistories({DB,ETHERSCAN_API_KEY:"test-key"});
  assert.equal(hits,1);
  assert.equal((await DB.prepare("SELECT generation FROM spender_history_jobs WHERE spender=?").bind(spender).first()).generation,g2);
  assert.equal((await DB.prepare("SELECT count(*) n FROM spender_history_addresses WHERE spender=?").bind(spender).first()).n,0);

  // Even direct late callbacks from the old version must not mutate history.
  await recordSpenderLiveApproval({DB},spender,log,1n,g1);
  assert.equal((await DB.prepare("SELECT count(*) n FROM spender_history_addresses WHERE spender=?").bind(spender).first()).n,0);
  await recordSpenderLiveApproval({DB},spender,log,1n,g2);
  const inserted=await DB.prepare("SELECT owner,verify_status FROM spender_history_addresses WHERE spender=?").bind(spender).first();
  assert.equal(inserted.owner,owner);
  assert.equal(inserted.verify_status,"active");
 }finally{globalThis.fetch=originalFetch;await mf.dispose()}
});
