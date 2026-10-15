// @ts-nocheck
import {now,addr} from "./core";

// Every wallet has one administrator-controlled display name across all Telegram groups.
// Keep first_user_name untouched: it records the original human query author.
export async function walletRemark(env,address,fallback=""){
  const row=await env.DB.prepare("SELECT remark FROM wallet_global_remarks WHERE address=?").bind(address).first();
  if(row?.remark)return row.remark;
  const existing=await env.DB.prepare("SELECT remark FROM subscriptions WHERE address=? ORDER BY updated_at DESC LIMIT 1").bind(address).first();
  return existing?.remark||fallback;
}
export async function saveWalletRemark(env,address,value){
  const a=addr(address),remark=String(value??"").trim();
  if(!a||!remark||Array.from(remark).length>80||/[\u0000-\u001f\u007f]/.test(remark))throw Error("备注不能为空、最多80个字符，且不能包含控制字符");
  await env.DB.batch([
    env.DB.prepare("INSERT INTO wallet_global_remarks(address,remark,updated_at) VALUES(?,?,?) ON CONFLICT(address) DO UPDATE SET remark=excluded.remark,updated_at=excluded.updated_at").bind(a,remark,now()),
    env.DB.prepare("UPDATE subscriptions SET remark=?,remark_version=remark_version+1,updated_at=? WHERE address=?").bind(remark,now(),a)
  ]);
  return remark;
}
