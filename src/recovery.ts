// @ts-nocheck
import {rpc,blockNumber,USDT,USDC,now,queueNotice} from "./core";
import {processActivity} from "./transfers";
// Periodic, bounded transaction recovery. Fast alerts are still delivered by Alchemy Webhook.
async function getOneDirection(env,address,direction,from,to,pendingRecoveryAddress=null){
  let cursor=null,loops=0,transactions=0;
  do{
    if(++loops>20)throw Error("Transfer backlog exceeds 20 pages; abort without advancing checkpoint");
    const params={
      fromBlock:"0x"+from.toString(16),toBlock:"0x"+to.toString(16),
      order:"asc",category:["external","internal","erc20"],contractAddresses:[USDT,USDC],
      excludeZeroValue:true,withMetadata:false,maxCount:"0x3e8",
      ...(direction==="out"?{fromAddress:address}:{toAddress:address}),
      ...(cursor?{pageKey:cursor}:{})
    };
    const page=await rpc(env,"alchemy_getAssetTransfers",[params]);
    if(!page||!Array.isArray(page.transfers))throw Error("Alchemy transfer page is invalid");
    const normalized=page.transfers.map(x=>({
      fromAddress:x.from,toAddress:x.to,hash:x.hash,uniqueId:x.uniqueId,
      blockNum:x.blockNum,value:x.value,category:x.category,typeTraceAddress:x.typeTraceAddress,
      rawContract:{address:x.rawContract?.address,rawValue:x.rawContract?.value}
    }));
    await processActivity(env,{network:"ETH_MAINNET",event:{network:"ETH_MAINNET",activity:normalized}},pendingRecoveryAddress?{pendingRecoveryAddress}:{});
    transactions+=normalized.length;cursor=page.pageKey||null;
  }while(cursor);
  return transactions;
}
export async function scanWalletGaps(env,maxWallets=8){
  const head=await blockNumber(env);
  const {results:wallets}=await env.DB.prepare(
   "SELECT c.address,c.last_block FROM wallet_checkpoints c JOIN wallet_watches w ON c.address=w.address WHERE w.state='active' AND c.last_block<? AND (c.last_error IS NULL OR c.checked_at IS NULL OR datetime(c.checked_at)<datetime('now','-5 minutes')) ORDER BY c.last_block ASC,c.checked_at ASC LIMIT ?"
  ).bind(head,maxWallets).all();
  for(const w of wallets||[]){
    const from=Math.max(0,w.last_block-5),to=Math.min(head,w.last_block+600);
    try {
      await getOneDirection(env,w.address,"out",from,to);
      await getOneDirection(env,w.address,"in",from,to);
      await env.DB.prepare("UPDATE wallet_checkpoints SET last_block=?,checked_at=?,last_error=NULL WHERE address=?").bind(to,now(),w.address).run();
    }catch(e){
      await env.DB.prepare("UPDATE wallet_checkpoints SET last_error=?,checked_at=? WHERE address=?").bind(String(e).slice(0,300),now(),w.address).run();
      console.error("Wallet recovery failure",w.address,String(e));
    }
  }
}
export async function reconcileRecentReorgs(env){
  const head=await blockNumber(env);
  const {results:rows}=await env.DB.prepare(
   "SELECT DISTINCT block_number,block_hash FROM transfer_events WHERE state='confirmed' AND block_hash IS NOT NULL AND block_number BETWEEN ? AND ? LIMIT 16"
  ).bind(Math.max(0,head-16),head).all();
  for(const row of rows||[]){
    try{
      const block=await rpc(env,"eth_getBlockByNumber",["0x"+row.block_number.toString(16),false]);
      if(!block || block.hash?.toLowerCase()===row.block_hash.toLowerCase())continue;
      const {results:changed}=await env.DB.prepare(
        "SELECT * FROM transfer_events WHERE block_number=? AND block_hash=? AND state='confirmed'"
      ).bind(row.block_number,row.block_hash).all();
      for(const event of changed||[]){
        await env.DB.prepare("UPDATE transfer_events SET state='reorged' WHERE event_id=?").bind(event.event_id).run();
        const {results:chats}=await env.DB.prepare("SELECT chat_id FROM subscriptions WHERE address=? AND status='active'").bind(event.address).all();
        for(const item of chats||[])await queueNotice(env,{dedup:"reorg:"+event.event_id+":"+item.chat_id,
          chat_id:item.chat_id,address:event.address,template:"reorg_correction",
          payload:{address:event.address,asset:event.asset,tx_hash:event.tx_hash,block_number:event.block_number}
        });
      }
    }catch(e){console.warn("reorg reconciliation error",String(e));}
  }
}

// RPC fallback for addresses pending Alchemy webhook enrollment. Do not mark
// these as active subscribers: periodic polling is not a realtime webhook.
const PENDING_RPC_PREFIX="pending_rpc_backup:";
export async function scanPendingRpcFallback(env,maxWallets=2){
  const db=env.DB;
  const {results:pending}=await db.prepare(
    "SELECT w.address FROM wallet_watches w WHERE w.state='pending' "+
    "AND EXISTS (SELECT 1 FROM subscriptions s WHERE s.address=w.address AND s.status IN ('active','pending')) "+
    "AND NOT EXISTS (SELECT 1 FROM wallet_exclusions x WHERE x.address=w.address) "+
    "AND NOT EXISTS (SELECT 1 FROM wallets v WHERE v.address=w.address AND v.deleted_at IS NOT NULL) "+
    "ORDER BY w.updated_at ASC LIMIT ?"
  ).bind(Math.max(1,Math.min(2,maxWallets))).all();
  if(!pending?.length)return {scanned:0};
  const head=await blockNumber(env);
  let succeeded=0,failed=0;
  for(const {address} of pending){
    const key=PENDING_RPC_PREFIX+address;
    const last=await db.prepare("SELECT value FROM runtime_state WHERE key=?").bind(key).first();
    let prior={};
    try{prior=JSON.parse(last?.value||"{}")}catch{}
    const cursor=Number(prior.last_block);
    // First scan covers about 50 minutes; later scans overlap five blocks.
    // This checkpoint is separate from the realtime webhook recovery cursor.
    const from=Number.isSafeInteger(cursor)&&cursor>=0
      ?Math.max(0,Math.min(head,cursor)-5):Math.max(0,head-250);
    const to=Math.min(head,from+300);
    try{
      const outbound=await getOneDirection(env,address,"out",from,to,address);
      const inbound=await getOneDirection(env,address,"in",from,to,address);
      const report={status:"ok",last_block:to,checked_at:now(),seen:outbound+inbound,mode:"rpc_minute_backup"};
      await db.prepare("INSERT INTO runtime_state(key,value,updated_at) VALUES(?,?,CURRENT_TIMESTAMP) ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=CURRENT_TIMESTAMP")
        .bind(key,JSON.stringify(report)).run();
      succeeded++;
    }catch(e){
      const report={status:"error",last_block:Number.isSafeInteger(cursor)?cursor:null,checked_at:now(),reason:String(e?.message||e).slice(0,180)};
      await db.prepare("INSERT INTO runtime_state(key,value,updated_at) VALUES(?,?,CURRENT_TIMESTAMP) ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=CURRENT_TIMESTAMP")
        .bind(key,JSON.stringify(report)).run();
      failed++;
      console.warn("Pending-wallet RPC backup retry",address,report.reason);
    }
  }
  return {scanned:pending.length,succeeded,failed};
}
