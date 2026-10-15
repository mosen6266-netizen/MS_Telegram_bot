-- Attribution is additive and conservative: never silently remove legacy subscriptions.
-- Existing rows may have manual or multiple-Spender origin not reconstructible
-- from the old schema. Mark as legacy until an administrator confirms ownership.
CREATE TABLE IF NOT EXISTS subscription_sources (
  chat_id TEXT NOT NULL,
  address TEXT NOT NULL,
  source_type TEXT NOT NULL CHECK(source_type IN ('legacy','manual','admin','spender','retained')),
  source_id TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY(chat_id,address,source_type,source_id),
  FOREIGN KEY(chat_id,address) REFERENCES subscriptions(chat_id,address)
);
CREATE INDEX IF NOT EXISTS idx_subscription_sources_route ON subscription_sources(source_type,source_id,chat_id);
INSERT OR IGNORE INTO subscription_sources(chat_id,address,source_type,source_id)
  SELECT chat_id,address,'legacy','pre_migration' FROM subscriptions
  WHERE status IN ('active','paused','pending');
