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
  if(existing.state!=="failed")return {error:"not_failed",status:409};
  const updated=await db.prepare(
    "UPDATE outbox SET state='pending',attempts=0,sending_started_at=NULL,"+
    "due_at=CURRENT_TIMESTAMP,last_error=NULL WHERE id=? AND state='failed'"
  ).bind(id).run();
  if(!updated.meta?.changes)return {error:"conflict",status:409};
  return {ok:true,task:existing};
}
