CREATE TABLE IF NOT EXISTS webhook_events (
  id TEXT NOT NULL PRIMARY KEY,
  idempotency_key TEXT NOT NULL,
  client_id TEXT NOT NULL,
  destination_url TEXT NOT NULL,
  payload TEXT NOT NULL CHECK (json_valid(payload)),
  metadata TEXT NOT NULL CHECK (
    json_valid(metadata) AND json_type(metadata) = 'object'
  ),
  headers TEXT NOT NULL CHECK (
    json_valid(headers) AND json_type(headers) = 'object'
  ),
  status TEXT NOT NULL CHECK (
    status IN ('pending', 'processing', 'delivered', 'retry', 'failed')
  ),
  attempt_count INTEGER NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
  next_retry_at TEXT,
  locked_at TEXT,
  locked_by TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  CONSTRAINT uq_client_idempotency UNIQUE (client_id, idempotency_key),
  CONSTRAINT chk_webhook_events_lease CHECK (
    (status = 'processing' AND locked_at IS NOT NULL AND locked_by IS NOT NULL)
    OR
    (status <> 'processing' AND locked_at IS NULL AND locked_by IS NULL)
  )
) STRICT;

CREATE INDEX IF NOT EXISTS idx_webhook_events_due
  ON webhook_events (status, next_retry_at);

CREATE TABLE IF NOT EXISTS webhook_event_attempts (
  id TEXT NOT NULL PRIMARY KEY,
  event_id TEXT NOT NULL,
  attempt_number INTEGER NOT NULL CHECK (attempt_number > 0),
  attempted_at TEXT NOT NULL,
  status_code INTEGER CHECK (status_code IS NULL OR status_code BETWEEN 100 AND 599),
  response_snippet TEXT CHECK (
    response_snippet IS NULL OR length(CAST(response_snippet AS BLOB)) <= 1024
  ),
  error TEXT,
  latency_ms INTEGER CHECK (latency_ms IS NULL OR latency_ms >= 0),
  outcome TEXT NOT NULL CHECK (
    outcome IN ('success', 'retry_scheduled', 'exhausted')
  ),
  CONSTRAINT fk_webhook_event_attempts_event
    FOREIGN KEY (event_id) REFERENCES webhook_events (id) ON DELETE CASCADE
) STRICT;

CREATE UNIQUE INDEX IF NOT EXISTS uq_webhook_event_attempts_event_number
  ON webhook_event_attempts (event_id, attempt_number);
