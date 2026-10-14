CREATE TABLE IF NOT EXISTS wallet_checkpoints(
  address TEXT PRIMARY KEY,
  last_block INTEGER NOT NULL,
  checked_at TEXT,
  last_error TEXT,
  FOREIGN KEY(address) REFERENCES wallets(address)
);
CREATE INDEX IF NOT EXISTS idx_wallet_checkpoints ON wallet_checkpoints(last_block);
CREATE TABLE IF NOT EXISTS recovered_transfers(
  transfer_id TEXT PRIMARY KEY, first_seen_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
