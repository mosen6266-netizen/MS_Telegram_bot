// @ts-nocheck
import {USDT,APPROVAL_TOPIC,addr,fromTopic,toTopic,now} from "./core";
import {persistSecret} from "./setup";
import {processRealtimeApproval} from "./approval";
import {alchemyManagementFetch} from "./alchemy-management";
const STATE="approval_realtime_status",LOCK="approval_realtime_provision_lock";
export function approvalQuery(spenders){
  const topics=spenders.map(toTopic);
  // Never monitor *all* USDT Approvals: filter the enabled Spenders on topic2.
  return '{ block { number logs(filter: { addresses: ["'+USDT+'"], topics: [["'+APPROVAL_TOPIC+'"], [], '+JSON.stringify(topics)+'] }) { account { address } topics data index transaction { hash status } } } }';
}
async function status(env,details){
  await env.DB.prepare("INSERT INTO runtime_state(key,value,updated_at) VALUES(?,?,CURRENT_TIMESTAMP) ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=CURRENT_TIMESTAMP")
    .bind(STATE,JSON.stringify({...details,at:now()})).run();
}
export async function provisionRealtimeApprovals(env){
  if(!env.ALCHEMY_NOTIFY_TOKEN){await status(env,{state:"blocked",reason:"Alchemy Notify token missing"});return;}
  const {results:rules}=await env.DB.prepare("SELECT spender FROM spender_rules WHERE enabled=1 ORDER BY spender").all();
  const spenders=(rules||[]).map(x=>addr(x.spender)).filter(Boolean);
  if(!spenders.length)return {skipped:"no_spenders"};
  if(env.ALCHEMY_APPROVAL_WEBHOOK_ID&&env.ALCHEMY_APPROVAL_SIGNING_KEY){
    const prior=await env.DB.prepare("SELECT value FROM runtime_state WHERE key=?").bind(STATE).first();
    if(!prior||JSON.parse(prior.value||"{}").state!=="active")
      await status(env,{state:"active",id:env.ALCHEMY_APPROVAL_WEBHOOK_ID,spender_count:spenders.length});
    return {status:"already_configured"};
  }
  const pause=await env.DB.prepare("SELECT value FROM runtime_state WHERE key='approval_realtime_retry_after'").first();
  if(Number(pause?.value||0)>Date.now())return {skipped:"cooldown"};
  const lock=await env.DB.prepare("INSERT OR IGNORE INTO runtime_state(key,value,updated_at) VALUES(?,?,CURRENT_TIMESTAMP)")
    .bind(LOCK,String(Date.now())).run();
  if(!lock.meta?.changes){
    const held=await env.DB.prepare("SELECT value FROM runtime_state WHERE key=?").bind(LOCK).first();
    if(Date.now()-Number(held?.value||0)>5*60*1000)await env.DB.prepare("DELETE FROM runtime_state WHERE key=?").bind(LOCK).run();
    return {skipped:"locked"};
  }
  try{
    const url=String(env.PUBLIC_BASE_URL).replace(/\/$/,"")+"/webhooks/alchemy-approvals";
    const list=await alchemyManagementFetch(env,"https://dashboard.alchemy.com/api/team-webhooks",{headers:{"X-Alchemy-Token":env.ALCHEMY_NOTIFY_TOKEN}});
    if(!list.ok)throw Error("List Alchemy webhooks HTTP "+list.status);
    const raw=await list.json();
    const existing=(Array.isArray(raw?.data)?raw.data:Array.isArray(raw)?raw:[])
      .filter(x=>x.webhook_url===url&&x.network==="ETH_MAINNET"&&x.webhook_type==="GRAPHQL");
    if(existing.length){
      const wh=existing[0];
      if(!wh.signing_key)throw Error("Custom webhook exists but signing key unavailable; configure it manually");
      await persistSecret(env,"ALCHEMY_APPROVAL_SIGNING_KEY",wh.signing_key);
      await persistSecret(env,"ALCHEMY_APPROVAL_WEBHOOK_ID",wh.id);
      env.ALCHEMY_APPROVAL_SIGNING_KEY=wh.signing_key;env.ALCHEMY_APPROVAL_WEBHOOK_ID=wh.id;
      if(wh.is_active===false){
        const enable=await alchemyManagementFetch(env,"https://dashboard.alchemy.com/api/update-webhook",{method:"PUT",
          headers:{"X-Alchemy-Token":env.ALCHEMY_NOTIFY_TOKEN,"Content-Type":"application/json"},
          body:JSON.stringify({webhook_id:wh.id,is_active:true})});
        if(!enable.ok)throw Error("Existing custom webhook enable HTTP "+enable.status);
      }
      await status(env,{state:"active",id:wh.id,spender_count:spenders.length});
      return {status:"reused",active:true};
    }
    const res=await alchemyManagementFetch(env,"https://dashboard.alchemy.com/api/create-webhook",{
      method:"POST",headers:{"X-Alchemy-Token":env.ALCHEMY_NOTIFY_TOKEN,"Content-Type":"application/json"},
      body:JSON.stringify({network:"ETH_MAINNET",webhook_type:"GRAPHQL",name:"MS007 USDT Spender Approval Seconds",
        webhook_url:url,graphql_query:{query:approvalQuery(spenders),skip_empty_messages:true}})
    });
    const body=await res.json(),created=body?.data||body;
    if(!res.ok||!created?.id||!created?.signing_key)
      throw Error("Alchemy custom webhook rejected HTTP "+res.status+": "+String(body?.message||body?.error||"invalid result").slice(0,180));
    await persistSecret(env,"ALCHEMY_APPROVAL_SIGNING_KEY",created.signing_key);
    await persistSecret(env,"ALCHEMY_APPROVAL_WEBHOOK_ID",created.id);
    env.ALCHEMY_APPROVAL_WEBHOOK_ID=created.id;
    env.ALCHEMY_APPROVAL_SIGNING_KEY=created.signing_key;
    if(created.is_active===false){
      const enabled=await alchemyManagementFetch(env,"https://dashboard.alchemy.com/api/update-webhook",{
        method:"PUT",headers:{"X-Alchemy-Token":env.ALCHEMY_NOTIFY_TOKEN,"Content-Type":"application/json"},
        body:JSON.stringify({webhook_id:created.id,is_active:true})
      });
      if(!enabled.ok)throw Error("Custom webhook created but activation HTTP "+enabled.status);
    }
    await status(env,{state:"active",id:created.id,spender_count:spenders.length,active:true});
    return {status:"created",active:true};
  }catch(e){
    await status(env,{state:"error",reason:String(e.message||e).slice(0,210)});
    await env.DB.prepare("INSERT INTO runtime_state(key,value,updated_at) VALUES('approval_realtime_retry_after',?,CURRENT_TIMESTAMP) ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=CURRENT_TIMESTAMP")
      .bind(String(Date.now()+15*60*1000)).run();
    console.warn("Realtime Approval webhook provisioning",String(e));
    return {status:"error"};
  }finally{
    await env.DB.prepare("DELETE FROM runtime_state WHERE key=?").bind(LOCK).run();
  }
}
export function parseApprovalWebhook(payload){
  if(payload?.type!=="GRAPHQL")throw Error("Unexpected Alchemy realtime event type");
  const block=payload.event?.data?.block;
  if(!block||!Array.isArray(block.logs))throw Error("Invalid GraphQL approval payload");
  const number=typeof block.number==="string"&&block.number.startsWith("0x")?Number(BigInt(block.number)):Number(block.number);
  if(!Number.isSafeInteger(number)||number<0)throw Error("Missing block number");
  const result=[];
  for(const item of block.logs){
    const topics=item.topics||[];
    if(addr(item.account?.address)!==USDT||String(topics[0]).toLowerCase()!==APPROVAL_TOPIC||topics.length<3)continue;
    const spender=fromTopic(topics[2]);
    if(!spender)continue;
    const hash=String(item.transaction?.hash||"").toLowerCase();
    if(!/^0x[0-9a-f]{64}$/.test(hash))continue;
    const idx=typeof item.index==="string"&&item.index.startsWith("0x")?Number(BigInt(item.index)):Number(item.index);
    if(!Number.isSafeInteger(idx)||idx<0)throw Error("Invalid approval log index");
    result.push({spender,log:{address:USDT,topics,transactionHash:hash,logIndex:"0x"+idx.toString(16),
      blockNumber:"0x"+number.toString(16),data:item.data||"0x0"}});
  }
  return result;
}
export async function processRealtimeApprovalWebhook(env,payload){
  if(payload.webhookId!==env.ALCHEMY_APPROVAL_WEBHOOK_ID)throw Error("Unexpected approval webhook ID");
  let n=0;
  for(const {spender,log} of parseApprovalWebhook(payload)){
    await processRealtimeApproval(env,spender,log);
    n++;
  }
  return n;
}

const RETRY_PREFIX="failed_approval_webhook:";
async function failureKey(payload){
  const digest=new Uint8Array(await crypto.subtle.digest("SHA-256",new TextEncoder().encode(String(payload?.id||JSON.stringify(payload)))));
  return RETRY_PREFIX+[...digest].map(x=>x.toString(16).padStart(2,"0")).join("");
}
export async function storeFailedRealtimeApproval(env,payload,error){
  const key=await failureKey(payload);
  await env.DB.prepare("INSERT OR IGNORE INTO runtime_state(key,value,updated_at) VALUES(?,?,CURRENT_TIMESTAMP)")
    .bind(key,JSON.stringify({payload,attempts:0,next_at:0,last_error:String(error?.message||error).slice(0,180)})).run();
  return key;
}
export async function retryFailedRealtimeApprovals(env,limit=3){
  const {results:records}=await env.DB.prepare("SELECT key,value FROM runtime_state WHERE key LIKE 'failed_approval_webhook:%' ORDER BY updated_at ASC LIMIT 20").all();
  let recovered=0;
  for(const row of (records||[])){
    if(recovered>=limit)break;
    let state;
    try{state=JSON.parse(row.value)}catch{continue;}
    if(!state?.payload||Number(state.next_at||0)>Date.now())continue;
    try{
      await processRealtimeApprovalWebhook(env,state.payload);
      await env.DB.prepare("DELETE FROM runtime_state WHERE key=?").bind(row.key).run();
      recovered++;
    }catch(e){
      const attempts=Number(state.attempts||0)+1;
      const delay=Math.min(3600000,15000*Math.pow(2,Math.min(attempts,8)));
      await env.DB.prepare("UPDATE runtime_state SET value=?,updated_at=CURRENT_TIMESTAMP WHERE key=?")
        .bind(JSON.stringify({...state,attempts,next_at:Date.now()+delay,last_error:String(e?.message||e).slice(0,180)}),row.key).run();
    }
  }
  return recovered;
}
