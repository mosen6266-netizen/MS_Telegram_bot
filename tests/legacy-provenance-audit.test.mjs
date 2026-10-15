import test from "node:test";
import assert from "node:assert/strict";
import {buildSync} from "esbuild";
import {Miniflare,convertV4MiniflareOptions} from "miniflare";
import {readFileSync} from "node:fs";

const compiled=buildSync({stdin:{contents:'export {listLegacySubscriptions} from "./src/subscription-sources";',
 resolveDir:process.cwd(),loader:"ts"},bundle:true,format:"esm",platform:"node",write:false}).outputFiles[0].text;
const {listLegacySubscriptions}=await import("data:text/javascript;base64,"+Buffer.from(compiled).toString("base64"));
const wallet=i=>"0x"+i.toString(16).padStart(40,"0");

test("legacy provenance audit pages and searches unknown subscriptions without modifying any subscription",async()=>{
 const mf=new Miniflare(convertV4MiniflareOptions({name:"legacy-audit-test",modules:true,
 script:'export default {fetch(){return new Response("ok")}}',d1Databases:{DB:"legacy-audit"}}));
 try{
  const DB=await mf.getD1Database("DB");
  await DB.prepare("CREATE TABLE subscriptions(chat_id TEXT,address TEXT,remark TEXT,status TEXT,updated_at TEXT DEFAULT CURRENT_TIMESTAMP,PRIMARY KEY(chat_id,address))").run();
  await DB.prepare("CREATE TABLE telegram_chats(chat_id TEXT PRIMARY KEY,title TEXT)").run();
  await DB.prepare("INSERT INTO telegram_chats(chat_id,title) VALUES('-1005555555555','旧授权群')").run();
  for(const q of readFileSync("migrations/20261015_subscription_sources.sql","utf8").split(";").map(x=>x.trim()).filter(Boolean))
   await DB.prepare(q).run();
  const statements=[];
  for(let i=1;i<=76;i++){
   statements.push(DB.prepare("INSERT INTO subscriptions(chat_id,address,remark,status) VALUES('-1005555555555',?,?,?)").bind(wallet(i),"历史钱包"+i,i===5?"removed":"active"));
  }
  for(let i=0;i<statements.length;i+=20)await DB.batch(statements.slice(i,i+20));
  // Model a legacy migration over historical subscriptions.
  await DB.prepare("INSERT INTO subscription_sources(chat_id,address,source_type,source_id) SELECT chat_id,address,'legacy','pre_migration' FROM subscriptions WHERE status IN ('active','paused','pending')").run();
  const before=await DB.prepare("SELECT count(*) n FROM subscriptions WHERE status='active'").first();
  const first=await listLegacySubscriptions(DB);
  assert.equal(first.total,75);assert.equal(first.rows.length,30);assert.equal(first.total_pages,3);
  assert.equal(first.read_only,true);
  const last=await listLegacySubscriptions(DB,{page:2});
  assert.equal(last.rows.length,15);
  const filtered=await listLegacySubscriptions(DB,{search:wallet(17).slice(-8)});
  assert.equal(filtered.total,1);assert.equal(filtered.rows[0].address,wallet(17));
  const group=await listLegacySubscriptions(DB,{search:"旧授权群"});
  assert.equal(group.total,75);
  const after=await DB.prepare("SELECT count(*) n FROM subscriptions WHERE status='active'").first();
  assert.equal(after.n,before.n);
  assert.equal((await DB.prepare("SELECT count(*) n FROM subscription_sources WHERE source_type='legacy'").first()).n,75);
 }finally{await mf.dispose()}
});
