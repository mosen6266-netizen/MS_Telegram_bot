import {queueNotice} from "./core";
import {assessUsage,cloudflareDayQuery,dayPeriod,monthPeriod,parseAlchemySummary,parseCloudflareDay} from "./usage-math";
import type {UsagePoint} from "./usage-math";

export const USAGE_METERS=[
  {name:"Alchemy",metric:"alchemy_cu",detail:"团队 Compute Units",unit:"CU",provider:"alchemy"},
  {name:"Cloudflare Workers",metric:"workers_requests",detail:"账号请求数",unit:"次",provider:"cloudflare"},
  {name:"Cloudflare Workers CPU",metric:"workers_cpu_ms",detail:"账号 CPU 时间",unit:"毫秒",provider:"cloudflare"},
  {name:"Cloudflare D1 读取",metric:"d1_reads",detail:"账号读取行数",unit:"行",provider:"cloudflare"},
  {name:"Cloudflare D1 写入",metric:"d1_writes",detail:"账号写入行数",unit:"行",provider:"cloudflare"},
  {name:"Cloudflare D1 存储",metric:"d1_storage_bytes",detail:"账号每日最高存储合计",unit:"字节",provider:"cloudflare"},
  {name:"Cloudflare Queues",metric:"queue_ops",detail:"账号计费操作数",unit:"次",provider:"cloudflare"},
  {name:"Etherscan",metric:"etherscan_requests",detail:"本程序 API 请求数",unit:"次",provider:"internal"},
  {name:"Telegram",metric:"telegram_notifications",detail:"本程序成功发送消息数",unit:"条",provider:"internal"}
];
type Sample=UsagePoint&{metric:string;unit:string;scope:string;extra_json?:string};
type Settings={cloudflare_plan:"unknown"|"free"|"standard";cloudflare_billing_day:number};
type Limit={metric:string;quota:number;period:"daily"|"monthly";unit:string};
type DayTotals=ReturnType<typeof parseCloudflareDay>;
type MeterView={name:string;metric:string;detail:string;unit:string;provider:string;source:string;status:string;
  used:number|null;quota:number|null;percentage:number|null;threshold_alert:boolean;forecast_alert:boolean;note:string;
  period_start?:string;period_end?:string;scope?:string;observed_at?:string;predicted_exhaust_days?:number|null;
  extra?:Record<string,unknown>;accurate_official_usage?:boolean;forecast_ready?:boolean;remaining?:number|null};
const ISO=()=>new Date().toISOString();

export async function usageSettings(env:Env):Promise<Settings>{
  const row=await env.DB.prepare("SELECT value FROM runtime_state WHERE key='usage_settings'").first<{value:string}>();
  const d=row?JSON.parse(row.value):{};
  return {cloudflare_plan:["free","standard"].includes(d.cloudflare_plan)?d.cloudflare_plan:"unknown",
    cloudflare_billing_day:Number.isInteger(d.cloudflare_billing_day)?d.cloudflare_billing_day:1};
}
export async function saveUsageSettings(env:Env,d:Settings){
  if(!["unknown","free","standard"].includes(d.cloudflare_plan)||!Number.isInteger(d.cloudflare_billing_day)||d.cloudflare_billing_day<1||d.cloudflare_billing_day>31)
    throw Error("请选择实际 Cloudflare 套餐和账期起始日");
  await env.DB.prepare("INSERT INTO runtime_state(key,value) VALUES('usage_settings',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=CURRENT_TIMESTAMP").bind(JSON.stringify(d)).run();
}
async function storeSample(env:Env,s:Sample){
  const complete=JSON.parse(s.extra_json||"{}").complete!==false;
  const statements=[
    env.DB.prepare("INSERT INTO usage_samples(metric,used,quota,unit,period_start,period_end,observed_at,source,scope,extra_json) VALUES(?,?,?,?,?,?,?,?,?,?) ON CONFLICT(metric) DO UPDATE SET used=excluded.used,quota=excluded.quota,unit=excluded.unit,period_start=excluded.period_start,period_end=excluded.period_end,observed_at=excluded.observed_at,source=excluded.source,scope=excluded.scope,extra_json=excluded.extra_json")
      .bind(s.metric,s.used,s.quota,s.unit,s.period_start,s.period_end,s.observed_at,s.source,s.scope,s.extra_json||"{}")
  ];
  // Backfilled history is not new consumption and must never become a forecast baseline.
  if(complete)statements.push(env.DB.prepare("INSERT OR IGNORE INTO usage_observations(metric,observed_at,used,period_start,source) VALUES(?,?,?,?,?)")
    .bind(s.metric,s.observed_at,s.used,s.period_start,s.source));
  await env.DB.batch(statements);
}
async function collector(env:Env,provider:string,work:()=>Promise<void>){
  const attempted=ISO();
  try{
    await work();
    await env.DB.prepare("INSERT INTO usage_collectors(provider,attempted_at,succeeded_at,last_error) VALUES(?,?,?,NULL) ON CONFLICT(provider) DO UPDATE SET attempted_at=excluded.attempted_at,succeeded_at=excluded.succeeded_at,last_error=NULL").bind(provider,attempted,ISO()).run();
  }catch(error){
    const message=error instanceof Error?error.message:"采集失败";
    await env.DB.prepare("INSERT INTO usage_collectors(provider,attempted_at,last_error) VALUES(?,?,?) ON CONFLICT(provider) DO UPDATE SET attempted_at=excluded.attempted_at,last_error=excluded.last_error").bind(provider,attempted,message.slice(0,250)).run();
  }
}
async function requestJson(url:string,init:RequestInit,provider:string):Promise<unknown>{
  const response=await fetch(url,{...init,signal:AbortSignal.timeout(12000)});
  if(!response.ok)throw Error(provider+" 采集失败（HTTP "+response.status+"），请检查只读凭证、权限和平台状态");
  return response.json();
}
async function collectAlchemy(env:Env){
  if(!env.ALCHEMY_USAGE_TOKEN)throw Error("待配置 Alchemy Usage read 只读访问 Key；RPC / Notify Key 不能读取用量");
  const body=await requestJson("https://admin-api.alchemy.com/v1/usage/summary",{headers:{Authorization:"Bearer "+env.ALCHEMY_USAGE_TOKEN}},"Alchemy");
  const data=parseAlchemySummary(body);
  if(data.extra.quota_source==="not_returned"){
    const limit=await env.DB.prepare("SELECT quota,period FROM usage_limits WHERE metric='alchemy_cu'").first<Limit>();
    if(limit?.period==="monthly"&&Number.isFinite(limit.quota)&&limit.quota>0){
      data.quota=limit.quota;
      data.extra.quota_source="configured_plan";
      data.extra.note="已用量来自官方 API；额度采用已确认的账号套餐基准，套餐变更后请更新";
    }
  }
  await storeSample(env,{...data,extra_json:JSON.stringify(data.extra)});
}
async function cfDay(env:Env,day:string){
  const body=await requestJson("https://api.cloudflare.com/client/v4/graphql",{method:"POST",
    headers:{"content-type":"application/json",Authorization:"Bearer "+env.CF_ANALYTICS_API_TOKEN},
    body:JSON.stringify({query:cloudflareDayQuery(env.CF_ACCOUNT_ID,day)})},"Cloudflare");
  const data=parseCloudflareDay(body);
  await env.DB.prepare("INSERT INTO usage_cf_days(day,payload_json,updated_at) VALUES(?,?,?) ON CONFLICT(day) DO UPDATE SET payload_json=excluded.payload_json,updated_at=excluded.updated_at").bind(day,JSON.stringify(data),ISO()).run();
  return data;
}
async function collectCloudflare(env:Env,settings:Settings){
  if(!env.CF_ANALYTICS_API_TOKEN)throw Error("待配置当前账号的 Account Analytics Read 只读令牌");
  const now=new Date(),today=now.toISOString().slice(0,10),monthly=monthPeriod(now,settings.cloudflare_billing_day),daily=dayPeriod(now);
  const rows=(await env.DB.prepare("SELECT day FROM usage_cf_days WHERE day>=?").bind(monthly.start.slice(0,10)).all<{day:string}>()).results;
  const cached=new Set(rows.map(x=>x.day));
  await cfDay(env,today);
  const yesterday=new Date(+now-86400000).toISOString().slice(0,10);
  if(yesterday>=monthly.start.slice(0,10))await cfDay(env,yesterday);
  const required:string[]=[];
  for(let time=Date.parse(monthly.start);time<+now;time+=86400000)required.push(new Date(time).toISOString().slice(0,10));
  for(const day of required.filter(d=>!cached.has(d)&&d!==today&&d!==yesterday).slice(0,4))await cfDay(env,day);
  const updated=(await env.DB.prepare("SELECT day,payload_json FROM usage_cf_days WHERE day>=? AND day<=?").bind(monthly.start.slice(0,10),today).all<{day:string;payload_json:string}>()).results;
  const totals=new Map(updated.map(x=>[x.day,JSON.parse(x.payload_json) as DayTotals]));
  const free=settings.cloudflare_plan==="free",known=settings.cloudflare_plan!=="unknown",period=free?daily:monthly;
  const complete=free||required.every(day=>totals.has(day)),last=totals.get(today);
  if(!last)throw Error("Cloudflare 当日用量未返回");
  const presets:Record<string,number|null>=free?
    {workers_requests:100000,workers_cpu_ms:null,d1_reads:5000000,d1_writes:100000,d1_storage_bytes:5e9,queue_ops:10000}:
    {workers_requests:10000000,workers_cpu_ms:30000000,d1_reads:25000000000,d1_writes:50000000,d1_storage_bytes:5e9,queue_ops:1000000};
  const limits=(await env.DB.prepare("SELECT * FROM usage_limits").all<Limit>()).results;
  for(const meter of USAGE_METERS.filter(x=>x.provider==="cloudflare")){
    const key=meter.metric as keyof DayTotals,storage=key==="d1_storage_bytes";
    const used=storage||free?last[key]:required.reduce((sum,day)=>sum+(totals.get(day)?.[key]||0),0);
    const limit=limits.find(x=>x.metric===key&&x.period===(free?"daily":"monthly"));
    await storeSample(env,{metric:key,used,quota:known&&complete?(limit?.quota??presets[key]):null,unit:meter.unit,
      period_start:storage?monthPeriod(now).start:period.start,period_end:storage?"9999-12-31T00:00:00.000Z":period.end,observed_at:ISO(),source:"official_api",scope:"Cloudflare 整个账号（含其他项目）",
      extra_json:JSON.stringify({plan:settings.cloudflare_plan,complete,missing_days:required.filter(d=>!totals.has(d)),
        note:!known?"请确认实际套餐后计算额度":!complete?"正在回填账期历史用量":storage?"当天最高存储合计，可能略高于当前值":"平台聚合数据可能有延迟"})});
  }
}
async function collectInternal(env:Env){
  const now=new Date(),daily=dayPeriod(now),monthly=monthPeriod(now);
  const rows=(await env.DB.prepare("SELECT metric,day,value FROM counters WHERE day>=?").bind(monthly.start.slice(0,10)).all<{metric:string;day:string;value:number}>()).results;
  const limits=(await env.DB.prepare("SELECT * FROM usage_limits").all<Limit>()).results;
  const started=(await env.DB.prepare("SELECT value FROM runtime_state WHERE key='usage_started_at'").first<{value:string}>())?.value;
  for(const meter of USAGE_METERS.filter(x=>x.provider==="internal")){
    const limit=limits.find(x=>x.metric===meter.metric),period=limit?.period==="monthly"?monthly:daily;
    await storeSample(env,{metric:meter.metric,used:rows.filter(x=>x.metric===meter.metric&&x.day>=period.start.slice(0,10)).reduce((n,x)=>n+x.value,0),
      quota:limit?.quota||null,unit:meter.unit,
      period_start:period.start,period_end:period.end,observed_at:ISO(),source:"application_counter",
      scope:"仅本程序，自 "+(started||"本次更新")+" 起统计",
      extra_json:JSON.stringify({rate_limited:rows.find(x=>x.metric==="telegram_rate_limited"&&x.day===daily.start.slice(0,10))?.value||0,
        note:meter.metric==="telegram_notifications"?"普通消息无固定月额度；显示成功发送量和限流次数":"按发起请求计数，包含失败尝试；不含其他程序使用此 Key 的请求"})});
  }
}
async function collectGithub(env:Env){
  const cached=await env.DB.prepare("SELECT value FROM runtime_state WHERE key='usage_github_checked_at'").first<{value:string}>();
  if(cached&&Date.now()-Date.parse(cached.value)<86400000)return;
  const data=await requestJson("https://api.github.com/repos/mosen6266-netizen/MS_Telegram_bot",{headers:{"user-agent":"Ethereum-Monitor",accept:"application/vnd.github+json"}},"GitHub") as {private?:boolean};
  if(typeof data.private!=="boolean")throw Error("GitHub 未返回仓库可见性");
  await env.DB.batch([
    env.DB.prepare("INSERT INTO runtime_state(key,value) VALUES('usage_github_visibility',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=CURRENT_TIMESTAMP").bind(data.private?"private":"public"),
    env.DB.prepare("INSERT INTO runtime_state(key,value) VALUES('usage_github_checked_at',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=CURRENT_TIMESTAMP").bind(ISO())
  ]);
}
export async function collectUsage(env:Env,force=false){
  const last=await env.DB.prepare("SELECT value FROM runtime_state WHERE key='usage_last_collect'").first<{value:string}>();
  if(!force&&last&&Date.now()-Date.parse(last.value)<15*60000)return {skipped:true};
  const lockId=crypto.randomUUID();
  const lock=await env.DB.prepare("INSERT INTO runtime_state(key,value) VALUES('usage_collect_lock',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=CURRENT_TIMESTAMP WHERE updated_at<datetime('now','-4 minutes')").bind(lockId).run();
  if(!lock.meta.changes)return {busy:true};
  try{
    const latest=await env.DB.prepare("SELECT value FROM runtime_state WHERE key='usage_last_collect'").first<{value:string}>();
    if(!force&&latest&&Date.now()-Date.parse(latest.value)<15*60000)return {skipped:true};
    await env.DB.prepare("INSERT INTO runtime_state(key,value) VALUES('usage_last_collect',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=CURRENT_TIMESTAMP").bind(ISO()).run();
    const settings=await usageSettings(env);
    const results=await Promise.allSettled([
      collector(env,"alchemy",()=>collectAlchemy(env)),collector(env,"cloudflare",()=>collectCloudflare(env,settings)),
      collector(env,"internal",()=>collectInternal(env)),collector(env,"github",()=>collectGithub(env))
    ]);
    for(const result of results)if(result.status==="rejected")throw result.reason;
    await env.DB.batch([
      env.DB.prepare("DELETE FROM usage_observations WHERE observed_at<?").bind(new Date(Date.now()-35*86400000).toISOString()),
      env.DB.prepare("DELETE FROM usage_cf_days WHERE day<date('now','-35 days')")
    ]);
    return {ok:true};
  }finally{await env.DB.prepare("DELETE FROM runtime_state WHERE key='usage_collect_lock' AND value=?").bind(lockId).run();}
}
export async function usageSnapshot(env:Env):Promise<MeterView[]>{
  const samples=(await env.DB.prepare("SELECT * FROM usage_samples").all<Sample>()).results;
  const collectors=(await env.DB.prepare("SELECT * FROM usage_collectors").all<{provider:string;last_error:string|null}>()).results;
  const rows:MeterView[]=[];
  for(const meter of USAGE_METERS){
    const sample=samples.find(x=>x.metric===meter.metric),health=collectors.find(x=>x.provider===meter.provider);
    if(!sample){rows.push({...meter,used:null,quota:null,percentage:null,status:"waiting",source:"not_connected",
      note:health?.last_error||"等待首次采集",threshold_alert:false,forecast_alert:false});continue;}
    const previous=await env.DB.prepare("SELECT * FROM usage_observations WHERE metric=? AND period_start=? AND source=? AND observed_at<=? AND observed_at>=? ORDER BY observed_at DESC LIMIT 1")
      .bind(meter.metric,sample.period_start,sample.source,new Date(Date.parse(sample.observed_at)-15*60000).toISOString(),new Date(Date.parse(sample.observed_at)-86400000).toISOString()).first<UsagePoint>();
    const assessment=assessUsage(sample,previous,new Date()),extra=JSON.parse(sample.extra_json||"{}");
    const valid=assessment.fresh&&!health?.last_error&&extra.complete!==false;
    rows.push({...meter,...sample,...assessment,extra,note:health?.last_error||extra.note||"",
      status:health?.last_error?"error":!assessment.fresh?"stale":extra.complete===false?"backfilling":"ok",
      threshold_alert:valid&&assessment.threshold_alert,forecast_alert:valid&&assessment.forecast_alert,
      accurate_official_usage:sample.source==="official_api"});
  }
  const repo=(await env.DB.prepare("SELECT value FROM runtime_state WHERE key='usage_github_visibility'").first<{value:string}>())?.value;
  const githubError=collectors.find(x=>x.provider==="github")?.last_error;
  rows.push({name:"GitHub",metric:"github_actions",detail:"代码仓库 / 标准 Actions",unit:"分钟",provider:"github",
    source:repo?"official_repository":"not_connected",status:githubError?"error":repo==="public"?"not_applicable":"waiting",
    used:null,quota:null,percentage:null,threshold_alert:false,forecast_alert:false,
    note:githubError||(repo==="public"?"当前为公开仓库，标准 Actions 不消耗私有仓库分钟包；程序日常监控运行在 Cloudflare":"仓库可见性未确认或为私有，需另外配置账单读取权限")});
  return rows;
}
export async function runUsageAlerts(env:Env){
  if(!env.ADMIN_TELEGRAM_CHAT_ID)return;
  for(const row of await usageSnapshot(env)){
    if(!row.period_start||!row.period_end)continue;
    for(const [kind,hit]of [["80_percent",row.threshold_alert],["7_day_forecast",row.forecast_alert]]as const){
      if(!hit)continue;
      const text="平台："+row.name+"\n范围："+row.scope+"\n已用："+row.used+" / "+row.quota+" "+row.unit+
        "\n使用率："+row.percentage+"%\n额度重置："+row.period_end+
        "\n原因："+(kind==="80_percent"?"使用率已达到 80%":"按近期实际增量预计 7 天内耗尽，且早于额度重置")+
        "\n来源："+(row.source==="official_api"?"平台官方用量（可能有统计延迟）":"本程序调用计数，非官方账单");
      await queueNotice(env,{dedup:"usage:"+row.metric+":"+kind+":"+row.period_start,chat_id:env.ADMIN_TELEGRAM_CHAT_ID,
        address:null,template:"usage_alert",payload:{alert_text:text,expires_at:row.period_end}});
    }
  }
}
export async function queueUsageTest(env:Env){
  if(!env.ADMIN_TELEGRAM_CHAT_ID)throw Error("请先绑定管理员 Telegram 私聊");
  const dedup="usage-test:"+crypto.randomUUID();
  await queueNotice(env,{dedup,chat_id:env.ADMIN_TELEGRAM_CHAT_ID,address:null,
    template:"usage_alert",payload:{alert_text:"🧪 费用预警通道测试\n这是一条测试消息，不代表真实用量已达到预警阈值。\n发送时间："+ISO(),
      expires_at:new Date(Date.now()+5*60000).toISOString()}});
  return dedup;
}
