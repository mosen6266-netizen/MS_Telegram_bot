// @ts-nocheck
import {USDT,USDC,addr,esc,receiptSuccess,queueNotice,increment} from "./core";
const asNum=x => typeof x==="string" && x.startsWith("0x")?Number(BigInt(x)):Number(x||0);
function identify(a){
  const category=String(a.category||"").toLowerCase();
  if(category==="external"||category==="internal")return {asset:"ETH", decimals:18};
  if(category!=="erc20")return null;
  const contract=addr(a.rawContract?.address||a.contractAddress||"");
  if(contract===USDT)return {asset:"USDT",decimals:6};
  if(contract===USDC)return {asset:"USDC",decimals:6};
  return null;
}
function displayAmount(a,asset){
  // Alchemy activity.value is a provider-supplied token-denominated decimal.
  // Never convert token amounts through JS floating point for arithmetic.
  if(a.value!==undefined && a.value!==null) return String(a.value);
  const raw=a.rawContract?.rawValue;
  if(raw!==undefined && raw!==null){
    let n=BigInt(raw),d=asset==="ETH"?18:6,txt=n.toString().padStart(d+1,"0");
    return txt.slice(0,-d)+(txt.slice(-d).replace(/0+$/,"")?"."+txt.slice(-d).replace(/0+$/,""):"");
  }
  return "未知";
}
export async function processActivity(env,payload){
  const event=payload.event||{};
  if(event.network && event.network!=="ETH_MAINNET")throw Error("Not Ethereum mainnet activity");
  if(payload.network && payload.network!=="ETH_MAINNET")throw Error("Invalid source network");
  const activities=event.activity||[];
  for(const a of activities){
    const asset=identify(a); if(!asset)continue;
    const from=addr(a.fromAddress),to=addr(a.toAddress);
    if(!from||!to)continue;
    const hash=a.hash||a.transactionHash;
    if(!/^0x[a-fA-F0-9]{64}$/.test(hash||""))continue;
    const success=await receiptSuccess(env,hash);
    if(success!==true)continue;
    const baseId="tx:"+hash+":"+(a.uniqueId||a.logIndex||a.category+":"+from+":"+to+":"+a.rawContract?.rawValue);
    const block=asNum(a.blockNum||a.blockNumber);
    const val=displayAmount(a,asset.asset);
    // Self transfers are recorded once, not twice.
    const owners=from===to?[{address:from,direction:"自转"}]:[{address:from,direction:"转出"},{address:to,direction:"转入"}];
    for(const o of owners){
      const watch=await env.DB.prepare("SELECT state FROM wallet_watches WHERE address=? AND state='active'").bind(o.address).first();
      if(!watch)continue;
      const eventId=baseId+":"+o.address+":"+o.direction;
      const inserted=await env.DB.prepare("INSERT OR IGNORE INTO transfer_events(event_id,address,asset,direction,raw_amount,from_address,to_address,tx_hash,block_number,block_hash) VALUES(?,?,?,?,?,?,?,?,?,?)")
        .bind(eventId,o.address,asset.asset,o.direction,val,from,to,hash,block,a.blockHash||null).run();
      if(!inserted.meta?.changes)continue;
      const {results:subs}=await env.DB.prepare("SELECT chat_id FROM subscriptions WHERE address=? AND status='active'").bind(o.address).all();
      for(const s of subs||[])await queueNotice(env,{
        dedup:eventId+":"+s.chat_id,chat_id:s.chat_id,address:o.address,template:"transfer",
        payload:{asset:asset.asset,direction:o.direction,amount:val,from_address:from,to_address:to,tx_hash:hash,block_number:block}
      });
      await increment(env,"transfer_events");
    }
  }
}
