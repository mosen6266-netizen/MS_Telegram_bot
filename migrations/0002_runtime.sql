CREATE TABLE IF NOT EXISTS telegram_updates (
  update_id INTEGER PRIMARY KEY, received_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS usage_limits (
  metric TEXT PRIMARY KEY, platform TEXT NOT NULL, unit TEXT NOT NULL,
  quota INTEGER NOT NULL CHECK(quota>0),
  period TEXT NOT NULL CHECK(period IN ('daily','monthly')),
  source TEXT NOT NULL DEFAULT 'internal_estimate',
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS usage_alerts (
  metric TEXT NOT NULL, alert_kind TEXT NOT NULL, period_key TEXT NOT NULL,
  sent_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY(metric,alert_kind,period_key)
);
