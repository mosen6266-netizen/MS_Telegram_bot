import test from "node:test";
import assert from "node:assert/strict";
import {readFileSync,readdirSync} from "node:fs";
import {buildSync} from "esbuild";
import {Miniflare,convertV4MiniflareOptions} from "miniflare";

const src=buildSync({stdin:{contents:
  'export {selectEnrollmentCandidates} from "./src/spender-enroll"; export {ensureWatch} from "./src/core";',
  resolveDir:process.cwd(),loader:"ts"
},bundle:true,platform:"node",format:"esm",write:false}).outputFiles[0].text;
const {selectEnrollmentCandidates,ensureWatch}=await import("data:text/javascript;base64,"+Buffer.from(src).toString("base64"));

test("historical onboarding prioritizes never-attempted wallets and defers repeatedly failed wallets",async()=>{
 const mf=new Miniflare(convertV4MiniflareOptions({
  name:"onboarding-priority-test",modules:true,
  script:'export default {fetch(){return new Response("ok")}}',
  d1Databases:{DB:"onboarding-priority"}
 }));
 try{
  const DB=await mf.getD1Database("DB");
  for(const file of readdirSync("migrations").filter(x=>x.endsWith(".sql")).sort()){
   for(const query of readFileSync("migrations/"+file,"utf8").split(";").map(x=>x.trim()).filter(Boolean))
    await DB.prepare(query).run();
  }
  const spender="0x"+"66".repeat(20);
  const priorFailed="0x"+"11".repeat(20),recentFailed="0x"+"22".repeat(20),fresh="0x"+"33".repeat(20);
  await DB.prepare("INSERT INTO spender_rules(spender,remark,start_block,cursor_block) VALUES(?,'test',500,500)").bind(spender).run();
  for(const [owner,block] of [[priorFailed,1],[recentFailed,2],[fresh,3]]){
   await DB.prepare("INSERT INTO spender_history_addresses(spender,owner,first_seen_block,latest_event_block) VALUES(?,?,?,?)").bind(spender,owner,block,block).run();
  }
  await DB.prepare("INSERT INTO spender_history_monitor_enrollments(spender,owner,state,attempts,updated_at) VALUES(?,?,'retrying',6,datetime('now','-5 minutes'))").bind(spender,priorFailed).run();
  await DB.prepare("INSERT INTO spender_history_monitor_enrollments(spender,owner,state,attempts,updated_at) VALUES(?,?,'retrying',1,datetime('now','-5 minutes'))").bind(spender,recentFailed).run();

  const selected=await selectEnrollmentCandidates(DB,20);
  assert.deepEqual(selected.map(x=>x.owner),[fresh,recentFailed],
   "never-enrolled must run first; a 6-attempt wallet must wait at least 30 minutes");
  const one=await selectEnrollmentCandidates(DB,1);
  assert.equal(one[0].owner,fresh);
  await DB.prepare("UPDATE spender_history_monitor_enrollments SET updated_at=datetime('now','-31 minutes') WHERE owner=?").bind(priorFailed).run();
  const afterCooldown=await selectEnrollmentCandidates(DB,20);
  assert.deepEqual(afterCooldown.map(x=>x.owner),[fresh,priorFailed,recentFailed]);
 }finally{await mf.dispose()}
});

test("ensureWatch does not make another RPC/Alchemy request or downgrade an already active wallet",async()=>{
 const mf=new Miniflare(convertV4MiniflareOptions({
  name:"active-watcher-test",modules:true,
  script:'export default {fetch(){return new Response("ok")}}',
  d1Databases:{DB:"active-watcher"}
 }));
 const savedFetch=globalThis.fetch;
 try{
  const DB=await mf.getD1Database("DB");
  await DB.prepare("CREATE TABLE wallet_watches(address TEXT PRIMARY KEY,state TEXT NOT NULL,synced_at TEXT,last_error TEXT,updated_at TEXT DEFAULT CURRENT_TIMESTAMP)").run();
  const wallet="0x"+"99".repeat(20);
  await DB.prepare("INSERT INTO wallet_watches(address,state) VALUES(?,'active')").bind(wallet).run();
  globalThis.fetch=()=>{throw Error("Unexpected external network call for active wallet")};
  assert.equal(await ensureWatch({DB},wallet),true);
  assert.equal((await DB.prepare("SELECT state FROM wallet_watches WHERE address=?").bind(wallet).first()).state,"active");
 }finally{globalThis.fetch=savedFetch;await mf.dispose()}
});
