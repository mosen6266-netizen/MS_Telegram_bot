CREATE TABLE IF NOT EXISTS setup_invites (
  code_hash TEXT PRIMARY KEY,
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  used_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_setup_invites_available ON setup_invites(expires_at, used_at);
