// @ts-nocheck
import {json,verifyAlchemy,ensureWatch,send,esc} from "./core";
import {handleTelegram} from "./telegram";
import {checkOwner,pollSpenders,verifyAdminOwner} from "./approval";
import {scanSpenderHistories,verifyHistoricalAllowances} from "./spender-history";
import {enrollHistoricalOwners} from "./spender-enroll";
import {reconcileAlchemyAddresses} from "./alchemy-reconcile";
import {processActivity} from "./transfers";
import {provisionRealtimeApprovals,processRealtimeApprovalWebhook,storeFailedRealtimeApproval,retryFailedRealtimeApprovals} from "./approval-realtime";
import {retainFailedActivity,replayFailedActivities} from "./activity-replay";
import {scanWalletGaps,reconcileRecentReorgs} from "./recovery";
import {flushOutbox,recoverStuck,renderTemplate} from "./notifications";
import {collectUsage,runUsageAlerts} from "./usage";
import {handleAdmin,adminHtml} from "./admin";
import {authRoute,isAdmin,setupApi,configEnv} from "./setup";
import {finishAddressQueryCleanup,flushMessageCleanup} from "./cleanup";
async function cron(env){
  // Every maintenance path must be independent. A single bad wallet or RPC
  // outage must not starve Telegram delivery or other addresses.
  try{await recoverStuck(env)}catch(e){console.error("Outbox stuck-task recovery",String(e))}
  try{
    const {results:pending}=await env.DB.prepare("SELECT w.address FROM wallet_watches w WHERE w.state='pending' AND NOT EXISTS (SELECT 1 FROM wallet_exclusions x WHERE x.address=w.address) AND NOT EXISTS (SELECT 1 FROM wallets v WHERE v.address=w.address AND v.deleted_at IS NOT NULL) AND EXISTS (SELECT 1 FROM subscriptions s WHERE s.address=w.address AND s.status IN ('active','pending')) AND NOT EXISTS (SELECT 1 FROM spender_history_monitor_enrollments e WHERE e.owner=w.address AND e.state IN ('pending','running','retrying')) LIMIT 8").all();
    for(const p of pending||[]){
      try{
        if(await ensureWatch(env,p.address))
          await env.DB.prepare("UPDATE subscriptions SET status='active' WHERE address=? AND status='pending'").bind(p.address).run();
      }catch(e){console.error("Pending wallet subscription retry",p.address,String(e))}
    }
  }catch(e){console.error("Pending wallet discovery",String(e))}
  try{await provisionRealtimeApprovals(env);}catch(e){console.error("Realtime Approval provisioning",String(e))}
  try{await pollSpenders(env);}catch(e){console.error("Spender scan",String(e))}
  try{for(let i=0;i<4;i++){if(!await scanSpenderHistories(env))break;}}catch(e){console.error("Spender history scan",String(e))}
  try{await verifyHistoricalAllowances(env,8);}catch(e){console.error("Historical allowance checks",String(e))}
  try{await enrollHistoricalOwners(env,20);}catch(e){console.error("Historical monitoring enrollment",String(e))}
  try{await reconcileAlchemyAddresses(env);}catch(e){console.error("Alchemy address reconciliation",String(e))}
  try{await scanWalletGaps(env,8);}catch(e){console.error("Transfer recovery",String(e))}
  try{await reconcileRecentReorgs(env);}catch(e){console.error("Reorg checks",String(e))}
  try{await replayFailedActivities(env,3);}catch(e){console.error("Failed activity recovery",String(e))}
  try{await retryFailedRealtimeApprovals(env,3);}catch(e){console.error("Failed realtime Approval recovery",String(e))}
  try{await flushOutbox(env,40);}catch(e){console.error("Telegram outbox delivery",String(e))}
  try{await env.DB.prepare("DELETE FROM remark_sessions WHERE expires_at<datetime('now')").run();}
  catch(e){console.error("Expired remark session cleanup",String(e))}
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
      // Admin UI and admin APIs need their own session check in handleAdmin,
      // but do not need to decrypt RPC, Alchemy or Telegram secrets on every
      // navigation, filter or search request. Decrypt only for live webhooks.
      if(req.method==="GET"&&path==="/health")return json({service:"ethereum-usdt-monitor",network:"Ethereum Mainnet",status:"service_available",build:"2026-10-15-admin-fastpath-v1",database_configured:!!env.DB});
      if(req.method==="GET"&&path==="/admin")return new Response(adminHtml(),{headers:{"content-type":"text/html;charset=utf-8","cache-control":"no-store","x-frame-options":"DENY","content-security-policy":"default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'"}});
      if(path.startsWith("/api/"))return await handleAdmin(req,env,path);
      const active=(await env.DB.prepare("SELECT value FROM runtime_state WHERE key='is_active'").first())?.value==="1";
      const configured=active?await configEnv(env):env;
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
      if(req.method==="POST"&&path==="/webhooks/alchemy-approvals"){
        if(!active)return json({error:"Monitor is not enabled"},503);
        if(!configured.ALCHEMY_APPROVAL_WEBHOOK_ID||!configured.ALCHEMY_APPROVAL_SIGNING_KEY)
          return json({error:"Realtime Approval webhook not configured"},503);
        const raw=await req.text();
        const approvalEnv={...configured,ALCHEMY_SIGNING_KEY:configured.ALCHEMY_APPROVAL_SIGNING_KEY};
        if(!await verifyAlchemy(approvalEnv,raw,req.headers.get("x-alchemy-signature")))
          return json({error:"Invalid approval webhook signature"},401);
        const d=JSON.parse(raw);
        if(d.type!=="GRAPHQL"||d.webhookId!==configured.ALCHEMY_APPROVAL_WEBHOOK_ID)
          return json({error:"Unexpected approval source"},400);
        await env.TASKS.send({kind:"approval_webhook",payload:d,received_at:Date.now()});
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
      let configured=env;
      try{
        const active=(await env.DB.prepare("SELECT value FROM runtime_state WHERE key='is_active'").first())?.value==="1";
        if(!active){message.retry({delaySeconds:120});continue;}
        configured=await configEnv(env);
        if(item.kind==="check"){
          await checkOwner(configured,item.owner,item.chat_id,item.user_id,item.display_name);
          // A final query result was delivered; temporary user input and progress are no longer needed.
          try{await finishAddressQueryCleanup(configured,item);}
          catch(cleanErr){console.warn("Address query cleanup deferred",String(cleanErr));}
        }
        else if(item.kind==="activity")await processActivity(configured,item.payload);
        else if(item.kind==="approval_webhook")await processRealtimeApprovalWebhook(configured,item.payload);
        else if(item.kind==="enroll_owner"){
          const owner=item.owner;
          const excluded=await env.DB.prepare("SELECT 1 FROM wallet_exclusions WHERE address=?").bind(owner).first();
          const wallet=await env.DB.prepare("SELECT deleted_at FROM wallets WHERE address=?").bind(owner).first();
          if(!excluded&&!wallet?.deleted_at){
            if(await ensureWatch(configured,owner,item.block))
              await env.DB.prepare("UPDATE subscriptions SET status='active' WHERE address=? AND status='pending'").bind(owner).run();
          }
        }
        else if(item.kind==="verify_admin")await verifyAdminOwner(configured,item.owner,item.chat_id);
        else throw Error("Unknown queue message kind");
        // The queue should send Telegram notices immediately after ingest,
        // without waiting for the two-minute scheduled maintenance task.
        if(item.kind==="activity"||item.kind==="approval_webhook"){
          try{await flushOutbox(configured,20)}catch(e){console.error("Immediate Telegram dispatch",String(e))}
        }
        message.ack();
      }catch(e){
        console.error("Queue job failed",item.kind,String(e));
        if(message.attempts>=5){
          if(item.kind==="approval_webhook"){
            try{await storeFailedRealtimeApproval(env,item.payload,e)}
            catch(saveError){console.error("Realtime approval retention failed",String(saveError));message.retry({delaySeconds:120});continue}
          }
          if(item.kind==="activity"){
            // Never ACK a failed real chain event until its replay payload
            // has been durably stored in D1.
            try{await retainFailedActivity(env,item.payload,e);}
            catch(saveError){
              console.error("Activity failure retention failed",String(saveError));
              message.retry({delaySeconds:120});
              continue;
            }
          }
          if(item.kind==="check"){
            try{await send(configured,item.chat_id,await renderTemplate(configured,"query_failed",item.chat_id,{address:item.owner}));}catch{}
            try{await finishAddressQueryCleanup(configured,item);}
            catch(cleanErr){console.warn("Failed query cleanup deferred",String(cleanErr));}
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
    // Always expire abandoned remark prompts, even when finance monitoring is paused.
    ctx.waitUntil((async()=>{try{await flushMessageCleanup(configured,60);}
      catch(e){console.warn("Telegram message cleanup maintenance",String(e));}})());
    ctx.waitUntil((async()=>{const active=(await env.DB.prepare("SELECT value FROM runtime_state WHERE key='is_active'").first())?.value==="1";if(active)await cron(configured);})());
  }
};
