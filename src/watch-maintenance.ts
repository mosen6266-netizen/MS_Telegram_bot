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
