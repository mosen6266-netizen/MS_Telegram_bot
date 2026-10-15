import test from "node:test";
import assert from "node:assert/strict";
import {readFileSync} from "node:fs";

test("queue exhausted-retry handler can use the configured secrets and clean temporary messages",()=>{
 const src=readFileSync("src/index.ts","utf8");
 const i=src.indexOf("  async queue(batch,env,ctx){"),j=src.indexOf("  async scheduled(",i);
 assert.ok(i>=0&&j>i);
 const queue=src.slice(i,j);
 assert.match(queue,/let configured=env;\s*try\{/);
 assert.match(queue,/configured=await configEnv\(env\);/);
 assert.doesNotMatch(queue,/const configured=await configEnv/);
 assert.match(queue,/catch\(e\)\{[\s\S]*await finishAddressQueryCleanup\(configured,item\)/);
});
test("notification retry threshold includes the current attempt, not the stale selected row",()=>{
 const src=readFileSync("src/notifications.ts","utf8");
 assert.match(src,/UPDATE outbox SET state='sending',attempts=attempts\+1/);
 assert.match(src,/if\(row\.attempts\+1>=5&&row\.template_key!=="usage_alert"\)/);
});
