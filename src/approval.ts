// @ts-nocheck
import {USDT,APPROVAL_TOPIC,addr,toTopic,fromTopic,allowance,blockNumber,rpc,formatUnits,esc,short,send,buttons,queueNotice,ensureWatch,increment,recordUsage,receiptSuccess,now} from "./core";
import {recordSpenderLiveApproval} from "./spender-history";
import {walletRemark} from "./wallet-remarks";
import {renderTemplate} from "./notifications";

// Etherscan V2 log indexing is essential for discovery. No 'no approval' claim is made on incomplete scans.
export async function ownerSpenders(env,owner){
  if(!env.ETHERSCAN_API_KEY)throw Error("ETHERSCAN_API_KEY required for complete historical spender discovery");
  const found=new Set();
  for(let page=1;page<=10;page++){
    const q=new URLSearchParams({chainid:"1",module:"logs",action:"getLogs",address:USDT,
      topic0:APPROVAL_TOPIC,topic1:toTopic(owner),topic0_1_opr:"and",fromBlock:"0",toBlock:"latest",
      page:String(page),offset:"1000",apikey:env.ETHERSCAN_API_KEY});
    await recordUsage(env,"etherscan_requests");
    const r=await fetch("https://api.etherscan.io/v2/api?"+q);
    if(!r.ok)throw Error("Etherscan HTTP "+r.status);
    const d=await r.json();
    if(d.status==="0" && /no records found/i.test(String(d.message)+" "+String(d.result)))return [...found];
    if(d.status!=="1"||!Array.isArray(d.result))throw Error("Historical log query failed: "+String(d.result||d.message).slice(0,120));
    for(const log of d.result) if(log.topics?.[0]?.toLowerCase()===APPROVAL_TOPIC && log.topics?.[1]?.toLowerCase()===toTopic(owner)){
      const a=fromTopic(log.topics[2]);if(a)found.add(a);
    }
    if(d.result.length<1000)return [...found];
  }
  throw Error("Historical allowance log scan exceeds configured pagination limit; result incomplete");
}
export async function verifyAdminOwner(env,owner,chat_id){
  const spenders=await ownerSpenders(env,owner);
  let active=0;
  for(const spender of spenders)if((await allowance(env,owner,spender))>0n)active++;
  if(active===0)return {active:false,checked:spenders.length};
  await env.DB.prepare("INSERT OR IGNORE INTO wallets(address,discovery_source) VALUES(?,'admin')").bind(owner).run();
  const watched=await ensureWatch(env,owner);
  if(watched)await env.DB.prepare("UPDATE subscriptions SET status='active' WHERE address=? AND status='pending'").bind(owner).run();
  return {active:watched,allowances:active};
}
export async function checkOwner(env, owner, chat_id, user_id, display_name){
  const spenders=await ownerSpenders(env,owner);
  const positives=[];
  for(const spender of spenders) {
    const amt=await allowance(env,owner,spender);
    if(amt>0n)positives.push({spender,amount:amt.toString()});
  }
  await env.DB.prepare("INSERT INTO query_history(user_id,chat_id,address,result) VALUES(?,?,?,?)")
    .bind(String(user_id),String(chat_id),owner,positives.length?"authorized":"no_effective_allowance").run();
  if(!positives.length){
    await send(env,chat_id,await renderTemplate(env,"query_inactive",chat_id,{address:owner}));
    return;
  }
  await env.DB.prepare("INSERT OR IGNORE INTO wallets(address,first_user_id,first_user_name,discovery_source) VALUES(?,?,?,'manual')")
    .bind(owner,String(user_id),display_name).run();
  await env.DB.prepare("UPDATE wallets SET first_user_id=?,first_user_name=? WHERE address=? AND first_user_id IS NULL")
    .bind(String(user_id),display_name,owner).run();
  const first=await env.DB.prepare("SELECT first_user_name FROM wallets WHERE address=?").bind(owner).first();
  const sharedRemark=await walletRemark(env,owner,first?.first_user_name||display_name);
  await env.DB.prepare("INSERT INTO subscriptions(chat_id,address,remark,status) VALUES(?,?,?,'pending') ON CONFLICT(chat_id,address) DO UPDATE SET status=CASE WHEN status='removed' THEN 'pending' ELSE status END").bind(String(chat_id),owner,sharedRemark).run();
  const watched=await ensureWatch(env,owner);
  if(watched)await env.DB.prepare("UPDATE subscriptions SET status='active' WHERE chat_id=? AND address=? AND status='pending'").bind(String(chat_id),owner).run();
  const current=await env.DB.prepare("SELECT remark FROM subscriptions WHERE chat_id=? AND address=?").bind(String(chat_id),owner).first();
  const groupRemark=await walletRemark(env,owner,current?.remark||first?.first_user_name||display_name);
  const lines=positives.slice(0,25).map((x,i)=>(i+1)+". <code>"+esc(x.spender)+"</code>\n额度："+(BigInt(x.amount)>=(1n<<255n)?"无限":formatUnits(x.amount,6)+" USDT"));
  const output=await renderTemplate(env,"query_active",chat_id,{
    remark:groupRemark,address:owner,
    more_count:positives.length>25?"\n另有 "+(positives.length-25)+" 项有效授权，请在后台查看。":"",
    watch_status:watched?"✅ ETH / USDT / USDC 已启动":"⚠️ 等待 Alchemy 订阅同步，尚未正式启动"
  },{approval_list:lines.join("\n")});
  await send(env,chat_id,output,buttons(owner));
  await increment(env,"wallet_lookups");
}
export async function addSpender(env,spender,remark,chat_ids){
  const head=await blockNumber(env);
  await env.DB.prepare("INSERT INTO spender_rules(spender,remark,start_block,cursor_block) VALUES(?,?,?,?) ON CONFLICT(spender) DO UPDATE SET remark=excluded.remark,enabled=1").bind(spender,remark,head,head).run();
  for(const chat of chat_ids||[])await env.DB.prepare("INSERT OR IGNORE INTO spender_routes(spender,chat_id) VALUES(?,?)").bind(spender,String(chat)).run();
}
// Scan in bounded batches and narrow the block range if the RPC provider
// rejects a request. Persist progress/errors instead of indefinitely retrying
// one opaque 500-block request with no actionable diagnostics.
async function etherscanApprovalLogs(env,spender,from,to){
  if(!env.ETHERSCAN_API_KEY)throw Error("Etherscan backup API key unavailable");
  const combined=[];
  for(let page=1;page<=20;page++){
    const q=new URLSearchParams({chainid:"1",module:"logs",action:"getLogs",
      address:USDT,fromBlock:String(from),toBlock:String(to),
      topic0:APPROVAL_TOPIC,topic2:toTopic(spender),topic0_2_opr:"and",
      page:String(page),offset:"200",apikey:env.ETHERSCAN_API_KEY});
    await recordUsage(env,"etherscan_requests");
    const res=await fetch("https://api.etherscan.io/v2/api?"+q);
    if(!res.ok)throw Error("Etherscan backup HTTP "+res.status);
    const data=await res.json();
    if(data.status==="0"&&/no records found/i.test(String(data.message)+" "+String(data.result)))return combined;
    if(data.status!=="1"||!Array.isArray(data.result))
      throw Error("Etherscan backup "+String(data.result||data.message||"response invalid").slice(0,120));
    if(from!==to&&data.result.length>=200)
      throw Error("Etherscan backup range saturated; reduce block window");
    combined.push(...data.result);
    if(data.result.length<200)return combined;
  }
  throw Error("Etherscan backup single block exceeds safe pagination limit");
}
async function fetchApprovalLogs(env,spender,from,to,preferBackup){
  const params=[{address:USDT,fromBlock:"0x"+from.toString(16),toBlock:"0x"+to.toString(16),
    topics:[APPROVAL_TOPIC,null,toTopic(spender)]}];
  if(preferBackup){
    try{return {logs:await etherscanApprovalLogs(env,spender,from,to),provider:"etherscan"};}
    catch(backupErr){
      const logs=await rpc(env,"eth_getLogs",params);
      if(!Array.isArray(logs))throw Error("Invalid RPC logs");
      return {logs,provider:"alchemy"};
    }
  }
  try{
    const logs=await rpc(env,"eth_getLogs",params);
    if(!Array.isArray(logs))throw Error("Invalid RPC logs");
    return {logs,provider:"alchemy"};
  }catch(rpcError){
    if(!env.ETHERSCAN_API_KEY)throw rpcError;
    try{return {logs:await etherscanApprovalLogs(env,spender,from,to),provider:"etherscan"};}
    catch(backupErr){throw Error("Alchemy "+String(rpcError.message||rpcError).slice(0,90)+"; backup "+String(backupErr.message||backupErr).slice(0,125));}
  }
}
const pollStatusKey=spender=>"spender_poll_status:"+spender;
const pollWindowKey=spender=>"spender_poll_window:"+spender;
async function savePollState(db,spender,details){
  await db.prepare("INSERT INTO runtime_state(key,value,updated_at) VALUES(?,?,CURRENT_TIMESTAMP) ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=CURRENT_TIMESTAMP")
    .bind(pollStatusKey(spender),JSON.stringify(details)).run();
}
export async function pollSpenders(env){
  const head=await blockNumber(env);
  const {results:rules}=await env.DB.prepare("SELECT * FROM spender_rules WHERE enabled=1 ORDER BY cursor_block ASC LIMIT 40").all();
  for(const rule of rules||[]){
    let cursor=Number(rule.cursor_block);
    const [saved,providerState]=await Promise.all([
      env.DB.prepare("SELECT value FROM runtime_state WHERE key=?").bind(pollWindowKey(rule.spender)).first(),
      env.DB.prepare("SELECT value FROM runtime_state WHERE key=?").bind("spender_poll_provider:"+rule.spender).first()
    ]);
    let preferBackup=providerState?.value==="etherscan";
    let window=Number(saved?.value||32);
    if(!Number.isSafeInteger(window)||window<1||window>256)window=32;
    let attempted=0;
    for(let cycle=0;cycle<8&&cursor<head;cycle++){
      const from=cursor+1,to=Math.min(head,from+window-1);
      let logs,provider;
      try{
        ({logs,provider}=await fetchApprovalLogs(env,rule.spender,from,to,preferBackup));
      }catch(e){
        const reason=String(e.message||e).slice(0,220);
        if(window>1){
          window=Math.max(1,Math.floor(window/2));
          await env.DB.prepare("INSERT INTO runtime_state(key,value,updated_at) VALUES(?,?,CURRENT_TIMESTAMP) ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=CURRENT_TIMESTAMP").bind(pollWindowKey(rule.spender),String(window)).run();
          // The rejected range has not advanced the cursor; retry a smaller
          // range immediately, without consuming a successful cycle.
          cycle--;
          attempted++;
          if(attempted<9)continue;
        }
        await savePollState(env.DB,rule.spender,{status:"error",stage:"eth_getLogs",cursor,head,window,message:reason,at:now()});
        console.error("Spender polling RPC error",rule.spender,reason);
        break;
      }
      try{
        for(const log of logs){
          if(log.removed)continue;
          await processApproval(env,rule,log);
        }
        await env.DB.prepare("UPDATE spender_rules SET cursor_block=? WHERE spender=? AND cursor_block<?").bind(to,rule.spender,to).run();
        cursor=to;
        if(provider==="etherscan"&&!preferBackup)preferBackup=true;
        await env.DB.prepare("INSERT INTO runtime_state(key,value,updated_at) VALUES(?,?,CURRENT_TIMESTAMP) ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=CURRENT_TIMESTAMP").bind("spender_poll_provider:"+rule.spender,provider).run();
        window=Math.min(256,Math.max(8,window*2));
        await env.DB.prepare("INSERT INTO runtime_state(key,value,updated_at) VALUES(?,?,CURRENT_TIMESTAMP) ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=CURRENT_TIMESTAMP").bind(pollWindowKey(rule.spender),String(window)).run();
        await savePollState(env.DB,rule.spender,{status:"ok",cursor,head,window,provider,events:logs.length,at:now()});
      }catch(e){
        const reason=String(e.message||e).slice(0,220);
        await savePollState(env.DB,rule.spender,{status:"error",stage:"processApproval",cursor,head,window,message:reason,at:now()});
        console.error("Spender approval processing failed",rule.spender,reason);
        break;
      }
    }
  }
}
async function processApproval(env,rule,log){
  const owner=fromTopic(log.topics?.[1]);if(!owner)return;
  const ok=await receiptSuccess(env,log.transactionHash);
  // A missing receipt is a transient RPC/indexing race, not a failed transaction.
  // Retrying this block is essential: advancing the cursor here loses approvals.
  if(ok===null)throw Error("Transaction receipt is not indexed yet; retry this block");
  if(ok===false)return;
  const amount=await allowance(env,owner,rule.spender);
  await recordSpenderLiveApproval(env,rule.spender,log,amount);
  // Keep an archival event, but do not restore monitoring for a manually removed wallet.
  const manuallyExcluded=await env.DB.prepare("SELECT 1 FROM wallet_exclusions WHERE address=?").bind(owner).first();
  const walletRecord=await env.DB.prepare("SELECT deleted_at FROM wallets WHERE address=?").bind(owner).first();
  if(manuallyExcluded||walletRecord?.deleted_at)return;
  const previous=await env.DB.prepare("SELECT amount_raw FROM allowances WHERE owner=? AND spender=?").bind(owner,rule.spender).first();
  const before=BigInt(previous?.amount_raw||"0");
  const evId="approval:"+log.transactionHash+":"+log.logIndex;
  // Replay the original classification when the event was recorded but the
  // outbox insert failed. Recomputing against the updated allowances row
  // would silently turn a genuine new approval into "unchanged".
  const eventRecord=await env.DB.prepare("SELECT event_type FROM approval_events WHERE event_id=?").bind(evId).first();
  const type=eventRecord?.event_type||(amount===0n?"revoked":!previous?"new":before===0n?"reauthorized":amount>before?"increased":amount<before?"decreased":"unchanged");
  await env.DB.prepare("INSERT OR IGNORE INTO approval_events(event_id,owner,spender,amount_raw,block_number,tx_hash,event_type) VALUES(?,?,?,?,?,?,?)")
   .bind(evId,owner,rule.spender,amount.toString(),Number(BigInt(log.blockNumber)),log.transactionHash,type).run();
  await env.DB.prepare("INSERT INTO allowances(owner,spender,amount_raw,first_seen_block,latest_block) VALUES(?,?,?,?,?) ON CONFLICT(owner,spender) DO UPDATE SET amount_raw=excluded.amount_raw,latest_block=excluded.latest_block,updated_at=CURRENT_TIMESTAMP")
   .bind(owner,rule.spender,amount.toString(),Number(BigInt(log.blockNumber)),Number(BigInt(log.blockNumber))).run();
  const registered=await env.DB.prepare("SELECT state FROM wallet_watches WHERE address=?").bind(owner).first();
  if(amount>0n && (type==="new"||type==="reauthorized")){
    await env.DB.prepare("INSERT OR IGNORE INTO wallets(address,discovery_source) VALUES(?,'spender')").bind(owner).run();
    const {results:routes}=await env.DB.prepare("SELECT chat_id FROM spender_routes WHERE spender=?").bind(rule.spender).all();
    for(const route of routes||[]){
      const chat=String(route.chat_id);
      const exists=await env.DB.prepare("SELECT 1 FROM telegram_chats WHERE chat_id=?").bind(chat).first();
      if(!exists)continue;
      const remark=await walletRemark(env,owner,"待备注 · "+short(owner));
      await env.DB.prepare("INSERT OR IGNORE INTO subscriptions(chat_id,address,remark,status) VALUES(?,?,?,'pending')").bind(chat,owner,remark).run();
    }
    let watched=registered?.state==="active";
    if(!watched){
      try{watched=await ensureWatch(env,owner,Number(BigInt(log.blockNumber)));}
      catch(watchError){
        // The approval notification is independent from Alchemy enrollment.
        // The pending-wallet cron will retry enrollment automatically.
        console.warn("Approval Owner monitor pending",owner,String(watchError));
      }
    }
    if(watched)await env.DB.prepare("UPDATE subscriptions SET status='active' WHERE address=? AND status='pending'").bind(owner).run();
    for(const route of routes||[])await queueNotice(env,{
      dedup:evId+":"+route.chat_id,chat_id:route.chat_id,address:owner,template:"new_approval",
      payload:{owner,spender:rule.spender,spender_remark:rule.remark,amount:formatUnits(amount,6)+" USDT",tx_hash:log.transactionHash,watch_status:watched?"active":"pending"}
    });
    if(!registered)await increment(env,"discovered_wallets");
  } else if(type!=="unchanged") {
    const {results:routes}=await env.DB.prepare("SELECT chat_id FROM spender_routes WHERE spender=?").bind(rule.spender).all();
    for(const route of routes||[])await queueNotice(env,{
      dedup:evId+":"+route.chat_id,chat_id:route.chat_id,address:owner,template:"approval_change",
      payload:{owner,spender:rule.spender,spender_remark:rule.remark,amount:formatUnits(amount,6)+" USDT",event_type:type,tx_hash:log.transactionHash}
    });
  }
}
