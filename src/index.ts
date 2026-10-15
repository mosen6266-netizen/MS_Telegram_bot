// @ts-nocheck
import {json,verifyAlchemy,ensureWatch,send,esc} from "./core";
import {handleTelegram} from "./telegram";
import {checkOwner,pollSpenders,verifyAdminOwner} from "./approval";
import {processActivity} from "./transfers";
import {scanWalletGaps,reconcileRecentReorgs} from "./recovery";
import {flushOutbox,recoverStuck} from "./notifications";
import {collectUsage,runUsageAlerts} from "./usage";
import {handleAdmin,adminHtml} from "./admin";
import {authRoute,isAdmin,setupApi,configEnv} from "./setup";
async function cron(env){
  await recoverStuck(env);
  const {results:pending}=await env.DB.prepare("SELECT address FROM wallet_watches WHERE state='pending' LIMIT 15").all();
  for(const p of pending||[]){
    if(await ensureWatch(env,p.address))await env.DB.prepare("UPDATE subscriptions SET status='active' WHERE address=? AND status='pending'").bind(p.address).run();
  }
  try{await pollSpenders(env);}catch(e){console.error("Spender scan",String(e))}
  try{await scanWalletGaps(env,3);}catch(e){console.error("Transfer recovery",String(e))}
  try{await reconcileRecentReorgs(env);}catch(e){console.error("Reorg checks",String(e))}
  await flushOutbox(env,40);
  await env.DB.prepare("DELETE FROM remark_sessions WHERE expires_at<datetime('now')").run();
}
export default {
  async fetch(req,env,ctx){
    const url=new URL(req.url),path=url.pathname;
    try{
      if(path.startsWith("/auth/"))return await authRoute(req,env,path);
      if(path.startsWith("/api/setup/")){
        if(!await isAdmin(req,env))return json({error:"Administrator authentication required"},401);
        return await setupApi(req,env,path);
      }
      const active=(await env.DB.prepare("SELECT value FROM runtime_state WHERE key='is_active'").first())?.value==="1";
      const configured=active?await configEnv(env):env;
      if(req.method==="GET"&&path==="/health")return json({service:"ethereum-usdt-monitor",network:"Ethereum Mainnet",status:"service_available",build:"2026-10-15-usage-v1",database_configured:!!env.DB});
      if(req.method==="GET"&&path==="/admin")return new Response(adminHtml(),{headers:{"content-type":"text/html;charset=utf-8","cache-control":"no-store","x-frame-options":"DENY","content-security-policy":"default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'"}});
      if(path.startsWith("/api/"))return await handleAdmin(req,env,path);
      if(req.method==="POST"&&path==="/webhooks/telegram"){
        if(!active)return json({error:"Monitor is not enabled"},503);
        if(!configured.TELEGRAM_WEBHOOK_SECRET||req.headers.get("x-telegram-bot-api-secret-token")!==configured.TELEGRAM_WEBHOOK_SECRET)return json({error:"Unauthorized"},401);
        const upd=await req.json();
        if(!Number.isSafeInteger(upd.update_id))return json({error:"Invalid update"},400);
        // Mark after successful handling; Telegram retries on transient failure.
        const seen=await env.DB.prepare("SELECT 1 FROM telegram_updates WHERE update_id=?").bind(upd.update_id).first();
        if(seen)return json({ok:true,duplicate:true});
        await handleTelegram(configured,upd);
        await env.DB.prepare("INSERT OR IGNORE INTO telegram_updates(update_id) VALUES(?)").bind(upd.update_id).run();
        return json({ok:true});
      }
      if(req.method==="POST"&&path==="/webhooks/alchemy"){
        if(!active)return json({error:"Monitor is not enabled"},503);
        const raw=await req.text();
        if(!await verifyAlchemy(configured,raw,req.headers.get("x-alchemy-signature")))return json({error:"Invalid webhook signature"},401);
        const d=JSON.parse(raw);
        await env.TASKS.send({kind:"activity",payload:d});
        return json({ok:true});
      }
      return json({error:"Not found"},404);
    }catch(e){
      console.error("Worker request error",String(e));
      return json({error:"Service temporarily unavailable"},503);
    }
  },
  async queue(batch,env,ctx){
    for(const message of batch.messages){
      const item=message.body;
      try{
        const active=(await env.DB.prepare("SELECT value FROM runtime_state WHERE key='is_active'").first())?.value==="1";
        if(!active){message.retry({delaySeconds:120});continue;}
        const configured=await configEnv(env);
        if(item.kind==="check")await checkOwner(configured,item.owner,item.chat_id,item.user_id,item.display_name);
        else if(item.kind==="activity")await processActivity(configured,item.payload);
        else if(item.kind==="verify_admin")await verifyAdminOwner(configured,item.owner,item.chat_id);
        else throw Error("Unknown queue message kind");
        message.ack();
      }catch(e){
        console.error("Queue job failed",item.kind,String(e));
        if(message.attempts>=5){
          if(item.kind==="check"){
            try{await send(configured,item.chat_id,"⚠️ <b>USDT 授权查询未完成</b>\n请稍后重试。系统未把此地址错误标记为无授权，也未擅自开启监控。");}catch{}
          }
          message.ack();
        }else message.retry({delaySeconds:Math.min(120,10*Math.pow(2,message.attempts||1))});
      }
    }
  },
  async scheduled(event,env,ctx){
    const configured=await configEnv(env);
    ctx.waitUntil((async()=>{
      try{await collectUsage(configured);await runUsageAlerts(configured);await flushOutbox(configured,10,true);}
      catch(e){console.error("Usage maintenance failed",String(e));}
    })());
    ctx.waitUntil((async()=>{const active=(await env.DB.prepare("SELECT value FROM runtime_state WHERE key='is_active'").first())?.value==="1";if(active)await cron(configured);})());
  }
};
