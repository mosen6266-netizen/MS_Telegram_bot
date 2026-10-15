import test from "node:test";
import assert from "node:assert/strict";
import {readFileSync} from "node:fs";
import {validateStagingConfig} from "../scripts/verify-staging-config.mjs";

const prod=JSON.parse(readFileSync("wrangler.jsonc","utf8"));
const template=JSON.parse(readFileSync("wrangler.staging.example.jsonc","utf8"));
const distinct=()=>JSON.parse(JSON.stringify({
 ...template,
 d1_databases:[{...template.d1_databases[0],database_id:"11111111-2222-3333-4444-555555555555"}],
 vars:{...template.vars,PUBLIC_BASE_URL:"https://ethereum-usdt-monitor-staging.example.workers.dev"}
}));
test("staging template is deliberately not deployable until distinct resources are provisioned",()=>{
 assert.match(validateStagingConfig(template,prod).join(" "),/独立预发布 D1|真实 UUID/);
 assert.ok(validateStagingConfig(template,prod).length>0);
});
test("isolation validator accepts distinct credentials-free staging bindings",()=>{
 assert.deepEqual(validateStagingConfig(distinct(),prod),[]);
});
test("staging guard blocks production D1, Worker name, queues, callback URL and Cron",()=>{
 const badD1=distinct();badD1.d1_databases[0].database_id=prod.d1_databases[0].database_id;
 assert.match(validateStagingConfig(badD1,prod).join(" "),/D1/);
 const badWorker=distinct();badWorker.name=prod.name;
 assert.match(validateStagingConfig(badWorker,prod).join(" "),/Worker/);
 const badQueue=distinct();badQueue.queues.producers[0].queue=prod.queues.producers[0].queue;
 assert.match(validateStagingConfig(badQueue,prod).join(" "),/Queue/);
 const badUrl=distinct();badUrl.vars.PUBLIC_BASE_URL=prod.vars.PUBLIC_BASE_URL;
 assert.match(validateStagingConfig(badUrl,prod).join(" "),/PUBLIC_BASE_URL|回调域名/);
 const badCron=distinct();badCron.triggers.crons=["*/2 * * * *"];
 assert.match(validateStagingConfig(badCron,prod).join(" "),/Cron/);
});
test("staging configuration refuses plaintext provider credentials",()=>{
 const bad=distinct();bad.vars.TELEGRAM_BOT_TOKEN="example-token";
 assert.match(validateStagingConfig(bad,prod).join(" "),/TELEGRAM_BOT_TOKEN/);
});
