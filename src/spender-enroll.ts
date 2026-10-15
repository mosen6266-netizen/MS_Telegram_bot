// @ts-nocheck
import {ensureWatch,short,now} from "./core";
import {walletRemark} from "./wallet-remarks";

// "History" means every owner with a recorded USDT Approval event, including
// later revoked approvals. This is intentional: historical authorizations
// must also be enrolled; rescinded allowances are reported as such separately.
export async function enrollHistoricalOwners(env,limit=8){
  // Another retry worker may already have connected a wallet. Reconcile the
  // durable enrollment state before making an unnecessary external API call.
  await env.DB.prepare("UPDATE spender_history_monitor_enrollments SET state='active',last_error=NULL,synced_at=COALESCE(synced_at,CURRENT_TIMESTAMP),updated_at=CURRENT_TIMESTAMP "+
    "WHERE state IN ('retrying','pending','running') "+
    "AND EXISTS (SELECT 1 FROM wallet_watches w WHERE w.address=spender_history_monitor_enrollments.owner AND w.state='active') "+
    "AND EXISTS (SELECT 1 FROM subscriptions s JOIN spender_routes r ON r.chat_id=s.chat_id AND r.spender=spender_history_monitor_enrollments.spender "+
    "WHERE s.address=spender_history_monitor_enrollments.owner AND s.status='active') "+
    "AND NOT EXISTS (SELECT 1 FROM wallet_exclusions x WHERE x.address=spender_history_monitor_enrollments.owner)").run();
  const {results:rows}=await env.DB.prepare(
    "SELECT h.spender,h.owner FROM spender_history_addresses h "+
    "JOIN spender_rules r ON r.spender=h.spender AND r.enabled=1 "+
    "LEFT JOIN wallets w ON w.address=h.owner "+
    "LEFT JOIN wallet_exclusions x ON x.address=h.owner "+
    "LEFT JOIN spender_history_monitor_enrollments e ON e.spender=h.spender AND e.owner=h.owner "+
    "WHERE x.address IS NULL AND (w.deleted_at IS NULL OR w.address IS NULL) "+
    "AND (e.spender IS NULL OR (e.state IN ('pending','retrying') AND e.updated_at<datetime('now','-90 seconds')) "+
    "OR (e.state='running' AND e.updated_at<datetime('now','-5 minutes'))) "+
    "ORDER BY h.first_seen_block ASC LIMIT ?"
  ).bind(Math.max(1,Math.min(20,limit))).all();
  for(const row of rows||[]){
    const spender=row.spender,owner=row.owner;
    try{
      await env.DB.prepare("INSERT OR IGNORE INTO spender_history_monitor_enrollments(spender,owner,state) VALUES(?,?,'pending')").bind(spender,owner).run();
      const claim=await env.DB.prepare("UPDATE spender_history_monitor_enrollments SET state='running',attempts=attempts+1,updated_at=CURRENT_TIMESTAMP WHERE spender=? AND owner=? AND (state='pending' OR (state='retrying' AND updated_at<datetime('now','-90 seconds')) OR (state='running' AND updated_at<datetime('now','-5 minutes')))").bind(spender,owner).run();
      if(!claim.meta?.changes)continue;
      const excluded=await env.DB.prepare("SELECT 1 FROM wallet_exclusions WHERE address=?").bind(owner).first();
      const deleted=await env.DB.prepare("SELECT deleted_at FROM wallets WHERE address=?").bind(owner).first();
      if(excluded||deleted?.deleted_at){
        await env.DB.prepare("UPDATE spender_history_monitor_enrollments SET state='excluded',last_error='管理员已手动移除',updated_at=CURRENT_TIMESTAMP WHERE spender=? AND owner=?").bind(spender,owner).run();
        continue;
      }
      await env.DB.prepare("INSERT OR IGNORE INTO wallets(address,discovery_source) VALUES(?,'spender_history')").bind(owner).run();
      const remark=await walletRemark(env,owner,"待备注 · "+short(owner));
      const chats=(await env.DB.prepare("SELECT chat_id FROM spender_routes WHERE spender=?").bind(spender).all()).results||[];
      if(!chats.length)throw Error("Spender 尚未绑定通知群组");
      for(const rowChat of chats){
        if(!(await env.DB.prepare("SELECT 1 FROM telegram_chats WHERE chat_id=?").bind(String(rowChat.chat_id)).first()))continue;
        await env.DB.prepare("INSERT OR IGNORE INTO subscriptions(chat_id,address,remark,status) VALUES(?,?,?,'pending')")
          .bind(String(rowChat.chat_id),owner,remark).run();
      }
      // Historic approvals only enroll tracking from now. Never replay years of
      // transfer alerts or claim a revoked allowance is currently active.
      const watch=await env.DB.prepare("SELECT state FROM wallet_watches WHERE address=?").bind(owner).first();
      const synced=watch?.state==="active" || await ensureWatch(env,owner);
      if(!synced){const detail=await env.DB.prepare("SELECT last_error FROM wallet_watches WHERE address=?").bind(owner).first();throw Error("Alchemy 订阅失败："+String(detail?.last_error||"稍后自动重试").slice(0,180));}
      await env.DB.prepare("UPDATE subscriptions SET status='active',updated_at=CURRENT_TIMESTAMP WHERE address=? AND status='pending' AND chat_id IN (SELECT chat_id FROM spender_routes WHERE spender=?)")
        .bind(owner,spender).run();
      await env.DB.prepare("UPDATE spender_history_monitor_enrollments SET state='active',last_error=NULL,synced_at=CURRENT_TIMESTAMP,updated_at=CURRENT_TIMESTAMP WHERE spender=? AND owner=?")
        .bind(spender,owner).run();
    }catch(e){
      console.error("Historical Owner enrollment",spender,owner,String(e));
      await env.DB.prepare("UPDATE spender_history_monitor_enrollments SET state='retrying',last_error=?,updated_at=CURRENT_TIMESTAMP WHERE spender=? AND owner=?")
        .bind(String(e.message||e).slice(0,240),spender,owner).run();
    }
  }
}
