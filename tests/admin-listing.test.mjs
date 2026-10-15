import test from "node:test";
import assert from "node:assert/strict";
import {buildSync} from "esbuild";
import {Miniflare,convertV4MiniflareOptions} from "miniflare";

const bundled=buildSync({stdin:{contents:
 'export {listWalletsPage,listSubscriptionsPage,listAuditPage,listTransfersPage} from "./src/admin-listing";',
 resolveDir:process.cwd(),loader:"ts"
},bundle:true,format:"esm",platform:"node",write:false}).outputFiles[0].text;
const {listWalletsPage,listSubscriptionsPage,listAuditPage,listTransfersPage}=await import(
 "data:text/javascript;base64,"+Buffer.from(bundled).toString("base64")
);
const addr=i=>"0x"+i.toString(16).padStart(40,"0");

test("wallet, subscription and audit pages search older data instead of dropping entries past limit 200",async()=>{
 const mf=new Miniflare(convertV4MiniflareOptions({name:"admin-listing-pages-test",modules:true,
  script:'export default {fetch(){return new Response("ok")}}',d1Databases:{DB:"admin-listing-pages"}}));
 try{
  const db=await mf.getD1Database("DB");
  for(const query of [
   "CREATE TABLE wallets(address TEXT PRIMARY KEY,first_user_name TEXT,discovery_source TEXT,created_at TEXT DEFAULT CURRENT_TIMESTAMP,deleted_at TEXT)",
   "CREATE TABLE wallet_watches(address TEXT PRIMARY KEY,state TEXT)",
   "CREATE TABLE wallet_global_remarks(address TEXT PRIMARY KEY,remark TEXT)",
   "CREATE TABLE telegram_chats(chat_id TEXT PRIMARY KEY,title TEXT)",
   "CREATE TABLE subscriptions(chat_id TEXT,address TEXT,remark TEXT,status TEXT,updated_at TEXT DEFAULT CURRENT_TIMESTAMP,PRIMARY KEY(chat_id,address))",
   "CREATE TABLE admin_audit(id INTEGER PRIMARY KEY,actor TEXT,action TEXT,target TEXT,created_at TEXT)",
   "CREATE TABLE transfer_events(event_id TEXT PRIMARY KEY,address TEXT,asset TEXT,direction TEXT,raw_amount TEXT,block_number INTEGER,tx_hash TEXT)"
  ])await db.prepare(query).run();
  await db.prepare("INSERT INTO telegram_chats(chat_id,title) VALUES('-100123','Test group')").run();
  // Populate 230 rows per table through SQL recursive inserts, avoiding
  // hundreds of network round trips from Miniflare's D1 test bridge.
  const nums="WITH RECURSIVE nums(i) AS (SELECT 1 UNION ALL SELECT i+1 FROM nums WHERE i<230) ";
  await db.prepare(nums+"INSERT INTO wallets(address,first_user_name,discovery_source,created_at) "+
    "SELECT printf('0x%040x',i),CASE WHEN i=1 THEN 'Oldest person' ELSE 'User '||i END,'manual',"+
    "datetime('now',printf('-%d minutes',240-i)) FROM nums").run();
  await db.prepare(nums+"INSERT INTO subscriptions(chat_id,address,remark,status,updated_at) "+
    "SELECT '-100123',printf('0x%040x',i),CASE WHEN i=1 THEN 'Rare legacy note' ELSE 'ordinary note' END,"+
    "CASE WHEN i%3<>0 THEN 'active' ELSE 'paused' END,datetime('now',printf('-%d minutes',240-i)) FROM nums").run();
  await db.prepare(nums+"INSERT INTO admin_audit(id,actor,action,target,created_at) "+
    "SELECT i,'admin',CASE WHEN i=1 THEN 'rare_old_action' ELSE 'edit' END,printf('0x%040x',i),CURRENT_TIMESTAMP FROM nums").run();
  await db.prepare(nums+"INSERT INTO transfer_events(event_id,address,asset,direction,raw_amount,block_number,tx_hash) "+
    "SELECT 'event-'||i,printf('0x%040x',i),CASE WHEN i%2=1 THEN 'USDT' ELSE 'ETH' END,'IN','1',i,"+
    "CASE WHEN i=1 THEN ? ELSE ? END FROM nums")
    .bind("0x"+"ee".repeat(32),"0x"+"ab".repeat(32)).run();
  await db.prepare("INSERT INTO wallet_global_remarks(address,remark) VALUES(?,'Important audit label')").bind(addr(1)).run();
  const w1=await listWalletsPage(db,{page:0});
  assert.equal(w1.total,230);assert.equal(w1.rows.length,50);assert.equal(w1.total_pages,5);
  const w5=await listWalletsPage(db,{page:4});
  assert.equal(w5.rows.length,30);
  const wa=await listWalletsPage(db,{search:"Important audit label"});
  assert.equal(wa.total,1);assert.equal(wa.rows[0].address,addr(1));
  const oldPerson=await listWalletsPage(db,{search:"Oldest person"});
  assert.equal(oldPerson.total,1);
  const s1=await listSubscriptionsPage(db,{page:0});
  assert.equal(s1.total,230);assert.equal(s1.rows.length,50);
  assert.equal((await listSubscriptionsPage(db,{status:"paused"})).total,76);
  assert.equal((await listSubscriptionsPage(db,{search:"Rare legacy note"})).rows[0].address,addr(1));
  assert.equal((await listSubscriptionsPage(db,{search:"Test group"})).total,230);
  assert.deepEqual(await listSubscriptionsPage(db,{status:"mistyped"}),{error:"invalid_status",status:400});
  const a1=await listAuditPage(db,{page:0});
  assert.equal(a1.total,230);assert.equal(a1.rows[0].id,230);
  const a5=await listAuditPage(db,{page:4});
  assert.equal(a5.rows.length,30);assert.equal(a5.rows.at(-1).id,1);
  const search=await listAuditPage(db,{search:"rare_old_action"});
  assert.equal(search.total,1);assert.equal(search.rows[0].id,1);
  const firstTx=await listTransfersPage(db,{page:0});
  assert.equal(firstTx.total,230);assert.equal(firstTx.rows.length,50);assert.equal(firstTx.total_pages,5);
  assert.equal(firstTx.rows[0].block_number,230);
  const oldTx=await listTransfersPage(db,{search:"0x"+"ee".repeat(32)});
  assert.equal(oldTx.total,1);assert.equal(oldTx.rows[0].event_id,"event-1");
  assert.equal((await listTransfersPage(db,{asset:"USDT"})).total,115);
  assert.deepEqual(await listTransfersPage(db,{asset:"BTC"}),{error:"invalid_asset",status:400});
  assert.equal((await listTransfersPage(db,{page:4})).rows.length,30);
  assert.equal((await db.prepare("SELECT COUNT(*) n FROM wallets").first()).n,230);
  assert.equal((await db.prepare("SELECT COUNT(*) n FROM subscriptions").first()).n,230);
 }finally{await mf.dispose()}
});
