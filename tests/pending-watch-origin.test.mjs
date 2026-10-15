import test from "node:test";
import assert from "node:assert/strict";
import {Miniflare,convertV4MiniflareOptions} from "miniflare";
import {buildSync} from "esbuild";

const compiled=buildSync({stdin:{
 contents:'export {selectStandalonePendingWatches} from "./src/watch-maintenance";',
 resolveDir:process.cwd(),loader:"ts"
},bundle:true,platform:"node",format:"esm",write:false}).outputFiles[0].text;
const {selectStandalonePendingWatches}=await import("data:text/javascript;base64,"+Buffer.from(compiled).toString("base64"));
const a=i=>"0x"+i.toString(16).padStart(40,"0");

test("pending orphan wallets from deleted Spenders are not re-enrolled by generic Cron",async()=>{
 const mf=new Miniflare(convertV4MiniflareOptions({name:"pending-watch-origin-test",modules:true,
 script:'export default {fetch(){return new Response("ok")}}',d1Databases:{DB:"pending-watch-origin"}}));
 try{
  const DB=await mf.getD1Database("DB");
  const queries=[
   "CREATE TABLE wallet_watches(address TEXT PRIMARY KEY,state TEXT NOT NULL,updated_at TEXT DEFAULT CURRENT_TIMESTAMP)",
   "CREATE TABLE spender_history_monitor_enrollments(spender TEXT,owner TEXT,state TEXT)",
   "CREATE TABLE wallet_exclusions(address TEXT PRIMARY KEY)",
   "CREATE TABLE wallets(address TEXT PRIMARY KEY,deleted_at TEXT)",
   "CREATE TABLE subscriptions(chat_id TEXT,address TEXT,status TEXT,PRIMARY KEY(chat_id,address))",
   "CREATE TABLE subscription_sources(chat_id TEXT,address TEXT,source_type TEXT,source_id TEXT)",
   "CREATE TABLE spender_rules(spender TEXT PRIMARY KEY,enabled INTEGER)"
  ];
  for(const q of queries)await DB.prepare(q).run();
  const activeSpender=a(100),goneSpender=a(101);
  await DB.prepare("INSERT INTO spender_rules(spender,enabled) VALUES(?,1)").bind(activeSpender).run();
  for(let i=1;i<=6;i++){
   await DB.prepare("INSERT INTO wallet_watches(address,state) VALUES(?,'pending')").bind(a(i)).run();
   await DB.prepare("INSERT INTO subscriptions(chat_id,address,status) VALUES('-100',?,'pending')").bind(a(i)).run();
  }
  for(const [i,type,id] of [[1,"manual","user"],[2,"admin","admin"],[3,"spender",activeSpender],[4,"spender",goneSpender],[5,"retained",goneSpender],[6,"legacy","pre_migration"]]){
   await DB.prepare("INSERT INTO subscription_sources(chat_id,address,source_type,source_id) VALUES('-100',?,?,?)").bind(a(i),type,id).run();
  }
  let selected=await selectStandalonePendingWatches(DB);
  assert.deepEqual(selected.map(x=>x.address).sort(),[a(1),a(2),a(3),a(6)].sort());
  await DB.prepare("INSERT INTO wallet_exclusions(address) VALUES(?)").bind(a(1)).run();
  await DB.prepare("INSERT INTO spender_history_monitor_enrollments(spender,owner,state) VALUES(?,?,'running')").bind(activeSpender,a(3)).run();
  selected=await selectStandalonePendingWatches(DB);
  assert.deepEqual(selected.map(x=>x.address).sort(),[a(2),a(6)].sort());
  assert.equal((await DB.prepare("SELECT state FROM wallet_watches WHERE address=?").bind(a(4)).first()).state,"pending");
 }finally{await mf.dispose()}
});
