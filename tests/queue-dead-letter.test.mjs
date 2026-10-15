import test from "node:test";
import assert from "node:assert/strict";
import {readFileSync,readdirSync} from "node:fs";
import {buildSync} from "esbuild";
import {Miniflare,convertV4MiniflareOptions} from "miniflare";

// Execute the real Worker queue entrypoint against an isolated migrated D1.
const code=buildSync({entryPoints:["src/index.ts"],bundle:true,format:"esm",
  platform:"node",target:"es2022",write:false}).outputFiles[0].text;
const worker=(await import("data:text/javascript;base64,"+Buffer.from(code).toString("base64"))).default;

test("exhausted chain-activity and verification jobs are retried into configured DLQ, never acknowledged",async()=>{
 const mf=new Miniflare(convertV4MiniflareOptions({
   name:"failed-queue-dead-letter-test",modules:true,
   script:'export default {fetch(){return new Response("ok")}}',
   d1Databases:{DB:"failed-queue-dead-letter"}
 }));
 try{
  const DB=await mf.getD1Database("DB");
  for(const file of readdirSync("migrations").filter(f=>f.endsWith(".sql")).sort()){
   for(const sql of readFileSync("migrations/"+file,"utf8").split(";").map(x=>x.trim()).filter(Boolean)){
    await DB.prepare(sql).run();
   }
  }
  await DB.prepare("INSERT INTO runtime_state(key,value) VALUES('is_active','1')").run();
  const env={DB};
  const makeMessage=(body,attempts)=>{
   const events=[];
   return {body,attempts,events,ack(){events.push({action:"ack"})},
     retry(options){events.push({action:"retry",options})}};
  };
  const invalidActivity=makeMessage({kind:"activity",payload:{network:"WRONG_NETWORK"}},5);
  const invalidVerify=makeMessage({kind:"verify_admin",owner:"0x"+"11".repeat(20),chat_id:"-10001"},5);
  await worker.queue({messages:[invalidActivity,invalidVerify]},env,{});
  for(const message of [invalidActivity,invalidVerify]){
   assert.equal(message.events.length,1);
   assert.equal(message.events[0].action,"retry","failed terminal jobs must reach the configured DLQ");
   assert.equal(message.events[0].options.delaySeconds,120);
  }

  // The same consumer must still ACK successful jobs; no phantom DLQ.
  const emptyActivity=makeMessage({kind:"activity",payload:{network:"ETH_MAINNET",event:{activity:[]}}},1);
  await worker.queue({messages:[emptyActivity]},env,{});
  assert.deepEqual(emptyActivity.events,[{action:"ack"}]);

  const ordinaryFailure=makeMessage({kind:"activity",payload:{network:"WRONG_NETWORK"}},1);
  await worker.queue({messages:[ordinaryFailure]},env,{});
  assert.equal(ordinaryFailure.events[0].action,"retry");
  assert.equal(ordinaryFailure.events[0].options.delaySeconds,20);
 }finally{await mf.dispose()}
});

test("DLQ safety contract remains attached to production Queue consumer",()=>{
 const live=JSON.parse(readFileSync("wrangler.jsonc","utf8"));
 const consumer=live.queues?.consumers?.[0];
 assert.ok(consumer?.dead_letter_queue,"no DLQ would turn retries into permanent message loss");
 assert.equal(consumer.max_retries,5);
 assert.notEqual(consumer.queue,consumer.dead_letter_queue);
});
