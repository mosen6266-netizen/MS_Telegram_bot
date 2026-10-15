// @ts-nocheck
import {USDT,APPROVAL_TOPIC,toTopic,fromTopic,addr,blockNumber,allowance,recordUsage} from "./core";

// A complete scan is reported only after every historical block range has been processed.
// Historical discoveries are archival; only new on-chain approvals trigger live monitoring.
const HISTORY_WINDOW=1000000;
const HISTORY_PAGE_SIZE=200;

export async function startSpenderHistory(env,spender){
  const rule=await env.DB.prepare("SELECT start_block,generation FROM spender_rules WHERE spender=?").bind(spender).first();
  if(!rule)throw Error("Spender not registered");
  await env.DB.prepare("INSERT OR IGNORE INTO spender_history_jobs(spender,next_block,cutoff_block,window_size,state,generation) SELECT ?,0,?,?,'scanning',? WHERE EXISTS(SELECT 1 FROM spender_rules WHERE spender=? AND generation=?)")
    .bind(spender,Math.max(0,Number(rule.start_block)-1),HISTORY_WINDOW,rule.generation,spender,rule.generation).run();
}

function parseApprovalTime(log){
  const raw=log.timeStamp||log.blockTimestamp;
  if(!raw)return null;
  try{const seconds=Number(BigInt(raw));return seconds>1400000000&&Number.isSafeInteger(seconds)?new Date(seconds*1000).toISOString():null;}catch{return null;}
}
// Every persisted event is fenced by the currently registered rule generation.
// A deleted and re-created Spender receives a new generation, so an old RPC
// response cannot resurrect history or overwrite a newer scan.
function historyTimeStmt(env,spender,owner,block,time,generation){
  return env.DB.prepare(
    "INSERT INTO spender_history_timestamps(spender,owner,block_number,approval_at) "+
    "SELECT ?,?,?,? WHERE EXISTS(SELECT 1 FROM spender_rules WHERE spender=? AND generation=? AND enabled=1) "+
    "ON CONFLICT(spender,owner) DO UPDATE SET block_number=excluded.block_number,approval_at=excluded.approval_at "+
    "WHERE excluded.block_number>=spender_history_timestamps.block_number"
  ).bind(spender,owner,block,time,spender,generation);
}
function historyEventStmt(env,spender,owner,first,block,hash,amount,generation){
  return env.DB.prepare(
    "INSERT INTO spender_history_addresses(spender,owner,first_seen_block,latest_event_block,latest_tx_hash,last_event_amount_raw,verify_status) "+
    "SELECT ?,?,?,?,?,?,'pending' WHERE EXISTS(SELECT 1 FROM spender_rules WHERE spender=? AND generation=? AND enabled=1) "+
    "ON CONFLICT(spender,owner) DO UPDATE SET "+
    "first_seen_block=MIN(spender_history_addresses.first_seen_block,excluded.first_seen_block),"+
    "latest_tx_hash=CASE WHEN excluded.latest_event_block>=spender_history_addresses.latest_event_block THEN excluded.latest_tx_hash ELSE spender_history_addresses.latest_tx_hash END,"+
    "last_event_amount_raw=CASE WHEN excluded.latest_event_block>=spender_history_addresses.latest_event_block THEN excluded.last_event_amount_raw ELSE spender_history_addresses.last_event_amount_raw END,"+
    "verify_status=CASE WHEN excluded.latest_event_block>=spender_history_addresses.latest_event_block THEN 'pending' ELSE spender_history_addresses.verify_status END,"+
    "current_allowance_raw=CASE WHEN excluded.latest_event_block>=spender_history_addresses.latest_event_block THEN NULL ELSE spender_history_addresses.current_allowance_raw END,"+
    "verified_at=CASE WHEN excluded.latest_event_block>=spender_history_addresses.latest_event_block THEN NULL ELSE spender_history_addresses.verified_at END,"+
    "latest_event_block=MAX(spender_history_addresses.latest_event_block,excluded.latest_event_block)"
  ).bind(spender,owner,first,block,hash,amount,spender,generation);
}
async function generationValid(env,spender,generation){
  return !!await env.DB.prepare("SELECT 1 FROM spender_rules WHERE spender=? AND generation=? AND enabled=1").bind(spender,generation).first();
}

export async function recordSpenderLiveApproval(env,spender,log,amount,generation){
  const owner=fromTopic(log.topics?.[1]);
  if(!owner)return;
  const block=Number(BigInt(log.blockNumber));
  await historyEventStmt(env,spender,owner,block,block,log.transactionHash,BigInt(log.data||"0x0").toString(),generation).run();
  const stamp=parseApprovalTime(log);
  if(stamp)await historyTimeStmt(env,spender,owner,block,stamp,generation).run();
  await env.DB.prepare("UPDATE spender_history_addresses SET current_allowance_raw=?,verify_status=?,verified_at=CURRENT_TIMESTAMP WHERE spender=? AND owner=? AND latest_event_block<=? AND EXISTS(SELECT 1 FROM spender_rules WHERE spender=? AND generation=? AND enabled=1)")
    .bind(amount.toString(),amount>0n?"active":"revoked",spender,owner,block,spender,generation).run();
}

async function fetchHistoryRange(env,spender,from,to){
  if(!env.ETHERSCAN_API_KEY)throw Error("Etherscan V2 API Key 未配置");
  const q=new URLSearchParams({chainid:"1",module:"logs",action:"getLogs",address:USDT,
    fromBlock:String(from),toBlock:String(to),topic0:APPROVAL_TOPIC,topic2:toTopic(spender),
    topic0_2_opr:"and",page:"1",offset:String(HISTORY_PAGE_SIZE),apikey:env.ETHERSCAN_API_KEY});
  await recordUsage(env,"etherscan_requests");
  const response=await fetch("https://api.etherscan.io/v2/api?"+q.toString());
  if(!response.ok)throw Error("Etherscan HTTP "+response.status);
  const data=await response.json();
  const detail=String(data.result||data.message||"").slice(0,200);
  if(data.status==="0" && /no records found/i.test(String(data.message)+" "+detail))return [];
  if(data.status!=="1"||!Array.isArray(data.result))throw Error("Etherscan 历史查询失败："+detail);
  return data.result;
}

export async function scanSpenderHistories(env){
  // Reclaim tasks abandoned after a Worker shutdown, but never overlap live runs.
  const job=await env.DB.prepare("SELECT j.* FROM spender_history_jobs j JOIN spender_rules r ON r.spender=j.spender AND r.generation=j.generation WHERE r.enabled=1 AND (j.state IN ('scanning','retrying') OR (j.state='running' AND j.updated_at<datetime('now','-5 minutes'))) ORDER BY j.updated_at ASC LIMIT 1").first();
  if(!job)return false;
  const locked=await env.DB.prepare("UPDATE spender_history_jobs SET state='running',updated_at=CURRENT_TIMESTAMP WHERE spender=? AND generation=? AND EXISTS(SELECT 1 FROM spender_rules WHERE spender=? AND generation=? AND enabled=1) AND (state IN ('scanning','retrying') OR (state='running' AND updated_at<datetime('now','-5 minutes')))").bind(job.spender,job.generation,job.spender,job.generation).run();
  if(!(locked.meta?.changes>0))return false;
  try{
    const begin=Number(job.next_block),cutoff=Number(job.cutoff_block);
    if(begin>cutoff){
      await env.DB.prepare("UPDATE spender_history_jobs SET state='completed',last_error=NULL,finished_at=CURRENT_TIMESTAMP,updated_at=CURRENT_TIMESTAMP WHERE spender=? AND generation=?").bind(job.spender,job.generation).run();
      return false;
    }
    const window=Math.max(1,Math.min(HISTORY_WINDOW,Number(job.window_size)||HISTORY_WINDOW));
    const end=Math.min(cutoff,begin+window-1);
    const logs=await fetchHistoryRange(env,job.spender,begin,end);
    if(!await generationValid(env,job.spender,job.generation))return false;
    if(logs.length>=HISTORY_PAGE_SIZE){
      if(end===begin)throw Error("单个区块授权事件超出接口返回上限；需要分页检索，不会跳过此区块");
      await env.DB.prepare("UPDATE spender_history_jobs SET state='scanning',window_size=?,last_error=NULL,updated_at=CURRENT_TIMESTAMP WHERE spender=? AND generation=?")
        .bind(Math.max(1,Math.floor(window/2)),job.spender,job.generation).run();
      return true; // Smaller range will be picked up in the same scheduled run.
    }
    const latest=new Map();
    for(const log of logs){
      if(log.removed)continue;
      if(!Array.isArray(log.topics)||log.topics[0]?.toLowerCase()!==APPROVAL_TOPIC||log.topics[2]?.toLowerCase()!==toTopic(job.spender))throw Error("Etherscan 返回了与 Spender 不符的授权事件");
      const owner=fromTopic(log.topics[1]);
      if(!owner||!/^0x[0-9a-fA-F]{64}$/.test(String(log.data||""))||!/^0x[0-9a-fA-F]{64}$/.test(String(log.transactionHash||"")))throw Error("历史授权事件格式不完整");
      const block=Number(BigInt(log.blockNumber));
      if(!Number.isSafeInteger(block)||block<begin||block>end)throw Error("历史授权事件区块范围不匹配");
      const event={owner,block,hash:log.transactionHash,amount:BigInt(log.data).toString(),stamp:parseApprovalTime(log)};
      const previous=latest.get(owner);
      if(!previous)latest.set(owner,{...event,first:block});
      else{
        previous.first=Math.min(previous.first,block);
        if(block>=previous.block){previous.block=block;previous.hash=event.hash;previous.amount=event.amount;previous.stamp=event.stamp;}
      }
    }
    const records=[...latest.values()];
    for(let i=0;i<records.length;i+=35){
      if(!await generationValid(env,job.spender,job.generation))return false;
      const chunk=records.slice(i,i+35);
      const statements=chunk.map(row=>historyEventStmt(env,job.spender,row.owner,row.first,row.block,row.hash,row.amount,job.generation));
      await env.DB.batch(statements);
      const times=chunk.filter(row=>row.stamp).map(row=>historyTimeStmt(env,job.spender,row.owner,row.block,row.stamp,job.generation));
      if(times.length)await env.DB.batch(times);
    }
    const next=end+1;
    await env.DB.prepare("UPDATE spender_history_jobs SET next_block=?,window_size=?,state=?,events_found=events_found+?,last_error=NULL,retry_count=0,updated_at=CURRENT_TIMESTAMP,finished_at=CASE WHEN ?>cutoff_block THEN CURRENT_TIMESTAMP ELSE finished_at END WHERE spender=? AND generation=? AND next_block=? AND EXISTS(SELECT 1 FROM spender_rules WHERE spender=? AND generation=? AND enabled=1)")
      .bind(next,Math.min(HISTORY_WINDOW,Math.max(5000,window*2)),next>cutoff?"completed":"scanning",logs.length,next,job.spender,job.generation,job.next_block,job.spender,job.generation).run();
    return next<=cutoff;
  }catch(e){
    console.error("Spender history scan",job.spender,String(e));
    const message=String(e.message||e).slice(0,240);
    if(/block range|query timeout|too large|response size|exceed|more than|too many records|window limit/i.test(message)&&Number(job.window_size)>1){
      await env.DB.prepare("UPDATE spender_history_jobs SET window_size=?,state='scanning',last_error=?,updated_at=CURRENT_TIMESTAMP WHERE spender=? AND generation=?")
       .bind(Math.max(1,Math.floor(Number(job.window_size)/2)),"请求范围过大，正在自动缩小区块范围",job.spender,job.generation).run();
      return true;
    }
    await env.DB.prepare("UPDATE spender_history_jobs SET state='retrying',last_error=?,retry_count=retry_count+1,updated_at=CURRENT_TIMESTAMP WHERE spender=? AND generation=?")
      .bind(String(e.message||e).slice(0,240),job.spender,job.generation).run();
    return false; // Do not repeat rate-limited/failing API calls immediately.
  }
}

export async function verifyHistoricalAllowances(env,max=8){
  const rows=(await env.DB.prepare("SELECT h.spender,h.owner,r.generation FROM spender_history_addresses h JOIN spender_rules r ON r.spender=h.spender WHERE h.verify_status='pending' AND r.enabled=1 ORDER BY h.latest_event_block DESC LIMIT ?").bind(max).all()).results||[];
  for(const row of rows){
    try{
      const value=await allowance(env,row.owner,row.spender);
      await env.DB.prepare("UPDATE spender_history_addresses SET current_allowance_raw=?,verify_status=?,verified_at=CURRENT_TIMESTAMP WHERE spender=? AND owner=? AND verify_status='pending' AND EXISTS(SELECT 1 FROM spender_rules WHERE spender=? AND generation=? AND enabled=1)")
        .bind(value.toString(),value>0n?"active":"revoked",row.spender,row.owner,row.spender,row.generation).run();
    }catch(e){console.error("History allowance verification",row.spender,row.owner,String(e));break;}
  }
}
