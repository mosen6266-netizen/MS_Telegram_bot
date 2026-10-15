// @ts-nocheck
// Shared D1 lease across create / add / remove mutations and Spender deletion.
// Expiry is intentionally much longer than an HTTP call. It is a fallback
// for abandoned Workers, not permission to overlap still-running requests.
const LEASE_KEY="alchemy_mutation_lease";
const DEFAULT_TTL_MS=180000;

export class AlchemyMutationBusy extends Error{
  constructor(){super("Alchemy 地址变更正在进行，请稍后重试");this.code="ALCHEMY_MUTATION_BUSY";}
}
export async function withAlchemyMutationLease(env,work,{ttlMs=DEFAULT_TTL_MS,clock=()=>Date.now()}={}){
  const token=crypto.randomUUID(),started=clock();
  const value=String(started+ttlMs)+"|"+token;
  const acquired=await env.DB.prepare(
    "INSERT INTO runtime_state(key,value,updated_at) VALUES(?,?,CURRENT_TIMESTAMP) "+
    "ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=CURRENT_TIMESTAMP "+
    "WHERE CAST(substr(runtime_state.value,1,instr(runtime_state.value,'|')-1) AS INTEGER)<=?"
  ).bind(LEASE_KEY,value,started).run();
  if(!acquired.meta?.changes)throw new AlchemyMutationBusy();
  try{return await work();}
  finally{
    // A timed-out predecessor must never release a lease already claimed by
    // another invocation after the safety TTL.
    await env.DB.prepare("DELETE FROM runtime_state WHERE key=? AND value=?").bind(LEASE_KEY,value).run();
  }
}
export function alchemyMutationFetch(url,options){
  // Abort within the lease window, even if Alchemy or the network stalls.
  return fetch(url,{...options,signal:AbortSignal.timeout(25000)});
}
