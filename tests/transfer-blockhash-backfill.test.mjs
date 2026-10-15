import test from "node:test";
import assert from "node:assert/strict";
import {buildSync} from "esbuild";
import {Miniflare,convertV4MiniflareOptions} from "miniflare";

const compiled=buildSync({stdin:{
 contents:'export {backfillMissingTransferBlockHashes} from "./src/recovery";',
 resolveDir:process.cwd(),loader:"ts"
},bundle:true,format:"esm",platform:"node",write:false}).outputFiles[0].text;
const {backfillMissingTransferBlockHashes}=await import(
 "data:text/javascript;base64,"+Buffer.from(compiled).toString("base64")
);

test("legacy null block hashes are repaired only when real receipt matches confirmed block height; throttle RPC calls",async()=>{
 const mf=new Miniflare(convertV4MiniflareOptions({
  name:"transfer-block-hash-backfill-test",modules:true,
  script:'export default {fetch(){return new Response("ok")}}',
  d1Databases:{DB:"transfer-block-hash-backfill"}
 }));
 const oldFetch=globalThis.fetch;
 try{
  const DB=await mf.getD1Database("DB");
  await DB.prepare("CREATE TABLE runtime_state(key TEXT PRIMARY KEY,value TEXT,updated_at TEXT DEFAULT CURRENT_TIMESTAMP)").run();
  await DB.prepare("CREATE TABLE transfer_events(event_id TEXT PRIMARY KEY,tx_hash TEXT,block_number INTEGER,block_hash TEXT,state TEXT)").run();
  const entries=[
   ["ok","0x"+"11".repeat(32),100,null,"confirmed"],
   ["different_block","0x"+"22".repeat(32),101,null,"confirmed"],
   ["no_receipt","0x"+"33".repeat(32),102,null,"confirmed"],
   ["previous_hash","0x"+"44".repeat(32),103,"0x"+"dd".repeat(32),"confirmed"]
  ];
  await DB.batch(entries.map(x=>
   DB.prepare("INSERT INTO transfer_events(event_id,tx_hash,block_number,block_hash,state) VALUES(?,?,?,?,?)").bind(...x)));
  const env={DB,ALCHEMY_RPC_URL:"https://rpc.blockhash.test"};
  let calls=0;
  globalThis.fetch=async(url,options)=>{
   assert.equal(url,env.ALCHEMY_RPC_URL);
   calls++;
   const [tx]=JSON.parse(options.body).params;
   if(tx===entries[0][1])return Response.json({jsonrpc:"2.0",id:1,
    result:{status:"0x1",blockNumber:"0x64",blockHash:"0x"+"aa".repeat(32)}});
   if(tx===entries[1][1])return Response.json({jsonrpc:"2.0",id:1,
    result:{status:"0x1",blockNumber:"0x999",blockHash:"0x"+"bb".repeat(32)}});
   if(tx===entries[2][1])return Response.json({jsonrpc:"2.0",id:1,result:null});
   throw Error("unexpected RPC for already-hashed record");
  };
  const first=await backfillMissingTransferBlockHashes(env,3);
  assert.equal(first.attempted,3);
  assert.equal(first.repaired,1);
  assert.equal(calls,3);
  const row=async id=>DB.prepare("SELECT block_hash FROM transfer_events WHERE event_id=?").bind(id).first();
  assert.equal((await row("ok")).block_hash,"0x"+"aa".repeat(32));
  assert.equal((await row("different_block")).block_hash,null);
  assert.equal((await row("no_receipt")).block_hash,null);
  assert.equal((await row("previous_hash")).block_hash,"0x"+"dd".repeat(32));
  assert.deepEqual(await backfillMissingTransferBlockHashes(env,3),{cooldown:true});
  assert.equal(calls,3,"six-hour throttle must prevent RPC retry storms");

  await DB.prepare("UPDATE runtime_state SET value='1' WHERE key='transfer_blockhash_backfill_after'").run();
  await DB.prepare("UPDATE transfer_events SET state='reorged' WHERE event_id='different_block'").run();
  const second=await backfillMissingTransferBlockHashes(env,3);
  assert.equal(second.repaired,0);
  assert.equal((await row("different_block")).block_hash,null,"reorged events are never rewritten");
 }finally{globalThis.fetch=oldFetch;await mf.dispose()}
});
