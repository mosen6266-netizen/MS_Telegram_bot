// @ts-nocheck
import {notifyAdmin,esc} from "./core";
const platforms=[
  {name:"Alchemy",metric:"alchemy_cu",kind:"official_api_required",detail:"Compute Units / Webhooks"},
  {name:"Cloudflare Workers",metric:"workers_requests",kind:"official_api_required",detail:"Requests / CPU"},
  {name:"Cloudflare D1",metric:"d1_reads",kind:"official_api_required",detail:"Rows read / written / storage"},
  {name:"Cloudflare Queues",metric:"queue_ops",kind:"official_api_required",detail:"Operations / backlog"},
  {name:"Etherscan",metric:"etherscan_requests",kind:"internal_counter",detail:"API calls / rate limits"},
  {name:"Telegram",metric:"telegram_notifications",kind:"internal_counter",detail:"Sent messages / rate limits"},
  {name:"GitHub",metric:"github_actions",kind:"official_api_required",detail:"Actions minutes / storage"}
];
export async function usageSnapshot(env){
  const {results:limits}=await env.DB.prepare("SELECT * FROM usage_limits").all();
  const {results:days}=await env.DB.prepare("SELECT metric,day,value FROM counters WHERE day>=date('now','-34 days')").all();
  const indexed=new Map((limits||[]).map(x=>[x.metric,x]));
  const d=new Date();
  const today=d.toISOString().slice(0,10),month=today.slice(0,7);
  return platforms.map(p=>{
    const limit=indexed.get(p.metric);
    const rows=(days||[]).filter(x=>x.metric===p.metric);
    const used=limit?rows.filter(x=>limit.period==="monthly"?x.day.startsWith(month):x.day===today).reduce((n,x)=>n+x.value,0):null;
    const past7=rows.filter(x=>x.day>=new Date(Date.now()-7*86400000).toISOString().slice(0,10)).reduce((n,x)=>n+x.value,0);
    const dailyAvg=past7/7;
    const remaining=limit?Math.max(0,limit.quota-used):null;
    const daysLeft=limit&&dailyAvg>0?remaining/dailyAvg:null;
    return {...p,quota:limit?.quota??null,period:limit?.period??null,source:limit?.source||"not_connected",
      used,remaining,percentage:limit?Math.round(1000*used/limit.quota)/10:null,
      predicted_exhaust_days:daysLeft===null?null:Math.round(daysLeft*10)/10,
      threshold_alert:limit?used/limit.quota>=0.8:false,
      forecast_alert:daysLeft!==null && daysLeft<=7,
      accurate_official_usage:false};
  });
}
export async function runUsageAlerts(env){
  if(!env.ADMIN_TELEGRAM_CHAT_ID)return;
  const rows=await usageSnapshot(env);
  for(const s of rows){
    if(!s.quota)continue;
    const key=s.period==="monthly"?new Date().toISOString().slice(0,7):new Date().toISOString().slice(0,10);
    for(const [kind,hit] of [["80_percent",s.threshold_alert],["7_day_forecast",s.forecast_alert]]){
      if(!hit)continue;
      const res=await env.DB.prepare("INSERT OR IGNORE INTO usage_alerts(metric,alert_kind,period_key) VALUES(?,?,?)").bind(s.metric,kind,key).run();
      if(!res.meta?.changes)continue;
      await notifyAdmin(env,"⚠️ <b>平台用量预警（系统内部统计，非官方账单）</b>\n平台："+esc(s.name)+"\n指标："+esc(s.metric)+"\n已用："+s.used+"/"+s.quota+" "+esc(s.unit)+"\n使用率："+s.percentage+"%\n剩余天数预估："+(s.predicted_exhaust_days??"暂无法预测")+"\n原因："+kind);
    }
  }
}
