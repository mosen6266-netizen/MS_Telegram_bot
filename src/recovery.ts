// @ts-nocheck
import {rpc,blockNumber,USDT,USDC,now,queueNotice} from "./core";
import {processActivity} from "./transfers";
// Periodic, bounded transaction recovery. Fast alerts are still delivered by Alchemy Webhook.
async function getOneDirection(env,address,direction,from,to){
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
      blockNum:x.blockNum,value:x.value,category:x.category,
      rawContract:{address:x.rawContract?.address,rawValue:x.rawContract?.value}
    }));
    await processActivity(env,{network:"ETH_MAINNET",event:{network:"ETH_MAINNET",activity:normalized}});
    transactions+=normalized.length;cursor=page.pageKey||null;
  }while(cursor);
  return transactions;
}
export async function selectGapScanCandidates(db,head,maxWallets=3){
  return (await db.prepare(
    "SELECT c.address,c.last_block FROM wallet_checkpoints c JOIN wallet_watches w ON c.address=w.address "+
    "WHERE w.state='active' AND c.last_block<? "+
    // checked_at is ISO8601 with T/Z while SQLite datetime is spaced; always
    // normalize before comparing or retries would be delayed for a full day.
    "AND (c.last_error IS NULL OR c.checked_at IS NULL OR datetime(c.checked_at)<=datetime('now','-5 minutes')) "+
    "ORDER BY c.last_block ASC,c.address ASC LIMIT ?"
  ).bind(head,Math.max(1,Math.min(12,maxWallets))).all()).results||[];
}
export async function scanWalletGaps(env,maxWallets=3){
  const head=await blockNumber(env);
  const wallets=await selectGapScanCandidates(env.DB,head,maxWallets);
  for(const w of wallets||[]){
    const from=Math.max(0,w.last_block-5),to=Math.min(head,w.last_block+120);
    try {
      await getOneDirection(env,w.address,"out",from,to);
      await getOneDirection(env,w.address,"in",from,to);
      await env.DB.prepare("UPDATE wallet_checkpoints SET last_block=?,checked_at=?,last_error=NULL WHERE address=?").bind(to,now(),w.address).run();
    }catch(e){
      // Preserve last_block so the exact failed range is retried later;
      // checked_at provides a bounded cooldown to unblock other wallets.
      await env.DB.prepare("UPDATE wallet_checkpoints SET last_error=?,checked_at=? WHERE address=?")
        .bind(String(e).slice(0,300),now(),w.address).run();
      console.error("Wallet recovery failure",w.address,String(e));
    }
  }
}
// Repair legacy confirmed events missing a block hash, using the real
// transaction receipt. Never infer or invent a hash from block height alone.
// Throttle repeated failures: older RPC receipts may be unavailable.
export async function backfillMissingTransferBlockHashes(env,limit=3){
  const key="transfer_blockhash_backfill_after";
  const stamp=Date.now();
  const next=(await env.DB.prepare("SELECT value FROM runtime_state WHERE key=?").bind(key).first())?.value;
  if(Number(next||0)>stamp)return {cooldown:true};
  await env.DB.prepare(
    "INSERT INTO runtime_state(key,value,updated_at) VALUES(?,?,CURRENT_TIMESTAMP) "+
    "ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=CURRENT_TIMESTAMP"
  ).bind(key,String(stamp+6*60*60*1000)).run();
  const rows=(await env.DB.prepare(
    "SELECT event_id,tx_hash,block_number FROM transfer_events "+
    "WHERE state='confirmed' AND block_hash IS NULL ORDER BY block_number DESC LIMIT ?"
  ).bind(Math.max(1,Math.min(limit,5))).all()).results||[];
  let repaired=0;
  for(const row of rows){
    try{
      const receipt=await rpc(env,"eth_getTransactionReceipt",[row.tx_hash]);
      const hash=String(receipt?.blockHash||"").toLowerCase();
      if(receipt?.status!=="0x1"||!/^0x[0-9a-f]{64}$/.test(hash))continue;
      if(Number(BigInt(receipt.blockNumber||"0x0"))!==Number(row.block_number))continue;
      const changed=await env.DB.prepare(
        "UPDATE transfer_events SET block_hash=? WHERE event_id=? AND block_hash IS NULL "+
        "AND block_number=? AND state='confirmed'"
      ).bind(hash,row.event_id,row.block_number).run();
      repaired+=changed.meta?.changes||0;
    }catch(error){console.warn("Legacy block hash backfill failed",row.event_id,String(error));}
  }
  return {attempted:rows.length,repaired};
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
