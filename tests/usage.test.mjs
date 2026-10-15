import test from "node:test";
import assert from "node:assert/strict";
import {readFileSync,readdirSync} from "node:fs";
import {buildSync} from "esbuild";
import {Miniflare,convertV4MiniflareOptions} from "miniflare";
import {assessUsage,dayPeriod,monthPeriod,parseAlchemySummary,parseCloudflareDay,cloudflareDayQuery} from "../src/usage-math.ts";

const at=new Date("2026-10-15T12:00:00Z");
const point=(extra={})=>({used:800,quota:1000,period_start:"2026-10-01T00:00:00Z",period_end:"2026-11-01T00:00:00Z",
  observed_at:at.toISOString(),source:"official_api",...extra});
test("80% threshold uses the actual fraction, not a rounded display percentage",()=>{
  assert.equal(assessUsage(point({used:799.99}),null,at).threshold_alert,false);
  assert.equal(assessUsage(point(),null,at).threshold_alert,true);
});
test("seven-day forecast uses elapsed observations and only warns before the next reset",()=>{
  const previous=point({used:790,observed_at:"2026-10-15T00:00:00Z"});
  const current=point({used:900});
  assert.equal(assessUsage(current,previous,at).forecast_alert,true);
  const daily={period_start:"2026-10-15T00:00:00Z",period_end:"2026-10-16T00:00:00Z"};
  assert.equal(assessUsage(point({...daily,used:100}),point({...daily,used:90,observed_at:"2026-10-15T11:00:00Z"}),at).forecast_alert,false);
});
test("new, stale, reset and counter-decrease observations cannot create false forecasts",()=>{
  assert.equal(assessUsage(point(),null,at).forecast_ready,false);
  assert.equal(assessUsage(point({observed_at:"2026-10-15T10:00:00Z"}),null,at).threshold_alert,false);
  assert.equal(assessUsage(point(),point({period_start:"2026-09-01T00:00:00Z",observed_at:"2026-10-15T11:00:00Z"}),at).forecast_ready,false);
  assert.equal(assessUsage(point({used:700}),point({observed_at:"2026-10-15T11:00:00Z"}),at).forecast_ready,false);
  assert.equal(assessUsage(point({quota:null}),null,at).threshold_alert,false);
});
test("UTC boundaries handle month-end billing dates",()=>{
  assert.deepEqual(dayPeriod(new Date("2026-10-15T23:59:00Z")),{start:"2026-10-15T00:00:00.000Z",end:"2026-10-16T00:00:00.000Z"});
  assert.deepEqual(monthPeriod(new Date("2026-02-15T12:00:00Z"),31),{start:"2026-01-31T00:00:00.000Z",end:"2026-02-28T00:00:00.000Z"});
});

const cfBody=()=>({data:{viewer:{accounts:[{
  workers:[{sum:{requests:1017,cpuTimeUs:3162519}}],
  d1:[{sum:{rowsRead:909737,rowsWritten:331}}],
  queues:[{sum:{billableOperations:6}}],
  storage:[{dimensions:{databaseId:"a"},max:{databaseSizeBytes:258048}}]
}]}}});
function alchemyBody(used=900){
  const period=monthPeriod(new Date());
  return {data:{billingPeriod:{startTime:period.start,endTime:period.end},
    usageLimit:{used:String(used),limit:"1000"},freshness:{dataThrough:new Date().toISOString()},
    totals:{monthToDate:{usd:"0.00"}}}};
}
test("official response parsers reject missing data, negatives and partial GraphQL failures",()=>{
  assert.equal(parseCloudflareDay(cfBody()).workers_cpu_ms,3162.519);
  assert.throws(()=>parseCloudflareDay({data:{viewer:{accounts:[{}]}}}));
  assert.throws(()=>parseCloudflareDay({...cfBody(),errors:[{message:"forbidden"}]}));
  assert.throws(()=>parseAlchemySummary({data:{}}));
  const bad=alchemyBody();bad.data.usageLimit.used="-1";
  assert.throws(()=>parseAlchemySummary(bad));
  assert.match(cloudflareDayQuery("415c5fcdf1106b794d36f6dd0853e326","2026-10-15"),/billableOperations/);
  assert.throws(()=>cloudflareDayQuery("injection","2026-10-15"));
});

const compiled=buildSync({stdin:{contents:'export * from "./src/usage"; export {flushOutbox} from "./src/notifications"; export {telegram} from "./src/core";',
  resolveDir:process.cwd(),loader:"ts"},bundle:true,format:"esm",platform:"node",write:false}).outputFiles[0].text;
const implementation=await import("data:text/javascript;base64,"+Buffer.from(compiled).toString("base64"));
test("real D1: collect, preserve failed samples, deduplicate alerts and retry delivery",async()=>{
  const mf=new Miniflare(convertV4MiniflareOptions({name:"usage-test-worker",modules:true,script:'export default {fetch(){return new Response("ok")}}',d1Databases:{DB:"usage-tests"}}));
  const originalFetch=globalThis.fetch;
  let mode="ok",sends=0;
  globalThis.fetch=async(url,options)=>{
    const target=String(url);
    if(target==="https://api.cloudflare.com/client/v4/graphql")return Response.json(mode==="cf-error"?{errors:[{message:"denied"}]}:cfBody());
    if(target==="https://admin-api.alchemy.com/v1/usage/summary")return Response.json(alchemyBody());
    if(target==="https://api.github.com/repos/mosen6266-netizen/MS_Telegram_bot")return Response.json({private:false});
    if(target.startsWith("https://api.telegram.org/bot")){
      sends++;
      if(mode==="send-error")return Response.json({ok:false,description:"Too Many Requests",parameters:{retry_after:2}},{status:429});
      return Response.json({ok:true,result:{message_id:678}});
    }
    return originalFetch(url,options);
  };
  try{
    const DB=await mf.getD1Database("DB");
    for(const file of readdirSync("migrations").sort()){
      for(const sql of readFileSync("migrations/"+file,"utf8").split(";").map(x=>x.trim()).filter(Boolean))
        await DB.prepare(sql).run();
    }
    const env={DB,CF_ACCOUNT_ID:"415c5fcdf1106b794d36f6dd0853e326",
      CF_ANALYTICS_API_TOKEN:"test-cf-token",ALCHEMY_USAGE_TOKEN:"test-alchemy-token",
      TELEGRAM_BOT_TOKEN:"test-bot-token",ADMIN_TELEGRAM_CHAT_ID:"12345"};
    await implementation.saveUsageSettings(env,{cloudflare_plan:"free",cloudflare_billing_day:1});
    await implementation.collectUsage(env,true);
    let rows=await implementation.usageSnapshot(env);
    assert.equal(rows.find(x=>x.metric==="workers_requests").used,1017);
    assert.equal(rows.find(x=>x.metric==="d1_reads").quota,5000000);
    assert.equal(rows.find(x=>x.metric==="alchemy_cu").threshold_alert,true);
    assert.equal(rows.find(x=>x.metric==="telegram_notifications").used,0);
    assert.equal(rows.find(x=>x.metric==="github_actions").status,"not_applicable");

    mode="cf-error";
    await implementation.collectUsage(env,true);
    rows=await implementation.usageSnapshot(env);
    const failed=rows.find(x=>x.metric==="workers_requests");
    assert.equal(failed.used,1017);
    assert.equal(failed.status,"error");
    assert.equal(failed.threshold_alert,false);

    await implementation.runUsageAlerts(env);
    await implementation.runUsageAlerts(env);
    assert.equal((await DB.prepare("SELECT count(*) n FROM outbox").first()).n,1);
    mode="send-error";
    await implementation.flushOutbox(env,10,true);
    let message=await DB.prepare("SELECT * FROM outbox").first();
    assert.equal(message.state,"pending");
    assert.equal(message.attempts,1);
    assert.equal((await DB.prepare("SELECT value FROM counters WHERE metric='telegram_rate_limited'").first()).value,1);
    await DB.prepare("UPDATE outbox SET due_at=datetime('now','-1 minute')").run();
    mode="ok";
    await implementation.flushOutbox(env,10,true);
    message=await DB.prepare("SELECT * FROM outbox").first();
    assert.equal(message.state,"sent");
    assert.equal(message.telegram_message_id,678);
    assert.equal((await DB.prepare("SELECT value FROM counters WHERE metric='telegram_notifications'").first()).value,1);
    assert.equal(sends,2);

    const expired=JSON.stringify({alert_text:"expired",expires_at:"2000-01-01T00:00:00Z"});
    await DB.prepare("INSERT INTO outbox(dedup_key,chat_id,template_key,payload_json) VALUES('expired','12345','usage_alert',?)").bind(expired).run();
    await implementation.flushOutbox(env,10,true);
    assert.equal((await DB.prepare("SELECT state FROM outbox WHERE dedup_key='expired'").first()).state,"skipped");
    assert.equal(sends,2);

    env.CF_ANALYTICS_API_TOKEN="";env.ALCHEMY_USAGE_TOKEN="";
    await implementation.collectUsage(env,true);
    rows=await implementation.usageSnapshot(env);
    assert.match(rows.find(x=>x.metric==="alchemy_cu").note,/待配置/);
    assert.equal(rows.find(x=>x.metric==="alchemy_cu").used,900);
    assert.equal(rows.find(x=>x.metric==="alchemy_cu").threshold_alert,false);
    assert.doesNotMatch(JSON.stringify(rows),/test-cf-token|test-alchemy-token|test-bot-token/);
  }finally{globalThis.fetch=originalFetch;await mf.dispose();}
});
