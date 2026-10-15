import test from "node:test";
import assert from "node:assert/strict";
import {readFileSync,readdirSync} from "node:fs";
import {buildSync} from "esbuild";
import {Miniflare,convertV4MiniflareOptions} from "miniflare";

const compiled=buildSync({stdin:{contents:'export {scanWalletGaps,selectGapScanCandidates} from "./src/recovery";',
  resolveDir:process.cwd(),loader:"ts"},bundle:true,format:"esm",platform:"node",write:false}).outputFiles[0].text;
const {scanWalletGaps,selectGapScanCandidates}=await import("data:text/javascript;base64,"+Buffer.from(compiled).toString("base64"));
const addr=i=>"0x"+i.toString(16).padStart(40,"0");

test("a repeatedly failing oldest wallet does not block other ETH/USDT/USDC recovery checkpoints",async()=>{
 const mf=new Miniflare(convertV4MiniflareOptions({name:"wallet-gap-recovery-fairness",modules:true,
 script:'export default {fetch(){return new Response("ok")}}',d1Databases:{DB:"wallet-gap-recovery-fairness"}}));
 const saved=globalThis.fetch;
 try{
  const DB=await mf.getD1Database("DB");
  for(const file of readdirSync("migrations").filter(x=>x.endsWith(".sql")).sort()){
   for(const sql of readFileSync("migrations/"+file,"utf8").split(";").map(x=>x.trim()).filter(Boolean))await DB.prepare(sql).run();
  }
  for(let i=1;i<=6;i++){
   const address=addr(i);
   await DB.prepare("INSERT INTO wallets(address,discovery_source) VALUES(?,'manual')").bind(address).run();
   await DB.prepare("INSERT INTO wallet_watches(address,state) VALUES(?,'active')").bind(address).run();
   await DB.prepare("INSERT INTO wallet_checkpoints(address,last_block) VALUES(?,?)").bind(address,10+i).run();
  }
  const env={DB,ALCHEMY_RPC_URL:"https://rpc.wallet-recovery.invalid"};
  let firstFails=0;
  globalThis.fetch=async(url,options)=>{
   assert.equal(url,env.ALCHEMY_RPC_URL);
   const body=JSON.parse(options.body);
   if(body.method==="eth_blockNumber")return Response.json({jsonrpc:"2.0",id:1,result:"0xc8"});
   if(body.method==="alchemy_getAssetTransfers"){
    const params=body.params[0];
    if(params.fromAddress===addr(1)||params.toAddress===addr(1)){
      firstFails++;
      throw Error("synthetic RPC timeout");
    }
    return Response.json({jsonrpc:"2.0",id:1,result:{transfers:[]}});
   }
   throw Error("unexpected RPC "+body.method);
  };
  await scanWalletGaps(env,2);
  const failed=await DB.prepare("SELECT last_block,last_error,checked_at FROM wallet_checkpoints WHERE address=?").bind(addr(1)).first();
  assert.equal(failed.last_block,11,"a failed range cannot advance its checkpoint");
  assert.match(failed.last_error,/synthetic RPC timeout/);
  assert.ok(failed.checked_at,"a recent failed attempt must be tracked");
  assert.equal(firstFails,1);
  const after=await selectGapScanCandidates(DB,200,2);
  assert.deepEqual(after.map(x=>x.address),[addr(3),addr(4)]);
  await scanWalletGaps(env,2);
  assert.ok((await DB.prepare("SELECT last_block FROM wallet_checkpoints WHERE address=?").bind(addr(3)).first()).last_block>13);
  assert.equal((await DB.prepare("SELECT last_block FROM wallet_checkpoints WHERE address=?").bind(addr(1)).first()).last_block,11);
  assert.equal(firstFails,1,"cooldown prevents immediate repeated failures");
  await DB.prepare("UPDATE wallet_checkpoints SET checked_at=datetime('now','-6 minutes') WHERE address=?").bind(addr(1)).run();
  const retry=await selectGapScanCandidates(DB,200,2);
  assert.equal(retry[0].address,addr(1),"failed range becomes eligible once retry delay expires");
 }finally{globalThis.fetch=saved;await mf.dispose()}
});
