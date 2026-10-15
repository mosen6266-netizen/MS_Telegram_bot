// @ts-nocheck
import {telegram,now} from "./core";

// Deletion requests are durable. Only temporary group inputs / progress prompts are queued.
// Final authorization, transfer and remark-result messages are NEVER queued.
export async function scheduleMessageDeletion(env,chatId,messageId,reason,delaySeconds=0){
  if(!/^-?\d+$/.test(String(chatId))||!Number.isSafeInteger(Number(messageId))||Number(messageId)<=0)return;
  const due=new Date(Date.now()+Math.max(0,delaySeconds)*1000).toISOString();
  await env.DB.prepare(
    "INSERT INTO telegram_message_cleanup(chat_id,message_id,reason,due_at) VALUES(?,?,?,?) "+
    "ON CONFLICT(chat_id,message_id) DO UPDATE SET "+
    "due_at=CASE WHEN state='deleted' THEN due_at WHEN excluded.due_at<due_at THEN excluded.due_at ELSE due_at END, "+
    "state=CASE WHEN state='deleted' THEN 'deleted' ELSE 'pending' END, updated_at=CURRENT_TIMESTAMP"
  ).bind(String(chatId),Number(messageId),reason,due).run();
}
export async function finishAddressQueryCleanup(env,job){
  const tasks=[];
  if(job.user_message_id)tasks.push(scheduleMessageDeletion(env,job.chat_id,job.user_message_id,"query_address"));
  if(job.progress_message_id)tasks.push(scheduleMessageDeletion(env,job.chat_id,job.progress_message_id,"query_progress"));
  await Promise.all(tasks);
  await flushMessageCleanup(env,8);
}
export async function finishRemarkCleanup(env,chatId,promptMessageId,userMessageId){
  await Promise.all([
    scheduleMessageDeletion(env,chatId,promptMessageId,"remark_prompt"),
    scheduleMessageDeletion(env,chatId,userMessageId,"remark_input")
  ]);
  await flushMessageCleanup(env,8);
}
export async function flushMessageCleanup(env,limit=35){
  // Recover interruptions that happened after taking ownership of a cleanup job.
  await env.DB.prepare(
    "UPDATE telegram_message_cleanup SET state='pending' WHERE state='processing' AND updated_at<datetime('now','-5 minutes')"
  ).run();
  const rows=await env.DB.prepare(
    "SELECT chat_id,message_id,attempts,reason FROM telegram_message_cleanup "+
    "WHERE state='pending' AND due_at<=? ORDER BY due_at LIMIT ?"
  ).bind(now(),limit).all();
  for(const task of rows.results||[]){
    const lease=await env.DB.prepare(
      "UPDATE telegram_message_cleanup SET state='processing', attempts=attempts+1,updated_at=CURRENT_TIMESTAMP "+
      "WHERE chat_id=? AND message_id=? AND state='pending'"
    ).bind(task.chat_id,task.message_id).run();
    if(!lease.meta?.changes)continue;
    try{
      await telegram(env,"deleteMessage",{chat_id:task.chat_id,message_id:task.message_id});
      await env.DB.prepare(
        "UPDATE telegram_message_cleanup SET state='deleted',last_error=NULL,updated_at=CURRENT_TIMESTAMP "+
        "WHERE chat_id=? AND message_id=?"
      ).bind(task.chat_id,task.message_id).run();
    }catch(error){
      const detail=String(error?.message||error).slice(0,220);
      // Deleted earlier by admins (or by a prior attempt whose acknowledgement was lost).
      if(/message to delete not found|message not found/i.test(detail)){
        await env.DB.prepare(
          "UPDATE telegram_message_cleanup SET state='deleted',last_error=NULL,updated_at=CURRENT_TIMESTAMP "+
          "WHERE chat_id=? AND message_id=?"
        ).bind(task.chat_id,task.message_id).run();
        continue;
      }
      const permanent=/message can't be deleted|message cannot be deleted|message is too old/i.test(detail);
      const attempts=Number(task.attempts)+1;
      if(permanent||attempts>=9){
        await env.DB.prepare(
          "UPDATE telegram_message_cleanup SET state='blocked',last_error=?,updated_at=CURRENT_TIMESTAMP "+
          "WHERE chat_id=? AND message_id=?"
        ).bind(detail,task.chat_id,task.message_id).run();
      }else{
        const backoff=Math.min(3600,20*Math.pow(2,Math.min(attempts,7)));
        await env.DB.prepare(
          "UPDATE telegram_message_cleanup SET state='pending',last_error=?,due_at=?,updated_at=CURRENT_TIMESTAMP "+
          "WHERE chat_id=? AND message_id=?"
        ).bind(detail,new Date(Date.now()+backoff*1000).toISOString(),task.chat_id,task.message_id).run();
      }
      console.warn("Telegram cleanup failed",task.reason,detail);
    }
  }
}
