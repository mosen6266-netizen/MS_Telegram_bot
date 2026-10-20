// @ts-nocheck
import {USDT,USDC,addr,receiptSuccess,queueNotice,increment} from "./core";

// Alchemy can label an ERC-20 transfer as either "erc20" (Transfers API)
// or "token" (Address Activity webhook). Match contracts, not token symbols.
function identify(a){
  const category=String(a.category||"").toLowerCase();
  if(category==="external"||category==="internal")return {asset:"ETH",kind:category,decimals:18};
  if(category!=="erc20"&&category!=="token")return null;
  const contract=addr(a.rawContract?.address||a.contractAddress||a.log?.address||"");
  if(contract===USDT)return {asset:"USDT",kind:"erc20",decimals:6};
  if(contract===USDC)return {asset:"USDC",kind:"erc20",decimals:6};
  return null;
}
function amount(a,decimals){
  // Prefer raw integer precision. Alchemy 'value' can be a JS number and
  // loses precision for large balances or transfers.
  const raw=a.rawContract?.rawValue??a.rawContract?.value;
  if(raw!==null&&raw!==undefined){
    const digits=BigInt(raw).toString().padStart(decimals+1,"0");
    const fraction=digits.slice(-decimals).replace(/0+$/,"");
    return digits.slice(0,-decimals)+(fraction?"."+fraction:"");
  }
  if(a.value!==null&&a.value!==undefined)return String(a.value);
  return "未知";
}
function indexValue(value){
  if(value===undefined||value===null||value==="")return null;
  try{
    const n=BigInt(value);
    return n>=0n?n.toString():null;
  }catch{return null;}
}
function transferKey(a,kind,hash,asset,from,to){
  // The same ERC-20 log arrives as "token" in Webhooks and "erc20" in
  // historical Transfers API. Both must produce the same outbox dedup key.
  if(kind==="erc20"){
    const unique=String(a.uniqueId||"");
    const suffix=unique.startsWith(hash+":log:")?unique.slice(hash.length+5):unique.startsWith(hash+":")?unique.slice(hash.length+1):null;
    const logIndex=indexValue(a.log?.logIndex??a.logIndex??suffix);
    if(logIndex!==null)return "tx:"+hash+":erc20:"+asset+":"+logIndex;
    // If the provider omitted log index, retain its unique ID, otherwise
    // derive a best-effort key without collapsing all same-hash transfers.
    return "tx:"+hash+":erc20:"+asset+":"+(unique||from+":"+to+":"+String(a.rawContract?.rawValue??a.rawContract?.value??a.value));
  }
  if(kind==="external")return "tx:"+hash+":external:ETH";
  return "tx:"+hash+":internal:ETH:"+(a.typeTraceAddress||a.uniqueId||from+":"+to+":"+String(a.rawContract?.rawValue??a.value));
}

export async function processActivity(env,payload,options={}){
  const event=payload.event||{};
  if(event.network && event.network!=="ETH_MAINNET")throw Error("Not Ethereum mainnet activity");
  if(payload.network && payload.network!=="ETH_MAINNET")throw Error("Invalid source network");
  const activities=event.activity||[];
  if(!Array.isArray(activities))throw Error("Invalid Alchemy activity list");
  for(const a of activities){
    const asset=identify(a);if(!asset)continue;
    const from=addr(a.fromAddress||a.from),to=addr(a.toAddress||a.to);
    if(!from||!to)continue;
    const hash=String(a.hash||a.transactionHash||"").toLowerCase();
    if(!/^0x[a-f0-9]{64}$/.test(hash))continue;
    if(a.log?.removed===true)continue;
    const success=await receiptSuccess(env,hash);
    // An unindexed receipt is transient: retry the *entire* webhook payload.
    // Previously we acknowledged and permanently lost these transactions.
    if(success===null)throw Error("Transaction receipt not indexed yet; retry this activity payload");
    if(success===false)continue;
    const baseId=transferKey(a,asset.kind,hash,asset.asset,from,to);
    const rawBlock=a.blockNum??a.blockNumber??a.log?.blockNumber;
    const block=typeof rawBlock==="string"&&rawBlock.startsWith("0x")?Number(BigInt(rawBlock)):Number(rawBlock);
    if(!Number.isSafeInteger(block)||block<0)throw Error("Transaction block number missing or invalid");
    const value=amount(a,asset.decimals);
    // A transfer between two watched wallets records each wallet's direction.
    // A self transfer has a single unique record and notification.
    const owners=from===to?[{address:from,direction:"自转"}]:[{address:from,direction:"转出"},{address:to,direction:"转入"}];
    for(const o of owners){
      const pendingRecovery=options.pendingRecoveryAddress===o.address;
      const watch=await env.DB.prepare("SELECT state FROM wallet_watches WHERE address=? AND (state='active' OR (state='pending' AND ?=1))").bind(o.address,pendingRecovery?1:0).first();
      if(!watch)continue;
      const eventId=baseId+":"+o.address+":"+o.direction;
      const inserted=await env.DB.prepare("INSERT OR IGNORE INTO transfer_events(event_id,address,asset,direction,raw_amount,from_address,to_address,tx_hash,block_number,block_hash) VALUES(?,?,?,?,?,?,?,?,?,?)")
        .bind(eventId,o.address,asset.asset,o.direction,value,from,to,hash,block,a.blockHash||a.log?.blockHash||null).run();
      if(inserted.meta?.changes)await increment(env,"transfer_events");
      // Even if the event already exists, an earlier queueNotice() may have
      // failed after the insert. INSERT OR IGNORE into outbox repairs it safely.
      const {results:subs}=await env.DB.prepare("SELECT chat_id FROM subscriptions WHERE address=? AND status "+(watch.state==="pending"&&pendingRecovery?"IN ('active','pending')":"='active'")).bind(o.address).all();
      for(const s of subs||[])await queueNotice(env,{
        dedup:eventId+":"+s.chat_id,chat_id:s.chat_id,address:o.address,template:"transfer",
        payload:{asset:asset.asset,direction:o.direction,amount:value,from_address:from,to_address:to,tx_hash:hash,block_number:block,
          rpc_fallback:watch.state==="pending"&&pendingRecovery}
      });
    }
  }
}
