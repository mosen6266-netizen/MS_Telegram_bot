import test from "node:test";
import assert from "node:assert/strict";
import {buildSync} from "esbuild";
import {Miniflare,convertV4MiniflareOptions} from "miniflare";

const bundled=buildSync({stdin:{
  contents:'export {usageSnapshot,USAGE_METERS} from "./src/usage";',
  resolveDir:process.cwd(),loader:"ts"
},bundle:true,platform:"node",format:"esm",write:false}).outputFiles[0].text;
const {usageSnapshot,USAGE_METERS}=await import("data:text/javascript;base64,"+Buffer.from(bundled).toString("base64"));

test("fees overview batches all 9 meter baselines into two D1 roundtrips while preserving alert safety",async()=>{
 const mf=new Miniflare(convertV4MiniflareOptions({name:"usage-batch-performance",modules:true,
  script:'export default {fetch(){return new Response("ok")}}',
  d1Databases:{DB:"usage-batch-performance"}}));
 try{
  const DB=await mf.getD1Database("DB");
  for(const sql of [
   "CREATE TABLE usage_samples(metric TEXT PRIMARY KEY,used REAL,quota REAL,unit TEXT,period_start TEXT,period_end TEXT,observed_at TEXT,source TEXT,scope TEXT,extra_json TEXT)",
   "CREATE TABLE usage_collectors(provider TEXT PRIMARY KEY,last_error TEXT)",
   "CREATE TABLE usage_observations(metric TEXT,observed_at TEXT,used REAL,period_start TEXT,source TEXT,PRIMARY KEY(metric,observed_at))",
   "CREATE TABLE runtime_state(key TEXT PRIMARY KEY,value TEXT)"
  ])await DB.prepare(sql).run();
  const now=new Date(),at=now.toISOString(),relative=ms=>new Date(+now-ms).toISOString();
  const start=relative(48*3600000),end=new Date(+now+48*3600000).toISOString();
  const source="official_api";
  const statements=USAGE_METERS.map(meter=>
   DB.prepare("INSERT INTO usage_samples(metric,used,quota,unit,period_start,period_end,observed_at,source,scope,extra_json) VALUES(?,900,1000,?,?,?,?,?,?,'{}')")
     .bind(meter.metric,meter.unit,start,end,at,source,"Test account")
  );
  await DB.batch(statements);
  await DB.batch([
   DB.prepare("INSERT INTO usage_observations(metric,observed_at,used,period_start,source) VALUES('alchemy_cu',?,?,?,?)").bind(relative(3600000),700,start,source),
   DB.prepare("INSERT INTO usage_observations(metric,observed_at,used,period_start,source) VALUES('alchemy_cu',?,?,?,?)").bind(relative(5*60000),899,start,source),
   DB.prepare("INSERT INTO usage_observations(metric,observed_at,used,period_start,source) VALUES('workers_requests',?,?,?,?)").bind(relative(3600000),700,"different billing period",source),
   DB.prepare("INSERT INTO usage_observations(metric,observed_at,used,period_start,source) VALUES('d1_reads',?,?,?,?)").bind(relative(3600000),700,start,"other source"),
   DB.prepare("INSERT INTO usage_observations(metric,observed_at,used,period_start,source) VALUES('telegram_notifications',?,?,?,?)").bind(relative(3600000),700,start,source),
   DB.prepare("INSERT INTO usage_collectors(provider,last_error) VALUES('internal','Collector unavailable')"),
   DB.prepare("INSERT INTO runtime_state(key,value) VALUES('usage_github_visibility','public')")
  ]);
  const counters={batches:0,prepared:0,first:0};
  const wrapped={
   batch(requests){counters.batches++;return DB.batch(requests)},
   prepare(sql){counters.prepared++;return DB.prepare(sql)}
  };
  const rows=await usageSnapshot({DB:wrapped});
  assert.equal(counters.batches,2,"fees display should make two D1 roundtrips, regardless of meter count");
  assert.equal(counters.prepared,3+USAGE_METERS.length);
  assert.equal(rows.length,USAGE_METERS.length+1);
  const find=metric=>rows.find(x=>x.metric===metric);
  assert.equal(find("alchemy_cu").forecast_ready,true);
  assert.equal(find("alchemy_cu").forecast_alert,true);
  assert.equal(find("alchemy_cu").threshold_alert,true);
  assert.equal(find("workers_requests").forecast_ready,false,"previous billing period must not be compared");
  assert.equal(find("d1_reads").forecast_ready,false,"wrong data source must not become forecast baseline");
  assert.equal(find("telegram_notifications").status,"error");
  assert.equal(find("telegram_notifications").threshold_alert,false,"collector failures suppress alerts");
  assert.equal(find("telegram_notifications").forecast_alert,false);
  assert.equal(find("github_actions").status,"not_applicable");

  // A new DB with no observations should still use one database roundtrip.
  await DB.prepare("DELETE FROM usage_samples").run();
  counters.batches=0;counters.prepared=0;
  const empty=await usageSnapshot({DB:wrapped});
  assert.equal(counters.batches,1);
  assert.equal(counters.prepared,3);
  assert.equal(empty.find(x=>x.metric==="alchemy_cu").status,"waiting");
 }finally{await mf.dispose()}
});
