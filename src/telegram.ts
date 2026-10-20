// @ts-nocheck
import {addr,esc,send,telegram,buttons,now,trunc,increment} from "./core";
import {checkOwner} from "./approval";
import {scheduleMessageDeletion,finishRemarkCleanup} from "./cleanup";
import {renderTemplate} from "./notifications";
import {saveWalletRemark} from "./wallet-remarks";
async function memberAllowed(env,chatId,userId){
  try{
    const m=await telegram(env,"getChatMember",{chat_id:chatId,user_id:Number(userId)});
    return !["left","kicked"].includes(m.status);
  }catch(e){console.warn("membership verification failed",String(e));return false;}
}
export async function handleTelegram(env,upd){
  if(upd.callback_query){
    const c=upd.callback_query, data=String(c.data||"");
    const answer=(message="",show_alert=false)=>telegram(env,"answerCallbackQuery",{callback_query_id:c.id,...(message?{text:message,show_alert}:{})});
    if(!data.startsWith("remark:")){await answer();return;}
    const address=addr(data.slice(7)),chat=c.message?.chat;
    if(!address||!chat||chat.type==="private"){await answer("此消息无法编辑地址备注",true);return;}
    if(!await memberAllowed(env,chat.id,c.from.id)){
      await answer("无法验证群组成员身份，请将新机器人设为群管理员后重试",true);
      return;
    }
    // A newly discovered wallet can have valid USDT approval but still await
    // Alchemy enrollment. That must not prevent editing its group/global remark.
    const sub=await env.DB.prepare("SELECT 1 FROM subscriptions WHERE chat_id=? AND address=? AND status IN ('active','pending')").bind(String(chat.id),address).first();
    if(!sub){await answer("此地址尚未登记在本群或已被移除",true);return;}
    await answer("请回复下面的备注输入提示");
    const prompt=await send(env,chat.id,await renderTemplate(env,"remark_prompt",String(chat.id),{user_name:c.from.first_name,address}),{force_reply:true,selective:true});
    await env.DB.prepare("INSERT OR REPLACE INTO remark_sessions(chat_id,user_id,prompt_message_id,address,expires_at) VALUES(?,?,?,?,datetime('now','+10 minutes'))")
      .bind(String(chat.id),String(c.from.id),prompt.message_id,address).run();
    // Remove even abandoned 10-minute input prompts. Never remove the original result.
    await scheduleMessageDeletion(env,String(chat.id),prompt.message_id,"remark_prompt_expired",600);
    return;
  }
  const m=upd.message;if(!m||!m.from||!m.chat||!m.text)return;
  const chatId=String(m.chat.id), userId=String(m.from.id);
  const name=trunc([m.from.first_name,m.from.last_name].filter(Boolean).join(" "),80)||userId;
  await env.DB.prepare("INSERT INTO telegram_users(user_id,display_name,username,last_seen_at) VALUES(?,?,?,?) ON CONFLICT(user_id) DO UPDATE SET display_name=excluded.display_name,username=excluded.username,last_seen_at=excluded.last_seen_at")
    .bind(userId,name,m.from.username||null,now()).run();
  await env.DB.prepare("INSERT INTO telegram_chats(chat_id,title,chat_type) VALUES(?,?,?) ON CONFLICT(chat_id) DO UPDATE SET title=excluded.title,chat_type=excluded.chat_type,active=1")
    .bind(chatId,m.chat.title||"Private",m.chat.type).run();
  if(m.reply_to_message){
    const session=await env.DB.prepare("SELECT * FROM remark_sessions WHERE chat_id=? AND user_id=? AND prompt_message_id=? AND expires_at>datetime('now')").bind(chatId,userId,m.reply_to_message.message_id).first();
    if(session){
      const remark=trunc(m.text.trim(),80);
      if(!remark || Array.from(m.text.trim()).length>80 || /[\u0000-\u001f\u007f]/.test(remark)){
        const notice=await send(env,chatId,await renderTemplate(env,"remark_invalid",chatId));
        await scheduleMessageDeletion(env,chatId,m.message_id,"invalid_remark_input",90);
        await scheduleMessageDeletion(env,chatId,notice.message_id,"temporary_validation_notice",90);
        return;
      }
      if(!await memberAllowed(env,m.chat.id,m.from.id))return;
      const old=await env.DB.prepare("SELECT remark,remark_version FROM subscriptions WHERE chat_id=? AND address=? AND status IN ('active','pending')").bind(chatId,session.address).first();
      if(!old){
        await send(env,chatId,await renderTemplate(env,"remark_unwatched",chatId));
        await env.DB.prepare("DELETE FROM remark_sessions WHERE chat_id=? AND user_id=? AND prompt_message_id=?").bind(chatId,userId,m.reply_to_message.message_id).run();
        try{await finishRemarkCleanup(env,chatId,m.reply_to_message.message_id,m.message_id);}catch(e){console.warn("Remark cancellation cleanup",String(e));}
        return;
      }
      const result=await env.DB.prepare("UPDATE subscriptions SET remark=?,remark_version=remark_version+1,updated_at=? WHERE chat_id=? AND address=? AND status IN ('active','pending') AND remark_version=?")
        .bind(remark,now(),chatId,session.address,old.remark_version).run();
      if(!result.meta?.changes){
        await send(env,chatId,await renderTemplate(env,"remark_conflict",chatId));
        await env.DB.prepare("DELETE FROM remark_sessions WHERE chat_id=? AND user_id=? AND prompt_message_id=?").bind(chatId,userId,m.reply_to_message.message_id).run();
        try{await finishRemarkCleanup(env,chatId,m.reply_to_message.message_id,m.message_id);}catch(e){console.warn("Remark conflict cleanup",String(e));}
        return;
      }
      await saveWalletRemark(env,session.address,remark);
      await env.DB.prepare("INSERT INTO remark_edits(chat_id,address,actor_id,old_value,new_value) VALUES(?,?,?,?,?)").bind(chatId,session.address,userId,old.remark,remark).run();
      // Show the permanent result first, then delete BOTH temporary group messages.
      // Do not keep the editor's identity in the visible result.
      await send(env,chatId,await renderTemplate(env,"remark_saved",chatId,{remark,address:session.address}),buttons(session.address));
      await env.DB.prepare("DELETE FROM remark_sessions WHERE chat_id=? AND user_id=? AND prompt_message_id=?").bind(chatId,userId,m.reply_to_message.message_id).run();
      try{await finishRemarkCleanup(env,chatId,m.reply_to_message.message_id,m.message_id);}
      catch(e){console.warn("Remark cleanup deferred",String(e));}
      return;
    }
    // An answer to a prompt that has already timed out is disposable too.
    // It must not be mistaken for a new query or remain permanently visible.
    const knownPrompt=await env.DB.prepare(
      "SELECT 1 FROM telegram_message_cleanup WHERE chat_id=? AND message_id=? AND reason LIKE 'remark_prompt%'"
    ).bind(chatId,m.reply_to_message.message_id).first();
    if(knownPrompt){
      try{await scheduleMessageDeletion(env,chatId,m.message_id,"late_remark_reply");}
      catch(e){console.warn("Late remark cleanup deferred",String(e));}
      return;
    }
  }
  if(m.chat.type==="private"){
    if(/^\/start/.test(m.text))await send(env,chatId,await renderTemplate(env,"start_welcome",chatId,{chat_id:chatId}));
    return;
  }
  const match=m.text.trim().match(/^(?:\/check(?:@\w+)?\s+)?(0x[0-9a-fA-F]{40})$/);
  if(!match)return;
  const owner=addr(match[1]);if(!owner)return;
  // First *request* wins, not first completed external API lookup.
  await env.DB.prepare("INSERT OR IGNORE INTO wallets(address,first_user_id,first_user_name,discovery_source) VALUES(?,?,?,'manual')").bind(owner,userId,name).run();
  await env.DB.prepare("UPDATE wallets SET first_user_id=?,first_user_name=? WHERE address=? AND first_user_id IS NULL").bind(userId,name,owner).run();
  const progress=await send(env,chatId,await renderTemplate(env,"query_progress",chatId,{address:owner}));
  // Thirty-minute fail-safe: clean temporary inputs even if the queue stalls permanently.
  await Promise.all([
    scheduleMessageDeletion(env,chatId,m.message_id,"query_address_stale",1800),
    scheduleMessageDeletion(env,chatId,progress.message_id,"query_progress_stale",1800)
  ]);
  await env.TASKS.send({kind:"check",owner,chat_id:chatId,user_id:userId,display_name:name,
    user_message_id:m.message_id,progress_message_id:progress.message_id});
  await increment(env,"telegram_queries");
}
