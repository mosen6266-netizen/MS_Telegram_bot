// @ts-nocheck
import {processActivity} from "./transfers";

// Persist chain events only after ordinary queue retries are exhausted.
// Uses the existing D1 runtime_state table, so no destructive migration or
// queue binding change is required. Records remain until replay succeeds.
const PREFIX="failed_activity:";
function storageKey(bytes){
  return crypto.subtle.digest("SHA-256",new TextEncoder().encode(bytes)).then(buffer=>
    PREFIX+[...new Uint8Array(buffer)].map(x=>x.toString(16).padStart(2,"0")).join(""));
}
export async function retainFailedActivity(env,payload,error){
  const encoded=JSON.stringify(payload);
  if(!encoded||encoded==="null")throw Error("Missing activity payload");
  const key=await storageKey(encoded);
  const content=JSON.stringify({payload,attempts:0,next_at:0,last_error:String(error||"unknown").slice(0,240),saved_at:new Date().toISOString()});
  await env.DB.prepare("INSERT OR IGNORE INTO runtime_state(key,value,updated_at) VALUES(?,?,CURRENT_TIMESTAMP)")
    .bind(key,content).run();
  return key;
}
export async function replayFailedActivities(env,max=3){
  const db=env.DB;
  const {results:rows}=await db.prepare(
    "SELECT key,value FROM runtime_state WHERE key LIKE 'failed_activity:%' ORDER BY updated_at ASC LIMIT 30"
  ).all();
  let checked=0,recovered=0;
  for(const row of rows||[]){
    if(checked>=max)break;
    let record;
    try{record=JSON.parse(row.value)}catch(e){
      // Malformed records are retained for investigation, never discarded.
      console.error("Stored activity replay payload unreadable",row.key);
      continue;
    }
    if(!record?.payload||Number(record.next_at||0)>Date.now())continue;
    checked++;
    try{
      await processActivity(env,record.payload);
      await db.prepare("DELETE FROM runtime_state WHERE key=?").bind(row.key).run();
      recovered++;
    }catch(e){
      const attempts=Math.max(0,Number(record.attempts)||0)+1;
      const delay=Math.min(6*60*60*1000,60*1000*Math.pow(2,Math.min(attempts,8)));
      const updated={...record,attempts,next_at:Date.now()+delay,last_error:String(e.message||e).slice(0,240)};
      await db.prepare("UPDATE runtime_state SET value=?,updated_at=CURRENT_TIMESTAMP WHERE key=?")
        .bind(JSON.stringify(updated),row.key).run();
      console.warn("Stored activity replay deferred",row.key,updated.last_error);
    }
  }
  return {checked,recovered};
}
