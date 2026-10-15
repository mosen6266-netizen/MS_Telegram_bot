-- Keep filtered, paginated admin outbox queries efficient as history grows.
CREATE INDEX IF NOT EXISTS idx_outbox_state_id_desc ON outbox(state,id DESC);
