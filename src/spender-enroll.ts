// @ts-nocheck
import {ensureWatch,short,now,blockNumber} from "./core";
import {walletRemark} from "./wallet-remarks";
import {sourceInsert} from "./subscription-sources";
import {withAlchemyMutationLease,alchemyMutationFetch} from "./alchemy-mutation-lease";

// Bulk enroll historical USDT Approval owners; this is distinct from discovering
// the addresses. Alchemy can rate-limit dashboard API calls (HTTP 429 / 1015).
// A shared cooldown prevents a per-address retry storm.
const ENROLL_BATCH=20;
const BACKOFF_KEY="spender_enroll_retry_after";
const LOCK_KEY="spender_enroll_batch_lock";
// Longer than one Worker execution; a crashed invocation can be reclaimed
// without deleting a newer invocation's independently owned lease.
const LOCK_TTL_MS=15*60000;
export async function withEnrollmentLease(env,work,{clock=()=>Date.now(),ttlMs=LOCK_TTL_MS}={}){
  const started=clock(),value=String(started+ttlMs)+"|"+crypto.randomUUID();
  const acquired=await env.DB.prepare(
    "INSERT INTO runtime_state(key,value,updated_at) VALUES(?,?,CURRENT_TIMESTAMP) "+
    "ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=CURRENT_TIMESTAMP "+
    "WHERE CAST(substr(runtime_state.value,1,instr(runtime_state.value,'|')-1) AS INTEGER)<=?"
  ).bind(LOCK_KEY,value,started).run();
  if(!acquired.meta?.changes)return {busy:true};
  try{return await work()}
  finally{await env.DB.prepare("DELETE FROM runtime_state WHERE key=? AND value=?").bind(LOCK_KEY,value).run()}
}
export function enrollmentRetryAfterSeconds(headerValue,nowMs=Date.now()){
  if(!headerValue)return null;
  const str=String(headerValue).trim(),number=Number(str);
  const seconds=Number.isFinite(number)&&number>=0?number:
    (Number.isFinite(Date.parse(str))?(Date.parse(str)-nowMs)/1000:NaN);
  return Number.isFinite(seconds)?Math.max(1,Math.min(4*3600,Math.ceil(seconds))):null;
}
async function setEnrollmentCooldown(env,seconds){
  const until=String(Date.now()+Math.max(1,Math.min(4*3600,Math.ceil(seconds)))*1000);
  await env.DB.prepare("INSERT INTO runtime_state(key,value,updated_at) VALUES(?,?,CURRENT_TIMESTAMP) ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=CURRENT_TIMESTAMP").bind(BACKOFF_KEY,until).run();
}
export async function selectEnrollmentCandidates(db,limit=ENROLL_BATCH){
  const max=Math.max(1,Math.min(ENROLL_BATCH,limit));
  const base="FROM spender_history_addresses h "+
    "JOIN spender_rules r ON r.spender=h.spender AND r.enabled=1 "+
    "LEFT JOIN wallets w ON w.address=h.owner "+
    "LEFT JOIN wallet_exclusions x ON x.address=h.owner "+
    "LEFT JOIN spender_history_monitor_enrollments e ON e.spender=h.spender AND e.owner=h.owner "+
    "WHERE x.address IS NULL AND (w.deleted_at IS NULL OR w.address IS NULL) AND ";
  const retry="(e.state IN ('pending','retrying') AND e.updated_at<datetime('now', "+
      "CASE WHEN e.attempts>=5 THEN '-30 minutes' WHEN e.attempts>=3 THEN '-10 minutes' ELSE '-90 seconds' END) "+
    "OR (e.state='running' AND e.updated_at<datetime('now','-5 minutes')))";
  const cursorKeys=["spender_enroll_rr_fresh","spender_enroll_rr_retry","spender_enroll_rr_pool_turn"];
  const cursors=await db.batch(cursorKeys.map(key=>
    db.prepare("SELECT value FROM runtime_state WHERE key=?").bind(key)));
  const [freshCursor,retryCursor,turn]=cursors.map(x=>String(x.results?.[0]?.value||""));
  // Even a one-slot batch must alternate queues when both remain busy.
  const reserved=max===1?(turn==="retry"?1:0):max>=4?Math.max(1,Math.floor(max/4)):1;
  const freshCount=max-reserved;
  const makeQuery=(where,order)=>
    "WITH ranked AS (SELECT h.spender,h.owner,r.generation,"+
    "ROW_NUMBER() OVER (PARTITION BY h.spender ORDER BY "+order+") AS round_no "+
    base+where+") "+
    "SELECT spender,owner,generation FROM ranked ORDER BY round_no ASC,"+
    "CASE WHEN spender>? THEN 0 ELSE 1 END,spender ASC,owner ASC LIMIT ? OFFSET ?";
  const freshSQL=makeQuery("e.spender IS NULL","h.first_seen_block ASC,h.owner ASC");
  const retrySQL=makeQuery(retry,"e.updated_at ASC,h.first_seen_block ASC,h.owner ASC");
  const [freshResult,retryResult]=await db.batch([
    db.prepare(freshSQL).bind(freshCursor,freshCount,0),
    db.prepare(retrySQL).bind(retryCursor,reserved,0)
  ]);
  const fresh=[...(freshResult.results||[])],due=[...(retryResult.results||[])];
  if(fresh.length+due.length<max){
    const missing=max-fresh.length-due.length;
    const [extraFresh,extraDue]=await db.batch([
      db.prepare(freshSQL).bind(freshCursor,missing,fresh.length),
      db.prepare(retrySQL).bind(retryCursor,missing,due.length)
    ]);
    fresh.push(...(extraFresh.results||[]).slice(0,missing));
    due.push(...(extraDue.results||[]).slice(0,Math.max(0,max-fresh.length-due.length)));
  }
  // Cursor persists across Cron cycles; with more Spenders than batch slots,
  // the next batch begins after the last served Spender rather than always
  // starting from the lexicographically smallest.
  const updates=[];
  if(fresh.length)updates.push(db.prepare(
    "INSERT INTO runtime_state(key,value,updated_at) VALUES('spender_enroll_rr_fresh',?,CURRENT_TIMESTAMP) "+
    "ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=CURRENT_TIMESTAMP"
  ).bind(fresh.at(-1).spender));
  if(due.length)updates.push(db.prepare(
    "INSERT INTO runtime_state(key,value,updated_at) VALUES('spender_enroll_rr_retry',?,CURRENT_TIMESTAMP) "+
    "ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=CURRENT_TIMESTAMP"
  ).bind(due.at(-1).spender));
  if(max===1&&fresh.length+due.length)updates.push(db.prepare(
    "INSERT INTO runtime_state(key,value,updated_at) VALUES('spender_enroll_rr_pool_turn',?,CURRENT_TIMESTAMP) "+
    "ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=CURRENT_TIMESTAMP"
  ).bind(reserved?"fresh":"retry"));
  if(updates.length)await db.batch(updates);
  return [...fresh,...due];
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

  return withEnrollmentLease(env,async()=>{
    const rows=await selectEnrollmentCandidates(db,limit);
    if(!rows.length)return {processed:0};

    const toSync=[];
    for(const row of rows){
      const {spender,owner}=row;
      try{
        await db.prepare("INSERT OR IGNORE INTO spender_history_monitor_enrollments(spender,owner,state) VALUES(?,?,'pending')").bind(spender,owner).run();
        const claimed=await db.prepare("UPDATE spender_history_monitor_enrollments SET state='running',attempts=attempts+1,updated_at=CURRENT_TIMESTAMP WHERE spender=? AND owner=? AND (state='pending' OR (state='retrying' AND updated_at<datetime('now',CASE WHEN attempts>=5 THEN '-30 minutes' WHEN attempts>=3 THEN '-10 minutes' ELSE '-90 seconds' END)) OR (state='running' AND updated_at<datetime('now','-5 minutes')))").bind(spender,owner).run();
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
        for(const group of groups){
          const chat=String(group.chat_id);
          if(!(await db.prepare("SELECT 1 FROM telegram_chats WHERE chat_id=?").bind(chat).first()))continue;
          await db.prepare("INSERT OR IGNORE INTO subscriptions(chat_id,address,remark,status) VALUES(?,?,?,'pending')").bind(chat,owner,remark).run();
          await sourceInsert(db,chat,owner,"spender",spender).run();
        }
        const state=await db.prepare("SELECT state FROM wallet_watches WHERE address=?").bind(owner).first();
        if(state?.state==="active"){
          await db.prepare("UPDATE subscriptions SET status='active',updated_at=CURRENT_TIMESTAMP WHERE address=? AND status='pending' AND chat_id IN (SELECT chat_id FROM spender_routes WHERE spender=?)").bind(owner,spender).run();
          await db.prepare("UPDATE spender_history_monitor_enrollments SET state='active',last_error=NULL,synced_at=CURRENT_TIMESTAMP,updated_at=CURRENT_TIMESTAMP WHERE spender=? AND owner=?").bind(spender,owner).run();
        }else toSync.push({spender,owner,generation:row.generation});
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
        const first=toSync.find(x=>x.owner===unique[0]);
        const created=await ensureWatch(env,unique[0],undefined,async()=>
          !!await db.prepare("SELECT 1 FROM spender_rules r JOIN spender_history_addresses h ON h.spender=r.spender WHERE r.spender=? AND r.generation=? AND r.enabled=1 AND h.owner=?")
            .bind(first.spender,first.generation,first.owner).first());
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
      return await withAlchemyMutationLease(env,async()=>{
        // The Spender DELETE API uses the same lease. A deletion that wins first
        // invalidates these generations; a mutation that wins first prevents
        // deletion until the remote call and local state commit finish.
        const valid=[];
        for(const row of toSync){
          if(!unique.includes(row.owner))continue;
          if(await db.prepare(
            "SELECT 1 FROM spender_rules r JOIN spender_history_addresses h ON h.spender=r.spender "+
            "WHERE r.spender=? AND r.generation=? AND r.enabled=1 AND h.owner=? "+
            "AND NOT EXISTS(SELECT 1 FROM wallet_exclusions x WHERE x.address=h.owner) "+
            "AND NOT EXISTS(SELECT 1 FROM wallets w WHERE w.address=h.owner AND w.deleted_at IS NOT NULL)"
          ).bind(row.spender,row.generation,row.owner).first())valid.push(row);
        }
        const verified=[...new Set(valid.map(x=>x.owner))];
        if(!verified.length)return {processed:rows.length,skipped:"spender_removed"};
        const res=await alchemyMutationFetch("https://dashboard.alchemy.com/api/update-webhook-addresses",{
        method:"PATCH",
        headers:{"content-type":"application/json","X-Alchemy-Token":env.ALCHEMY_NOTIFY_TOKEN},
        body:JSON.stringify({webhook_id:env.ALCHEMY_ACTIVITY_WEBHOOK_ID,addresses_to_add:verified,addresses_to_remove:[]})
      });
      const body=await res.text();
      if(!res.ok){
        const error=Error("Alchemy batch sync HTTP "+res.status+" "+body.slice(0,130));
        error.httpStatus=res.status;
        error.retryAfterSeconds=enrollmentRetryAfterSeconds(res.headers?.get("retry-after"));
        throw error;
      }
      let parsed;
      try{parsed=JSON.parse(body)}catch{}
      if(parsed?.success===false||parsed?.error)throw Error("Alchemy batch rejected: "+JSON.stringify(parsed.error||parsed.message).slice(0,150));
      const stamp=now();
      const statements=[];
      for(const owner of verified)statements.push(db.prepare("UPDATE wallet_watches SET state='active',synced_at=?,last_error=NULL,updated_at=? WHERE address=? AND state='pending'").bind(stamp,stamp,owner));
      for(const row of valid){
        statements.push(db.prepare("UPDATE subscriptions SET status='active',updated_at=CURRENT_TIMESTAMP WHERE address=? AND status='pending' AND chat_id IN (SELECT chat_id FROM spender_routes WHERE spender=?)").bind(row.owner,row.spender));
        statements.push(db.prepare("UPDATE spender_history_monitor_enrollments SET state='active',last_error=NULL,synced_at=CURRENT_TIMESTAMP,updated_at=CURRENT_TIMESTAMP WHERE spender=? AND owner=?").bind(row.spender,row.owner));
      }
      await db.batch(statements);
      await db.prepare("DELETE FROM runtime_state WHERE key=?").bind(BACKOFF_KEY).run();
      await db.prepare("DELETE FROM runtime_state WHERE key='spender_enroll_throttle_count'").run();
      return {processed:rows.length,synced:verified.length};
      });
    }catch(e){
      const reason=String(e.message||e).slice(0,225);
      const limited=e?.httpStatus===429||/HTTP 429|error code:\\s*1015|rate limit/i.test(reason);
      // Exact Retry-After wins when present; exponential fallback grows
      // across repeated rate-limit incidents and is capped at two hours.
      if(limited){
        const failures=Number((await db.prepare("SELECT value FROM runtime_state WHERE key='spender_enroll_throttle_count'").first())?.value||0);
        const next=Math.min(6,failures+1);
        await db.prepare("INSERT INTO runtime_state(key,value,updated_at) VALUES('spender_enroll_throttle_count',?,CURRENT_TIMESTAMP) ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=CURRENT_TIMESTAMP").bind(String(next)).run();
        await setEnrollmentCooldown(env,e?.retryAfterSeconds??Math.min(7200,900*Math.pow(2,next-1)));
      }else if(e?.httpStatus>=500||/HTTP 5\\d\\d/.test(reason)){
        await setEnrollmentCooldown(env,e?.retryAfterSeconds??300);
      }
      console.error("Historical Spender bulk enrollment failed",reason);
      for(const row of toSync){
        await db.prepare("UPDATE spender_history_monitor_enrollments SET state='retrying',last_error=?,updated_at=CURRENT_TIMESTAMP WHERE spender=? AND owner=?")
          .bind(reason,row.spender,row.owner).run();
        await db.prepare("UPDATE wallet_watches SET last_error=?,updated_at=CURRENT_TIMESTAMP WHERE address=? AND state='pending'").bind(reason,row.owner).run();
      }
      return {processed:0,error:reason,cooldown:limited};
    }
  });
}
