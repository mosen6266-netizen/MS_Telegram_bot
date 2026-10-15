// @ts-nocheck
import {removeWatch} from "./core";

// Retry only removals already requested by the user. Never remove wallets with
// active subscriptions. Respect the enrollment backoff to avoid extra Alchemy
// dashboard calls during a rate limit.
export async function retryPendingWatchRemovals(env,{limit=2}={}){
  if(!env.ALCHEMY_NOTIFY_TOKEN||!env.ALCHEMY_ACTIVITY_WEBHOOK_ID)return {skipped:"missing_credentials"};
  const cooldown=(await env.DB.prepare("SELECT value FROM runtime_state WHERE key='spender_enroll_retry_after'").first())?.value;
  if(Number(cooldown||0)>Date.now())return {skipped:"alchemy_rate_limited"};
  const watches=(await env.DB.prepare(
    "SELECT w.address FROM wallet_watches w WHERE w.state='removal_pending' "+
    "AND w.updated_at<datetime('now','-30 minutes') "+
    "AND NOT EXISTS(SELECT 1 FROM subscriptions s WHERE s.address=w.address AND s.status='active') "+
    "ORDER BY w.updated_at ASC LIMIT ?"
  ).bind(Math.max(1,Math.min(2,limit))).all()).results||[];
  let removed=0,retrying=0;
  for(const row of watches){
    // removeWatch rechecks active subscriptions so resurrected subscriptions
    // cannot be deleted merely because they were unreferenced at selection.
    if(await removeWatch(env,row.address))removed++;
    else retrying++;
  }
  return {selected:watches.length,removed,retrying};
}

export async function selectStandalonePendingWatches(db,limit=8){
  // Never resurrect an orphan pending watch left by a deleted Spender.
  // The generic retry loop is for sources with a current owner, not for
  // wallets that merely have a stale row in wallet_watches.
  const q="SELECT w.address FROM wallet_watches w WHERE w.state='pending' "+
    "AND NOT EXISTS (SELECT 1 FROM spender_history_monitor_enrollments e WHERE e.owner=w.address AND e.state IN ('pending','running','retrying')) "+
    "AND NOT EXISTS (SELECT 1 FROM wallet_exclusions x WHERE x.address=w.address) "+
    "AND NOT EXISTS (SELECT 1 FROM wallets a WHERE a.address=w.address AND a.deleted_at IS NOT NULL) "+
    "AND EXISTS (SELECT 1 FROM subscriptions s JOIN subscription_sources src ON src.address=s.address AND src.chat_id=s.chat_id "+
    "WHERE s.address=w.address AND s.status IN ('pending','active') "+
    "AND (src.source_type IN ('manual','admin','legacy') "+
    "OR (src.source_type='spender' AND EXISTS(SELECT 1 FROM spender_rules r WHERE r.spender=src.source_id AND r.enabled=1)))) "+
    "ORDER BY w.updated_at ASC LIMIT ?";
  return (await db.prepare(q).bind(Math.max(1,Math.min(20,limit))).all()).results||[];
}
