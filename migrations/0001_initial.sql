PRAGMA foreign_keys=ON;
CREATE TABLE IF NOT EXISTS telegram_users (
  user_id TEXT PRIMARY KEY, display_name TEXT NOT NULL, username TEXT, last_seen_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS telegram_chats (
  chat_id TEXT PRIMARY KEY, title TEXT NOT NULL, chat_type TEXT NOT NULL, active INTEGER NOT NULL DEFAULT 1
);
CREATE TABLE IF NOT EXISTS wallets (
  address TEXT PRIMARY KEY, first_user_id TEXT, first_user_name TEXT,
  discovery_source TEXT NOT NULL DEFAULT 'manual', created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY(first_user_id) REFERENCES telegram_users(user_id)
);
CREATE TABLE IF NOT EXISTS subscriptions (
  chat_id TEXT NOT NULL, address TEXT NOT NULL,
  remark TEXT NOT NULL, remark_version INTEGER NOT NULL DEFAULT 1,
  status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active','paused','removed','pending')),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY(chat_id,address),
  FOREIGN KEY(chat_id) REFERENCES telegram_chats(chat_id),
  FOREIGN KEY(address) REFERENCES wallets(address)
);
CREATE INDEX IF NOT EXISTS idx_subs_address ON subscriptions(address,status);
CREATE TABLE IF NOT EXISTS spender_rules (
  spender TEXT PRIMARY KEY, remark TEXT NOT NULL, enabled INTEGER NOT NULL DEFAULT 1,
  start_block INTEGER NOT NULL, cursor_block INTEGER NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS spender_routes (
  spender TEXT NOT NULL, chat_id TEXT NOT NULL, PRIMARY KEY(spender,chat_id),
  FOREIGN KEY(spender) REFERENCES spender_rules(spender)
);
CREATE TABLE IF NOT EXISTS allowances (
  owner TEXT NOT NULL, spender TEXT NOT NULL,
  amount_raw TEXT NOT NULL, first_seen_block INTEGER NOT NULL, latest_block INTEGER NOT NULL,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY(owner,spender)
);
CREATE TABLE IF NOT EXISTS approval_events (
  event_id TEXT PRIMARY KEY, owner TEXT NOT NULL, spender TEXT NOT NULL,
  amount_raw TEXT NOT NULL, block_number INTEGER NOT NULL, tx_hash TEXT NOT NULL,
  event_type TEXT NOT NULL, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS wallet_watches (
  address TEXT PRIMARY KEY, state TEXT NOT NULL DEFAULT 'pending',
  synced_at TEXT, last_error TEXT, updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS query_history (
  id INTEGER PRIMARY KEY AUTOINCREMENT, user_id TEXT, chat_id TEXT, address TEXT NOT NULL,
  result TEXT NOT NULL, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS remark_sessions (
  chat_id TEXT NOT NULL, user_id TEXT NOT NULL, prompt_message_id INTEGER NOT NULL,
  address TEXT NOT NULL, expires_at TEXT NOT NULL, PRIMARY KEY(chat_id,user_id,prompt_message_id)
);
CREATE TABLE IF NOT EXISTS remark_edits (
  id INTEGER PRIMARY KEY AUTOINCREMENT, chat_id TEXT NOT NULL, address TEXT NOT NULL,
  actor_id TEXT NOT NULL, old_value TEXT NOT NULL, new_value TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS transfer_events (
  event_id TEXT PRIMARY KEY, address TEXT NOT NULL, asset TEXT NOT NULL, direction TEXT NOT NULL,
  raw_amount TEXT NOT NULL, from_address TEXT NOT NULL, to_address TEXT NOT NULL,
  tx_hash TEXT NOT NULL, block_number INTEGER NOT NULL, block_hash TEXT,
  state TEXT NOT NULL DEFAULT 'confirmed', created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_transfers_wallet ON transfer_events(address,block_number DESC);
CREATE TABLE IF NOT EXISTS outbox (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  dedup_key TEXT NOT NULL UNIQUE,
  chat_id TEXT NOT NULL, address TEXT, template_key TEXT NOT NULL, payload_json TEXT NOT NULL,
  state TEXT NOT NULL DEFAULT 'pending', attempts INTEGER NOT NULL DEFAULT 0,
  due_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  telegram_message_id INTEGER,
  last_error TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, sent_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_outbox_pending ON outbox(state,due_at);
CREATE TABLE IF NOT EXISTS templates (
  template_key TEXT NOT NULL, chat_id TEXT NOT NULL DEFAULT '*',
  body TEXT NOT NULL, version INTEGER NOT NULL DEFAULT 1,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY(template_key,chat_id)
);
CREATE TABLE IF NOT EXISTS admin_audit (
  id INTEGER PRIMARY KEY AUTOINCREMENT, actor TEXT NOT NULL, action TEXT NOT NULL,
  target TEXT NOT NULL, details_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS counters (
  metric TEXT NOT NULL, day TEXT NOT NULL, value INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY(metric,day)
);
CREATE TABLE IF NOT EXISTS runtime_state (
  key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
