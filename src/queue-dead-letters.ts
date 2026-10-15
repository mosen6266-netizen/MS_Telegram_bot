// @ts-nocheck
// Durable quarantine for Cloudflare Queue messages exhausted to a DLQ.
// We intentionally never replay jobs automatically: a prior attempt may
// have succeeded at Telegram/Alchemy before its acknowledgement was lost.
export async function receiveDeadLetters(env,batch){
  let succeeded=0,failed=0;
  for(const msg of batch.messages||[]){
    try{
      if(!msg.id)throw Error("Dead-letter item is missing a stable Queue message id");
      const raw=JSON.stringify(msg.body);
      if(!raw||raw.length>750000)throw Error("Dead-letter payload is too large to store safely");
      const kind=String(msg.body?.kind||"unknown").slice(0,64);
      await env.DB.prepare(
        "INSERT OR IGNORE INTO queue_dead_letters(queue_message_id,kind,payload_json,attempts) VALUES(?,?,?,?)"
      ).bind(String(msg.id),kind,raw,Math.max(0,Number(msg.attempts)||0)).run();
      msg.ack();
      succeeded++;
    }catch(e){
      failed++;
      console.error("DLQ archive failure; leaving message for retry",String(e));
      msg.retry({delaySeconds:120});
    }
  }
  return {succeeded,failed};
}
export async function listDeadLetters(db,{page=0,state="needs_review"}={}){
  if(!["all","needs_review","reviewed"].includes(String(state)))
    return {error:"invalid_state",status:400};
  const safePage=Math.max(0,Math.min(100000,parseInt(String(page),10)||0));
  const where=state==="all"?"":" WHERE state=?";
  const params=state==="all"?[]:[state];
  const [c,r]=await db.batch([
    db.prepare("SELECT COUNT(*) n FROM queue_dead_letters"+where).bind(...params),
    db.prepare("SELECT id,kind,attempts,state,first_seen_at,reviewed_at FROM queue_dead_letters"+
      where+" ORDER BY id DESC LIMIT 30 OFFSET ?").bind(...params,safePage*30)
  ]);
  const total=c.results?.[0]?.n||0;
  return {rows:r.results||[],total,page:safePage,total_pages:Math.ceil(total/30)};
}
export async function reviewDeadLetter(db,id){
  if(!Number.isSafeInteger(id)||id<=0)return {error:"invalid_id",status:400};
  const task=await db.prepare("SELECT id,kind,state FROM queue_dead_letters WHERE id=?").bind(id).first();
  if(!task)return {error:"not_found",status:404};
  if(task.state!=="needs_review")return {error:"already_reviewed",status:409};
  const updated=await db.prepare(
    "UPDATE queue_dead_letters SET state='reviewed',reviewed_at=CURRENT_TIMESTAMP WHERE id=? AND state='needs_review'"
  ).bind(id).run();
  if(!updated.meta?.changes)return {error:"conflict",status:409};
  return {ok:true,task};
}
