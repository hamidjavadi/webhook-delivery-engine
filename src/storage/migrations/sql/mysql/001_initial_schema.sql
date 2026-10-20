CREATE TABLE IF NOT EXISTS webhook_events (
  id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  idempotency_key VARCHAR(255) CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_bin NOT NULL,
  client_id VARCHAR(255) CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_bin NOT NULL,
  destination_url TEXT NOT NULL,
  payload JSON NOT NULL,
  metadata JSON NOT NULL,
  headers JSON NOT NULL,
  status ENUM('pending', 'processing', 'delivered', 'retry', 'failed') NOT NULL,
  attempt_count INT UNSIGNED NOT NULL DEFAULT 0,
  next_retry_at DATETIME(3),
  locked_at DATETIME(3),
  locked_by VARCHAR(255),
  created_at DATETIME(3) NOT NULL,
  updated_at DATETIME(3) NOT NULL,
  PRIMARY KEY (id),
  CONSTRAINT uq_client_idempotency UNIQUE (client_id, idempotency_key),
  KEY idx_webhook_events_due (status, next_retry_at)
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS webhook_event_attempts (
  id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  event_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  attempt_number INT UNSIGNED NOT NULL,
  attempted_at DATETIME(3) NOT NULL,
  status_code SMALLINT UNSIGNED,
  response_snippet VARCHAR(1024),
  error TEXT,
  latency_ms BIGINT UNSIGNED,
  outcome ENUM('success', 'retry_scheduled', 'exhausted') NOT NULL,
  PRIMARY KEY (id),
  CONSTRAINT fk_webhook_event_attempts_event
    FOREIGN KEY (event_id) REFERENCES webhook_events (id) ON DELETE CASCADE,
  CONSTRAINT uq_webhook_event_attempts_event_number
    UNIQUE (event_id, attempt_number)
) ENGINE=InnoDB;
