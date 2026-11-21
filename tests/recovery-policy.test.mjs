import test from "node:test";
import assert from "node:assert/strict";
import {
  recoveryScanSize, recoveryEndBlock, recentlyVerifiedWebhook,
  NORMAL_RECOVERY_BATCH,
  RECOVERY_BACKLOG_THRESHOLD_BLOCKS
} from "../src/recovery-policy.ts";

test("healthy scan uses bounded five-wallet budget", () => {
  assert.equal(NORMAL_RECOVERY_BATCH, 5);
  assert.equal(recoveryScanSize(8, 26464000, 26463348), 5);
  assert.equal(recoveryScanSize(2, 26464000, 26463348), 2);
  assert.equal(recoveryScanSize(0, 26464000, 26463348), 0);
});

test("backlog immediately restores pre-optimization recovery throughput", () => {
  assert.equal(RECOVERY_BACKLOG_THRESHOLD_BLOCKS, 900);
  assert.equal(recoveryScanSize(8, 26464000, 26463100), 8);
  assert.equal(recoveryScanSize(8, 26464000, 26463101), 5);
});

test("unhealthy or stale webhook preserves original eight-wallet scan", () => {
  assert.equal(recoveryScanSize(8, 26464000, 26463990, false), 8);
  const now=Date.parse("2026-11-21T22:15:00Z");
  assert.equal(recentlyVerifiedWebhook({status:"verified",checked_at:"2026-11-21T21:45:00Z"},now),true);
  assert.equal(recentlyVerifiedWebhook({status:"error",checked_at:"2026-11-21T21:45:00Z"},now),false);
  assert.equal(recentlyVerifiedWebhook({status:"verified",checked_at:"2026-11-21T18:45:00Z"},now),false);
});

test("recovery spans cover the normal full-sweep gap and retain catchup", () => {
  assert.equal(recoveryEndBlock(26463348, 26464000), 26464000);
  assert.equal(recoveryEndBlock(26462000, 26464000), 26463200);
  assert.ok(recoveryEndBlock(26462000, 26464000) <= 26464000);
});

test("normal wallet sweep stays within recovery window at 297 addresses", () => {
  const wallets=297, perTick=5, minutesPerTick=2, secondsPerBlock=12;
  const maxSweepBlocks=Math.ceil(wallets/perTick)*minutesPerTick*60/secondsPerBlock;
  assert.ok(maxSweepBlocks < 900, "the fallback can catch up before activating backlog boost");
});
