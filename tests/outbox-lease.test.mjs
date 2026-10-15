import test from "node:test";
import assert from "node:assert/strict";
import {readdirSync,readFileSync} from "node:fs";
import {buildSync} from "esbuild";
import {Miniflare,convertV4MiniflareOptions} from "miniflare";

const compiled=buildSync({stdin:{contents:'export {recoverStuck} from "./src/notifications";',
 resolveDir:process.cwd(),loader:"ts"},bundle:true,format:"esm",platform:"node",write:false}).outputFiles[0].text;
const {recoverStuck}=await import("data:text/javascript;base64,"+Buffer.from(compiled).toString("base64"));

test("an old message freshly claimed for sending must not be reclaimed; true stale attempts recover",async()=>{
 const mf=new Miniflare(convertV4MiniflareOptions({name:"outbox-lease-test",modules:true,
  script:'export default {fetch(){return new Response("ok")}}',d1Databases:{DB:"outbox-lease"}}));
 try{
  const DB=await mf.getD1Database("DB");
  const migrate=async name=>{
   for(const query of readFileSync("migrations/"+name,"utf8").split(";").map(x=>x.trim()).filter(Boolean))
    await DB.prepare(query).run();
  };
  const all=readdirSync("migrations").filter(x=>x.endsWith(".sql")).sort();
  const lease="20261015_outbox_sending_lease.sql";
  assert.ok(all.includes(lease),"lease migration must be present");
  for(const name of all.filter(x=>x!==lease))await migrate(name);

  await DB.prepare("INSERT INTO outbox(dedup_key,chat_id,template_key,payload_json,state,created_at) VALUES('old','-1001','transfer','{}','sending',datetime('now','-2 days'))").run();
  await migrate(lease);

  let row=await DB.prepare("SELECT state,sending_started_at FROM outbox WHERE dedup_key='old'").first();
  assert.equal(row.state,"sending");
  assert.ok(row.sending_started_at,"migration must assign safe grace period to in-flight rows");
  await recoverStuck({DB});
  row=await DB.prepare("SELECT state FROM outbox WHERE dedup_key='old'").first();
  assert.equal(row.state,"sending","creation age does not make a newly sending message stale");

  await DB.prepare("UPDATE outbox SET sending_started_at=datetime('now','-15 minutes') WHERE dedup_key='old'").run();
  await recoverStuck({DB});
  row=await DB.prepare("SELECT state,sending_started_at FROM outbox WHERE dedup_key='old'").first();
  assert.equal(row.state,"pending");
  assert.equal(row.sending_started_at,null);
 }finally{await mf.dispose()}
});
