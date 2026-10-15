-- One shared wallet label for admin, Telegram groups, history views and future notices.
CREATE TABLE IF NOT EXISTS wallet_global_remarks (
  address TEXT PRIMARY KEY,
  remark TEXT NOT NULL,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
-- Durable onboarding status for every historical Owner discovered through a Spender.
CREATE TABLE IF NOT EXISTS spender_history_monitor_enrollments (
  spender TEXT NOT NULL,
  owner TEXT NOT NULL,
  state TEXT NOT NULL DEFAULT 'pending',
  attempts INTEGER NOT NULL DEFAULT 0,
  last_error TEXT,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  synced_at TEXT,
  PRIMARY KEY(spender,owner)
);
CREATE INDEX IF NOT EXISTS idx_spender_history_enroll_state ON spender_history_monitor_enrollments(state,updated_at);
