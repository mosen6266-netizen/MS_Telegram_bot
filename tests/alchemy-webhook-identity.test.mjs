import test from "node:test";
import assert from "node:assert/strict";
import {buildSync} from "esbuild";
import {Miniflare,convertV4MiniflareOptions} from "miniflare";

const compiled=buildSync({stdin:{contents:'export {syncWatch} from "./src/core"; export {persistSecret} from "./src/setup";',
 resolveDir:process.cwd(),loader:"ts"},bundle:true,platform:"node",format:"esm",write:false}).outputFiles[0].text;
const {syncWatch,persistSecret}=await import("data:text/javascript;base64,"+Buffer.from(compiled).toString("base64"));
const a="0x"+"11".repeat(20);

test("stale Worker config reuses the encrypted Alchemy webhook ID rather than creating a duplicate",async()=>{
 const mf=new Miniflare(convertV4MiniflareOptions({name:"alchemy-webhook-identity-test",modules:true,
 script:'export default {fetch(){return new Response("ok")}}',d1Databases:{DB:"alchemy-webhook-identity"}}));
 const saved=globalThis.fetch;
 try{
  const DB=await mf.getD1Database("DB");
  await DB.prepare("CREATE TABLE runtime_state(key TEXT PRIMARY KEY,value TEXT,updated_at TEXT DEFAULT CURRENT_TIMESTAMP)").run();
  await DB.prepare("CREATE TABLE setup_secrets(key TEXT PRIMARY KEY,encrypted_value TEXT,updated_at TEXT DEFAULT CURRENT_TIMESTAMP)").run();
  const APP_ENCRYPTION_KEY=Buffer.alloc(32,7).toString("base64");
  const credentials={DB,APP_ENCRYPTION_KEY,ALCHEMY_NOTIFY_TOKEN:"test-token"};
  await persistSecret(credentials,"ALCHEMY_ACTIVITY_WEBHOOK_ID","wh-existing");
  let calls=0;
  globalThis.fetch=async(url,options)=>{
   calls++;
   assert.equal(url,"https://dashboard.alchemy.com/api/update-webhook-addresses");
   assert.equal(JSON.parse(options.body).webhook_id,"wh-existing");
   return Response.json({success:true});
  };
  await syncWatch(credentials,a);
  assert.equal(calls,1);
  assert.equal(credentials.ALCHEMY_ACTIVITY_WEBHOOK_ID,"wh-existing");

  const wrong={DB,APP_ENCRYPTION_KEY:Buffer.alloc(32,8).toString("base64"),ALCHEMY_NOTIFY_TOKEN:"test-token"};
  await assert.rejects(syncWatch(wrong,a),/cannot be read/);
  assert.equal(calls,1,"decryption errors must not create duplicate Webhooks");
 }finally{globalThis.fetch=saved;await mf.dispose()}
});
