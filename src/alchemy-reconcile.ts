// @ts-nocheck
import {addr} from "./core";

// Alchemy Notify supports cursor-paginated GET /api/webhook-addresses.
// Never use a partial response to downgrade or remove an existing wallet.
const URL_BASE="https://dashboard.alchemy.com/api/webhook-addresses";
export async function fetchAlchemyAddresses(env,{fetcher=fetch,pageSize=100,maxPages=200}={}){
  if(!env.ALCHEMY_NOTIFY_TOKEN||!env.ALCHEMY_ACTIVITY_WEBHOOK_ID)throw Error("Alchemy webhook reconciliation is not configured");
  const all=new Set(),cursors=new Set();
  let after="",total=null,pages=0;
  while(true){
    if(pages>=maxPages)throw Error("Alchemy address pagination exceeded safety limit; comparison aborted");
    const url=new URL(URL_BASE);
    url.searchParams.set("webhook_id",env.ALCHEMY_ACTIVITY_WEBHOOK_ID);
    url.searchParams.set("limit",String(pageSize));
    if(after)url.searchParams.set("after",after);
    const response=await fetcher(url.toString(),{method:"GET",headers:{"X-Alchemy-Token":env.ALCHEMY_NOTIFY_TOKEN,"accept":"application/json"}});
    if(!response.ok)throw Error("Alchemy address reconciliation HTTP "+response.status);
    let payload;
    try{payload=await response.json()}catch{throw Error("Alchemy address reconciliation returned invalid JSON")}
    if(!Array.isArray(payload?.data))throw Error("Alchemy address reconciliation has no address array");
    const advertised=payload?.pagination?.total_count;
    if(!Number.isSafeInteger(advertised)||advertised<0)throw Error("Alchemy address reconciliation has no trustworthy total count");
    if(total===null)total=advertised;
    if(total!==advertised)throw Error("Alchemy address count changed during pagination; retry for consistent snapshot");
    const page=payload.data;
    if(page.length>pageSize)throw Error("Alchemy address reconciliation returned oversized page");
    for(const raw of page){
      const parsed=addr(raw);
      if(!parsed)throw Error("Alchemy address reconciliation returned invalid address");
      if(all.has(parsed))throw Error("Alchemy address reconciliation returned duplicate address across pages");
      all.add(parsed);
    }
    pages++;
    const next=payload?.pagination?.cursors?.after;
    if(next!==undefined&&next!==null&&typeof next!=="string")throw Error("Alchemy returned invalid cursor");
    if(!next){
      if(all.size!==total)throw Error("Alchemy pagination ended before advertised total: "+all.size+"/"+total);
      return {addresses:all,total_count:total,pages};
    }
    if(next===after||cursors.has(next))throw Error("Alchemy address pagination cursor did not advance");
    if(all.size>=total)throw Error("Alchemy pagination has extra cursor after all addresses were returned");
    cursors.add(next);
    after=next;
  }
}

export async function compareAlchemyAddressLists(env,{fetcher=fetch,pageSize=100,maxPages=200}={}){
  // Include non-active local rows for diagnosis, never to implicitly subscribe
  // or delete them. D1 active is not proof of remote registration.
  const fetched=await fetchAlchemyAddresses(env,{fetcher,pageSize,maxPages});
  const rows=(await env.DB.prepare("SELECT address,state FROM wallet_watches WHERE state IN ('active','pending','removal_pending')").all()).results||[];
  const localActive=new Set(),localKnown=new Set(),pending=new Set(),removalPending=new Set();
  for(const row of rows){
    const address=addr(row.address);
    if(!address)throw Error("Local watch table contains an invalid address; reconciliation aborted");
    localKnown.add(address);
    if(row.state==="active")localActive.add(address);
    if(row.state==="pending")pending.add(address);
    if(row.state==="removal_pending")removalPending.add(address);
  }
  const missing=[...localActive].filter(x=>!fetched.addresses.has(x));
  const unexpected=[...fetched.addresses].filter(x=>!localKnown.has(x));
  const pendingRemote=[...pending].filter(x=>fetched.addresses.has(x));
  const removalRemote=[...removalPending].filter(x=>fetched.addresses.has(x));
  const matched=localActive.size-missing.length;
  return {
    checked_at:new Date().toISOString(),
    remote_total:fetched.total_count,pages:fetched.pages,
    local_active:localActive.size,matched_active:matched,
    missing_remote:missing.length,missing_sample:missing.slice(0,10),
    remote_not_in_local:unexpected.length,unexpected_sample:unexpected.slice(0,10),
    pending_already_remote:pendingRemote.length,pending_sample:pendingRemote.slice(0,10),
    removal_still_remote:removalRemote.length,removal_sample:removalRemote.slice(0,10),
    // Automatic remedial mutations are deliberately forbidden for now.
    status:missing.length||unexpected.length||removalRemote.length?"needs_review":"consistent"
  };
}

// Scheduled read-only reconciliation: one successful snapshot per 24 hours.
// Failed reads are retried after at least an hour. Never overwrite the last
// complete snapshot on HTTP 429, malformed pages or timeouts.
export async function maybeReconcileAlchemy(env,{fetcher=fetch,clock=()=>Date.now(),force=false}={}){
  if(!env.ALCHEMY_NOTIFY_TOKEN||!env.ALCHEMY_ACTIVITY_WEBHOOK_ID)return {skipped:"not_configured"};
  const db=env.DB,now=clock();
  const [ok,attempt]=(await db.batch([
    db.prepare("SELECT value FROM runtime_state WHERE key='alchemy_reconcile_last_ok'"),
    db.prepare("SELECT value FROM runtime_state WHERE key='alchemy_reconcile_last_attempt'")
  ])).map(x=>x.results?.[0]?.value||"0");
  if(!force && now-Number(ok)<24*3600*1000)return {skipped:"recent_success"};
  if(!force && now-Number(attempt)<3600*1000)return {skipped:"backoff"};
  // A conditional update claims the attempt across concurrent cron executions.
  await db.prepare("INSERT OR IGNORE INTO runtime_state(key,value) VALUES('alchemy_reconcile_last_attempt','0')").run();
  const claim=await db.prepare("UPDATE runtime_state SET value=?,updated_at=CURRENT_TIMESTAMP WHERE key='alchemy_reconcile_last_attempt' AND CAST(value AS INTEGER)<?")
    .bind(String(now),force?now+1:now-3600*1000).run();
  if(!claim.meta?.changes)return {skipped:"claimed_elsewhere"};
  try{
    const report=await compareAlchemyAddressLists(env,{fetcher});
    await db.batch([
      db.prepare("INSERT INTO runtime_state(key,value,updated_at) VALUES('alchemy_reconcile_report',?,CURRENT_TIMESTAMP) ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=CURRENT_TIMESTAMP").bind(JSON.stringify(report)),
      db.prepare("INSERT INTO runtime_state(key,value,updated_at) VALUES('alchemy_reconcile_last_ok',?,CURRENT_TIMESTAMP) ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=CURRENT_TIMESTAMP").bind(String(now)),
      db.prepare("DELETE FROM runtime_state WHERE key='alchemy_reconcile_last_error'")
    ]);
    return {status:report.status,remote_total:report.remote_total,missing_remote:report.missing_remote};
  }catch(error){
    const message=String(error?.message||error).slice(0,240);
    // Avoid leaking token or request URL (which contains a webhook ID).
    await db.prepare("INSERT INTO runtime_state(key,value,updated_at) VALUES('alchemy_reconcile_last_error',?,CURRENT_TIMESTAMP) ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=CURRENT_TIMESTAMP").bind(message).run();
    console.warn("Alchemy read-only reconciliation incomplete",message);
    return {error:message};
  }
}

export async function lastAlchemyReconciliation(db){
  const records=(await db.prepare("SELECT key,value FROM runtime_state WHERE key IN ('alchemy_reconcile_report','alchemy_reconcile_last_error','alchemy_reconcile_last_attempt')").all()).results||[];
  const values=Object.fromEntries(records.map(x=>[x.key,x.value]));
  let report=null;
  try{report=values.alchemy_reconcile_report?JSON.parse(values.alchemy_reconcile_report):null}catch{}
  return {report,last_error:values.alchemy_reconcile_last_error||null,
    last_attempt:values.alchemy_reconcile_last_attempt?Number(values.alchemy_reconcile_last_attempt):null};
}
