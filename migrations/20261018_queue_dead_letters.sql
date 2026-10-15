-- Persist messages exhausted from Cloudflare's finite-retention DLQ.
-- Never auto-replay: some jobs may have already produced external side effects.
CREATE TABLE IF NOT EXISTS queue_dead_letters(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  queue_message_id TEXT NOT NULL UNIQUE,
  kind TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0,
  state TEXT NOT NULL DEFAULT 'needs_review',
  first_seen_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  reviewed_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_queue_dead_letters_state_id ON queue_dead_letters(state,id DESC);
