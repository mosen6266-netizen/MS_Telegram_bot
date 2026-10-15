-- Cleanup jobs survive worker restarts and Telegram API failures.
CREATE TABLE IF NOT EXISTS telegram_message_cleanup (
  chat_id TEXT NOT NULL,
  message_id INTEGER NOT NULL,
  reason TEXT NOT NULL,
  due_at TEXT NOT NULL,
  state TEXT NOT NULL DEFAULT 'pending' CHECK(state IN ('pending','processing','deleted','blocked')),
  attempts INTEGER NOT NULL DEFAULT 0,
  last_error TEXT,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY(chat_id,message_id)
);
CREATE INDEX IF NOT EXISTS idx_telegram_message_cleanup_pending
  ON telegram_message_cleanup(state,due_at);
