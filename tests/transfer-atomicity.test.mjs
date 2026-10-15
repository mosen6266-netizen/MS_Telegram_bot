import test from "node:test";
import assert from "node:assert/strict";
import {readFileSync,readdirSync} from "node:fs";
import {buildSync} from "esbuild";
import {Miniflare,convertV4MiniflareOptions} from "miniflare";

// Compile the actual implementation so this catches bugs beyond source grep.
const bundled=buildSync({stdin:{
  contents:'export {processActivity} from "./src/transfers";',
  resolveDir:process.cwd(),loader:"ts"
},bundle:true,format:"esm",platform:"node",write:false}).outputFiles[0].text;
const {processActivity}=await import("data:text/javascript;base64,"+Buffer.from(bundled).toString("base64"));

test("transfer event and all active-recipient notices commit atomically, replay repairs and deduplicates",async()=>{
  const mf=new Miniflare(convertV4MiniflareOptions({
    name:"transfer-atomicity-test",modules:true,
    script:'export default {fetch(){return new Response("ok")}}',
    d1Databases:{DB:"transfer-atomicity"}
  }));
  const existingFetch=globalThis.fetch;
  try{
    const DB=await mf.getD1Database("DB");
    for(const filename of readdirSync("migrations").filter(name=>name.endsWith(".sql")).sort()){
      const source=readFileSync("migrations/"+filename,"utf8");
      for(const statement of source.split(";").map(x=>x.trim()).filter(Boolean))await DB.prepare(statement).run();
    }
    const owner="0x"+"11".repeat(20),other="0x"+"22".repeat(20),hash="0x"+"ab".repeat(32);
    await DB.prepare("INSERT INTO wallets(address) VALUES(?)").bind(owner).run();
    await DB.prepare("INSERT INTO wallet_watches(address,state) VALUES(?,'active')").bind(owner).run();
    for(const id of ["-1001000000001","-1001000000002"]){
      await DB.prepare("INSERT INTO telegram_chats(chat_id,title,chat_type,active) VALUES(?,'Integration group','supergroup',1)").bind(id).run();
      await DB.prepare("INSERT INTO subscriptions(chat_id,address,remark,status) VALUES(?,?,'Test Owner','active')").bind(id,owner).run();
    }
    globalThis.fetch=async (url,options)=>{
      assert.equal(String(url),"https://rpc.test.invalid");
      const request=JSON.parse(options.body);
      assert.equal(request.method,"eth_getTransactionReceipt");
      return Response.json({jsonrpc:"2.0",id:1,result:{status:"0x1"}});
    };
    const env={DB,ALCHEMY_RPC_URL:"https://rpc.test.invalid"};
    const activity={network:"ETH_MAINNET",event:{network:"ETH_MAINNET",activity:[{
      category:"external",fromAddress:owner,toAddress:other,
      hash,uniqueId:"transfer-1",blockNum:"0x100000",blockHash:"0x"+"dd".repeat(32),
      value:1.25
    }]}};
    await DB.prepare("CREATE TRIGGER reject_notice BEFORE INSERT ON outbox BEGIN SELECT RAISE(ABORT,'outbox is unavailable'); END").run();
    await assert.rejects(()=>processActivity(env,activity),/outbox is unavailable/);
    assert.equal((await DB.prepare("SELECT count(*) n FROM transfer_events").first()).n,0);
    assert.equal((await DB.prepare("SELECT count(*) n FROM outbox").first()).n,0);

    await DB.prepare("DROP TRIGGER reject_notice").run();
    await processActivity(env,activity);
    assert.equal((await DB.prepare("SELECT count(*) n FROM transfer_events").first()).n,1);
    assert.equal((await DB.prepare("SELECT count(*) n FROM outbox").first()).n,2);
    assert.equal((await DB.prepare("SELECT count(*) n FROM outbox WHERE template_key='transfer'").first()).n,2);

    await processActivity(env,activity);
    assert.equal((await DB.prepare("SELECT count(*) n FROM transfer_events").first()).n,1);
    assert.equal((await DB.prepare("SELECT count(*) n FROM outbox").first()).n,2);

    const first=await DB.prepare("SELECT dedup_key FROM outbox ORDER BY chat_id LIMIT 1").first();
    await DB.prepare("DELETE FROM outbox WHERE dedup_key=?").bind(first.dedup_key).run();
    assert.equal((await DB.prepare("SELECT count(*) n FROM outbox").first()).n,1);
    await processActivity(env,activity);
    assert.equal((await DB.prepare("SELECT count(*) n FROM outbox").first()).n,2,"replay must repair an older partially queued event");
  }finally{
    globalThis.fetch=existingFetch;
    await mf.dispose();
  }
});
