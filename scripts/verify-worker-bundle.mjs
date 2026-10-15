#!/usr/bin/env node
// This checks the ACTUAL deployable bundle, not just TypeScript source files.
// Missing helper modules once silently disabled historical wallet monitoring.
import {readFileSync} from "node:fs";
import {resolve} from "node:path";

const filename=resolve(process.argv[2]||"build/worker.mjs");
const bundle=readFileSync(filename,"utf8");
const required=[
 ["wallet remark lookup",/async function walletRemark\s*\(/],
 ["wallet remark write",/async function saveWalletRemark\s*\(/],
 ["historical approval scanner",/async function scanSpenderHistories\s*\(/],
 ["historical allowance verification",/async function verifyHistoricalAllowances\s*\(/],
 ["historical monitor enrollment",/async function enrollHistoricalOwners\s*\(/],
 ["monitor enrollment backoff",/spender_enroll_retry_after/],
 ["monitor enrollment candidate selection",/async function selectEnrollmentCandidates\s*\(/],
 ["Alchemy remote address reconciliation",/async function maybeReconcileAlchemy\s*\(/],
 ["Alchemy pending-removal retry",/async function retryPendingWatchRemovals\s*\(/],
 ["subscription source attribution",/function sourceInsert\s*\(/],
 ["generation-fenced history writer",/function generationValid\s*\(/],
 ["legacy provenance review",/async function listLegacySubscriptions\s*\(/],
 ["safe Spender route source cleanup",/function removeSpenderRouteSourceStatements\s*\(/],
 ["administrator failed-notification retry",/async function requeueFailedOutbox\s*\(/],
 ["live approval monitor",/async function pollSpenders\s*\(/],
 ["transfer processing",/async function processActivity\s*\(/],
 ["Telegram outbox",/async function flushOutbox\s*\(/],
 ["stuck message recovery",/async function recoverStuck\s*\(/],
 ["admin server",/async function handleAdmin\s*\(/],
 ["admin frontend",/var ADMIN_HTML\s*=/],
 ["API for historical approvals",/\/api\/spenders\/history/],
 ["API for monitored wallets",/\/api\/monitoring/],
 ["Ethereum activity callback",/\/webhooks\/alchemy/],
 ["Telegram callback",/\/webhooks\/telegram/],
 ["Worker scheduled entrypoint",/async scheduled\s*\(/]
];
const missing=required.filter(([,pattern])=>!pattern.test(bundle)).map(([name])=>name);
if(missing.length){
 console.error("Bundle integrity check failed: missing "+missing.join(", "));
 process.exitCode=1;
}else{
 console.log("Verified all "+required.length+" critical features in "+filename+" ("+bundle.length+" chars)");
}
