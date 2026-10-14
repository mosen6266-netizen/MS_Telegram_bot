// @ts-nocheck
import {json,telegram,now,notifyAdmin} from "./core";
const SECRET_KEYS=["TELEGRAM_BOT_TOKEN","TELEGRAM_WEBHOOK_SECRET","ADMIN_TELEGRAM_CHAT_ID","ALCHEMY_RPC_URL","ALCHEMY_NOTIFY_TOKEN","ALCHEMY_ACTIVITY_WEBHOOK_ID","ALCHEMY_SIGNING_KEY","ETHERSCAN_API_KEY"];
const encoder=new TextEncoder();
const b64=b=>btoa(String.fromCharCode(...new Uint8Array(b)));
const un64=s=>Uint8Array.from(atob(s),c=>c.charCodeAt(0));
const hex=b=>Array.from(new Uint8Array(b),x=>x.toString(16).padStart(2,"0")).join("");
const random=n=>crypto.getRandomValues(new Uint8Array(n));
async function sha256(s){return hex(await crypto.subtle.digest("SHA-256",encoder.encode(s)))}
async function passwordHash(password,salt,iters=200000){
  const material=await crypto.subtle.importKey("raw",encoder.encode(password),"PBKDF2",false,["deriveBits"]);
  return hex(await crypto.subtle.deriveBits({name:"PBKDF2",salt:un64(salt),iterations:iters,hash:"SHA-256"},material,256));
}
function equal(a,b){
  if(typeof a!=="string"||typeof b!=="string"||a.length!==b.length)return false;
  let diff=0;for(let i=0;i<a.length;i++)diff|=a.charCodeAt(i)^b.charCodeAt(i);
  return diff===0;
}
async function key(env){
  if(!env.APP_ENCRYPTION_KEY)throw Error("App encryption secret not provisioned");
  return crypto.subtle.importKey("raw",un64(env.APP_ENCRYPTION_KEY),{name:"AES-GCM"},false,["encrypt","decrypt"]);
}
async function encrypt(env,s){
  const iv=random(12),cipher=await crypto.subtle.encrypt({name:"AES-GCM",iv},await key(env),encoder.encode(s));
  return b64(iv)+"."+b64(cipher);
}
async function decrypt(env,s){
  const [i,v]=s.split(".");
  const data=await crypto.subtle.decrypt({name:"AES-GCM",iv:un64(i)},await key(env),un64(v));
  return new TextDecoder().decode(data);
}
async function adminExists(env){return !!(await env.DB.prepare("SELECT 1 FROM admin_login WHERE id=1").first());}
async function locked(env,subject){
  const row=await env.DB.prepare("SELECT locked_until FROM auth_failures WHERE subject=?").bind(subject).first();
  return row?.locked_until && new Date(row.locked_until).getTime()>Date.now();
}
async function fail(env,subject){
  const l=new Date(Date.now()+15*60*1000).toISOString();
  await env.DB.prepare("INSERT INTO auth_failures(subject,attempts,locked_until) VALUES(?,1,NULL) ON CONFLICT(subject) DO UPDATE SET attempts=CASE WHEN attempts>=6 THEN 1 ELSE attempts+1 END,locked_until=CASE WHEN attempts>=5 THEN ? ELSE locked_until END,updated_at=CURRENT_TIMESTAMP").bind(subject,l).run();
}
async function clearFail(env,subject){await env.DB.prepare("DELETE FROM auth_failures WHERE subject=?").bind(subject).run();}
async function session(env){
  const token=b64(random(32)).replace(/=+$/,"").replace(/\+/g,"-").replace(/\//g,"_");
  const id=await sha256(token);
  await env.DB.prepare("INSERT INTO admin_sessions(token_hash,expires_at) VALUES(?,?)").bind(id,new Date(Date.now()+12*3600000).toISOString()).run();
  return "__Host-ethadmin="+token+"; Secure; HttpOnly; SameSite=Strict; Path=/; Max-Age=43200";
}
async function authorized(req,env){
  const raw=req.headers.get("cookie")||"";
  const token=raw.match(/(?:^|;\s*)__Host-ethadmin=([a-zA-Z0-9_-]+)/)?.[1];
  if(!token)return false;
  const hash=await sha256(token);
  return !!(await env.DB.prepare("SELECT 1 FROM admin_sessions WHERE token_hash=? AND expires_at>?").bind(hash,now()).first());
}
function csrf(req){
  if(["GET","HEAD","OPTIONS"].includes(req.method))return true;
  const origin=req.headers.get("origin");
  return origin === new URL(req.url).origin && req.headers.get("x-app-action")==="1";
}
export async function isAdmin(req,env){return csrf(req) && await authorized(req,env);}
export async function authRoute(req,env,path){
  if(path==="/auth/status"&&req.method==="GET")return json({initialized:await adminExists(env),authenticated:await authorized(req,env)});
  if(path==="/auth/setup"&&req.method==="POST"){
    if(!csrf(req))return json({error:"Invalid origin"},403);
    if(await adminExists(env))return json({error:"Already initialized"},403);
    const b=await req.json(),code=String(b.setup_code||""),password=String(b.password||"");
    if(await locked(env,"setup"))return json({error:"Too many setup attempts, retry later"},429);
    if(password.length<14||password.length>200)return json({error:"Password must be 14-200 characters"},400);
    if(env.INIT_SETUP_CODE){
      if(!equal(code,env.INIT_SETUP_CODE)){await fail(env,"setup");return json({error:"Invalid one-time setup code"},403);}
    }else{
      // Bootstrap is secured by proof of Cloudflare Worker-edit permission for THIS account.
      // The token is used once and never stored in the database or Worker.
      const cfToken=String(b.cloudflare_api_token||"").trim();
      if(!/^\S{20,300}$/.test(cfToken)){await fail(env,"setup");return json({error:"Enter a Cloudflare API token with Workers Scripts Edit permission for this account"},403);}
      if(!env.CF_ACCOUNT_ID)return json({error:"Cloudflare account binding unavailable"},503);
      const master=b64(random(32));
      const result=await fetch("https://api.cloudflare.com/client/v4/accounts/"+encodeURIComponent(env.CF_ACCOUNT_ID)+"/workers/scripts/ethereum-usdt-monitor/secrets",{
        method:"PUT",headers:{"authorization":"Bearer "+cfToken,"content-type":"application/json"},
        body:JSON.stringify({name:"APP_ENCRYPTION_KEY",type:"secret_text",text:master})
      });
      const resultData=await result.json();
      if(!result.ok||!resultData.success){await fail(env,"setup");return json({error:"Cloudflare key provisioning failed. The API token must be authorized to edit the ethereum-usdt-monitor Worker in this Cloudflare account."},403);}
    }
    const salt=b64(random(24)),hash=await passwordHash(password,salt);
    // Database uniqueness prevents two simultaneous first-run initializations.
    const result=await env.DB.prepare("INSERT OR IGNORE INTO admin_login(id,salt,verifier,iterations) VALUES(1,?,?,200000)").bind(salt,hash).run();
    if(!result.meta?.changes)return json({error:"Already initialized"},409);
    await clearFail(env,"setup");
    return new Response(JSON.stringify({ok:true}),{headers:{"content-type":"application/json","set-cookie":await session(env)}});
  }
  if(path==="/auth/login"&&req.method==="POST"){
    if(!csrf(req))return json({error:"Invalid origin"},403);
    if(await locked(env,"login"))return json({error:"Too many attempts. Wait 15 minutes."},429);
    const b=await req.json(),p=String(b.password||"");
    const row=await env.DB.prepare("SELECT salt,verifier,iterations FROM admin_login WHERE id=1").first();
    if(!row)return json({error:"Not initialized"},403);
    const hash=await passwordHash(p,row.salt,row.iterations);
    if(!equal(hash,row.verifier)){await fail(env,"login");return json({error:"Password incorrect"},401);}
    await clearFail(env,"login");
    return new Response(JSON.stringify({ok:true}),{headers:{"content-type":"application/json","set-cookie":await session(env)}});
  }
  if(path==="/auth/logout"&&req.method==="POST"){
    if(!csrf(req))return json({error:"Invalid origin"},403);
    const token=(req.headers.get("cookie")||"").match(/(?:^|;\s*)__Host-ethadmin=([a-zA-Z0-9_-]+)/)?.[1];
    if(token)await env.DB.prepare("DELETE FROM admin_sessions WHERE token_hash=?").bind(await sha256(token)).run();
    return new Response(JSON.stringify({ok:true}),{headers:{"content-type":"application/json","set-cookie":"__Host-ethadmin=; Max-Age=0; Secure; HttpOnly; SameSite=Strict; Path=/"}});
  }
  return json({error:"Unknown auth endpoint"},404);
}
export async function configEnv(env){
  const records=(await env.DB.prepare("SELECT key,encrypted_value FROM setup_secrets").all()).results||[];
  const e={...env};
  for(const r of records){
    if(SECRET_KEYS.includes(r.key))try{e[r.key]=await decrypt(env,r.encrypted_value);}
    catch(err){console.error("Unable to decrypt configured key",r.key);}
  }
  return e;
}
export async function persistSecret(env,keyName,value){
  if(!SECRET_KEYS.includes(keyName))throw Error("Unsupported secret name");
  await env.DB.prepare("INSERT INTO setup_secrets(key,encrypted_value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET encrypted_value=excluded.encrypted_value,updated_at=CURRENT_TIMESTAMP")
    .bind(keyName,await encrypt(env,value)).run();
}
async function status(env){
  const configured=new Set(((await env.DB.prepare("SELECT key FROM setup_secrets").all()).results||[]).map(x=>x.key));
  const ready=(await env.DB.prepare("SELECT value FROM runtime_state WHERE key='is_active'").first())?.value==="1";
  return {active:ready,keys:Object.fromEntries(SECRET_KEYS.map(k=>[k,configured.has(k)])),needs:[
    "TELEGRAM_BOT_TOKEN","TELEGRAM_WEBHOOK_SECRET","ALCHEMY_RPC_URL","ALCHEMY_NOTIFY_TOKEN","ETHERSCAN_API_KEY"
  ].filter(k=>!configured.has(k))};
}
export async function setupApi(req,env,path){
  if(path==="/api/setup/status"&&req.method==="GET")return json(await status(env));
  if(path==="/api/setup/save"&&req.method==="POST"){
    const data=await req.json();if(!data||typeof data!=="object")return json({error:"Invalid configuration"},400);
    const incoming=Object.entries(data).filter(([k,v])=>SECRET_KEYS.includes(k)&&typeof v==="string"&&v.trim());
    if(!incoming.length)return json({error:"Nothing to save"},400);
    for(const [name,val] of incoming){
      const clean=val.trim();
      if(clean.length>8192)return json({error:name+" too long"},400);
      if(name==="ALCHEMY_RPC_URL"&&!/^https:\/\/[a-zA-Z0-9.-]+(?:\/[^\s]*)?$/.test(clean))return json({error:"Alchemy RPC must use HTTPS"},400);
      if(name==="TELEGRAM_WEBHOOK_SECRET"&&!/^[A-Za-z0-9_-]{12,256}$/.test(clean))return json({error:"Webhook secret needs 12-256 safe characters"},400);
      const encrypted=await encrypt(env,clean);
      await env.DB.prepare("INSERT INTO setup_secrets(key,encrypted_value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET encrypted_value=excluded.encrypted_value,updated_at=CURRENT_TIMESTAMP").bind(name,encrypted).run();
    }
    return json({ok:true,configured:incoming.map(x=>x[0]),...(await status(env))});
  }
  if(path==="/api/setup/test"&&req.method==="POST"){
    const b=await req.json(),which=b?.service;
    const e=await configEnv(env);
    if(which==="telegram"){
      if(!e.TELEGRAM_BOT_TOKEN)return json({error:"Telegram Bot Token 未配置"},400);
      try{const result=await telegram(e,"getMe",{});return json({ok:true,bot_name:result.username,id:result.id});}catch(err){return json({error:"Telegram connection failed: "+String(err).slice(0,150)},422);}
    }
    if(which==="alchemy"){
      if(!e.ALCHEMY_RPC_URL)return json({error:"Alchemy RPC 未配置"},400);
      try{
        const res=await fetch(e.ALCHEMY_RPC_URL,{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({jsonrpc:"2.0",id:1,method:"eth_chainId",params:[]})});
        const dat=await res.json();if(dat.result!=="0x1")throw Error("RPC must point to Ethereum Mainnet");
        return json({ok:true,chain:"Ethereum Mainnet"});
      }catch(err){return json({error:"Alchemy RPC test failed: "+String(err).slice(0,150)},422);}
    }
    if(which==="etherscan"){
      if(!e.ETHERSCAN_API_KEY)return json({error:"Etherscan API Key 未配置"},400);
      try{
        const u=new URL("https://api.etherscan.io/v2/api");u.search=new URLSearchParams({chainid:"1",module:"proxy",action:"eth_blockNumber",apikey:e.ETHERSCAN_API_KEY}).toString();
        const data=await (await fetch(u)).json();
        if(!data.result||!String(data.result).startsWith("0x"))throw Error("Key refused or rate-limited");
        return json({ok:true,block:Number(BigInt(data.result))});
      }catch(err){return json({error:"Etherscan test failed: "+String(err).slice(0,150)},422);}
    }
    return json({error:"Unknown test service"},400);
  }
  if(path==="/api/setup/activate"&&req.method==="POST"){
    const s=await status(env);if(s.needs.length)return json({error:"Missing required configuration: "+s.needs.join(", ")},409);
    const e=await configEnv(env);
    // The Address Activity webhook is created lazily with the FIRST real Owner.
    // This avoids registering a dummy wallet or relying on empty-address webhook support.
    if((!e.ALCHEMY_ACTIVITY_WEBHOOK_ID||!e.ALCHEMY_SIGNING_KEY)&&!e.ALCHEMY_NOTIFY_TOKEN)
      return json({error:"Alchemy Notify token is needed for automatic creation of the first activity webhook"},409);
    // Keep disabled if Telegram webhook registration fails.
    const webhookUrl=new URL(req.url).origin+"/webhooks/telegram";
    try{
      await telegram(e,"setWebhook",{url:webhookUrl,secret_token:e.TELEGRAM_WEBHOOK_SECRET,allowed_updates:["message","callback_query"],drop_pending_updates:false});
    }catch(err){return json({error:"Telegram webhook failed: "+String(err).slice(0,150)},422);}
    await env.DB.prepare("INSERT INTO runtime_state(key,value) VALUES('is_active','1') ON CONFLICT(key) DO UPDATE SET value='1',updated_at=CURRENT_TIMESTAMP").run();
    return json({ok:true,active:true,webhook_url:webhookUrl});
  }
  if(path==="/api/setup/deactivate"&&req.method==="POST"){
    await env.DB.prepare("INSERT INTO runtime_state(key,value) VALUES('is_active','0') ON CONFLICT(key) DO UPDATE SET value='0',updated_at=CURRENT_TIMESTAMP").run();
    return json({ok:true,active:false});
  }
  return json({error:"Unknown setup API"},404);
}
