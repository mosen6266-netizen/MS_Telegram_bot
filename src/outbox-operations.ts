// @ts-nocheck
// Admin-triggered recovery only. A failed Telegram send can be ambiguous
// (Telegram accepted the message but D1 status update failed), so the system
// must never automatically requeue terminal failures.
export async function requeueFailedOutbox(db,id){
  if(!Number.isSafeInteger(id)||id<=0)return {error:"invalid_id",status:400};
  const existing=await db.prepare(
    "SELECT id,state,template_key,chat_id,address FROM outbox WHERE id=?"
  ).bind(id).first();
  if(!existing)return {error:"not_found",status:404};
  if(!["failed","delivery_unknown"].includes(existing.state))return {error:"not_retryable",status:409};
  const updated=await db.prepare(
    "UPDATE outbox SET state='pending',attempts=0,sending_started_at=NULL,"+
    "due_at=CURRENT_TIMESTAMP,last_error=NULL WHERE id=? AND state IN ('failed','delivery_unknown')"
  ).bind(id).run();
  if(!updated.meta?.changes)return {error:"conflict",status:409};
  return {ok:true,task:existing};
}

// Fast, bounded server-side listing with searchable historical failures.
export async function listOutboxPage(db,{page=0,status="all",search=""}={}){
  page=Math.max(0,Math.min(100000,Number.parseInt(String(page),10)||0));
  search=String(search||"").trim().slice(0,40);
  if(!["all","pending","sending","sent","failed","skipped","delivery_unknown","acknowledged"].includes(status))return {error:"invalid_status",status:400};
  if(search&&!/^-?[0-9]{1,20}$/.test(search))return {error:"invalid_search",status:400};
  const id=search&&Number.isSafeInteger(Number(search))&&Number(search)>0?Number(search):null;
  const where="1=1"+(status==="all"?"":" AND state=?")+(search?(id!==null?" AND (id=? OR chat_id=?)":" AND chat_id=?"):"");
  const params=[...(status==="all"?[]:[status]),...(search?(id!==null?[id,search]:[search]):[])];
  const [count,items,summary]=await db.batch([
    db.prepare("SELECT COUNT(*) n FROM outbox WHERE "+where).bind(...params),
    db.prepare("SELECT id,chat_id,address,template_key,state,attempts,last_error,created_at,due_at FROM outbox WHERE "+where+" ORDER BY id DESC LIMIT 50 OFFSET ?").bind(...params,page*50),
    db.prepare("SELECT state,COUNT(*) n FROM outbox GROUP BY state")
  ]);
  const total=count.results?.[0]?.n||0;
  return {rows:items.results||[],summary:summary.results||[],page,total,total_pages:Math.ceil(total/50)};
}

// An administrator checks Telegram history and explicitly closes an uncertain
// delivery without claiming it was sent. This does not send anything.
export async function acknowledgeUnknownOutbox(db,id){
  if(!Number.isSafeInteger(id)||id<=0)return {error:"invalid_id",status:400};
  const row=await db.prepare("SELECT id,state,chat_id,template_key FROM outbox WHERE id=?").bind(id).first();
  if(!row)return {error:"not_found",status:404};
  if(row.state!=="delivery_unknown")return {error:"not_unknown",status:409};
  const updated=await db.prepare(
    "UPDATE outbox SET state='acknowledged',last_error='管理员确认已核查，不再自动投递',sending_started_at=NULL "+
    "WHERE id=? AND state='delivery_unknown'"
  ).bind(id).run();
  if(!updated.meta?.changes)return {error:"conflict",status:409};
  return {ok:true,task:row};
}
