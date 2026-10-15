// @ts-nocheck
import {send,buttons,esc,short,now,notifyAdmin,increment} from "./core";
const DEFAULTS={
usage_alert:"⚠️ <b>平台用量通知</b>\n{{alert_text}}",
new_approval:"🛡️ <b>发现新的 USDT 授权</b>\n备注：{{remark}}\nOwner：<code>{{owner}}</code>\nSpender：<code>{{spender}}</code>\n被授权人备注：{{spender_remark}}\n当前授权：{{amount}}\n资金监控：{{watch_status}}\n交易：<code>{{tx_hash}}</code>",
approval_change:"🔄 <b>USDT 授权变更</b>\n备注：{{remark}}\n钱包：<code>{{owner}}</code>\n被授权人：<code>{{spender}}</code>\n变化：{{event_type}}\n最新额度：{{amount}}\n交易：<code>{{tx_hash}}</code>",
transfer:"🔔 <b>Ethereum 资金异动</b>\n备注：{{remark}}\n监控地址：<code>{{address}}</code>\n资产：{{asset}}\n方向：{{direction}}\n金额：{{amount}} {{asset}}\n发送方：<code>{{from_address}}</code>\n接收方：<code>{{to_address}}</code>\n交易：<code>{{tx_hash}}</code>\n区块：{{block_number}}\n状态：首个区块已确认",
reorg_correction:"⚠️ <b>区块链重组更正通知</b>\n钱包备注：{{remark}}\n地址：<code>{{address}}</code>\n资产：{{asset}}\n交易：<code>{{tx_hash}}</code>\n原区块：{{block_number}}\n原交易所在区块已离开当前主链，之前的提醒不再代表有效确认。请查看链上最新交易状态。"
,
query_progress:"🔎 <b>正在查询 USDT 授权</b>\n地址：<code>{{address}}</code>\n正在检索历史授权并核验当前额度，请稍候……",
query_active:"🛡️ <b>USDT 有效授权</b>\n备注：{{remark}}\n地址：<code>{{address}}</code>\n{{approval_list}}{{more_count}}\n资金监控：{{watch_status}}",
query_inactive:"🔎 <b>USDT 授权核验完成</b>\n地址：<code>{{address}}</code>\n未发现当前有效授权，因此未自动启动资金监控。",
query_failed:"⚠️ <b>USDT 授权查询未完成</b>\n地址：<code>{{address}}</code>\n请稍后重试。系统未把此地址错误标记为无授权，也未擅自开启监控。",
remark_prompt:"✏️ {{user_name}}，请<b>回复这条消息</b>输入新的地址备注：\n<code>{{address}}</code>\n限 1–80 个字符，10 分钟内有效。",
remark_invalid:"⚠️ 备注必须为 1–80 个有效字符，请重新回复。",
remark_unwatched:"⚠️ 当前群组已停止监控这个地址。",
remark_conflict:"⚠️ 备注已被其他成员更新，请重新点击修改按钮。",
remark_saved:"✅ 地址备注已更新：<b>{{remark}}</b>\n<code>{{address}}</code>",
start_welcome:"欢迎使用 Ethereum USDT 授权监控机器人。请将机器人加入群组后发送 Ethereum 地址查询。\n管理员私聊预警需配置本聊天 ID：{{chat_id}}",
notice_failed:"⚠️ <b>通知投递失败</b>\n队列编号：{{queue_id}}\n原因：{{error_message}}"
};
export const defaults=DEFAULTS;
export const templateCatalog=[
  {
    "key": "query_progress",
    "title": "授权查询中",
    "category": "查询回复",
    "mode": "被动回复",
    "description": "成员发送钱包地址后立即显示，查询结束后自动删除。",
    "variables": [
      "address"
    ],
    "temporary": true
  },
  {
    "key": "query_active",
    "title": "查询到有效 USDT 授权",
    "category": "查询回复",
    "mode": "被动回复",
    "description": "展示地址、群组备注、授权明细及资金监控状态，保留修改备注按钮。",
    "variables": [
      "remark",
      "address",
      "approval_list",
      "more_count",
      "watch_status"
    ],
    "temporary": false
  },
  {
    "key": "query_inactive",
    "title": "未查询到有效授权",
    "category": "查询回复",
    "mode": "被动回复",
    "description": "核验无有效 USDT 授权时的回复，不启动资金监控。",
    "variables": [
      "address"
    ],
    "temporary": false
  },
  {
    "key": "query_failed",
    "title": "授权查询失败",
    "category": "查询回复",
    "mode": "被动回复",
    "description": "链上接口持续失败后的兜底提醒，不会错误判断成未授权。",
    "variables": [
      "address"
    ],
    "temporary": false
  },
  {
    "key": "remark_prompt",
    "title": "请输入新备注",
    "category": "备注管理",
    "mode": "被动回复",
    "description": "群成员点击修改备注按钮后显示，十分钟后自动清理。",
    "variables": [
      "user_name",
      "address"
    ],
    "temporary": true
  },
  {
    "key": "remark_invalid",
    "title": "备注格式不符合要求",
    "category": "备注管理",
    "mode": "被动回复",
    "description": "用户提交空备注或非法内容时发送，会自动清理。",
    "variables": [],
    "temporary": true
  },
  {
    "key": "remark_unwatched",
    "title": "备注修改时已停止监控",
    "category": "备注管理",
    "mode": "被动回复",
    "description": "地址已从该群停止监控时回复。",
    "variables": [],
    "temporary": false
  },
  {
    "key": "remark_conflict",
    "title": "备注被其他成员修改",
    "category": "备注管理",
    "mode": "被动回复",
    "description": "并发修改冲突时提醒重新操作。",
    "variables": [],
    "temporary": false
  },
  {
    "key": "remark_saved",
    "title": "备注修改成功",
    "category": "备注管理",
    "mode": "被动回复",
    "description": "群备注保存成功后的永久结果，附修改备注按钮。",
    "variables": [
      "remark",
      "address"
    ],
    "temporary": false
  },
  {
    "key": "new_approval",
    "title": "发现新 USDT 授权",
    "category": "授权推送",
    "mode": "主动推送",
    "description": "Spender 新授权发现时推送给对应群组。",
    "variables": [
      "remark",
      "owner",
      "spender",
      "spender_remark",
      "amount",
      "watch_status",
      "tx_hash"
    ],
    "temporary": false
  },
  {
    "key": "approval_change",
    "title": "USDT 授权额度变更",
    "category": "授权推送",
    "mode": "主动推送",
    "description": "已发现授权的撤销、增加或减少等变化提醒。",
    "variables": [
      "remark",
      "owner",
      "spender",
      "event_type",
      "amount",
      "tx_hash"
    ],
    "temporary": false
  },
  {
    "key": "transfer",
    "title": "ETH / USDT / USDC 转账提醒",
    "category": "资金监控",
    "mode": "主动推送",
    "description": "监控钱包发生入账或出账并经首个区块确认时推送。",
    "variables": [
      "remark",
      "address",
      "asset",
      "direction",
      "amount",
      "from_address",
      "to_address",
      "tx_hash",
      "block_number"
    ],
    "temporary": false
  },
  {
    "key": "reorg_correction",
    "title": "区块链重组更正",
    "category": "资金监控",
    "mode": "主动推送",
    "description": "此前确认的区块被重组替换时发送更正提醒。",
    "variables": [
      "remark",
      "address",
      "asset",
      "tx_hash",
      "block_number"
    ],
    "temporary": false
  },
  {
    "key": "usage_alert",
    "title": "平台额度与费用预警",
    "category": "系统通知",
    "mode": "系统通知",
    "description": "平台用量达到 80% 或预测七天内耗尽时发给管理员；也用于费用通道测试。",
    "variables": [
      "alert_text"
    ],
    "temporary": false
  },
  {
    "key": "notice_failed",
    "title": "通知发送最终失败",
    "category": "系统通知",
    "mode": "系统通知",
    "description": "通知连续投递失败，提醒管理员检查错误原因。",
    "variables": [
      "queue_id",
      "error_message"
    ],
    "temporary": false
  },
  {
    "key": "start_welcome",
    "title": "机器人私聊欢迎消息",
    "category": "系统通知",
    "mode": "被动回复",
    "description": "管理员私聊向机器人发送 /start 时显示 Chat ID。",
    "variables": [
      "chat_id"
    ],
    "temporary": false
  }
];
function render(template,data,safeHtml={}){
  // All user data is HTML-escaped. The query handler generates only trusted approval_list markup.
  const allowed=new Set(["remark","address","owner","spender","spender_remark","amount","asset","direction","from_address","to_address","tx_hash","block_number","event_type","watch_status","alert_text","more_count","user_name","chat_id","queue_id","error_message"]);
  return template.replace(/\{\{([a-z_]+)\}\}/g,(_,name)=>name==="approval_list"?String(safeHtml.approval_list||""):allowed.has(name)?esc(data[name]??"—"):"—");
}
export async function renderTemplate(env,key,chatId,data={},safeHtml={}){
  const row=await env.DB.prepare("SELECT body FROM templates WHERE template_key=? AND chat_id IN (?, '*') ORDER BY CASE WHEN chat_id=? THEN 0 ELSE 1 END LIMIT 1")
    .bind(key,String(chatId),String(chatId)).first();
  return render(row?.body||DEFAULTS[key]||"",data,safeHtml);
}

export async function flushOutbox(env,max=30,onlyUsage=false){
  const {results:rows}=await env.DB.prepare("SELECT * FROM outbox WHERE state='pending' AND due_at<=CURRENT_TIMESTAMP "+(onlyUsage?"AND template_key='usage_alert' ":"")+"ORDER BY id ASC LIMIT ?").bind(max).all();
  for(const row of rows||[]){
    const locked=await env.DB.prepare("UPDATE outbox SET state='sending',attempts=attempts+1,due_at=CURRENT_TIMESTAMP WHERE id=? AND state='pending'").bind(row.id).run();
    if(!locked.meta?.changes)continue;
    try {
      const payload=JSON.parse(row.payload_json||"{}");
      // A changed Spender destination must not receive delayed approval notices
      // through routes that have already been removed.
      if(payload.spender && (row.template_key==="new_approval"||row.template_key==="approval_change")){
        const linked=await env.DB.prepare("SELECT r.chat_id,s.remark FROM spender_routes r JOIN spender_rules s ON s.spender=r.spender WHERE r.spender=? AND r.chat_id=?")
          .bind(String(payload.spender).toLowerCase(),String(row.chat_id)).first();
        if(!linked){
          await env.DB.prepare("UPDATE outbox SET state='skipped',last_error='Spender 通知群已更换' WHERE id=?").bind(row.id).run();
          continue;
        }
        payload.spender_remark=linked.remark;
      }
      if(row.template_key==="usage_alert"&&payload.expires_at&&Date.parse(payload.expires_at)<=Date.now()){
        await env.DB.prepare("UPDATE outbox SET state='skipped',last_error='Usage period has reset' WHERE id=?").bind(row.id).run();
        continue;
      }
      let remark="—";
      if(row.address){
        const sub=await env.DB.prepare("SELECT remark,status FROM subscriptions WHERE address=? AND chat_id=?").bind(row.address,row.chat_id).first();
        // A new approval should reach the configured Telegram group even if
        // the Alchemy address enrollment is still pending. The alert explicitly
        // labels this state. Explicitly paused/removed subscriptions stay muted.
        const approvalAlert=row.template_key==="new_approval"||row.template_key==="approval_change";
        if(!sub || (sub.status!=="active"&&!(approvalAlert&&sub.status==="pending"))){
          await env.DB.prepare("UPDATE outbox SET state='skipped',last_error='Subscription no longer active' WHERE id=?").bind(row.id).run();
          continue;
        }
        remark=sub.remark;
      }
      const content=await renderTemplate(env,row.template_key,row.chat_id,{...payload,remark,address:row.address});
      const result=await send(env,row.chat_id,content.slice(0,3800),row.address?buttons(row.address):undefined);
      await env.DB.prepare("UPDATE outbox SET state='sent',sent_at=?,telegram_message_id=?,last_error=NULL WHERE id=?").bind(now(),result.message_id,row.id).run();
    }catch(e){
      const message=String(e).slice(0,250);
      if(row.attempts+1>=5&&row.template_key!=="usage_alert"){
        await env.DB.prepare("UPDATE outbox SET state='failed',last_error=? WHERE id=?").bind(message,row.id).run();
        // Best-effort escalation: a broken administrator DM must not prevent
        // the remaining users' notifications from being delivered.
        try{await notifyAdmin(env,await renderTemplate(env,"notice_failed",env.ADMIN_TELEGRAM_CHAT_ID||"*",{queue_id:row.id,error_message:message}));}
        catch(reportError){console.warn("Failed-notice escalation unavailable",String(reportError));}
      }else{
        const seconds=Math.max(Number(e?.retryAfter)||0,Math.min(3600,30*Math.pow(2,Math.min(row.attempts,7))));
        await env.DB.prepare("UPDATE outbox SET state='pending',last_error=?,due_at=datetime('now',?) WHERE id=?").bind(message,"+"+seconds+" seconds",row.id).run();
      }
    }
  }
}
export async function recoverStuck(env){
  await env.DB.prepare("UPDATE outbox SET state='pending',due_at=datetime('now') WHERE state='sending' AND due_at<datetime('now','-10 minutes')").run();
}
