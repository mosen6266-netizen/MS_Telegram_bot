CREATE TABLE IF NOT EXISTS usage_samples (
  metric TEXT PRIMARY KEY, used REAL NOT NULL CHECK(used>=0), quota REAL,
  unit TEXT NOT NULL, period_start TEXT NOT NULL, period_end TEXT NOT NULL,
  observed_at TEXT NOT NULL, source TEXT NOT NULL, scope TEXT NOT NULL,
  extra_json TEXT NOT NULL DEFAULT '{}'
);
CREATE TABLE IF NOT EXISTS usage_observations (
  metric TEXT NOT NULL, observed_at TEXT NOT NULL, used REAL NOT NULL,
  period_start TEXT NOT NULL, source TEXT NOT NULL,
  PRIMARY KEY(metric, observed_at)
);
CREATE INDEX IF NOT EXISTS idx_usage_history ON usage_observations(metric, period_start, observed_at);
CREATE TABLE IF NOT EXISTS usage_collectors (
  provider TEXT PRIMARY KEY, attempted_at TEXT NOT NULL, succeeded_at TEXT,
  last_error TEXT
);
CREATE TABLE IF NOT EXISTS usage_cf_days (
  day TEXT PRIMARY KEY, payload_json TEXT NOT NULL, updated_at TEXT NOT NULL
);
INSERT OR IGNORE INTO runtime_state(key,value) VALUES('usage_started_at',strftime('%Y-%m-%dT%H:%M:%fZ','now'));
INSERT OR IGNORE INTO usage_limits(metric,platform,unit,quota,period,source)
  VALUES('etherscan_requests','Etherscan','次',100000,'daily','account_plan_reference_2026_10_15');
