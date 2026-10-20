// @ts-nocheck
import {ensureWatch,short,now,blockNumber} from "./core";
import {walletRemark} from "./wallet-remarks";
import {alchemyManagementFetch} from "./alchemy-management";

// Bulk enroll historical USDT Approval owners; this is distinct from discovering
// the addresses. Alchemy can rate-limit dashboard API calls (HTTP 429 / 1015).
// A shared cooldown prevents a per-address retry storm.
const ENROLL_BATCH=20;
const BACKOFF_KEY="spender_enroll_retry_after";
const LOCK_KEY="spender_enroll_batch_lock";
async function setEnrollmentCooldown(env,minutes){
  const until=String(Date.now()+minutes*60000);
  await env.DB.prepare("INSERT INTO runtime_state(key,value,updated_at) VALUES(?,?,CURRENT_TIMESTAMP) ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=CURRENT_TIMESTAMP").bind(BACKOFF_KEY,until).run();
}

export async function enrollHistoricalOwners(env,limit=ENROLL_BATCH){
  const db=env.DB;
  // A generic watcher retry can succeed between history attempts.
  await db.prepare("UPDATE spender_history_monitor_enrollments SET state='active',last_error=NULL,synced_at=COALESCE(synced_at,CURRENT_TIMESTAMP),updated_at=CURRENT_TIMESTAMP "+
    "WHERE state IN ('retrying','pending','running') "+
    "AND EXISTS (SELECT 1 FROM wallet_watches w WHERE w.address=spender_history_monitor_enrollments.owner AND w.state='active') "+
    "AND EXISTS (SELECT 1 FROM subscriptions s JOIN spender_routes r ON r.chat_id=s.chat_id AND r.spender=spender_history_monitor_enrollments.spender "+
    "WHERE s.address=spender_history_monitor_enrollments.owner AND s.status='active') "+
    "AND NOT EXISTS (SELECT 1 FROM wallet_exclusions x WHERE x.address=spender_history_monitor_enrollments.owner)").run();

  const wait=await db.prepare("SELECT value FROM runtime_state WHERE key=?").bind(BACKOFF_KEY).first();
  if(Number(wait?.value||0)>Date.now())return {cooldown:true,until:Number(wait.value)};

  // Avoid concurrent bulk submissions during long scheduled Worker invocations.
  const lock=await db.prepare("INSERT OR IGNORE INTO runtime_state(key,value) VALUES(?,?)").bind(LOCK_KEY,now()).run();
  if(!lock.meta?.changes){
    const old=await db.prepare("SELECT updated_at FROM runtime_state WHERE key=?").bind(LOCK_KEY).first();
    if(old && Date.now()-new Date(old.updated_at+"Z").getTime()>300000){
      await db.prepare("DELETE FROM runtime_state WHERE key=?").bind(LOCK_KEY).run();
    }
    return {busy:true};
  }
  try{
    const query="SELECT h.spender,h.owner FROM spender_history_addresses h "+
      "JOIN spender_rules r ON r.spender=h.spender AND r.enabled=1 "+
      "LEFT JOIN wallets w ON w.address=h.owner "+
      "LEFT JOIN wallet_exclusions x ON x.address=h.owner "+
      "LEFT JOIN spender_history_monitor_enrollments e ON e.spender=h.spender AND e.owner=h.owner "+
      "WHERE x.address IS NULL AND (w.deleted_at IS NULL OR w.address IS NULL) "+
      "AND (e.spender IS NULL OR (e.state IN ('pending','retrying') AND e.updated_at<datetime('now','-90 seconds')) "+
      "OR (e.state='running' AND e.updated_at<datetime('now','-5 minutes'))) "+
      "ORDER BY h.first_seen_block ASC LIMIT ?";
    const rows=(await db.prepare(query).bind(Math.max(1,Math.min(ENROLL_BATCH,limit))).all()).results||[];
    if(!rows.length)return {processed:0};

    const toSync=[];
    for(const row of rows){
      const {spender,owner}=row;
      try{
        await db.prepare("INSERT OR IGNORE INTO spender_history_monitor_enrollments(spender,owner,state) VALUES(?,?,'pending')").bind(spender,owner).run();
        const claimed=await db.prepare("UPDATE spender_history_monitor_enrollments SET state='running',attempts=attempts+1,updated_at=CURRENT_TIMESTAMP WHERE spender=? AND owner=? AND (state='pending' OR (state='retrying' AND updated_at<datetime('now','-90 seconds')) OR (state='running' AND updated_at<datetime('now','-5 minutes')))").bind(spender,owner).run();
        if(!claimed.meta?.changes)continue;
        const exclude=await db.prepare("SELECT 1 FROM wallet_exclusions WHERE address=?").bind(owner).first();
        const archived=await db.prepare("SELECT deleted_at FROM wallets WHERE address=?").bind(owner).first();
        if(exclude||archived?.deleted_at){
          await db.prepare("UPDATE spender_history_monitor_enrollments SET state='excluded',last_error='管理员已手动移除',updated_at=CURRENT_TIMESTAMP WHERE spender=? AND owner=?").bind(spender,owner).run();
          continue;
        }
        await db.prepare("INSERT OR IGNORE INTO wallets(address,discovery_source) VALUES(?,'spender_history')").bind(owner).run();
        const remark=await walletRemark(env,owner,"待备注 · "+short(owner));
        const groups=(await db.prepare("SELECT chat_id FROM spender_routes WHERE spender=?").bind(spender).all()).results||[];
        if(!groups.length)throw Error("Spender 未设置通知群");
        let hasActiveRoute=false;
        for(const group of groups){
          const chat=String(group.chat_id);
          const registered=await db.prepare("SELECT active,chat_type FROM telegram_chats WHERE chat_id=?").bind(chat).first();
          if(!registered?.active || !["group","supergroup"].includes(registered.chat_type))continue;
          await db.prepare("INSERT OR IGNORE INTO subscriptions(chat_id,address,remark,status) VALUES(?,?,?,'pending')").bind(chat,owner,remark).run();
          // An explicit manual removal is never silently overridden by scanning.
          const subscription=await db.prepare("SELECT status FROM subscriptions WHERE chat_id=? AND address=?").bind(chat,owner).first();
          if(subscription && ["active","pending"].includes(subscription.status))hasActiveRoute=true;
        }
        if(!hasActiveRoute)throw Error("未找到可用的群组订阅；需要检查群组启用状态或手动恢复已移除的订阅");
        const state=await db.prepare("SELECT state FROM wallet_watches WHERE address=?").bind(owner).first();
        if(state?.state==="active"){
          await db.prepare("UPDATE subscriptions SET status='active',updated_at=CURRENT_TIMESTAMP WHERE address=? AND status='pending' AND chat_id IN (SELECT chat_id FROM spender_routes WHERE spender=?)").bind(owner,spender).run();
          await db.prepare("UPDATE spender_history_monitor_enrollments SET state='active',last_error=NULL,synced_at=CURRENT_TIMESTAMP,updated_at=CURRENT_TIMESTAMP WHERE spender=? AND owner=?").bind(spender,owner).run();
        }else toSync.push({spender,owner});
      }catch(e){
        const reason=String(e.message||e).slice(0,210);
        await db.prepare("UPDATE spender_history_monitor_enrollments SET state='retrying',last_error=?,updated_at=CURRENT_TIMESTAMP WHERE spender=? AND owner=?").bind(reason,spender,owner).run();
      }
    }
    if(!toSync.length)return {processed:rows.length,alreadyWatched:true};

    const unique=[...new Set(toSync.map(x=>x.owner))];
    try{
      // If this is the first monitored wallet, let the existing implementation
      // create the webhook and save its signing key before attempting bulk sync.
      if(!env.ALCHEMY_ACTIVITY_WEBHOOK_ID){
        const created=await ensureWatch(env,unique[0]);
        if(!created)throw Error("Alchemy webhook 创建失败");
        const one=unique.shift();
        const matched=toSync.filter(x=>x.owner===one);
        for(const row of matched){
          await db.prepare("UPDATE subscriptions SET status='active',updated_at=CURRENT_TIMESTAMP WHERE address=? AND status='pending' AND chat_id IN (SELECT chat_id FROM spender_routes WHERE spender=?)").bind(row.owner,row.spender).run();
          await db.prepare("UPDATE spender_history_monitor_enrollments SET state='active',last_error=NULL,synced_at=CURRENT_TIMESTAMP,updated_at=CURRENT_TIMESTAMP WHERE spender=? AND owner=?").bind(row.spender,row.owner).run();
        }
      }
      if(!unique.length)return {processed:rows.length};
      if(!env.ALCHEMY_NOTIFY_TOKEN||!env.ALCHEMY_ACTIVITY_WEBHOOK_ID)throw Error("Alchemy Notify Token / Webhook ID 未配置");

      // Prepare local checkpoints but do not claim successful monitoring until
      // the whole Alchemy PATCH request is accepted.
      const latest=await blockNumber(env);
      const setup=[];
      for(const owner of unique){
        setup.push(db.prepare("INSERT OR IGNORE INTO wallet_watches(address,state) VALUES(?,'pending')").bind(owner));
        setup.push(db.prepare("INSERT OR IGNORE INTO wallet_checkpoints(address,last_block) VALUES(?,?)").bind(owner,Math.max(0,latest-1)));
      }
      await db.batch(setup);
      const res=await alchemyManagementFetch(env,"https://dashboard.alchemy.com/api/update-webhook-addresses",{
        method:"PATCH",
        headers:{"content-type":"application/json","X-Alchemy-Token":env.ALCHEMY_NOTIFY_TOKEN},
        body:JSON.stringify({webhook_id:env.ALCHEMY_ACTIVITY_WEBHOOK_ID,addresses_to_add:unique,addresses_to_remove:[]})
      });
      const body=await res.text();
      if(!res.ok)throw Error("Alchemy batch sync HTTP "+res.status+" "+body.slice(0,130));
      let parsed;
      try{parsed=JSON.parse(body)}catch{}
      if(parsed?.success===false||parsed?.error)throw Error("Alchemy batch rejected: "+JSON.stringify(parsed.error||parsed.message).slice(0,150));
      const stamp=now();
      const statements=[];
      for(const owner of unique)statements.push(db.prepare("UPDATE wallet_watches SET state='active',synced_at=?,last_error=NULL,updated_at=? WHERE address=?").bind(stamp,stamp,owner));
      for(const row of toSync){
        statements.push(db.prepare("UPDATE subscriptions SET status='active',updated_at=CURRENT_TIMESTAMP WHERE address=? AND status='pending' AND chat_id IN (SELECT chat_id FROM spender_routes WHERE spender=?)").bind(row.owner,row.spender));
        statements.push(db.prepare("UPDATE spender_history_monitor_enrollments SET state='active',last_error=NULL,synced_at=CURRENT_TIMESTAMP,updated_at=CURRENT_TIMESTAMP WHERE spender=? AND owner=?").bind(row.spender,row.owner));
      }
      await db.batch(statements);
      await db.prepare("DELETE FROM runtime_state WHERE key=?").bind(BACKOFF_KEY).run();
      return {processed:rows.length,synced:unique.length};
    }catch(e){
      const reason=String(e.message||e).slice(0,225);
      const limited=/HTTP 429|error code:\s*1015|rate limit/i.test(reason);
      if(limited)await setEnrollmentCooldown(env,15);
      else if(/HTTP 5\d\d/.test(reason))await setEnrollmentCooldown(env,5);
      console.error("Historical Spender bulk enrollment failed",reason);
      for(const row of toSync){
        await db.prepare("UPDATE spender_history_monitor_enrollments SET state='retrying',last_error=?,updated_at=CURRENT_TIMESTAMP WHERE spender=? AND owner=?")
          .bind(reason,row.spender,row.owner).run();
        await db.prepare("UPDATE wallet_watches SET last_error=?,updated_at=CURRENT_TIMESTAMP WHERE address=? AND state='pending'").bind(reason,row.owner).run();
      }
      return {processed:0,error:reason,cooldown:limited};
    }
  }finally{
    await db.prepare("DELETE FROM runtime_state WHERE key=?").bind(LOCK_KEY).run();
  }
}
