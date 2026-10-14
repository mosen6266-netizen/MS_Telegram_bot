ALTER TABLE wallets ADD COLUMN deleted_at TEXT;
CREATE TABLE IF NOT EXISTS wallet_exclusions(address TEXT PRIMARY KEY,reason TEXT NOT NULL DEFAULT 'Manually removed by administrator',created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP);
