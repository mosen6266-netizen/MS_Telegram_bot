// @ts-nocheck
// Consistent, bounded D1 pagination for large administrator lists.
const validStatuses=["all","active","paused","pending","removed"];

function pageArgs(opts={}){
 const page=Math.max(0,Math.min(100000,Number.parseInt(String(opts.page??0),10)||0));
 const search=String(opts.search||"").trim().slice(0,100);
 return {page,search,offset:page*50};
}
async function runPage(db,{countSql,selectSql,params,page}){
 const [countResult,rowsResult]=await db.batch([
  db.prepare(countSql).bind(...params),
  db.prepare(selectSql).bind(...params,page*50)
 ]);
 const total=countResult.results?.[0]?.n||0;
 return {rows:rowsResult.results||[],page,total,total_pages:Math.ceil(total/50)};
}
export async function listWalletsPage(db,options={}){
 const {page,search}=pageArgs(options);
 const from=" FROM wallets w LEFT JOIN wallet_watches ww ON ww.address=w.address "+
  "LEFT JOIN wallet_global_remarks g ON g.address=w.address ";
 const filter=search?"WHERE instr(lower(w.address),lower(?))>0 "+
  "OR instr(lower(COALESCE(g.remark,'')),lower(?))>0 "+
  "OR instr(lower(COALESCE(w.first_user_name,'')),lower(?))>0":"";
 const params=search?[search,search,search]:[];
 return runPage(db,{page,params,countSql:"SELECT COUNT(*) n"+from+filter,
  selectSql:"SELECT w.address,w.first_user_name,w.discovery_source,w.created_at,w.deleted_at,ww.state watch_state,"+
    "COALESCE(g.remark,(SELECT s.remark FROM subscriptions s WHERE s.address=w.address ORDER BY updated_at DESC LIMIT 1),w.first_user_name) remark"+
    from+filter+" ORDER BY w.created_at DESC,w.address DESC LIMIT 50 OFFSET ?"});
}
export async function listSubscriptionsPage(db,options={}){
 const {page,search}=pageArgs(options),status=String(options.status||"all");
 if(!validStatuses.includes(status))return {error:"invalid_status",status:400};
 const from=" FROM subscriptions s LEFT JOIN telegram_chats c ON c.chat_id=s.chat_id ";
 const predicates=[],params=[];
 if(status!=="all"){predicates.push("s.status=?");params.push(status)}
 if(search){
  predicates.push("(instr(lower(s.address),lower(?))>0 OR instr(cast(s.chat_id AS TEXT),?)>0 "+
    "OR instr(lower(COALESCE(c.title,'')),lower(?))>0 OR instr(lower(COALESCE(s.remark,'')),lower(?))>0)");
  params.push(search,search,search,search);
 }
 const where=predicates.length?" WHERE "+predicates.join(" AND "):"";
 return runPage(db,{page,params,countSql:"SELECT COUNT(*) n"+from+where,
   selectSql:"SELECT s.chat_id,s.address,s.remark,s.status,s.updated_at,c.title"+from+where+
     " ORDER BY s.updated_at DESC,s.chat_id DESC,s.address DESC LIMIT 50 OFFSET ?"});
}
export async function listAuditPage(db,options={}){
 const {page,search}=pageArgs(options);
 const filter=search?" WHERE instr(lower(actor),lower(?))>0 OR instr(lower(action),lower(?))>0 OR instr(lower(target),lower(?))>0":"";
 const params=search?[search,search,search]:[];
 return runPage(db,{page,params,countSql:"SELECT COUNT(*) n FROM admin_audit"+filter,
  selectSql:"SELECT id,actor,action,target,created_at FROM admin_audit"+filter+
    " ORDER BY id DESC LIMIT 50 OFFSET ?"});
}

export async function listTransfersPage(db,options={}){
 const {page,search}=pageArgs(options),asset=String(options.asset||"all").toUpperCase();
 if(!["ALL","ETH","USDT","USDC"].includes(asset))return {error:"invalid_asset",status:400};
 const predicates=[],params=[];
 if(asset!=="ALL"){predicates.push("asset=?");params.push(asset)}
 if(search){
  predicates.push("(instr(lower(address),lower(?))>0 OR instr(lower(tx_hash),lower(?))>0)");
  params.push(search,search);
 }
 const where=predicates.length?" WHERE "+predicates.join(" AND "):"";
 return runPage(db,{page,params,countSql:"SELECT COUNT(*) n FROM transfer_events"+where,
  selectSql:"SELECT event_id,address,asset,direction,raw_amount,block_number,tx_hash FROM transfer_events"+where+
    " ORDER BY block_number DESC,event_id DESC LIMIT 50 OFFSET ?"});
}
