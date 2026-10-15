-- Track when the current delivery attempt started; created_at is NOT a lease time.
ALTER TABLE outbox ADD COLUMN sending_started_at TEXT;
-- Existing in-flight rows receive a fresh recovery grace period during migration.
UPDATE outbox SET sending_started_at=CURRENT_TIMESTAMP WHERE state='sending' AND sending_started_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_outbox_sending_lease ON outbox(state,sending_started_at);
