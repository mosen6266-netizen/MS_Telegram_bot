// Pure scheduling policy for periodic RPC gap recovery.
// The realtime Alchemy Webhook and immediate Telegram queue are unaffected.
// With 297 wallets, five checks per 2-minute tick provide a normal sweep
// in roughly two hours. The larger block window keeps cursors caught up.
// If the oldest eligible wallet lags by 900+ blocks, restore the original
// eight-wallet rate until backlog is reduced.
export const NORMAL_RECOVERY_BATCH = 5;
export const RECOVERY_BACKLOG_THRESHOLD_BLOCKS = 900;
export const RECOVERY_SPAN_BLOCKS = 1200;

export function recoveryScanSize(maxWallets: number, chainHead: number, oldestBlock: number, webhookHealthy = true) {
  const limit = Math.max(0, Math.floor(Number(maxWallets) || 0));
  if (!webhookHealthy) return limit; // Backfill at full original rate if realtime status is unknown or unhealthy.\n  const lag = Number(chainHead) - Number(oldestBlock);
  return Number.isFinite(lag) && lag >= RECOVERY_BACKLOG_THRESHOLD_BLOCKS
    ? limit
    : Math.min(limit, NORMAL_RECOVERY_BATCH);
}

export function recoveryEndBlock(lastBlock: number, chainHead: number) {
  return Math.min(chainHead, lastBlock + RECOVERY_SPAN_BLOCKS);
}

export function recentlyVerifiedWebhook(report: { status?: string; checked_at?: string }, nowMs: number) {
  if (!report || !["verified", "repaired"].includes(String(report.status))) return false;
  const checked = Date.parse(String(report.checked_at || ""));
  return Number.isFinite(checked) && nowMs >= checked && nowMs - checked <= 2 * 60 * 60 * 1000;
}
