import test from "node:test";
import assert from "node:assert/strict";
import {readFileSync} from "node:fs";
test("mainnet-only contracts and 80% / 7-day alert defaults",()=>{
  const core=readFileSync("src/core.ts","utf8");
  const wrangler=readFileSync("wrangler.jsonc","utf8");
  assert.match(core,/0xdac17f958d2ee523a2206206994597c13d831ec7/);
  assert.match(core,/0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48/);
  assert.match(wrangler,/"USAGE_ALERT_PERCENT": "80"/);
  assert.match(wrangler,/"USAGE_FORECAST_DAYS": "7"/);
});
test("no production tokens committed in env example",()=>{
  const example=readFileSync(".env.example","utf8");
  assert.match(example,/TELEGRAM_BOT_TOKEN=\n/);
  assert.match(example,/ALCHEMY_SIGNING_KEY=\n/);
});
test("reverse monitoring never subscribes spender as an Owner by default",()=>{
  const code=readFileSync("src/approval.ts","utf8");
  assert.match(code,/ensureWatch\(env,owner\)/);
  assert.doesNotMatch(code,/ensureWatch\(env,rule\.spender\)/);
});
