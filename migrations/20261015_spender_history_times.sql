-- Timestamp metadata is stored separately so this migration is safe to reapply.
CREATE TABLE IF NOT EXISTS spender_history_timestamps(
  spender TEXT NOT NULL,
  owner TEXT NOT NULL,
  block_number INTEGER NOT NULL,
  approval_at TEXT NOT NULL,
  PRIMARY KEY(spender,owner)
);