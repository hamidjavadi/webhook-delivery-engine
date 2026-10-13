# Product Requirements Document (PRD)

## Webhook Retry Engine — v1.0

| Field          | Value                                                                  |
| -------------- | ---------------------------------------------------------------------- |
| Product        | Webhook Retry Engine                                                   |
| Version        | 1.0.0                                                                  |
| Status         | Finalized                                                              |
| Stack          | Node.js ≥ 24, TypeScript, Express 5, better-sqlite3, Pino, Zod, Vitest |
| Document Owner | Engineering                                                            |

---

## 1. Overview

A lightweight, embeddable Node.js/TypeScript library and HTTP service for **reliable, idempotent webhook delivery with persistent, bounded exponential-backoff retries**. Events are accepted once, persisted in SQLite, delivered to a target webhook URL, and retried on transient failures until delivered or permanently failed.

### 1.1 Goals

- **Idempotent ingestion** — the same event (same idempotency key) is never enqueued twice.
- **Durable persistence** — events and retry state survive process restarts (embedded SQLite via `better-sqlite3`).
- **Bounded exponential backoff** — deterministic, capped retry schedule for transient HTTP/network failures.
- **Delivery observability** — every attempt records timestamp, HTTP status, latency, and error detail.

### 1.2 Non-Goals (v1.0)

- Multi-tenant / multi-endpoint fan-out (single configured `WEBHOOK_URL` per instance).
- Distributed clustering or cross-process locking (single-process `better-sqlite3` WAL).
- At-least-exact-once guarantees beyond idempotency-key dedupe; end-to-end exactly-once is the receiver's responsibility.
- A UI dashboard (JSON API + logs only in v1.0).

---

## 2. Architecture (Finalized)

### 2.1 Components

```
┌─────────────┐    POST /events     ┌──────────────────────────────┐
│   Producer   │ ──────────────────▶ │ Express app (app.ts)         │
└─────────────┘                     │  - Zod validation            │
                                     │  - Idempotency check         │
                                     └──────────┬───────────────────┘
                                                │ INSERT (dedupe)
                                     ┌──────────▼───────────────────┐
                                     │ Storage layer (storage/db.ts)│
                                     │ SQLite (WAL, better-sqlite3) │
                                     └──────────┬───────────────────┘
                                                │ poll due jobs
                                     ┌──────────▼───────────────────┐
                                     │ Delivery worker (in-process) │
                                     │  - fetch() POST + timeout    │
                                     │  - classify result           │
                                     │  - backoff schedule          │
                                     └──────────┬───────────────────┘
                                                │ attempt log
                                     ┌──────────▼───────────────────┐
                                     │ attempts table + Pino logs   │
                                     └──────────────────────────────┘
```

**Decisions (final):**

| #   | Decision                                                                                                                  | Rationale                                                                         |
| --- | ------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------- |
| A1  | Embed SQLite (`better-sqlite3`) with WAL journal; synchronous API on a dedicated worker step                              | Zero external infra, durable across restarts, adequate for single-node throughput |
| A2  | Single in-process delivery worker (`setInterval` poll, concurrency = 1)                                                   | Simple, no double-delivery races within the process; v2 may add worker threads    |
| A3  | Idempotency via unique `event_key` (SHA-256 of provider-supplied idempotency key, or of `event_id + payload` when absent) | Idempotent ingestion without producer-side coordination                           |
| A4  | Zod v4 for request/response schema validation                                                                             | Single source of truth for validation and inferred types                          |
| A5  | Retry classification by HTTP status class (see #5.3)                                                                      | Predictable, testable policy                                                      |
| A6  | `fetch()` with `AbortSignal.timeout(DELIVERY_TIMEOUT_MS)`                                                                 | No extra HTTP client dependency; hard timeout enforced                            |
| A7  | Pino structured logging, level from `LOG_LEVEL`                                                                           | Observability with minimal overhead                                               |
| A8  | Transactions wrap every state transition (claim, complete, fail)                                                          | Crash-safe state machine                                                          |

### 2.2 Module Map

| Module                                       | Responsibility                                                                                       |
| -------------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| `src/server.ts`                              | HTTP server bootstrap, graceful shutdown (SIGTERM/SIGINT: stop worker → close DB)                    |
| `src/app.ts`                                 | Express routes, Zod validation, error middleware                                                     |
| `src/config.ts`                              | Env parsing (`PORT`, `NODE_ENV`, `LOG_LEVEL`, `DATABASE_PATH`, `WEBHOOK_URL`, retries/backoff knobs) |
| `src/logger.ts`                              | Pino logger instance                                                                                 |
| `src/storage/db.ts`                          | Connection, `schema.sql` migration runner, job CRUD, transactional transitions                       |
| `src/storage/schema.sql`                     | DDL (#4.2)                                                                                           |
| `src/worker/delivery.ts`                     | Poll loop, delivery, classification, backoff, attempt logging                                        |
| `src/types/config.ts`, `src/types/errors.ts` | Shared types, custom errors                                                                          |

---

## 3. API Contract

### 3.1 `POST /events` — Ingest an event

**Request**

```json
{
  "event_id": "evt_01H9ZK3F2M",
  "event_type": "order.created",
  "idempotency_key": "ord-8812-evt_01H9ZK3F2M",
  "payload": {
    "order_id": "ord-8812",
    "amount": 4200,
    "currency": "USD"
  },
  "metadata": { "source": "billing-service" }
}
```

**Responses**

| Status | Body                                 | Meaning                                                                |
| ------ | ------------------------------------ | ---------------------------------------------------------------------- |
| `202`  | Accepted schema below                | New event enqueued (status `pending`)                                  |
| `200`  | Accepted schema, `"duplicate": true` | Idempotent replay: same `event_key` already exists; no new job created |
| `400`  | Error schema                         | Validation failure (Zod)                                               |
| `500`  | Error schema                         | Unexpected server error                                                |

**Accepted (202/200)**

```json
{
  "accepted": true,
  "duplicate": false,
  "event_id": "evt_01H9ZK3F2M",
  "event_key": "9f2c…64-char-hex",
  "status": "pending",
  "created_at": "2025-01-15T10:00:00.000Z"
}
```

### 3.2 Other Endpoints

| Method | Path                             | Description                                                                    |
| ------ | -------------------------------- | ------------------------------------------------------------------------------ |
| `GET`  | `/health`                        | Liveness: `{ "status": "ok" }`                                                 |
| `GET`  | `/events/:event_id`              | Event record + attempts (404 if unknown)                                       |
| `GET`  | `/events?status=&limit=&offset=` | List events, filterable by status                                              |
| `POST` | `/events/:event_id/retry`        | Manually re-enqueue a `failed` or `dead` event (resets attempt counter per #6) |
| `GET`  | `/stats`                         | Counters by status, success rate, p50/p95 delivery latency                     |

**Error schema (4xx/5xx)**

```json
{
  "error": {
    "code": "VALIDATION_ERROR",
    "message": "payload: expected object",
    "request_id": "req_01H9ZKABCD"
  }
}
```

Codes: `VALIDATION_ERROR` (400), `NOT_FOUND` (404), `CONFLICT_STATE` (409), `INTERNAL_ERROR` (500).

---

## 4. Data Model

### 4.1 Event JSON Schema (ingestion, Zod-equivalent JSON Schema)

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "title": "WebhookEventInput",
  "type": "object",
  "required": ["event_id", "event_type", "payload"],
  "additionalProperties": false,
  "properties": {
    "event_id": { "type": "string", "minLength": 1, "maxLength": 255 },
    "event_type": {
      "type": "string",
      "minLength": 1,
      "maxLength": 128,
      "pattern": "^[a-z0-9]+(\\.[a-z0-9]+)*$"
    },
    "idempotency_key": { "type": "string", "minLength": 1, "maxLength": 255 },
    "payload": { "type": "object" },
    "metadata": { "type": "object" }
  }
}
```

Rules:

- `payload` must be a JSON object (serialized to TEXT in SQLite).
- If `idempotency_key` is omitted, `event_key = SHA-256(event_id + "\n" + canonical JSON of payload)`.
- If present, `event_key = SHA-256(idempotency_key)`.

### 4.2 SQLite Schema (`src/storage/schema.sql`)

```sql
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;
PRAGMA busy_timeout = 5000;

CREATE TABLE IF NOT EXISTS events (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  event_id         TEXT    NOT NULL,
  event_key        TEXT    NOT NULL UNIQUE,   -- sha256 hex, dedupe key
  event_type       TEXT    NOT NULL,
  payload          TEXT    NOT NULL,          -- canonical JSON
  metadata         TEXT,                      -- JSON or NULL
  status           TEXT    NOT NULL DEFAULT 'pending'
                   CHECK (status IN ('pending','in_flight','delivered','failed','dead')),
  attempt_count    INTEGER NOT NULL DEFAULT 0,
  max_attempts     INTEGER NOT NULL,          -- snapshot of config at enqueue
  next_attempt_at  INTEGER,                   -- unix ms; NULL once terminal
  last_error       TEXT,
  created_at       INTEGER NOT NULL,          -- unix ms
  updated_at       INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_events_status_next
  ON events (status, next_attempt_at);

CREATE TABLE IF NOT EXISTS attempts (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  event_row_id  INTEGER NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  attempt_no    INTEGER NOT NULL,
  started_at    INTEGER NOT NULL,
  finished_at   INTEGER,
  outcome       TEXT NOT NULL DEFAULT 'in_progress'
                CHECK (outcome IN ('in_progress','success','retryable_error','permanent_error','timeout')),
  http_status   INTEGER,
  latency_ms    INTEGER,
  error_detail  TEXT,
  UNIQUE (event_row_id, attempt_no)
);

CREATE INDEX IF NOT EXISTS idx_attempts_event ON attempts (event_row_id, attempt_no);
```

### 4.3 Delivery Attempt JSON Schema (read model, `GET /events/:id`)

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "title": "DeliveryAttempt",
  "type": "object",
  "required": ["attempt_no", "started_at", "outcome"],
  "properties": {
    "attempt_no": { "type": "integer", "minimum": 1 },
    "started_at": { "type": "string", "format": "date-time" },
    "finished_at": { "type": ["string", "null"], "format": "date-time" },
    "outcome": {
      "enum": ["in_progress", "success", "retryable_error", "permanent_error", "timeout"]
    },
    "http_status": { "type": ["integer", "null"], "minimum": 100, "maximum": 599 },
    "latency_ms": { "type": ["integer", "null"], "minimum": 0 },
    "error_detail": { "type": ["string", "null"] }
  }
}
```

---

## 5. Retry Policy (Finalized)

### 5.1 Constants (configurable via env, defaults below)

| Env var                   | Default          | Meaning                                     |
| ------------------------- | ---------------- | ------------------------------------------- |
| `MAX_ATTEMPTS`            | `5`              | Total delivery attempts (initial + retries) |
| `BACKOFF_BASE_MS`         | `2000`           | Base delay multiplier                       |
| `BACKOFF_FACTOR`          | `2`              | Exponential growth factor                   |
| `BACKOFF_MAX_MS`          | `300000` (5 min) | Hard cap on any single delay                |
| `BACKOFF_JITTER_MS`       | `500`            | Max full-jitter additive noise              |
| `DELIVERY_TIMEOUT_MS`     | `10000`          | Per-attempt HTTP timeout                    |
| `WORKER_POLL_INTERVAL_MS` | `1000`           | Due-job poll frequency                      |

### 5.2 Retry Delay Formula

For attempt number `n` that failed (next attempt is attempt `n + 1`, `k = n`):

```
delay(n) = min( BACKOFF_MAX_MS, BACKOFF_BASE_MS × BACKOFF_FACTOR^(n − 1) )
         + random(0, BACKOFF_JITTER_MS)

next_attempt_at = finished_at + delay(n)
```

With defaults (`base=2000, factor=2, max=300000, jitter=500`):

| Failed attempt n |                  Base delay | Max delay incl. jitter |
| ---------------: | --------------------------: | ---------------------: |
|                1 |                         2 s |                  2.5 s |
|                2 |                         4 s |                  4.5 s |
|                3 |                         8 s |                  8.5 s |
|                4 |                        16 s |                 16.5 s |
|                5 | terminal — no further retry |                      — |

For `n ≥ 9`, the exponential term alone reaches/exceeds the 5-minute cap, so the effective maximum delay is always **300.5 s**.

### 5.3 Outcome Classification (final)

| Condition                                         | Outcome           | Action                                                                   |
| ------------------------------------------------- | ----------------- | ------------------------------------------------------------------------ |
| HTTP 2xx                                          | `success`         | Event → `delivered`                                                      |
| HTTP 408, 425, 409, 429                           | `retryable_error` | Retry per #5.2 (honor `Retry-After` if `≤ BACKOFF_MAX_MS`, else formula) |
| HTTP 500, 502, 503, 504                           | `retryable_error` | Retry per #5.2                                                           |
| HTTP 3xx (any)                                    | `permanent_error` | No retry — redirects are not followed; treat as misconfiguration         |
| Other 4xx (400, 401, 403, 404, 405, 410, 422…)    | `permanent_error` | Event → `failed` immediately                                             |
| Network error / DNS / connection reset            | `retryable_error` | Retry per #5.2                                                           |
| Timeout (AbortSignal fires)                       | `timeout`         | Retry per #5.2                                                           |
| Attempt count reaches `MAX_ATTEMPTS` on a failure | —                 | Event → `dead` (instead of `failed`)                                     |

### 5.4 State Machine (Lifecycle Rules)

```
            ingest
              │
              ▼
          ┌────────┐   worker claims (due, atomic)   ┌───────────┐
          │pending │ ───────────────────────────────▶│ in_flight │
          └────────┘                                 └─────┬─────┘
              ▲                                        │
   POST /:id/retry        ┌────────────────────────────┼──────────────────────┐
   (resets counters)      │ 2xx                        │ retryable/timeout    │
              │           ▼                            │ & attempts < max     │
          ┌────────┐  ┌───────────┐                    ▼                      │
          │pending │  │ delivered │ (terminal)   backoff delay set → status      │
          └────────┘  └───────────┘              returns to `pending` with      │
              ▲                                  next_attempt_at in future     │
              │                                  (worker skips until due)      │
              │  retryable & attempts == max ────► `dead` (terminal)             │
              │  permanent_error ────────────────► `failed` (terminal)           │
```

**Rules:**

1. **Terminal states:** `delivered`, `failed`, `dead`. No automatic transition out; only `POST /events/:id/retry` may resurrect `failed`/`dead` back to `pending` (attempt_count reset to 0, `max_attempts` re-snapshotted, `next_attempt_at = now`).
2. **Claim is atomic:** worker claims due jobs with a single `UPDATE … WHERE status='pending' AND next_attempt_at ≤ now AND id IN (SELECT … LIMIT 1)` inside a transaction; rows in `in_flight` are never re-claimed.
3. **Crash recovery:** on startup, any row left in `in_flight` (stale claim) is reset to `pending` with `next_attempt_at = now` and its `in_progress` attempt row marked `timeout`.
4. **Duplicate ingestion** returns `200` with `"duplicate": true` and never mutates the existing row.
5. **`updated_at`** is refreshed on every state transition; `attempts` rows are append-only.
6. **Shutdown:** SIGTERM stops the poll loop, waits ≤ 5 s for the in-flight attempt, persists its result, then closes the DB.

---

## 6. Manual Retry Endpoint

`POST /events/:event_id/retry` is allowed only when `status ∈ {failed, dead}`; otherwise `409 CONFLICT_STATE`. Effect: `attempt_count = 0`, `status = 'pending'`, `next_attempt_at = now`, `last_error = NULL`, and a new audit row appended to `attempts` is _not_ created (history preserved via previous attempts).

---

## 7. Observability

- **Structured logs (Pino):** one log line per state transition and per attempt: `{ event_id, event_key, attempt_no, outcome, http_status, latency_ms, next_attempt_at }`.
- **`GET /stats`:** counts per status, success rate = `delivered / total terminal attempts-eligible events`, p50/p95 latency over last 24 h from `attempts.latency_ms`.
- **Health:** `GET /health` returns `ok` only if the DB responds to `SELECT 1` within 1 s.

---

## 8. Testing Requirements

| Suite       | File                     | Coverage                                                                                             |
| ----------- | ------------------------ | ---------------------------------------------------------------------------------------------------- |
| Unit        | `tests/storage.test.ts`  | Schema migration, idempotency dedupe, state transitions, backoff math (deterministic, jitter mocked) |
| Unit        | `tests/backoff.test.ts`  | Formula #5.2 incl. cap and jitter bounds                                                             |
| Integration | `tests/server.test.ts`   | All endpoints incl. 202/200/400/404/409, validation errors                                           |
| Integration | `tests/delivery.test.ts` | Mock HTTP target: 2xx success, 500→retry, 400→failed, timeout→retry, exhaustion→dead, crash recovery |

---

## 9. Acceptance Criteria

1. **Idempotency:** posting the same event twice (same `idempotency_key`, or same `event_id`+`payload` without one) yields exactly **one** row in `events`; second response is `200` with `"duplicate": true`.
2. **Validation:** a request missing `event_id`, `event_type`, or `payload`, or with a non-object `payload`, returns `400 VALIDATION_ERROR` and inserts nothing.
3. **Persistence:** killing the process (`SIGKILL`) mid-retry and restarting resumes the schedule; no event is lost or double-claimed (verified by `in_flight` recovery rule #5.4.3).
4. **Backoff formula:** with defaults, delays after failed attempts 1–4 are 2 s, 4 s, 8 s, 16 s (± 500 ms jitter), capped at 300 s from attempt 9 onward. Unit tests assert exact bounds.
5. **Exhaustion:** an event that fails all 5 attempts (429/500/timeout) ends in status `dead`, with exactly 5 rows in `attempts`.
6. **Permanent failure:** a `400` or `404` from the target moves the event to `failed` after the **first** attempt, with no further retries.
7. **Delivery success:** a `2xx` marks the event `delivered`, records `http_status`, `latency_ms`, and `finished_at`.
8. **Manual retry:** `POST /events/:event_id/retry` on a `dead` event returns `202`-equivalent success, resets the counter, and the event is re-delivered; on a `pending` event it returns `409`.
9. **Observability:** every attempt produces a Pino log line with the fields in #7; `GET /stats` returns counters matching the DB contents exactly.
10. **Timeout enforcement:** a target that hangs is aborted at `DELIVERY_TIMEOUT_MS` (10 s default), recorded as `timeout`, and retried.
11. **Config:** all constants in #5.1 are overridable via environment variables and take effect without code changes.
12. **Quality gates:** `pnpm lint` (0 warnings), `pnpm test` (all suites green), `pnpm build` (TypeScript compiles clean) all pass.

---

## 10. Milestones

| Milestone | Scope                                                          |
| --------- | -------------------------------------------------------------- |
| M1        | Schema + storage layer + migrations, idempotent ingestion      |
| M2        | API endpoints + Zod validation + error middleware              |
| M3        | Delivery worker, backoff, classification, crash recovery       |
| M4        | Observability (`/stats`, logs), manual retry, full test suites |
