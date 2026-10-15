import test from "node:test";
import assert from "node:assert/strict";
import {readFileSync} from "node:fs";
import {buildSync} from "esbuild";
import {Miniflare,convertV4MiniflareOptions} from "miniflare";

const compiled=buildSync({stdin:{
 contents:'export {sourceInsert,assignSpenderSourcesForRoute,removeSpenderRouteSourceStatements,retainDeletedSpenderSources} from "./src/subscription-sources";',
 resolveDir:process.cwd(),loader:"ts"
},bundle:true,format:"esm",platform:"node",write:false}).outputFiles[0].text;
const mod=await import("data:text/javascript;base64,"+Buffer.from(compiled).toString("base64"));
const addr=i=>"0x"+i.toString(16).padStart(40,"0");

test("multi-origin Spender route removal preserves manual and other-Spender subscriptions",async()=>{
 const mf=new Miniflare(convertV4MiniflareOptions({name:"subscription-sources-test",modules:true,
  script:'export default {fetch(){return new Response("ok")}}',d1Databases:{DB:"subscription-sources"}}));
 try{
  const DB=await mf.getD1Database("DB");
  await DB.prepare("PRAGMA foreign_keys=ON").run();
  await DB.prepare("CREATE TABLE subscriptions(chat_id TEXT NOT NULL,address TEXT NOT NULL,remark TEXT NOT NULL,status TEXT NOT NULL,updated_at TEXT DEFAULT CURRENT_TIMESTAMP,PRIMARY KEY(chat_id,address))").run();
  await DB.prepare("CREATE TABLE spender_history_addresses(spender TEXT NOT NULL,owner TEXT NOT NULL,PRIMARY KEY(spender,owner))").run();
  const chat="-1007777777777",s1=addr(10),s2=addr(20);
  const legacy=addr(1),onlyS1=addr(2),overlap=addr(3),manual=addr(4);
  for(const owner of [legacy,onlyS1,overlap,manual]){
   await DB.prepare("INSERT INTO subscriptions(chat_id,address,remark,status) VALUES(?,?,'test','active')").bind(chat,owner).run();
  }
  // Apply the actual migration, not a hand-crafted imitation.
  const migration=readFileSync("migrations/20261015_subscription_sources.sql","utf8");
  for(const query of migration.split(";").map(x=>x.trim()).filter(Boolean))await DB.prepare(query).run();
  const baseline=await DB.prepare("SELECT source_type FROM subscription_sources WHERE chat_id=? AND address=?").bind(chat,legacy).first();
  assert.equal(baseline.source_type,"legacy","unknown existing subscriptions must be protected");

  // These are post-migration Spender-managed rows; remove the legacy label
  // only in the test to emulate a genuinely new subscription.
  for(const wallet of [onlyS1,overlap,manual]){
   await DB.prepare("DELETE FROM subscription_sources WHERE chat_id=? AND address=?").bind(chat,wallet).run();
  }
  for(const owner of [legacy,onlyS1,overlap,manual]){
   await DB.prepare("INSERT INTO spender_history_addresses(spender,owner) VALUES(?,?)").bind(s1,owner).run();
   await mod.sourceInsert(DB,chat,owner,"spender",s1).run();
  }
  await DB.prepare("INSERT INTO spender_history_addresses(spender,owner) VALUES(?,?)").bind(s2,overlap).run();
  await mod.sourceInsert(DB,chat,overlap,"spender",s2).run();
  await mod.sourceInsert(DB,chat,manual,"manual","user-17").run();
  await DB.batch(mod.removeSpenderRouteSourceStatements(DB,s1,chat));

  const state=async a=>(await DB.prepare("SELECT status FROM subscriptions WHERE chat_id=? AND address=?").bind(chat,a).first()).status;
  assert.equal(await state(onlyS1),"removed","only this Spender owned the subscription");
  assert.equal(await state(overlap),"active","another Spender still owns it");
  assert.equal(await state(manual),"active","manual subscription survives Spender removal");
  assert.equal(await state(legacy),"active","uncertain pre-migration origin remains protected");

  assert.equal((await DB.prepare("SELECT COUNT(*) n FROM subscription_sources WHERE source_id=?").bind(s1).first()).n,0);
  assert.equal((await DB.prepare("SELECT COUNT(*) n FROM subscription_sources WHERE source_id=?").bind(s2).first()).n,1);

  const newcomer=addr(5);
  await DB.prepare("INSERT INTO subscriptions(chat_id,address,remark,status) VALUES(?,?,'new','pending')").bind(chat,newcomer).run();
  await DB.prepare("INSERT INTO spender_history_addresses(spender,owner) VALUES(?,?)").bind(s2,newcomer).run();
  await mod.assignSpenderSourcesForRoute(DB,s2,chat).run();
  assert.equal((await DB.prepare("SELECT source_type FROM subscription_sources WHERE chat_id=? AND address=?").bind(chat,newcomer).first()).source_type,"spender");

  await DB.batch(mod.retainDeletedSpenderSources(DB,s2));
  assert.equal((await DB.prepare("SELECT source_type FROM subscription_sources WHERE chat_id=? AND address=? AND source_id=?").bind(chat,newcomer,s2).first()).source_type,"retained");
  assert.equal((await DB.prepare("SELECT COUNT(*) n FROM subscription_sources WHERE source_type='spender' AND source_id=?").bind(s2).first()).n,0);
 }finally{await mf.dispose()}
});
