-- Stable newest-first pages for potentially large administrator lists.
CREATE INDEX IF NOT EXISTS idx_wallets_created_address ON wallets(created_at DESC,address DESC);
CREATE INDEX IF NOT EXISTS idx_subscriptions_updated_chat_address ON subscriptions(updated_at DESC,chat_id DESC,address DESC);
CREATE INDEX IF NOT EXISTS idx_transfers_block_event ON transfer_events(block_number DESC,event_id DESC);
