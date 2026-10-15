// @ts-nocheck
import {addr,json,audit,short,now,ensureWatch} from "./core";
import {addSpender} from "./approval";
import {saveWalletRemark,walletRemark} from "./wallet-remarks";
import {startSpenderHistory} from "./spender-history";
import {sourceInsert,assignSpenderSourcesForRoute,removeSpenderRouteSourceStatements,retainDeletedSpenderSources,listLegacySubscriptions} from "./subscription-sources";
import {requeueFailedOutbox,listOutboxPage} from "./outbox-operations";
import {lastAlchemyReconciliation} from "./alchemy-reconcile";
import {usageSnapshot,usageSettings,saveUsageSettings,collectUsage,runUsageAlerts,queueUsageTest,USAGE_METERS} from "./usage";
import {flushOutbox} from "./notifications";
import {defaults,templateCatalog} from "./notifications";
import {ADMIN_HTML} from "./admin-ui";
import {isAdmin,configEnv} from "./setup";
import {removeWatch} from "./core";
export const adminHtml=()=>ADMIN_HTML;
const bad=(message,status=400)=>json({error:message},status);
const body=async req=>{try{return await req.json()}catch{return {}}};
export async function handleAdmin(req,env,path){
  if(!await isAdmin(req,env))return bad("管理员验证失败或请求来源无效",401);
  const method=req.method;
  if(method==="GET"&&path==="/api/summary"){
    const qs=["SELECT count(*) n FROM wallets","SELECT count(*) n FROM spender_rules WHERE enabled=1","SELECT count(*) n FROM subscriptions WHERE status='active'","SELECT count(*) n FROM outbox WHERE state='failed'","SELECT count(*) n FROM transfer_events WHERE date(created_at)=date('now')","SELECT count(*) n FROM telegram_message_cleanup WHERE state='blocked'","SELECT count(*) n FROM telegram_message_cleanup WHERE state='pending'"];
    // One D1 roundtrip instead of seven consecutive count queries.
    const results=await env.DB.batch(qs.map(q=>env.DB.prepare(q)));
    const v=results.map(result=>result.results?.[0]?.n||0);
    return json({wallets:v[0],spenders:v[1],subscriptions:v[2],failed:v[3],transfers_today:v[4],cleanup_blocked:v[5],cleanup_pending:v[6]});
  }
  if(method==="GET"&&path==="/api/chats")return json((await env.DB.prepare("SELECT * FROM telegram_chats ORDER BY title").all()).results);
  if(method==="GET"&&path==="/api/monitoring/reconciliation"){
    // Admin authentication is verified above. This endpoint never contacts
    // Alchemy or exposes the notify token; it serves the last safe snapshot.
    return json(await lastAlchemyReconciliation(env.DB));
  }
  if(method==="GET"&&path==="/api/monitoring"){
    const q=new URL(req.url).searchParams;
    const page=Math.min(100000,Math.max(0,parseInt(q.get("page")||"0",10)||0));
    const status=q.get("status")||"all",search=String(q.get("search")||"").trim().slice(0,90);
    if(!["all","active","pending","removal_pending"].includes(status))return bad("监控状态筛选无效");
    const where="ww.state IN ('active','pending','removal_pending') AND (w.deleted_at IS NULL OR w.address IS NULL)"
      +(status==="all"?"":" AND ww.state=?")
      +(search?" AND (ww.address LIKE ? OR COALESCE(g.remark,(SELECT remark FROM subscriptions s WHERE s.address=ww.address ORDER BY s.updated_at DESC LIMIT 1),'') LIKE ?)":"");
    const args=[...(status==="all"?[]:[status]),...(search?["%"+search+"%","%"+search+"%"]:[])];
    const countQuery=env.DB.prepare("SELECT COUNT(*) n FROM wallet_watches ww LEFT JOIN wallets w ON w.address=ww.address LEFT JOIN wallet_global_remarks g ON g.address=ww.address WHERE "+where).bind(...args);
    const rowsQuery=env.DB.prepare(
      "SELECT ww.address,ww.state,ww.synced_at,ww.updated_at,ww.last_error,w.discovery_source,w.first_user_name,"+
      "COALESCE(g.remark,(SELECT s.remark FROM subscriptions s WHERE s.address=ww.address ORDER BY s.updated_at DESC LIMIT 1),w.first_user_name,'待备注') AS remark,"+
      "(SELECT GROUP_CONCAT(DISTINCT COALESCE(c.title,s.chat_id)) FROM subscriptions s LEFT JOIN telegram_chats c ON c.chat_id=s.chat_id WHERE s.address=ww.address AND s.status IN ('active','pending')) AS groups,"+
      "(SELECT COUNT(*) FROM subscriptions s WHERE s.address=ww.address AND s.status='active') AS active_groups,"+
      "(SELECT COUNT(*) FROM spender_history_addresses h WHERE h.owner=ww.address) AS history_spenders "+
      "FROM wallet_watches ww LEFT JOIN wallets w ON w.address=ww.address LEFT JOIN wallet_global_remarks g ON g.address=ww.address WHERE "+where+
      " ORDER BY ww.updated_at DESC LIMIT 50 OFFSET ?"
    ).bind(...args,page*50);
    const summaryQuery=env.DB.prepare("SELECT state,COUNT(*) n FROM wallet_watches WHERE state IN ('active','pending','removal_pending') GROUP BY state");
    const [countResult,rowsResult,summaryResult]=await env.DB.batch([countQuery,rowsQuery,summaryQuery]);
    const total=countResult.results?.[0]?.n||0,rows=rowsResult.results||[],summary=summaryResult.results||[];
    return json({rows,total,page,total_pages:Math.ceil(total/50),summary});
  }
  if(method==="POST"&&path==="/api/monitoring/remark"){
    const d=await body(req),address=addr(d.address);
    if(!address)return bad("钱包地址无效");
    const watch=await env.DB.prepare("SELECT state FROM wallet_watches WHERE address=?").bind(address).first();
    if(!watch||watch.state==="removed")return bad("此地址当前不在监控列表中",404);
    const previous=await walletRemark(env,address,"");
    let remark;
    try{remark=await saveWalletRemark(env,address,d.remark)}catch(e){return bad(String(e.message||e))}
    await audit(env,"admin","global_wallet_remark",address,{previous,remark});
    return json({ok:true,remark,note:"此地址备注已同步所有群组、后台列表与后续消息"});
  }
  if(method==="GET"&&path==="/api/wallets")return json((await env.DB.prepare("SELECT w.*,ww.state watch_state,COALESCE(g.remark,(SELECT s.remark FROM subscriptions s WHERE s.address=w.address ORDER BY s.updated_at DESC LIMIT 1),w.first_user_name) remark FROM wallets w LEFT JOIN wallet_watches ww USING(address) LEFT JOIN wallet_global_remarks g USING(address) ORDER BY w.created_at DESC LIMIT 200").all()).results);
  if(method==="POST"&&path==="/api/wallets"){
    const d=await body(req),a=addr(d.address);if(!a)return bad("无效的 Ethereum 地址");
    await env.DB.prepare("INSERT OR IGNORE INTO wallets(address,discovery_source) VALUES(?,'admin')").bind(a).run();
    if(d.chat_id){
      const chat=String(d.chat_id);
      if(!(await env.DB.prepare("SELECT 1 FROM telegram_chats WHERE chat_id=?").bind(chat).first()))return bad("机器人必须先加入这个 Telegram 群组");
      const remark=await walletRemark(env,a,String(d.remark||"待核验 · "+short(a)).trim().slice(0,80));
      await env.DB.prepare("INSERT OR IGNORE INTO subscriptions(chat_id,address,remark,status) VALUES(?,?,?,'pending')").bind(chat,a,remark).run();
      await sourceInsert(env.DB,chat,a,"admin","admin").run();
      await env.TASKS.send({kind:"verify_admin",owner:a,chat_id:chat});
    }
    await audit(env,"admin","create_wallet",a);
    return json({ok:true,monitored:false,note:"地址已存档。必须核实有效 USDT 授权才能启动资金监控。"});
  }
  if(method==="POST"&&path==="/api/wallets/remove"){
    const d=await body(req),wallet=addr(d.address);if(!wallet)return bad("无效钱包地址");
    if(!(await env.DB.prepare("SELECT 1 FROM wallets WHERE address=?").bind(wallet).first()))return bad("地址不存在",404);
    await env.DB.prepare("INSERT OR IGNORE INTO wallet_exclusions(address) VALUES(?)").bind(wallet).run();
    await env.DB.prepare("UPDATE subscriptions SET status='removed',updated_at=? WHERE address=?").bind(now(),wallet).run();
    await env.DB.prepare("UPDATE wallets SET deleted_at=? WHERE address=?").bind(now(),wallet).run();
    await env.DB.prepare("UPDATE spender_history_monitor_enrollments SET state='excluded',last_error='管理员手动移除',updated_at=CURRENT_TIMESTAMP WHERE owner=?").bind(wallet).run();
    const removed=await removeWatch(await configEnv(env),wallet);
    await audit(env,"admin","global_remove_wallet",wallet,{alchemy_removed:removed});
    return json({ok:true,alchemy_removed:removed,archived:true});
  }
  if(method==="POST"&&path==="/api/wallets/restore"){
    const d=await body(req),wallet=addr(d.address);if(!wallet)return bad("无效钱包地址");
    await env.DB.prepare("DELETE FROM wallet_exclusions WHERE address=?").bind(wallet).run();
    await env.DB.prepare("UPDATE wallets SET deleted_at=NULL WHERE address=?").bind(wallet).run();
    await env.DB.prepare("UPDATE spender_history_monitor_enrollments SET state='pending',last_error=NULL,updated_at=datetime('now','-2 minutes') WHERE owner=? AND state='excluded'").bind(wallet).run();
    await audit(env,"admin","restore_wallet",wallet);
    return json({ok:true,watch_status:"not_automatically_resumed",note:"已恢复档案。需要重新进行有效 USDT 授权核验并建立群组订阅。"});
  }
  if(method==="GET"&&path==="/api/spenders")return json((await env.DB.prepare("SELECT s.*,group_concat(r.chat_id) groups FROM spender_rules s LEFT JOIN spender_routes r USING(spender) GROUP BY s.spender ORDER BY s.created_at DESC LIMIT 200").all()).results);
  if(method==="POST"&&path==="/api/spenders"){
    const d=await body(req),a=addr(d.spender);if(!a)return bad("Spender 地址无效");
    const groups=[...new Set((Array.isArray(d.chat_ids)?d.chat_ids:[]).map(String).filter(x=>/^-?\d+$/.test(x)))];
    if(!groups.length)return bad("必须选择至少一个 Telegram 群组");
    for(const chat of groups)if(!(await env.DB.prepare("SELECT 1 FROM telegram_chats WHERE chat_id=?").bind(chat).first()))return bad("未登记的群组："+chat);
    await addSpender(await configEnv(env),a,String(d.remark||"Spender "+short(a)).slice(0,80),groups);
    await startSpenderHistory(env,a);
    await audit(env,"admin","create_spender",a,{groups});
    return json({ok:true,mode:"history_and_new_approvals",note:"历史上授权过此 Spender 的 Owner 将逐步加入监控；不自动监控 Spender 自身。"});
  }
  if(method==="GET"&&path==="/api/spenders/history"){
    const q=new URL(req.url).searchParams,spender=addr(q.get("spender"));
    if(!spender)return bad("请输入有效的 Spender 地址");
    const page=Math.min(100000,Math.max(0,Number.parseInt(q.get("page")||"0",10)||0));
    const status=q.get("status")||"all";
    if(!["all","active","revoked","pending"].includes(status))return bad("授权状态筛选值无效");
    const jobQuery=env.DB.prepare("SELECT * FROM spender_history_jobs WHERE spender=?").bind(spender);
    const countsQuery=env.DB.prepare("SELECT COUNT(*) AS total, COALESCE(SUM(CASE WHEN verify_status='active' THEN 1 ELSE 0 END),0) AS active, COALESCE(SUM(CASE WHEN verify_status='revoked' THEN 1 ELSE 0 END),0) AS revoked, COALESCE(SUM(CASE WHEN verify_status='pending' THEN 1 ELSE 0 END),0) AS pending FROM spender_history_addresses WHERE spender=?").bind(spender);
    const filter=status==="all"?"":" AND h.verify_status=?";
    const args=status==="all"?[spender,50,page*50]:[spender,status,50,page*50];
    const rowsQuery=env.DB.prepare("SELECT h.owner,h.first_seen_block,h.latest_event_block,h.latest_tx_hash,h.last_event_amount_raw,h.current_allowance_raw,h.verify_status,h.verified_at,t.approval_at,g.remark,COALESCE(e.state,'waiting') monitor_state FROM spender_history_addresses h LEFT JOIN spender_history_timestamps t ON t.spender=h.spender AND t.owner=h.owner LEFT JOIN wallet_global_remarks g ON g.address=h.owner LEFT JOIN spender_history_monitor_enrollments e ON e.spender=h.spender AND e.owner=h.owner WHERE h.spender=?"+filter+" ORDER BY h.latest_event_block DESC LIMIT ? OFFSET ?").bind(...args);
    const monitorQuery=env.DB.prepare(
      "SELECT COUNT(*) total,"+
      "COALESCE(SUM(CASE WHEN ww.state='active' THEN 1 ELSE 0 END),0) watched,"+
      "COALESCE(SUM(CASE WHEN e.state='active' THEN 1 ELSE 0 END),0) connected,"+
      "COALESCE(SUM(CASE WHEN e.state='retrying' THEN 1 ELSE 0 END),0) retrying "+
      "FROM spender_history_addresses h "+
      "LEFT JOIN wallet_watches ww ON ww.address=h.owner "+
      "LEFT JOIN spender_history_monitor_enrollments e ON e.spender=h.spender AND e.owner=h.owner "+
      "WHERE h.spender=?"
    ).bind(spender);
    const cooldownQuery=env.DB.prepare("SELECT value FROM runtime_state WHERE key='spender_enroll_retry_after'");
    const [jobResult,countsResult,rowsResult,monitorResult,cooldownResult]=await env.DB.batch([jobQuery,countsQuery,rowsQuery,monitorQuery,cooldownQuery]);
    const job=jobResult.results?.[0];
    if(!job)return bad("尚未创建历史授权扫描任务",404);
    const counts=countsResult.results?.[0]||{total:0,active:0,revoked:0,pending:0};
    const rows=rowsResult.results||[],monitor=monitorResult.results?.[0]||null;
    const cooldown=cooldownResult.results?.[0]?.value||null;
    const total=status==="all"?counts.total:counts[status];
    return json({job,counts,monitor,monitor_retry_at:cooldown?Number(cooldown):null,rows,page,total,total_pages:Math.ceil(total/50)});
  }
  if(method==="POST"&&path==="/api/spenders/history/refresh"){
    const d=await body(req),spender=addr(d.spender);
    if(!spender)return bad("Spender 地址无效");
    if(!(await env.DB.prepare("SELECT 1 FROM spender_history_jobs WHERE spender=?").bind(spender).first()))return bad("历史扫描任务不存在",404);
    await env.DB.prepare("UPDATE spender_history_addresses SET verify_status='pending',verified_at=NULL WHERE spender=?").bind(spender).run();
    await env.DB.prepare("UPDATE spender_history_jobs SET state=CASE WHEN state='retrying' THEN 'scanning' ELSE state END,last_error=NULL,updated_at=CURRENT_TIMESTAMP WHERE spender=?").bind(spender).run();
    return json({ok:true,note:"已安排重新核验当前授权额度，历史扫描从断点继续"});
  }
  if(method==="DELETE"&&path==="/api/spenders"){
    const d=await body(req),a=addr(d.spender);
    if(!a)return bad("Spender 地址无效");
    const rule=await env.DB.prepare("SELECT spender,remark FROM spender_rules WHERE spender=?").bind(a).first();
    if(!rule)return bad("该 Spender 已不存在",404);
    const histories=(await env.DB.prepare("SELECT COUNT(*) AS n FROM spender_history_addresses WHERE spender=?").bind(a).first())?.n||0;
    // Remove dependent rows before deleting the parent; spender_routes
    // references spender_rules via a foreign key. Preserve wallet watches,
    // subscriptions and transaction/audit archives to avoid accidental loss
    // of unrelated monitoring. Re-adding starts a clean history scan.
    await env.DB.batch([
      ...retainDeletedSpenderSources(env.DB,a),
      env.DB.prepare("DELETE FROM spender_routes WHERE spender=?").bind(a),
      env.DB.prepare("DELETE FROM spender_history_monitor_enrollments WHERE spender=?").bind(a),
      env.DB.prepare("DELETE FROM spender_history_timestamps WHERE spender=?").bind(a),
      env.DB.prepare("DELETE FROM spender_history_addresses WHERE spender=?").bind(a),
      env.DB.prepare("DELETE FROM spender_history_jobs WHERE spender=?").bind(a),
      env.DB.prepare("DELETE FROM spender_rules WHERE spender=?").bind(a)
    ]);
    await audit(env,"admin","delete_spender",a,{remark:rule.remark,history_wallets_deleted_from_rule:histories,monitored_wallets_retained:true});
    return json({ok:true,removed_spender:a,history_records_removed:histories,monitored_wallets_retained:true,
      note:"Spender 规则已删除，历史扫描与这条规则的群组推送已停止；已接入的独立钱包监控和既有消息记录保留。"});
  }
  if(method==="PATCH"&&path==="/api/spenders"){
    const d=await body(req),a=addr(d.spender);
    if(!a)return bad("无效 Spender 地址");
    const rule=await env.DB.prepare("SELECT spender,remark,enabled FROM spender_rules WHERE spender=?").bind(a).first();
    if(!rule)return bad("找不到该 Spender 规则",404);
    let remark;
    if(d.remark!==undefined){
      remark=String(d.remark).trim();
      if(!remark||Array.from(remark).length>80||/[\u0000-\u001f\u007f]/.test(remark))return bad("备注须为 1–80 个字符，不能包含控制字符");
    }
    let chats,oldGroups=[],removed=[],added=[];
    if(d.chat_ids!==undefined){
      if(!Array.isArray(d.chat_ids))return bad("通知群 ID 格式无效");
      chats=[...new Set(d.chat_ids.map(x=>String(x).trim()))];
      if(!chats.length||chats.some(x=>!/^-\d{5,20}$/.test(x)))return bad("请填写至少一个有效 Telegram 群 ID（例如 -100...）");
      for(const chat of chats){
        const c=await env.DB.prepare("SELECT chat_id,chat_type,active FROM telegram_chats WHERE chat_id=?").bind(chat).first();
        if(!c)return bad("群组尚未登记："+chat+"。请先将机器人加入该群，并在群内发送一条消息。");
        if(!["group","supergroup"].includes(c.chat_type)||!c.active)return bad("通知目标不是已启用的 Telegram 群："+chat);
      }
      oldGroups=((await env.DB.prepare("SELECT chat_id FROM spender_routes WHERE spender=?").bind(a).all()).results||[]).map(x=>String(x.chat_id));
      removed=oldGroups.filter(x=>!chats.includes(x));
      added=chats.filter(x=>!oldGroups.includes(x));
    }
    const changes=[];
    if(d.enabled!==undefined)changes.push(env.DB.prepare("UPDATE spender_rules SET enabled=? WHERE spender=?").bind(d.enabled?1:0,a));
    if(remark!==undefined)changes.push(env.DB.prepare("UPDATE spender_rules SET remark=? WHERE spender=?").bind(remark,a));
    if(chats){
      // Add all new destinations first. If any statement fails, the D1 batch
      // rolls back rather than leaving a Spender without notification routes.
      for(const chat of added)changes.push(env.DB.prepare("INSERT OR IGNORE INTO spender_routes(spender,chat_id) VALUES(?,?)").bind(a,chat));
      for(const chat of added){
        changes.push(env.DB.prepare(
          "INSERT OR IGNORE INTO subscriptions(chat_id,address,remark,status) "+
          "SELECT ?,h.owner,COALESCE(g.remark,(SELECT s.remark FROM subscriptions s WHERE s.address=h.owner ORDER BY s.updated_at DESC LIMIT 1),'待备注 · '||substr(h.owner,1,12)),"+
          "CASE WHEN ww.state='active' THEN 'active' ELSE 'pending' END "+
          "FROM spender_history_addresses h "+
          "LEFT JOIN wallet_global_remarks g ON g.address=h.owner "+
          "LEFT JOIN wallet_watches ww ON ww.address=h.owner "+
          "LEFT JOIN wallets w ON w.address=h.owner "+
          "LEFT JOIN wallet_exclusions x ON x.address=h.owner "+
          "WHERE h.spender=? AND x.address IS NULL AND (w.deleted_at IS NULL OR w.address IS NULL)"
        ).bind(chat,a));
        changes.push(assignSpenderSourcesForRoute(env.DB,a,chat));
      }
      // Removed routes must stop receiving this Spender's future approval
      // notifications. Only remove auto-created wallet subscriptions that do
      // not belong to another Spender, manual query or admin-added wallet.
      for(const chat of removed){
        changes.push(env.DB.prepare("DELETE FROM spender_routes WHERE spender=? AND chat_id=?").bind(a,chat));
        changes.push(...removeSpenderRouteSourceStatements(env.DB,a,chat));
      }
    }
    if(changes.length)await env.DB.batch(changes);
    await audit(env,"admin","update_spender",a,{remark_changed:remark!==undefined,old_groups:oldGroups,new_groups:chats||undefined,removed,added});
    return json({ok:true,remark:remark??rule.remark,groups:chats||oldGroups,added,removed,note:"Spender 备注和通知群规则已保存；旧群的手动订阅与其他 Spender 订阅保持不变。"});
  }
  if(method==="GET"&&path==="/api/subscriptions/legacy"){
    const q=new URL(req.url).searchParams;
    return json(await listLegacySubscriptions(env.DB,{page:q.get("page")||0,search:q.get("search")||""}));
  }
  if(method==="GET"&&path==="/api/subscriptions")return json((await env.DB.prepare("SELECT s.*,c.title FROM subscriptions s LEFT JOIN telegram_chats c USING(chat_id) ORDER BY s.updated_at DESC LIMIT 200").all()).results);
  if(method==="PATCH"&&path==="/api/subscriptions"){
    const d=await body(req),a=addr(d.address),chat=String(d.chat_id||"");if(!a||!/^-?\d+$/.test(chat))return bad("无效订阅地址或群组");
    const old=await env.DB.prepare("SELECT * FROM subscriptions WHERE address=? AND chat_id=?").bind(a,chat).first();if(!old)return bad("订阅不存在",404);
    if(d.remark!==undefined){
      const text=String(d.remark).trim();if(!text||Array.from(text).length>80)return bad("备注长度为 1–80 字符");
      await saveWalletRemark(env,a,text);
      await env.DB.prepare("INSERT INTO remark_edits(chat_id,address,actor_id,old_value,new_value) VALUES(?,?,?,?,?)").bind(chat,a,"admin",old.remark,text).run();
    }
    if(d.status!==undefined){
      if(!["active","paused","removed"].includes(d.status))return bad("状态无效");
      if(d.status==="active"&&(await env.DB.prepare("SELECT state FROM wallet_watches WHERE address=?").bind(a).first())?.state!=="active"){
        // Only previously monitored addresses can be resumed without another USDT approval verification.
        if(!["paused","removed"].includes(old.status))return bad("该地址尚未完成有效 USDT 授权核验",409);
        if(!await ensureWatch(await configEnv(env),a))return bad("Alchemy 监控订阅仍未完成，请稍后重试",409);
      }
      await env.DB.prepare("UPDATE subscriptions SET status=?,updated_at=? WHERE chat_id=? AND address=?").bind(d.status,now(),chat,a).run();
      if(d.status==="removed"||d.status==="paused"){
        const still=(await env.DB.prepare("SELECT count(*) n FROM subscriptions WHERE address=? AND status='active'").bind(a).first())?.n||0;
        if(!still)await removeWatch(await configEnv(env),a);
      }
    }
    await audit(env,"admin","update_subscription",a,{chat});
    return json({ok:true});
  }
  if(method==="GET"&&path==="/api/templates"){
    const [overridesResult,notesResult]=await env.DB.batch([
      env.DB.prepare("SELECT * FROM templates ORDER BY template_key,chat_id"),
      env.DB.prepare("SELECT key,value FROM runtime_state WHERE key LIKE 'template_note:%'")
    ]);
    const overrides=overridesResult.results||[],notes=notesResult.results||[];
    return json({defaults,catalog:templateCatalog,overrides,notes:notes.map(x=>({id:x.key.slice("template_note:".length),note:x.value}))});
  }
  if((method==="PUT"||method==="DELETE")&&path==="/api/templates"){
    const d=await body(req),key=String(d.template_key||""),chat=String(d.chat_id||"*"),txt=String(d.body||"");
    if(!Object.hasOwn(defaults,key)||!/^(\*|-?\d+)$/.test(chat))return bad("模板类型或群组 ID 不合法");
    const noteKey="template_note:"+key+":"+chat;
    if(method==="DELETE"){
      await env.DB.prepare("DELETE FROM templates WHERE template_key=? AND chat_id=?").bind(key,chat).run();
      await env.DB.prepare("DELETE FROM runtime_state WHERE key=?").bind(noteKey).run();
      await audit(env,"admin","reset_template",key,{chat});
      return json({ok:true});
    }
    const note=d.note===undefined?undefined:String(d.note);
    if(!txt.trim()||txt.length>3500||note!==undefined&&Array.from(note).length>500)return bad("模板正文须为 1–3500 字符；管理员备注最多 500 字");
    await env.DB.prepare("INSERT INTO templates(template_key,chat_id,body) VALUES(?,?,?) ON CONFLICT(template_key,chat_id) DO UPDATE SET body=excluded.body,version=templates.version+1,updated_at=CURRENT_TIMESTAMP").bind(key,chat,txt).run();
    if(note!==undefined){
      await env.DB.prepare("INSERT INTO runtime_state(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=CURRENT_TIMESTAMP").bind(noteKey,note).run();
    }
    await audit(env,"admin","update_template",key,{chat});
    return json({ok:true});
  }
  if(method==="GET"&&path==="/api/transfers")return json((await env.DB.prepare("SELECT * FROM transfer_events ORDER BY block_number DESC LIMIT 200").all()).results);
  if(method==="POST"&&path==="/api/outbox/retry"){
    const d=await body(req);
    const result=await requeueFailedOutbox(env.DB,Number(d.id));
    if(result.error){
      const messages={invalid_id:"无效通知任务编号",not_found:"通知任务不存在",not_failed:"只有最终发送失败的任务才能手动重试",conflict:"任务状态已改变，请刷新后重试"};
      return bad(messages[result.error]||"无法重新排队",result.status);
    }
    // A manual requeue is explicitly requested by an administrator. It never
    // sends synchronously, and the outbox worker still validates subscription.
    await audit(env,"admin","retry_failed_outbox",String(result.task.id),{chat:result.task.chat_id,template:result.task.template_key});
    return json({ok:true,queued:true,note:"任务已重新排队。极少数远端实际发送成功、但回执记录失败的情况可能产生重复消息。"});
  }
  if(method==="GET"&&path==="/api/outbox"){
    const q=new URL(req.url).searchParams;
    const result=await listOutboxPage(env.DB,{page:q.get("page"),status:q.get("status")||"all",search:q.get("search")||""});
    if(result.error)return bad(result.error==="invalid_status"?"通知状态筛选无效":"请输入有效任务编号或 Telegram 群 ID",result.status);
    return json(result);
  }
  if(method==="GET"&&path==="/api/audit")return json((await env.DB.prepare("SELECT * FROM admin_audit ORDER BY id DESC LIMIT 200").all()).results);
  if(method==="GET"&&path==="/api/usage"){
    const [settings,platforms]=await Promise.all([usageSettings(env),usageSnapshot(env)]);
    return json({warning_threshold_percent:80,forecast_days:7,telegram_dm:true,email:false,
      source_warning:"官方用量约每 15 分钟同步；本程序计数单独标注。失联或过期数据不参与预警。预测只比较同一账期的实际增量，并考虑额度重置。",
      settings,platforms});
  }
  if(method==="POST"&&path==="/api/usage/refresh"){
    const e=await configEnv(env);const result=await collectUsage(e,true);
    await runUsageAlerts(e);await flushOutbox(e,10,true);
    return json({...result,platforms:await usageSnapshot(e)});
  }
  if(method==="PUT"&&path==="/api/usage/settings"){
    try{await saveUsageSettings(env,await body(req));}catch(e){return bad(e.message);}
    await audit(env,"admin","update_usage_settings","usage");
    return json({ok:true});
  }
  if(method==="POST"&&path==="/api/usage/test-alert"){
    const e=await configEnv(env),dedup=await queueUsageTest(e);
    await flushOutbox(e,10,true);
    return json(await env.DB.prepare("SELECT state,attempts,last_error FROM outbox WHERE dedup_key=?").bind(dedup).first());
  }
  if(method==="PUT"&&path==="/api/usage/limit"){
    const d=await body(req);
    const allowed=Object.fromEntries(USAGE_METERS.map(x=>[x.metric,x.name]));
    if(!allowed[d.metric]||!["daily","monthly"].includes(d.period)||!Number.isSafeInteger(d.quota)||d.quota<1)return bad("配额参数无效");
    if(d.metric==="alchemy_cu"&&d.period!=="monthly")return bad("Alchemy CU 额度按官方月账期计算，请选择每月");
    await env.DB.prepare("INSERT INTO usage_limits(metric,platform,unit,quota,period,source) VALUES(?,?,?,?,?,'configured_quota') ON CONFLICT(metric) DO UPDATE SET quota=excluded.quota,unit=excluded.unit,period=excluded.period,source=excluded.source,updated_at=CURRENT_TIMESTAMP").bind(d.metric,allowed[d.metric],USAGE_METERS.find(x=>x.metric===d.metric).unit,d.quota,d.period).run();
    await audit(env,"admin","update_usage_limit",d.metric,{quota:d.quota});
    return json({ok:true,source:"configured_quota"});
  }
  return bad("Unknown admin route",404);
}
