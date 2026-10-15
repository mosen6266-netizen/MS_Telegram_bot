-- Historical Ethereum Mainnet USDT Approval discovery by indexed Spender.
-- Re-running is safe. Existing live wallet notifications are not modified.
CREATE TABLE IF NOT EXISTS spender_history_jobs (
  spender TEXT PRIMARY KEY,
  next_block INTEGER NOT NULL DEFAULT 0,
  cutoff_block INTEGER NOT NULL,
  window_size INTEGER NOT NULL DEFAULT 200000,
  state TEXT NOT NULL DEFAULT 'scanning',
  events_found INTEGER NOT NULL DEFAULT 0,
  retry_count INTEGER NOT NULL DEFAULT 0,
  last_error TEXT,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  finished_at TEXT
);
CREATE TABLE IF NOT EXISTS spender_history_addresses (
  spender TEXT NOT NULL,
  owner TEXT NOT NULL,
  first_seen_block INTEGER NOT NULL,
  latest_event_block INTEGER NOT NULL,
  latest_tx_hash TEXT,
  last_event_amount_raw TEXT,
  current_allowance_raw TEXT,
  verify_status TEXT NOT NULL DEFAULT 'pending',
  verified_at TEXT,
  PRIMARY KEY (spender,owner)
);
CREATE INDEX IF NOT EXISTS idx_spender_history_pending ON spender_history_addresses(verify_status,latest_event_block);
CREATE INDEX IF NOT EXISTS idx_spender_history_order ON spender_history_addresses(spender,latest_event_block DESC);
-- Automatically schedule backfill for Spenders registered before this migration.
INSERT OR IGNORE INTO spender_history_jobs(spender,next_block,cutoff_block,window_size,state)
SELECT spender,0,MAX(0,start_block-1),200000,'scanning' FROM spender_rules;
