CREATE TABLE IF NOT EXISTS events (
    event_id TEXT PRIMARY KEY,
    payload TEXT NOT NULL,
    status TEXT NOT NULL CHECK(status IN ('pending', 'delivering', 'delivered', 'failed')),
    attempt_count INTEGER NOT NULL DEFAULT 0,
    next_attempt_at TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_events_status_next_attempt 
ON events(status, next_attempt_at);

CREATE TABLE IF NOT EXISTS delivery_attempts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    event_id TEXT NOT NULL,
    attempt_number INTEGER NOT NULL,
    status_code INTEGER,
    response_body TEXT,
    error_message TEXT,
    attempted_at TEXT NOT NULL DEFAULT (datetime('now')),
    FOREIGN KEY (event_id) REFERENCES events(event_id) ON DELETE CASCADE,
    UNIQUE(event_id, attempt_number)
);

CREATE INDEX IF NOT EXISTS idx_delivery_attempts_event_id 
ON delivery_attempts(event_id);
