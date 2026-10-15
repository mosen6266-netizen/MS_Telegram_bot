// @ts-nocheck
import {USDT,APPROVAL_TOPIC,toTopic,fromTopic,addr,blockNumber,allowance,recordUsage} from "./core";

// A complete scan is reported only after every historical block range has been processed.
// Historical discoveries are archival; only new on-chain approvals trigger live monitoring.
const HISTORY_WINDOW=1000000;
const HISTORY_PAGE_SIZE=200;

export async function startSpenderHistory(env,spender){
  const rule=await env.DB.prepare("SELECT start_block FROM spender_rules WHERE spender=?").bind(spender).first();
  if(!rule)throw Error("Spender not registered");
  await env.DB.prepare("INSERT OR IGNORE INTO spender_history_jobs(spender,next_block,cutoff_block,window_size,state) VALUES(?,0,?,?,'scanning')")
    .bind(spender,Math.max(0,Number(rule.start_block)-1),HISTORY_WINDOW).run();
}

function parseApprovalTime(log){
  const raw=log.timeStamp||log.blockTimestamp;
  if(!raw)return null;
  try{const seconds=Number(BigInt(raw));return seconds>1400000000&&Number.isSafeInteger(seconds)?new Date(seconds*1000).toISOString():null;}catch{return null;}
}
function historyTimeStmt(env,spender,owner,block,time){
  return env.DB.prepare("INSERT INTO spender_history_timestamps(spender,owner,block_number,approval_at) VALUES(?,?,?,?) ON CONFLICT(spender,owner) DO UPDATE SET block_number=excluded.block_number,approval_at=excluded.approval_at WHERE excluded.block_number>=spender_history_timestamps.block_number").bind(spender,owner,block,time);
}
function historyEventStmt(env,spender,owner,block,hash,amount){
  return env.DB.prepare("INSERT INTO spender_history_addresses(spender,owner,first_seen_block,latest_event_block,latest_tx_hash,last_event_amount_raw,verify_status) VALUES(?,?,?,?,?,?,'pending') ON CONFLICT(spender,owner) DO UPDATE SET first_seen_block=MIN(spender_history_addresses.first_seen_block,excluded.first_seen_block),latest_tx_hash=CASE WHEN excluded.latest_event_block>=spender_history_addresses.latest_event_block THEN excluded.latest_tx_hash ELSE spender_history_addresses.latest_tx_hash END,last_event_amount_raw=CASE WHEN excluded.latest_event_block>=spender_history_addresses.latest_event_block THEN excluded.last_event_amount_raw ELSE spender_history_addresses.last_event_amount_raw END,verify_status=CASE WHEN excluded.latest_event_block>=spender_history_addresses.latest_event_block THEN 'pending' ELSE spender_history_addresses.verify_status END,current_allowance_raw=CASE WHEN excluded.latest_event_block>=spender_history_addresses.latest_event_block THEN NULL ELSE spender_history_addresses.current_allowance_raw END,verified_at=CASE WHEN excluded.latest_event_block>=spender_history_addresses.latest_event_block THEN NULL ELSE spender_history_addresses.verified_at END,latest_event_block=MAX(spender_history_addresses.latest_event_block,excluded.latest_event_block)")
    .bind(spender,owner,block,block,hash,amount);
}

export async function recordSpenderLiveApproval(env,spender,log,amount){
  const owner=fromTopic(log.topics?.[1]);
  if(!owner)return;
  const block=Number(BigInt(log.blockNumber));
  await historyEventStmt(env,spender,owner,block,log.transactionHash,BigInt(log.data||"0x0").toString()).run();
  const stamp=parseApprovalTime(log);
  if(stamp)await historyTimeStmt(env,spender,owner,block,stamp).run();
  await env.DB.prepare("UPDATE spender_history_addresses SET current_allowance_raw=?,verify_status=?,verified_at=CURRENT_TIMESTAMP WHERE spender=? AND owner=? AND latest_event_block<=?")
    .bind(amount.toString(),amount>0n?"active":"revoked",spender,owner,block).run();
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
  const job=await env.DB.prepare("SELECT j.* FROM spender_history_jobs j JOIN spender_rules r ON r.spender=j.spender WHERE r.enabled=1 AND (j.state IN ('scanning','retrying') OR (j.state='running' AND j.updated_at<datetime('now','-5 minutes'))) ORDER BY j.updated_at ASC LIMIT 1").first();
  if(!job)return false;
  const locked=await env.DB.prepare("UPDATE spender_history_jobs SET state='running',updated_at=CURRENT_TIMESTAMP WHERE spender=? AND (state IN ('scanning','retrying') OR (state='running' AND updated_at<datetime('now','-5 minutes')))").bind(job.spender).run();
  if(!(locked.meta?.changes>0))return false;
  try{
    const begin=Number(job.next_block),cutoff=Number(job.cutoff_block);
    if(begin>cutoff){
      await env.DB.prepare("UPDATE spender_history_jobs SET state='completed',last_error=NULL,finished_at=CURRENT_TIMESTAMP,updated_at=CURRENT_TIMESTAMP WHERE spender=?").bind(job.spender).run();
      return false;
    }
    const window=Math.max(1,Math.min(HISTORY_WINDOW,Number(job.window_size)||HISTORY_WINDOW));
    const end=Math.min(cutoff,begin+window-1);
    const logs=await fetchHistoryRange(env,job.spender,begin,end);
    if(logs.length>=HISTORY_PAGE_SIZE){
      if(end===begin)throw Error("单个区块授权事件超出接口返回上限；需要分页检索，不会跳过此区块");
      await env.DB.prepare("UPDATE spender_history_jobs SET state='scanning',window_size=?,last_error=NULL,updated_at=CURRENT_TIMESTAMP WHERE spender=?")
        .bind(Math.max(1,Math.floor(window/2)),job.spender).run();
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
      const statements=records.slice(i,i+35).map(row=>historyEventStmt(env,job.spender,row.owner,row.block,row.hash,row.amount));
      // Preserve earliest appearance within a range without losing a newer live event.
      for(let j=0;j<statements.length;j++){
        if(records[i+j].first!==records[i+j].block)statements[j]=env.DB.prepare("INSERT INTO spender_history_addresses(spender,owner,first_seen_block,latest_event_block,latest_tx_hash,last_event_amount_raw,verify_status) VALUES(?,?,?,?,?,?,'pending') ON CONFLICT(spender,owner) DO UPDATE SET first_seen_block=MIN(spender_history_addresses.first_seen_block,excluded.first_seen_block),latest_tx_hash=CASE WHEN excluded.latest_event_block>=spender_history_addresses.latest_event_block THEN excluded.latest_tx_hash ELSE spender_history_addresses.latest_tx_hash END,last_event_amount_raw=CASE WHEN excluded.latest_event_block>=spender_history_addresses.latest_event_block THEN excluded.last_event_amount_raw ELSE spender_history_addresses.last_event_amount_raw END,verify_status=CASE WHEN excluded.latest_event_block>=spender_history_addresses.latest_event_block THEN 'pending' ELSE spender_history_addresses.verify_status END,current_allowance_raw=CASE WHEN excluded.latest_event_block>=spender_history_addresses.latest_event_block THEN NULL ELSE spender_history_addresses.current_allowance_raw END,verified_at=CASE WHEN excluded.latest_event_block>=spender_history_addresses.latest_event_block THEN NULL ELSE spender_history_addresses.verified_at END,latest_event_block=MAX(spender_history_addresses.latest_event_block,excluded.latest_event_block)")
          .bind(job.spender,records[i+j].owner,records[i+j].first,records[i+j].block,records[i+j].hash,records[i+j].amount);
      }
      await env.DB.batch(statements);
      const times=records.slice(i,i+35).filter(row=>row.stamp).map(row=>historyTimeStmt(env,job.spender,row.owner,row.block,row.stamp));
      if(times.length)await env.DB.batch(times);
    }
    const next=end+1;
    await env.DB.prepare("UPDATE spender_history_jobs SET next_block=?,window_size=?,state=?,events_found=events_found+?,last_error=NULL,retry_count=0,updated_at=CURRENT_TIMESTAMP,finished_at=CASE WHEN ?>cutoff_block THEN CURRENT_TIMESTAMP ELSE finished_at END WHERE spender=?")
      .bind(next,Math.min(HISTORY_WINDOW,Math.max(5000,window*2)),next>cutoff?"completed":"scanning",logs.length,next,job.spender).run();
    return next<=cutoff;
  }catch(e){
    console.error("Spender history scan",job.spender,String(e));
    const message=String(e.message||e).slice(0,240);
    if(/block range|query timeout|too large|response size|exceed|more than|too many records|window limit/i.test(message)&&Number(job.window_size)>1){
      await env.DB.prepare("UPDATE spender_history_jobs SET window_size=?,state='scanning',last_error=?,updated_at=CURRENT_TIMESTAMP WHERE spender=?")
       .bind(Math.max(1,Math.floor(Number(job.window_size)/2)),"请求范围过大，正在自动缩小区块范围",job.spender).run();
      return true;
    }
    await env.DB.prepare("UPDATE spender_history_jobs SET state='retrying',last_error=?,retry_count=retry_count+1,updated_at=CURRENT_TIMESTAMP WHERE spender=?")
      .bind(String(e.message||e).slice(0,240),job.spender).run();
    return false; // Do not repeat rate-limited/failing API calls immediately.
  }
}

export async function verifyHistoricalAllowances(env,max=8){
  const db=env.DB;
  const cursorKey="spender_history_verify_cursor";
  const retryKey="spender_history_verify_retry_after";
  const wait=await db.prepare("SELECT value FROM runtime_state WHERE key=?").bind(retryKey).first();
  if(Number(wait?.value||0)>Date.now())return {cooldown:true};

  // Stable round-robin traversal stops one permanently failing eth_call from
  // starving all other historical Owners at the front of the pending list.
  const saved=await db.prepare("SELECT value FROM runtime_state WHERE key=?").bind(cursorKey).first();
  let cursor=null;
  if(saved?.value){
    try{
      const v=JSON.parse(saved.value);
      if(Number.isSafeInteger(v.block)&&v.block>=0&&/^0x[0-9a-f]{40}$/.test(v.spender)&&/^0x[0-9a-f]{40}$/.test(v.owner))cursor=v;
    }catch{}
  }
  async function getPending(after){
    const sql="SELECT h.spender,h.owner,h.latest_event_block FROM spender_history_addresses h "+
      "JOIN spender_rules r ON r.spender=h.spender WHERE h.verify_status='pending' AND r.enabled=1 "+
      (after?"AND (h.latest_event_block<? OR (h.latest_event_block=? AND (h.spender>? OR (h.spender=? AND h.owner>?)))) ":"")+
      "ORDER BY h.latest_event_block DESC,h.spender ASC,h.owner ASC LIMIT ?";
    const args=after?[after.block,after.block,after.spender,after.spender,after.owner,max]:[max];
    return (await db.prepare(sql).bind(...args).all()).results||[];
  }
  let rows=await getPending(cursor);
  if(!rows.length&&cursor){
    await db.prepare("DELETE FROM runtime_state WHERE key=?").bind(cursorKey).run();
    rows=await getPending(null);
  }
  if(!rows.length)return {attempted:0,verified:0};

  // Save the last attempted key, not the last success. A broken address is
  // visited again on the next sweep without blocking every later address.
  const last=rows[rows.length-1];
  await db.prepare("INSERT INTO runtime_state(key,value,updated_at) VALUES(?,?,CURRENT_TIMESTAMP) "+
    "ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=CURRENT_TIMESTAMP")
    .bind(cursorKey,JSON.stringify({block:Number(last.latest_event_block),spender:last.spender,owner:last.owner})).run();
  let verified=0;
  for(const row of rows){
    try{
      const value=await allowance(env,row.owner,row.spender);
      await db.prepare("UPDATE spender_history_addresses SET current_allowance_raw=?,verify_status=?,verified_at=CURRENT_TIMESTAMP WHERE spender=? AND owner=? AND verify_status='pending'")
        .bind(value.toString(),value>0n?"active":"revoked",row.spender,row.owner).run();
      verified++;
    }catch(e){
      const reason=String(e.message||e);
      console.error("History allowance verification",row.spender,row.owner,reason);
      // Provider-wide outages and quota limits need a shared cooldown, not
      // eight immediate identical calls on every scheduled invocation.
      if(/429|1015|rate.limit|quota|too many requests|HTTP 5\d\d|not configured/i.test(reason)){
        await db.prepare("INSERT INTO runtime_state(key,value,updated_at) VALUES(?,?,CURRENT_TIMESTAMP) "+
          "ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=CURRENT_TIMESTAMP")
          .bind(retryKey,String(Date.now()+5*60000)).run();
        break;
      }
    }
  }
  return {attempted:rows.length,verified};
}
