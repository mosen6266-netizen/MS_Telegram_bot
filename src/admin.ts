// @ts-nocheck
import {addr,json,audit,short,now} from "./core";
import {addSpender} from "./approval";
import {usageSnapshot} from "./usage";
import {defaults} from "./notifications";
import {ADMIN_HTML} from "./admin-ui";
export const adminHtml=()=>ADMIN_HTML;
const bad=(message,status=400)=>json({error:message},status);
const body=async req=>{try{return await req.json()}catch{return {}}};
export async function handleAdmin(req,env,path){
  if(!env.ADMIN_API_TOKEN||req.headers.get("authorization")!=="Bearer "+env.ADMIN_API_TOKEN)return bad("管理员验证失败",401);
  const method=req.method;
  if(method==="GET"&&path==="/api/summary"){
    const qs=["SELECT count(*) n FROM wallets","SELECT count(*) n FROM spender_rules WHERE enabled=1","SELECT count(*) n FROM subscriptions WHERE status='active'","SELECT count(*) n FROM outbox WHERE state='failed'","SELECT count(*) n FROM transfer_events WHERE date(created_at)=date('now')"];
    const v=[];for(const q of qs)v.push((await env.DB.prepare(q).first())?.n||0);
    return json({wallets:v[0],spenders:v[1],subscriptions:v[2],failed:v[3],transfers_today:v[4]});
  }
  if(method==="GET"&&path==="/api/chats")return json((await env.DB.prepare("SELECT * FROM telegram_chats ORDER BY title").all()).results);
  if(method==="GET"&&path==="/api/wallets")return json((await env.DB.prepare("SELECT w.*,ww.state watch_state FROM wallets w LEFT JOIN wallet_watches ww USING(address) ORDER BY w.created_at DESC LIMIT 200").all()).results);
  if(method==="POST"&&path==="/api/wallets"){
    const d=await body(req),a=addr(d.address);if(!a)return bad("无效的 Ethereum 地址");
    await env.DB.prepare("INSERT OR IGNORE INTO wallets(address,discovery_source) VALUES(?,'admin')").bind(a).run();
    if(d.chat_id){
      const chat=String(d.chat_id);
      if(!(await env.DB.prepare("SELECT 1 FROM telegram_chats WHERE chat_id=?").bind(chat).first()))return bad("机器人必须先加入这个 Telegram 群组");
      const remark=String(d.remark||"待核验 · "+short(a)).trim().slice(0,80);
      await env.DB.prepare("INSERT OR IGNORE INTO subscriptions(chat_id,address,remark,status) VALUES(?,?,?,'pending')").bind(chat,a,remark).run();
    }
    await audit(env,"admin","create_wallet",a);
    return json({ok:true,monitored:false,note:"地址已存档。必须核实有效 USDT 授权才能启动资金监控。"});
  }
  if(method==="GET"&&path==="/api/spenders")return json((await env.DB.prepare("SELECT s.*,group_concat(r.chat_id) groups FROM spender_rules s LEFT JOIN spender_routes r USING(spender) GROUP BY s.spender ORDER BY s.created_at DESC LIMIT 200").all()).results);
  if(method==="POST"&&path==="/api/spenders"){
    const d=await body(req),a=addr(d.spender);if(!a)return bad("Spender 地址无效");
    const groups=[...new Set((Array.isArray(d.chat_ids)?d.chat_ids:[]).map(String).filter(x=>/^-?\d+$/.test(x)))];
    if(!groups.length)return bad("必须选择至少一个 Telegram 群组");
    for(const chat of groups)if(!(await env.DB.prepare("SELECT 1 FROM telegram_chats WHERE chat_id=?").bind(chat).first()))return bad("未登记的群组："+chat);
    await addSpender(env,a,String(d.remark||"Spender "+short(a)).slice(0,80),groups);
    await audit(env,"admin","create_spender",a,{groups});
    return json({ok:true,mode:"new_approvals_only",note:"只监控新授权 Owner 的资金，不自动监控 Spender 自身。"});
  }
  if(method==="PATCH"&&path==="/api/spenders"){
    const d=await body(req),a=addr(d.spender);if(!a)return bad("无效 Spender");
    if(d.enabled!==undefined)await env.DB.prepare("UPDATE spender_rules SET enabled=? WHERE spender=?").bind(d.enabled?1:0,a).run();
    if(d.remark!==undefined){
      const remark=String(d.remark).trim();if(!remark||remark.length>80)return bad("备注长度为 1–80 字符");
      await env.DB.prepare("UPDATE spender_rules SET remark=? WHERE spender=?").bind(remark,a).run();
    }
    await audit(env,"admin","update_spender",a);
    return json({ok:true});
  }
  if(method==="GET"&&path==="/api/subscriptions")return json((await env.DB.prepare("SELECT s.*,c.title FROM subscriptions s LEFT JOIN telegram_chats c USING(chat_id) ORDER BY s.updated_at DESC LIMIT 200").all()).results);
  if(method==="PATCH"&&path==="/api/subscriptions"){
    const d=await body(req),a=addr(d.address),chat=String(d.chat_id||"");if(!a||!/^-?\d+$/.test(chat))return bad("无效订阅地址或群组");
    const old=await env.DB.prepare("SELECT * FROM subscriptions WHERE address=? AND chat_id=?").bind(a,chat).first();if(!old)return bad("订阅不存在",404);
    if(d.remark!==undefined){
      const text=String(d.remark).trim();if(!text||Array.from(text).length>80)return bad("备注长度为 1–80 字符");
      await env.DB.prepare("UPDATE subscriptions SET remark=?,remark_version=remark_version+1,updated_at=? WHERE chat_id=? AND address=?").bind(text,now(),chat,a).run();
      await env.DB.prepare("INSERT INTO remark_edits(chat_id,address,actor_id,old_value,new_value) VALUES(?,?,?,?,?)").bind(chat,a,"admin",old.remark,text).run();
    }
    if(d.status!==undefined){
      if(!["active","paused","removed"].includes(d.status))return bad("状态无效");
      if(d.status==="active"&&(await env.DB.prepare("SELECT state FROM wallet_watches WHERE address=?").bind(a).first())?.state!=="active")return bad("Alchemy 未完成订阅，不能标记为监控中",409);
      await env.DB.prepare("UPDATE subscriptions SET status=?,updated_at=? WHERE chat_id=? AND address=?").bind(d.status,now(),chat,a).run();
    }
    await audit(env,"admin","update_subscription",a,{chat});
    return json({ok:true});
  }
  if(method==="GET"&&path==="/api/templates")return json({defaults,overrides:(await env.DB.prepare("SELECT * FROM templates").all()).results});
  if(method==="PUT"&&path==="/api/templates"){
    const d=await body(req),key=String(d.template_key||""),chat=String(d.chat_id||"*"),txt=String(d.body||"");
    if(!Object.hasOwn(defaults,key)||!/^(\*|-?\d+)$/.test(chat)||!txt.trim()||txt.length>3500)return bad("模板类型、群组或长度不合法");
    await env.DB.prepare("INSERT INTO templates(template_key,chat_id,body) VALUES(?,?,?) ON CONFLICT(template_key,chat_id) DO UPDATE SET body=excluded.body,version=templates.version+1,updated_at=CURRENT_TIMESTAMP").bind(key,chat,txt).run();
    await audit(env,"admin","update_template",key,{chat});
    return json({ok:true});
  }
  if(method==="GET"&&path==="/api/transfers")return json((await env.DB.prepare("SELECT * FROM transfer_events ORDER BY block_number DESC LIMIT 200").all()).results);
  if(method==="GET"&&path==="/api/outbox")return json((await env.DB.prepare("SELECT id,chat_id,address,template_key,state,attempts,last_error,created_at FROM outbox ORDER BY id DESC LIMIT 200").all()).results);
  if(method==="GET"&&path==="/api/audit")return json((await env.DB.prepare("SELECT * FROM admin_audit ORDER BY id DESC LIMIT 200").all()).results);
  if(method==="GET"&&path==="/api/usage")return json({warning_threshold_percent:80,forecast_days:7,telegram_dm:true,email:false,source_warning:"官方账单 API 未接入；内部计数不等于平台真实用量。",platforms:await usageSnapshot(env)});
  if(method==="PUT"&&path==="/api/usage/limit"){
    const d=await body(req);
    const allowed={"alchemy_cu":"Alchemy","workers_requests":"Cloudflare Workers","d1_reads":"Cloudflare D1","queue_ops":"Cloudflare Queues","etherscan_requests":"Etherscan","telegram_notifications":"Telegram","github_actions":"GitHub"};
    if(!allowed[d.metric]||!["daily","monthly"].includes(d.period)||!Number.isSafeInteger(d.quota)||d.quota<1)return bad("配额参数无效");
    await env.DB.prepare("INSERT INTO usage_limits(metric,platform,unit,quota,period) VALUES(?,?,?,?,?) ON CONFLICT(metric) DO UPDATE SET quota=excluded.quota,period=excluded.period,updated_at=CURRENT_TIMESTAMP").bind(d.metric,allowed[d.metric],String(d.unit||"units"),d.quota,d.period).run();
    await audit(env,"admin","update_usage_limit",d.metric,{quota:d.quota});
    return json({ok:true,source:"internal_estimate"});
  }
  return bad("Unknown admin route",404);
}
