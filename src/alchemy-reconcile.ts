// @ts-nocheck
// Keep local "active" watches in sync with the authoritative Alchemy webhook.
// Never replace the external address list or remove addresses we do not own.
const PREFIX="alchemy_address_reconcile_";
const LOCK=PREFIX+"lock";
const NEXT=PREFIX+"next_at";
const RESULT=PREFIX+"result";
const OK_DELAY=60*60*1000;
const ERROR_DELAY=15*60*1000;

async function state(db,key){
  return (await db.prepare("SELECT value FROM runtime_state WHERE key=?").bind(key).first())?.value;
}
async function save(db,key,value){
  await db.prepare("INSERT INTO runtime_state(key,value,updated_at) VALUES(?,?,CURRENT_TIMESTAMP) ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=CURRENT_TIMESTAMP").bind(key,String(value)).run();
}

async function verifyWebhookConfiguration(env){
  const res=await fetch("https://dashboard.alchemy.com/api/team-webhooks",{
    headers:{"X-Alchemy-Token":env.ALCHEMY_NOTIFY_TOKEN,"Accept":"application/json"}
  });
  if(!res.ok)throw Error("Alchemy webhook metadata HTTP "+res.status);
  const body=await res.json();
  const outer=Array.isArray(body)?body:[body];
  const all=outer.flatMap(item=>Array.isArray(item?.data)?item.data:Array.isArray(item)?item:[]);
  const webhook=all.find(x=>x?.id===env.ALCHEMY_ACTIVITY_WEBHOOK_ID);
  if(!webhook)throw Error("Configured Alchemy activity webhook is not present in team");
  if(webhook.is_active!==true)throw Error("Configured Alchemy webhook is disabled");
  if(webhook.network!=="ETH_MAINNET"||webhook.webhook_type!=="ADDRESS_ACTIVITY")throw Error("Alchemy webhook type or network differs from Ethereum Mainnet address activity");
  const base=String(env.PUBLIC_BASE_URL||"");
  const expected=(base.endsWith("/")?base.slice(0,-1):base)+"/webhooks/alchemy";
  if(webhook.webhook_url!==expected)throw Error("Alchemy webhook destination URL does not match the bot");
}

async function actualAddresses(env){
  const result=new Set();
  let cursor=null;
  const cursors=new Set();
  for(let page=0;page<100;page++){
    const params=new URLSearchParams({webhook_id:env.ALCHEMY_ACTIVITY_WEBHOOK_ID,limit:"100"});
    if(cursor)params.set("after",cursor);
    const response=await fetch("https://dashboard.alchemy.com/api/webhook-addresses?"+params,{
      headers:{"X-Alchemy-Token":env.ALCHEMY_NOTIFY_TOKEN,"Accept":"application/json"}
    });
    if(!response.ok)throw Error("Alchemy address list HTTP "+response.status);
    const body=await response.json();
    if(!Array.isArray(body?.data))throw Error("Alchemy address list response malformed");
    for(const raw of body.data){
      if(typeof raw!=="string"||!/^0x[0-9a-f]{40}$/i.test(raw))throw Error("Alchemy returned an invalid address");
      result.add(raw.toLowerCase());
    }
    const next=body.pagination?.cursors?.after;
    if(!next){
      const total=Number(body.pagination?.total_count);
      if(Number.isFinite(total)&&total>result.size)throw Error("Alchemy address pagination incomplete");
      return result;
    }
    if(typeof next!=="string"||cursors.has(next))throw Error("Alchemy address pagination cursor repeated");
    cursors.add(next);cursor=next;
  }
  throw Error("Alchemy address pagination exceeds the safe limit");
}

// Scheduled reconciliation is deliberately infrequent, paginated and bounded.
// It first reads the webhook's actual subscribed addresses, then *adds only*
// missing active watches, and verifies the result with a second read.
export async function reconcileAlchemyAddresses(env){
  const db=env.DB;
  if(Number(await state(db,NEXT)||0)>Date.now())return {skipped:"not_due"};
  const lock=await db.prepare("INSERT OR IGNORE INTO runtime_state(key,value) VALUES(?,?)").bind(LOCK,String(Date.now())).run();
  if(!lock.meta?.changes){
    const since=Number(await state(db,LOCK)||0);
    if(since&&Date.now()-since>5*60*1000)await db.prepare("DELETE FROM runtime_state WHERE key=?").bind(LOCK).run();
    return {skipped:"running"};
  }
  let missing=[];
  try{
    await save(db,NEXT,Date.now()+ERROR_DELAY);
    if(!env.ALCHEMY_NOTIFY_TOKEN||!env.ALCHEMY_ACTIVITY_WEBHOOK_ID)throw Error("Alchemy webhook credentials not configured");
    const rows=(await db.prepare(
      "SELECT w.address FROM wallet_watches w WHERE w.state='active' "+
      "AND NOT EXISTS (SELECT 1 FROM wallet_exclusions x WHERE x.address=w.address) "+
      "AND NOT EXISTS (SELECT 1 FROM wallets v WHERE v.address=w.address AND v.deleted_at IS NOT NULL) "+
      "AND EXISTS (SELECT 1 FROM subscriptions s WHERE s.address=w.address AND s.status='active')"
    ).all()).results||[];
    const expected=[...new Set(rows.map(r=>String(r.address).toLowerCase()))];
    await verifyWebhookConfiguration(env);
    const actual=await actualAddresses(env);
    missing=expected.filter(a=>!actual.has(a));
    if(missing.length){
      // Alchemy documents PATCH as idempotent. Do not use PUT: PUT would remove
      // external subscriptions that do not belong to this bot.
      for(let i=0;i<missing.length;i+=50){
        const addresses=missing.slice(i,i+50);
        const res=await fetch("https://dashboard.alchemy.com/api/update-webhook-addresses",{
          method:"PATCH",
          headers:{"X-Alchemy-Token":env.ALCHEMY_NOTIFY_TOKEN,"Content-Type":"application/json"},
          body:JSON.stringify({webhook_id:env.ALCHEMY_ACTIVITY_WEBHOOK_ID,addresses_to_add:addresses,addresses_to_remove:[]})
        });
        if(!res.ok)throw Error("Alchemy address repair HTTP "+res.status);
      }
      const after=await actualAddresses(env);
      const unresolved=missing.filter(a=>!after.has(a));
      // A temporarily inconsistent Alchemy listing is not grounds for
      // pausing local watches. Keep RPC gap recovery and Telegram subscriptions
      // active while retrying the external repair next cycle.
      const report={status:unresolved.length?"incomplete":"repaired",expected:expected.length,actual:actual.size,missing_before:missing.length,missing_after:unresolved.length,checked_at:new Date().toISOString()};
      await save(db,RESULT,JSON.stringify(report));
      await save(db,NEXT,Date.now()+(unresolved.length?ERROR_DELAY:OK_DELAY));
      return report;
    }
    const report={status:"verified",expected:expected.length,actual:actual.size,missing_before:0,missing_after:0,checked_at:new Date().toISOString()};
    await save(db,RESULT,JSON.stringify(report));
    await save(db,NEXT,Date.now()+OK_DELAY);
    return report;
  }catch(e){
    // A complete external listing is required before concluding an address is
    // absent. A transient listing error never wipes or downgrades local watches.
    // When a PATCH or follow-up GET fails, the remote state may already have
    // changed. Do not demote any wallet without a complete confirming read.
    const report={status:"error",missing_identified:missing.length,reason:String(e.message||e).slice(0,180),checked_at:new Date().toISOString()};
    await save(db,RESULT,JSON.stringify(report));
    await save(db,NEXT,Date.now()+ERROR_DELAY);
    console.warn("Alchemy webhook reconciliation",report.reason);
    return report;
  }finally{
    await db.prepare("DELETE FROM runtime_state WHERE key=?").bind(LOCK).run();
  }
}
