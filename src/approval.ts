// @ts-nocheck
import {USDT,APPROVAL_TOPIC,addr,toTopic,fromTopic,allowance,blockNumber,rpc,formatUnits,esc,short,send,buttons,queueNotice,ensureWatch,increment,receiptSuccess,now} from "./core";

// Etherscan V2 log indexing is essential for discovery. No 'no approval' claim is made on incomplete scans.
export async function ownerSpenders(env,owner){
  if(!env.ETHERSCAN_API_KEY)throw Error("ETHERSCAN_API_KEY required for complete historical spender discovery");
  const found=new Set();
  for(let page=1;page<=10;page++){
    const q=new URLSearchParams({chainid:"1",module:"logs",action:"getLogs",address:USDT,
      topic0:APPROVAL_TOPIC,topic1:toTopic(owner),topic0_1_opr:"and",fromBlock:"0",toBlock:"latest",
      page:String(page),offset:"1000",apikey:env.ETHERSCAN_API_KEY});
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
    await send(env,chat_id,"🔎 <b>USDT 授权核验完成</b>\n地址：<code>"+owner+"</code>\n未发现当前有效授权，因此未自动启动资金监控。");
    return;
  }
  await env.DB.prepare("INSERT OR IGNORE INTO wallets(address,first_user_id,first_user_name,discovery_source) VALUES(?,?,?,'manual')")
    .bind(owner,String(user_id),display_name).run();
  await env.DB.prepare("UPDATE wallets SET first_user_id=?,first_user_name=? WHERE address=? AND first_user_id IS NULL")
    .bind(String(user_id),display_name,owner).run();
  const first=await env.DB.prepare("SELECT first_user_name FROM wallets WHERE address=?").bind(owner).first();
  await env.DB.prepare("INSERT INTO subscriptions(chat_id,address,remark,status) VALUES(?,?,?,'pending') ON CONFLICT(chat_id,address) DO UPDATE SET status=CASE WHEN status='removed' THEN 'pending' ELSE status END").bind(String(chat_id),owner,first?.first_user_name||display_name).run();
  const watched=await ensureWatch(env,owner);
  if(watched)await env.DB.prepare("UPDATE subscriptions SET status='active' WHERE chat_id=? AND address=? AND status='pending'").bind(String(chat_id),owner).run();
  const lines=positives.slice(0,25).map((x,i)=>(i+1)+". <code>"+x.spender+"</code>\n额度："+(BigInt(x.amount)>=(1n<<255n)?"无限":formatUnits(x.amount,6)+" USDT"));
  await send(env,chat_id,"🛡️ <b>USDT 有效授权</b>\n备注："+esc(first?.first_user_name||display_name)+"\n地址：<code>"+owner+"</code>\n"+
   lines.join("\n")+(positives.length>25?"\n另有 "+(positives.length-25)+" 项有效授权，请在后台查看。":"")+
   "\n资金监控："+(watched?"✅ ETH / USDT / USDC 已启动":"⚠️ 等待 Alchemy 订阅同步，尚未正式启动"),buttons(owner));
  await increment(env,"wallet_lookups");
}
export async function addSpender(env,spender,remark,chat_ids){
  const head=await blockNumber(env);
  await env.DB.prepare("INSERT INTO spender_rules(spender,remark,start_block,cursor_block) VALUES(?,?,?,?) ON CONFLICT(spender) DO UPDATE SET remark=excluded.remark,enabled=1").bind(spender,remark,head,head).run();
  for(const chat of chat_ids||[])await env.DB.prepare("INSERT OR IGNORE INTO spender_routes(spender,chat_id) VALUES(?,?)").bind(spender,String(chat)).run();
}
export async function pollSpenders(env){
  const head=await blockNumber(env);
  const {results:rules}=await env.DB.prepare("SELECT * FROM spender_rules WHERE enabled=1 ORDER BY cursor_block ASC LIMIT 40").all();
  for(const rule of rules||[]){
    const from=rule.cursor_block+1;
    const to=Math.min(head,from+499);
    if(from>to)continue;
    try {
      const logs=await rpc(env,"eth_getLogs",[{address:USDT,fromBlock:"0x"+from.toString(16),toBlock:"0x"+to.toString(16),topics:[APPROVAL_TOPIC,null,toTopic(rule.spender)]}]);
      for(const log of logs||[]){
        if(log.removed)continue;
        await processApproval(env,rule,log);
      }
      await env.DB.prepare("UPDATE spender_rules SET cursor_block=? WHERE spender=?").bind(to,rule.spender).run();
    }catch(e){console.error("Spender polling failed",rule.spender,String(e));}
  }
}
async function processApproval(env,rule,log){
  const owner=fromTopic(log.topics?.[1]);if(!owner)return;
  const ok=await receiptSuccess(env,log.transactionHash);if(ok!==true)return;
  const amount=await allowance(env,owner,rule.spender);
  const previous=await env.DB.prepare("SELECT amount_raw FROM allowances WHERE owner=? AND spender=?").bind(owner,rule.spender).first();
  const before=BigInt(previous?.amount_raw||"0");
  const evId="approval:"+log.transactionHash+":"+log.logIndex;
  const type=amount===0n?"revoked":!previous?"new":before===0n?"reauthorized":amount>before?"increased":amount<before?"decreased":"unchanged";
  await env.DB.prepare("INSERT OR IGNORE INTO approval_events(event_id,owner,spender,amount_raw,block_number,tx_hash,event_type) VALUES(?,?,?,?,?,?,?)")
   .bind(evId,owner,rule.spender,amount.toString(),Number(BigInt(log.blockNumber)),log.transactionHash,type).run();
  await env.DB.prepare("INSERT INTO allowances(owner,spender,amount_raw,first_seen_block,latest_block) VALUES(?,?,?,?,?) ON CONFLICT(owner,spender) DO UPDATE SET amount_raw=excluded.amount_raw,latest_block=excluded.latest_block,updated_at=CURRENT_TIMESTAMP")
   .bind(owner,rule.spender,amount.toString(),Number(BigInt(log.blockNumber)),Number(BigInt(log.blockNumber))).run();
  const registered=await env.DB.prepare("SELECT 1 FROM wallet_watches WHERE address=?").bind(owner).first();
  if(amount>0n && (!registered || !previous)){
    await env.DB.prepare("INSERT OR IGNORE INTO wallets(address,discovery_source) VALUES(?,'spender')").bind(owner).run();
    const {results:routes}=await env.DB.prepare("SELECT chat_id FROM spender_routes WHERE spender=?").bind(rule.spender).all();
    for(const route of routes||[]){
      const chat=String(route.chat_id);
      const exists=await env.DB.prepare("SELECT 1 FROM telegram_chats WHERE chat_id=?").bind(chat).first();
      if(!exists)continue;
      const remark="待备注 · "+short(owner);
      await env.DB.prepare("INSERT OR IGNORE INTO subscriptions(chat_id,address,remark,status) VALUES(?,?,?,'pending')").bind(chat,owner,remark).run();
    }
    const watched=await ensureWatch(env,owner);
    if(watched)await env.DB.prepare("UPDATE subscriptions SET status='active' WHERE address=? AND status='pending'").bind(owner).run();
    for(const route of routes||[])await queueNotice(env,{
      dedup:evId+":"+route.chat_id,chat_id:route.chat_id,address:owner,template:"new_approval",
      payload:{owner,spender:rule.spender,spender_remark:rule.remark,amount:formatUnits(amount,6)+" USDT",tx_hash:log.transactionHash,watch_status:watched?"active":"pending"}
    });
    await increment(env,"discovered_wallets");
  } else if(type!=="unchanged" && previous) {
    const {results:routes}=await env.DB.prepare("SELECT chat_id FROM spender_routes WHERE spender=?").bind(rule.spender).all();
    for(const route of routes||[])await queueNotice(env,{
      dedup:evId+":"+route.chat_id,chat_id:route.chat_id,address:owner,template:"approval_change",
      payload:{owner,spender:rule.spender,spender_remark:rule.remark,amount:formatUnits(amount,6)+" USDT",event_type:type,tx_hash:log.transactionHash}
    });
  }
}
