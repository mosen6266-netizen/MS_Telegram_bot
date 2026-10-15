import test from "node:test";
import assert from "node:assert/strict";
import {readFileSync,readdirSync} from "node:fs";
import {buildSync} from "esbuild";
import {Miniflare,convertV4MiniflareOptions} from "miniflare";

const src=buildSync({stdin:{contents:'export {collectUsage,USAGE_METERS} from "./src/usage";',
  resolveDir:process.cwd(),loader:"ts"},bundle:true,platform:"node",format:"esm",write:false}).outputFiles[0].text;
const {collectUsage,USAGE_METERS}=await import("data:text/javascript;base64,"+Buffer.from(src).toString("base64"));
const day={data:{viewer:{accounts:[{
  workers:[{sum:{requests:100,cpuTimeUs:20000}}],
  d1:[{sum:{rowsRead:350,rowsWritten:20}}],
  queues:[{sum:{billableOperations:5}}],
  storage:[{dimensions:{databaseId:"test-db"},max:{databaseSizeBytes:4096}}]
}]}}};

test("Cloudflare usage metrics commit atomically; one metric write error cannot leave partial usage snapshots",async()=>{
 const mf=new Miniflare(convertV4MiniflareOptions({name:"usage-cloudflare-atomic",modules:true,
  script:'export default {fetch(){return new Response("ok")}}',d1Databases:{DB:"usage-cloudflare-atomic"}}));
 const saved=globalThis.fetch;
 try{
  const DB=await mf.getD1Database("DB");
  for(const file of readdirSync("migrations").filter(x=>x.endsWith(".sql")).sort()){
    for(const stmt of readFileSync("migrations/"+file,"utf8").split(";").map(x=>x.trim()).filter(Boolean))
      await DB.prepare(stmt).run();
  }
  const meters=USAGE_METERS.filter(x=>x.provider==="cloudflare").map(x=>x.metric);
  assert.ok(meters.length>=5);
  globalThis.fetch=async url=>{
    if(String(url)==="https://api.cloudflare.com/client/v4/graphql")return Response.json(day);
    if(String(url).startsWith("https://api.github.com/"))return Response.json({private:false});
    throw Error("unexpected outbound service in isolated test");
  };
  const env={DB,CF_ANALYTICS_API_TOKEN:"synthetic-read-token",CF_ACCOUNT_ID:"415c5fcdf1106b794d36f6dd0853e326"};
  await DB.prepare("CREATE TRIGGER reject_one_cloudflare_sample BEFORE INSERT ON usage_samples "+
    "WHEN NEW.metric='d1_reads' BEGIN SELECT RAISE(ABORT,'synthetic D1 write failure'); END").run();
  await collectUsage(env,true);
  const absent=await DB.prepare("SELECT metric FROM usage_samples WHERE metric IN ('workers_requests','workers_cpu_ms','d1_reads','d1_writes','d1_storage_bytes','queue_ops')").all();
  assert.equal(absent.results.length,0,"a single Cloudflare metric failure must roll back the full provider snapshot");
  const failed=await DB.prepare("SELECT last_error FROM usage_collectors WHERE provider='cloudflare'").first();
  assert.match(failed.last_error,/synthetic D1 write failure/);

  await DB.prepare("DROP TRIGGER reject_one_cloudflare_sample").run();
  await collectUsage(env,true);
  const inserted=await DB.prepare("SELECT metric FROM usage_samples WHERE metric IN ('workers_requests','workers_cpu_ms','d1_reads','d1_writes','d1_storage_bytes','queue_ops')").all();
  assert.equal(inserted.results.length,meters.length);
  assert.equal((await DB.prepare("SELECT last_error FROM usage_collectors WHERE provider='cloudflare'").first()).last_error,null);
 }finally{globalThis.fetch=saved;await mf.dispose()}
});
