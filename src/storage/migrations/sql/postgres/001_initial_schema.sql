CREATE TABLE IF NOT EXISTS webhook_events (
  id UUID NOT NULL PRIMARY KEY,
  idempotency_key TEXT NOT NULL,
  client_id TEXT NOT NULL,
  destination_url TEXT NOT NULL,
  payload TEXT NOT NULL CHECK (payload::jsonb IS NOT NULL),
  metadata TEXT NOT NULL DEFAULT '{}'
    CHECK (jsonb_typeof(metadata::jsonb) = 'object'),
  headers TEXT NOT NULL DEFAULT '{}'
    CHECK (jsonb_typeof(headers::jsonb) = 'object'),
  status TEXT NOT NULL CHECK (
    status IN ('pending', 'processing', 'delivered', 'retry', 'failed')
  ),
  attempt_count INTEGER NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
  next_retry_at TIMESTAMPTZ,
  locked_at TIMESTAMPTZ,
  locked_by TEXT,
  created_at TIMESTAMPTZ NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL,
  CONSTRAINT uq_client_idempotency UNIQUE (client_id, idempotency_key),
  CONSTRAINT chk_webhook_events_lease CHECK (
    (status = 'processing' AND locked_at IS NOT NULL AND locked_by IS NOT NULL)
    OR
    (status <> 'processing' AND locked_at IS NULL AND locked_by IS NULL)
  )
);

CREATE INDEX IF NOT EXISTS idx_webhook_events_due
  ON webhook_events (status, next_retry_at);

CREATE TABLE IF NOT EXISTS webhook_event_attempts (
  id UUID NOT NULL PRIMARY KEY,
  event_id UUID NOT NULL,
  attempt_number INTEGER NOT NULL CHECK (attempt_number > 0),
  attempted_at TIMESTAMPTZ NOT NULL,
  status_code SMALLINT CHECK (status_code IS NULL OR status_code BETWEEN 100 AND 599),
  response_snippet TEXT CHECK (
    response_snippet IS NULL OR octet_length(response_snippet) <= 1024
  ),
  error TEXT,
  latency_ms BIGINT CHECK (latency_ms IS NULL OR latency_ms >= 0),
  outcome TEXT NOT NULL CHECK (
    outcome IN ('success', 'retry_scheduled', 'exhausted')
  ),
  CONSTRAINT fk_webhook_event_attempts_event
    FOREIGN KEY (event_id) REFERENCES webhook_events (id) ON DELETE CASCADE,
  CONSTRAINT uq_webhook_event_attempts_event_number
    UNIQUE (event_id, attempt_number)
);
