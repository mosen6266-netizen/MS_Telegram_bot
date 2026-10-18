import test from "node:test";
import assert from "node:assert/strict";
import {readFileSync} from "node:fs";
const index=readFileSync(new URL("../src/index.ts",import.meta.url),"utf8");
const ui=readFileSync(new URL("../src/admin-ui.ts",import.meta.url),"utf8");
const gateway=readFileSync(new URL("../signal-cloud-runtime/worker.mjs",import.meta.url),"utf8");
test("Signal is gated by existing admin auth and a private service binding",()=>{
 assert.match(index,/if\(path\.startsWith\("\/api\/signal\/"\)\)/);
 assert.match(index,/if\(!await isAdmin\(req,env\)\)/);
 assert.match(index,/env\.SIGNAL_RUNTIME\.fetch/);
});
test("Telegram webhook and outbox still have their original routes",()=>{
 assert.match(index,/path==="\/webhooks\/telegram"/);
 assert.match(index,/path==="\/webhooks\/alchemy"/);
 assert.match(index,/flushOutbox\(configured,20\)/);
 assert.match(index,/async queue\(batch,env,ctx\)/);
 assert.doesNotMatch(index,/flushOutbox\([^)]*signal/i);
});
test("admin Signal control is a real QR data image, never a fake sample",()=>{
 assert.match(ui,/\/api\/signal\/link/);
 assert.match(ui,/data:image\/png;base64,/);
 assert.match(ui,/\/api\/signal\/groups-selection/);
 assert.match(index,/img-src 'self' data:/);
});
test("signal runtime has independent persistent snapshots and no Telegram credentials",()=>{
 assert.match(gateway,/snapshotContainer/);
 assert.match(gateway,/getByName\("primary"\)/);
 assert.match(gateway,/startLink/);
 assert.match(gateway,/finishLink/);
 assert.doesNotMatch(gateway,/TELEGRAM_BOT_TOKEN|ADMIN_TELEGRAM_CHAT_ID|ALCHEMY_NOTIFY_TOKEN/);
});
