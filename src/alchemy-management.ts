// @ts-nocheck
// Limits *management* requests only. Incoming Alchemy webhooks and Telegram
// delivery must never wait for this control plane backoff.
const PREFIX="alchemy_management_";
const LOCK=PREFIX+"lock",NEXT=PREFIX+"next_request_at";
const COOLDOWN=PREFIX+"cooldown_until",STREAK=PREFIX+"rate_limit_streak";
const GAP_MS=5000,STALE_LOCK_MS=90000;
const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));

async function read(db,key){
  return (await db.prepare("SELECT value FROM runtime_state WHERE key=?").bind(key).first())?.value;
}
async function save(db,key,value){
  await db.prepare("INSERT INTO runtime_state(key,value,updated_at) VALUES(?,?,CURRENT_TIMESTAMP) ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=CURRENT_TIMESTAMP")
    .bind(key,String(value)).run();
}
function retryAfterMs(header){
  if(!header)return 0;
  const seconds=Number(header);
  if(Number.isFinite(seconds))return Math.max(0,seconds*1000);
  const date=Date.parse(header);
  return Number.isFinite(date)?Math.max(0,date-Date.now()):0;
}
function cooldownError(until){
  const err=Error("Alchemy management cooldown until "+new Date(until).toISOString()+"; realtime webhook notifications are unaffected");
  err.code="ALCHEMY_MANAGEMENT_COOLDOWN";err.retryAt=until;
  return err;
}
async function lock(db){
  const token=Date.now()+":"+crypto.randomUUID();
  const inserted=await db.prepare("INSERT OR IGNORE INTO runtime_state(key,value,updated_at) VALUES(?,?,CURRENT_TIMESTAMP)")
    .bind(LOCK,token).run();
  if(inserted.meta?.changes)return token;
  const held=await read(db,LOCK);
  const started=Number(String(held||"").split(":")[0]);
  if(held && Number.isFinite(started)&&Date.now()-started>STALE_LOCK_MS){
    const replaced=await db.prepare("UPDATE runtime_state SET value=?,updated_at=CURRENT_TIMESTAMP WHERE key=? AND value=?")
      .bind(token,LOCK,held).run();
    if(replaced.meta?.changes)return token;
  }
  const error=Error("Alchemy management request already in progress; automatic retry will follow");
  error.code="ALCHEMY_MANAGEMENT_BUSY";
  throw error;
}
export async function alchemyManagementFetch(env,url,init={}){
  const db=env.DB;
  // This limiter does not wrap Ethereum RPC, incoming Webhooks or Telegram.
  const preliminary=Number(await read(db,COOLDOWN)||0);
  if(preliminary>Date.now())throw cooldownError(preliminary);
  const lease=await lock(db);
  try{
    const until=Number(await read(db,COOLDOWN)||0);
    if(until>Date.now())throw cooldownError(until);
    const next=Number(await read(db,NEXT)||0);
    if(next>Date.now())await sleep(next-Date.now());
    // Reserve a globally paced slot before starting the network request.
    await save(db,NEXT,Date.now()+GAP_MS);
    const response=await fetch(url,init);
    const rateLimited=response.status===429 ||
      (response.status===403 && (await response.clone().text()).includes("1015"));
    if(rateLimited){
      const streak=Math.min(12,Math.max(0,Number(await read(db,STREAK)||0))+1);
      const exponential=Math.min(2*60*60*1000,15*60*1000*Math.pow(2,streak-1));
      const wait=Math.max(exponential,retryAfterMs(response.headers.get("retry-after")));
      const blockedUntil=Date.now()+Math.min(wait,24*60*60*1000);
      await save(db,STREAK,streak);
      await save(db,COOLDOWN,blockedUntil);
      const error=Error("Alchemy management HTTP "+response.status+" (rate limit 1015 / 429); retry after "+new Date(blockedUntil).toISOString());
      error.code="ALCHEMY_MANAGEMENT_RATE_LIMIT";
      error.retryAt=blockedUntil;
      throw error;
    }
    if(response.ok && Number(await read(db,STREAK)||0)>0)await save(db,STREAK,0);
    return response;
  }finally{
    // Compare the lease so that a stale request cannot release another's lock.
    await db.prepare("DELETE FROM runtime_state WHERE key=? AND value=?").bind(LOCK,lease).run();
  }
}
