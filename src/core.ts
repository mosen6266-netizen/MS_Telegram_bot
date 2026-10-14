// @ts-nocheck
import {persistSecret} from './setup';
export const USDT = "0xdac17f958d2ee523a2206206994597c13d831ec7";
export const USDC = "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48";
export const APPROVAL_TOPIC = "0x8c5be1e5ebec7d5bd14f71427d1e84f3dd0314c0f7b2291e5b200ac8c7c3b925";
export const TRANSFER_TOPIC = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";
export const ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;
export const addr = s => ADDRESS_RE.test(String(s || "")) ? String(s).toLowerCase() : null;
export const now = () => new Date().toISOString();
export const json = (data, status=200) => Response.json(data,{status,headers:{"cache-control":"no-store"}});
export const esc = s => String(s ?? "").replaceAll("&","&amp;").replaceAll("<","&lt;").replaceAll(">","&gt;").replaceAll('"',"&quot;");
export const short = s => s ? s.slice(0,8)+"…"+s.slice(-6) : "—";
export const toTopic = s => "0x"+s.slice(2).toLowerCase().padStart(64,"0");
export const fromTopic = s => s && addr("0x"+s.slice(-40)) ;
export const trunc = (s,n=80) => Array.from(String(s||"")).slice(0,n).join("");
export function formatUnits(raw,decimals=6) {
  let n=BigInt(raw); const minus=n<0n?"-":""; if(n<0)n=-n;
  const digits=n.toString().padStart(decimals+1,"0");
  if(!decimals)return minus+digits;
  const frac=digits.slice(-decimals).replace(/0+$/,"");
  return minus+digits.slice(0,-decimals)+(frac?"."+frac:"");
}
export async function rpc(env, method, params) {
  if(!env.ALCHEMY_RPC_URL) throw Error("ALCHEMY_RPC_URL is not configured");
  const r=await fetch(env.ALCHEMY_RPC_URL,{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({jsonrpc:"2.0",id:1,method,params})});
  if(!r.ok)throw Error("Ethereum RPC HTTP "+r.status);
  const d=await r.json();
  if(d.error)throw Error("RPC "+String(d.error.message||d.error.code));
  return d.result;
}
export async function blockNumber(env){return Number(BigInt(await rpc(env,"eth_blockNumber",[])));}
export async function allowance(env,owner,spender,block="latest"){
  const data="0xdd62ed3e"+owner.slice(2).padStart(64,"0")+spender.slice(2).padStart(64,"0");
  const value=await rpc(env,"eth_call",[{to:USDT,data},block]);
  return BigInt(value || "0x0");
}
export async function receiptSuccess(env,hash){
  const d=await rpc(env,"eth_getTransactionReceipt",[hash]);
  return d ? d.status==="0x1" : null;
}
export async function telegram(env,method,body){
  if(!env.TELEGRAM_BOT_TOKEN)throw Error("TELEGRAM_BOT_TOKEN is missing");
  const r=await fetch("https://api.telegram.org/bot"+env.TELEGRAM_BOT_TOKEN+"/"+method,{
    method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify(body)
  });
  const d=await r.json();
  if(!r.ok || !d.ok) throw Error("Telegram "+(d.description||r.status));
  return d.result;
}
export const send=(env,chat_id,text,reply_markup=undefined)=>telegram(env,"sendMessage",{
  chat_id,text,parse_mode:"HTML",disable_web_page_preview:true,reply_markup
});
export const buttons=address=>({inline_keyboard:[
  [{text:"✏️ 修改备注",callback_data:"remark:"+address}],
  [{text:"🔎 Etherscan",url:"https://etherscan.io/address/"+address}]
]});
export async function increment(env,metric){
  await env.DB.prepare("INSERT INTO counters(metric,day,value) VALUES(?,date('now'),1) ON CONFLICT(metric,day) DO UPDATE SET value=value+1").bind(metric).run();
}
export async function queueNotice(env,{dedup,chat_id,address,template,payload}){
  await env.DB.prepare("INSERT OR IGNORE INTO outbox(dedup_key,chat_id,address,template_key,payload_json) VALUES(?,?,?,?,?)")
  .bind(dedup,String(chat_id),address||null,template,JSON.stringify(payload||{})).run();
}
export async function audit(env,actor,action,target,details={}){
  await env.DB.prepare("INSERT INTO admin_audit(actor,action,target,details_json) VALUES(?,?,?,?)")
    .bind(String(actor),action,String(target),JSON.stringify(details)).run();
}
export async function syncWatch(env,address,remove=false) {
  if(!env.ALCHEMY_NOTIFY_TOKEN) throw Error("Alchemy Notify token is missing");
  if(!env.ALCHEMY_ACTIVITY_WEBHOOK_ID && !remove){
    // Create a webhook ONLY when a genuine monitored Owner exists.
    // Hold a short-lived D1 lock to avoid simultaneous duplicate webhook creation.
    const lock=await env.DB.prepare("INSERT OR IGNORE INTO runtime_state(key,value) VALUES('activity_webhook_lock',?)").bind(now()).run();
    if(!lock.meta?.changes){
      const old=await env.DB.prepare("SELECT updated_at FROM runtime_state WHERE key='activity_webhook_lock'").first();
      if(old&&Date.now()-new Date(old.updated_at+"Z").getTime()>180000){
        await env.DB.prepare("DELETE FROM runtime_state WHERE key='activity_webhook_lock'").run();
      }
      throw Error("Alchemy webhook creation is already running; retry shortly");
    }
    try{
      const r=await fetch("https://dashboard.alchemy.com/api/create-webhook",{
        method:"POST",headers:{"content-type":"application/json","X-Alchemy-Token":env.ALCHEMY_NOTIFY_TOKEN},
        body:JSON.stringify({network:"ETH_MAINNET",webhook_type:"ADDRESS_ACTIVITY",
          webhook_url:env.PUBLIC_BASE_URL+"/webhooks/alchemy",name:"Ethereum USDT Owner Monitor",addresses:[address]})
      });
      const d=await r.json();const created=d.data||d;
      if(!r.ok || !created.id || !created.signing_key)
        throw Error("Alchemy webhook creation rejected: "+String(d.message||r.status).slice(0,100));
      await persistSecret(env,"ALCHEMY_ACTIVITY_WEBHOOK_ID",created.id);
      await persistSecret(env,"ALCHEMY_SIGNING_KEY",created.signing_key);
      env.ALCHEMY_ACTIVITY_WEBHOOK_ID=created.id;
      env.ALCHEMY_SIGNING_KEY=created.signing_key;
      // The newly created webhook already tracks this first Owner.
      return;
    } finally{
      await env.DB.prepare("DELETE FROM runtime_state WHERE key='activity_webhook_lock'").run();
    }
  }
  if(!env.ALCHEMY_ACTIVITY_WEBHOOK_ID)throw Error("Alchemy activity webhook missing");
  const r=await fetch("https://dashboard.alchemy.com/api/update-webhook-addresses",{
    method:"PATCH",headers:{"content-type":"application/json","X-Alchemy-Token":env.ALCHEMY_NOTIFY_TOKEN},
    body:JSON.stringify({webhook_id:env.ALCHEMY_ACTIVITY_WEBHOOK_ID,addresses_to_add:remove?[]:[address],addresses_to_remove:remove?[address]:[]})
  });
  if(!r.ok)throw Error("Alchemy sync HTTP "+r.status+" "+(await r.text()).slice(0,140));
}
export async function removeWatch(env,address){
  const active=await env.DB.prepare("SELECT count(*) n FROM subscriptions WHERE address=? AND status='active'").bind(address).first();
  if(active?.n>0)return false;
  const rule=await env.DB.prepare("SELECT state FROM wallet_watches WHERE address=?").bind(address).first();
  if(!rule || rule.state==='removed')return true;
  try{
    if(env.ALCHEMY_ACTIVITY_WEBHOOK_ID && env.ALCHEMY_NOTIFY_TOKEN)await syncWatch(env,address,true);
    await env.DB.prepare("UPDATE wallet_watches SET state='removed',last_error=NULL,updated_at=? WHERE address=?").bind(now(),address).run();
    return true;
  }catch(e){
    await env.DB.prepare("UPDATE wallet_watches SET state='removal_pending',last_error=?,updated_at=? WHERE address=?").bind(String(e).slice(0,300),now(),address).run();
    return false;
  }
}
export async function ensureWatch(env,address,fromBlock=undefined){
  await env.DB.prepare("INSERT OR IGNORE INTO wallet_watches(address,state) VALUES(?,'pending')").bind(address).run();
  try {
    // Start recovery at first relevant authorization block when available.
    const head=fromBlock===undefined?await blockNumber(env):fromBlock;
    await env.DB.prepare("INSERT OR IGNORE INTO wallet_checkpoints(address,last_block) VALUES(?,?)").bind(address,Math.max(0,head-1)).run();
    await syncWatch(env,address,false);
    await env.DB.prepare("UPDATE wallet_watches SET state='active',synced_at=?,last_error=NULL,updated_at=? WHERE address=?").bind(now(),now(),address).run();
    return true;
  } catch(e) {
    await env.DB.prepare("UPDATE wallet_watches SET state='pending',last_error=?,updated_at=? WHERE address=?").bind(String(e).slice(0,500),now(),address).run();
    return false;
  }
}
export async function notifyAdmin(env,html) {
  if(!env.ADMIN_TELEGRAM_CHAT_ID)return;
  try {await send(env,env.ADMIN_TELEGRAM_CHAT_ID,html);}catch(e){console.warn("Admin DM failed",String(e))}
}
export async function verifyAlchemy(env,body,signature){
  if(!env.ALCHEMY_SIGNING_KEY || !signature)return false;
  const key=await crypto.subtle.importKey("raw",new TextEncoder().encode(env.ALCHEMY_SIGNING_KEY),{name:"HMAC",hash:"SHA-256"},false,["sign"]);
  const dig=new Uint8Array(await crypto.subtle.sign("HMAC",key,new TextEncoder().encode(body)));
  const ours=Array.from(dig,x=>x.toString(16).padStart(2,"0")).join("");
  const theirs=signature.toLowerCase().replace(/^sha256=/,"");
  if(theirs.length!==ours.length)return false;
  let diff=0;for(let i=0;i<ours.length;i++)diff|=ours.charCodeAt(i)^theirs.charCodeAt(i);
  return diff===0;
}
