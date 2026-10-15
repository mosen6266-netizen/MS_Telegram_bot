// @ts-nocheck
import {send,buttons,esc,short,now,notifyAdmin,increment} from "./core";
const DEFAULTS={
usage_alert:"⚠️ <b>平台用量通知</b>\n{{alert_text}}",
new_approval:"🛡️ <b>发现新的 USDT 授权</b>\n备注：{{remark}}\nOwner：<code>{{owner}}</code>\nSpender：<code>{{spender}}</code>\n被授权人备注：{{spender_remark}}\n当前授权：{{amount}}\n资金监控：{{watch_status}}\n交易：<code>{{tx_hash}}</code>",
approval_change:"🔄 <b>USDT 授权变更</b>\n备注：{{remark}}\n钱包：<code>{{owner}}</code>\n被授权人：<code>{{spender}}</code>\n变化：{{event_type}}\n最新额度：{{amount}}\n交易：<code>{{tx_hash}}</code>",
transfer:"🔔 <b>Ethereum 资金异动</b>\n备注：{{remark}}\n监控地址：<code>{{address}}</code>\n资产：{{asset}}\n方向：{{direction}}\n金额：{{amount}} {{asset}}\n发送方：<code>{{from_address}}</code>\n接收方：<code>{{to_address}}</code>\n交易：<code>{{tx_hash}}</code>\n区块：{{block_number}}\n状态：首个区块已确认",
reorg_correction:"⚠️ <b>区块链重组更正通知</b>\n钱包备注：{{remark}}\n地址：<code>{{address}}</code>\n资产：{{asset}}\n交易：<code>{{tx_hash}}</code>\n原区块：{{block_number}}\n原交易所在区块已离开当前主链，之前的提醒不再代表有效确认。请查看链上最新交易状态。"
};
export const defaults=DEFAULTS;
function render(template,data){
  // Only program-owned template markup remains unescaped. User-controlled values are HTML-escaped.
  const allowed=new Set(["remark","address","owner","spender","spender_remark","amount","asset","direction","from_address","to_address","tx_hash","block_number","event_type","watch_status","alert_text"]);
  return template.replace(/\{\{([a-z_]+)\}\}/g,(_,name)=>allowed.has(name)?esc(data[name]??"—"):"—");
}
export async function flushOutbox(env,max=30,onlyUsage=false){
  const {results:rows}=await env.DB.prepare("SELECT * FROM outbox WHERE state='pending' AND due_at<=CURRENT_TIMESTAMP "+(onlyUsage?"AND template_key='usage_alert' ":"")+"ORDER BY id ASC LIMIT ?").bind(max).all();
  for(const row of rows||[]){
    const locked=await env.DB.prepare("UPDATE outbox SET state='sending',attempts=attempts+1 WHERE id=? AND state='pending'").bind(row.id).run();
    if(!locked.meta?.changes)continue;
    try {
      const payload=JSON.parse(row.payload_json||"{}");
      if(row.template_key==="usage_alert"&&payload.expires_at&&Date.parse(payload.expires_at)<=Date.now()){
        await env.DB.prepare("UPDATE outbox SET state='skipped',last_error='Usage period has reset' WHERE id=?").bind(row.id).run();
        continue;
      }
      let remark="—";
      if(row.address){
        const sub=await env.DB.prepare("SELECT remark,status FROM subscriptions WHERE address=? AND chat_id=?").bind(row.address,row.chat_id).first();
        if(!sub || sub.status!=="active"){
          await env.DB.prepare("UPDATE outbox SET state='skipped',last_error='Subscription no longer active' WHERE id=?").bind(row.id).run();
          continue;
        }
        remark=sub.remark;
      }
      const templateRow=await env.DB.prepare("SELECT body FROM templates WHERE template_key=? AND chat_id IN (?, '*') ORDER BY CASE WHEN chat_id=? THEN 0 ELSE 1 END LIMIT 1").bind(row.template_key,row.chat_id,row.chat_id).first();
      const content=render(templateRow?.body||DEFAULTS[row.template_key]||"{{address}}",{...payload,remark,address:row.address});
      const result=await send(env,row.chat_id,content.slice(0,3800),row.address?buttons(row.address):undefined);
      await env.DB.prepare("UPDATE outbox SET state='sent',sent_at=?,telegram_message_id=?,last_error=NULL WHERE id=?").bind(now(),result.message_id,row.id).run();
    }catch(e){
      const message=String(e).slice(0,250);
      if(row.attempts>=5&&row.template_key!=="usage_alert"){
        await env.DB.prepare("UPDATE outbox SET state='failed',last_error=? WHERE id=?").bind(message,row.id).run();
        await notifyAdmin(env,"⚠️ <b>通知投递失败</b>\n队列编号："+row.id+"\n原因："+esc(message));
      }else{
        const seconds=Math.max(Number(e?.retryAfter)||0,Math.min(3600,30*Math.pow(2,Math.min(row.attempts,7))));
        await env.DB.prepare("UPDATE outbox SET state='pending',last_error=?,due_at=datetime('now',?) WHERE id=?").bind(message,"+"+seconds+" seconds",row.id).run();
      }
    }
  }
}
export async function recoverStuck(env){
  await env.DB.prepare("UPDATE outbox SET state='pending',due_at=datetime('now') WHERE state='sending' AND created_at<datetime('now','-10 minutes')").run();
}
