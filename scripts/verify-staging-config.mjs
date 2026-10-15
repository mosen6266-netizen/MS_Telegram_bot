#!/usr/bin/env node
// Production safety gate: no deployment or migration is performed here.
// Run with a SEPARATELY provisioned staging configuration after replacing
// placeholders; this command fails closed on production resource overlaps.
import {readFileSync} from "node:fs";
import {resolve} from "node:path";
import {pathToFileURL} from "node:url";

export function validateStagingConfig(staging,production){
  const problems=[];
  const fail=(condition,message)=>{if(condition)problems.push(message)};
  const name=String(staging?.name||"");
  fail(!/staging|preprod|sandbox/.test(name),"独立 Worker 名称必须明确包含 staging/preprod/sandbox");
  fail(!name||name===production?.name,"预发布 Worker 与正式 Worker 不能重名");
  const sd=staging?.d1_databases?.find(x=>x.binding==="DB");
  const pd=production?.d1_databases?.find(x=>x.binding==="DB");
  const uuid=/^[a-f\d]{8}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{12}$/i;
  fail(!sd||!uuid.test(String(sd.database_id||"")),"先创建独立预发布 D1 并填写真实 UUID");
  fail(!!sd&&!!pd&&(sd.database_id===pd.database_id||sd.database_name===pd.database_name),
    "预发布 D1 不得与正式数据库共用 ID 或名称");
  const queueNames=config=>[
    ...(config?.queues?.producers||[]).map(x=>x.queue),
    ...(config?.queues?.consumers||[]).flatMap(x=>[x.queue,x.dead_letter_queue].filter(Boolean))
  ];
  const prodQueues=new Set(queueNames(production));
  const stageQueues=queueNames(staging);
  fail(!stageQueues.length,"预发布必须拥有独立队列与死信队列");
  fail(stageQueues.some(x=>!x||prodQueues.has(x)),"预发布 Queue 或 DLQ 与正式队列重名");
  fail(!stageQueues.some(x=>/staging|preprod|sandbox/.test(x)),"预发布 Queue 名称应标明 staging/preprod/sandbox");
  fail((staging?.triggers?.crons||[]).length!==0,"首次隔离验收前必须禁用 Cron 防止意外触发外部扫描");
  const base=String(staging?.vars?.PUBLIC_BASE_URL||"");
  const live=String(production?.vars?.PUBLIC_BASE_URL||"");
  let parsed;try{parsed=new URL(base)}catch{}
  fail(!parsed||parsed.protocol!=="https:"||!parsed.hostname.includes("staging")&&
    !parsed.hostname.includes("preprod")&&!parsed.hostname.includes("sandbox"),
    "PUBLIC_BASE_URL 必须为真实独立 HTTPS 预发布域名");
  fail(!!base&&!!live&&base===live,"回调域名不能使用正式 Worker");
  fail(/REPLACE_|example\.invalid|localhost/i.test(base),"预发布回调域名不可包含占位符");
  fail(staging?.vars?.NETWORK!=="ETH_MAINNET","网络只能为 ETH_MAINNET");
  for(const key of ["APP_ENCRYPTION_KEY","TELEGRAM_BOT_TOKEN","ALCHEMY_NOTIFY_TOKEN",
    "ALCHEMY_RPC_URL","ALCHEMY_ACTIVITY_WEBHOOK_ID","ALCHEMY_SIGNING_KEY","INIT_SETUP_CODE"]){
    fail(Object.prototype.hasOwnProperty.call(staging?.vars||{},key),"密钥或 RPC 凭证禁止写在配置 vars 中："+key);
  }
  return problems;
}
if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href){
  const candidate=process.argv[2];
  if(!candidate){console.error("Usage: node scripts/verify-staging-config.mjs <dedicated-staging-config.jsonc>");process.exit(2)}
  try{
    const staging=JSON.parse(readFileSync(candidate,"utf8"));
    const prod=JSON.parse(readFileSync("wrangler.jsonc","utf8"));
    const errors=validateStagingConfig(staging,prod);
    if(errors.length){for(const error of errors)console.error("BLOCKED:",error);process.exitCode=1}
    else console.log("Staging resource separation validated. This does NOT deploy anything.");
  }catch(error){console.error("Staging config invalid:",String(error));process.exitCode=1}
}
