# Project Scope Specification: Webhook Retry Engine

**Document Version:** 1.0.0  
**Phase:** 01-Plan  
**Status:** Approved / Baseline  
**Reference PRD:** `PRD.md` (v1.0.0)

---

## 1. Executive Summary & Purpose

The **Webhook Retry Engine** is an embeddable Node.js library and lightweight HTTP service designed to deliver outgoing HTTP webhooks with guaranteed durability, strict idempotency, bounded exponential backoff, and full execution observability without external message brokers (such as Redis, Kafka, or RabbitMQ).

---

## 2. In-Scope (v1.0.0)

### 2.1 Persistence & Data Schema

- **Dual-Table Schema:**
  - `webhook_events`: Durable queue holding system-generated non-enumerable event `id` (PK, UUIDv4/UUIDv7), client-supplied `idempotency_key`, authenticated `client_id`, destination URL, payload, event status (`pending`, `processing`, `delivered`, `retry`, `failed`), attempt count, next retry timestamp, and worker claim lease metadata (`locked_at`, `locked_by`).
  - `webhook_event_attempts`: Append-only audit log recording event foreign key (`event_id`), attempt ordinal, attempt timestamp, HTTP status codes, latencies, response body snippets (bounded to ≤ 1 KB), error descriptions, and execution outcomes (`success`, `retry_scheduled`, `exhausted`).
- **Database Adapter:** Implement the canonical `DatabaseAdapter` contract using `better-sqlite3`; enable WAL and `busy_timeout=5000`, parameterize all SQL, and preserve idempotency, tenant-scoped reads, worker lease ownership, and atomic attempt/state transitions. PostgreSQL and MySQL are deferred to v2.0.
- **Atomic Claim Mechanism:**
  - A single SQLite conditional `UPDATE ... RETURNING` statement per batch, selecting only due rows and ensuring no concurrent double-claim across worker processes per ADR-0001; the adapter contract remains driver-neutral.
  - SQLite stale-lease recovery for worker crashes or network partitions: atomically transition only `processing` rows with `locked_at < now - max(timeoutLimitMs + 30000 ms, 90000 ms)` to `retry`, clear lease ownership, and set retry eligibility to `now + 10000 ms`. The adapter operation is WBS 2.7; the scheduler poll loop that invokes it is WBS 4.1.

### 2.2 Core Ingestion & Delivery Engine

- **Idempotent Ingestion & Tenant Isolation:**
  - System-generated cryptographically secure `id` assigned per event; client supplies only `idempotency_key` and payload.
  - Per-tenant idempotency enforced via `UNIQUE(client_id, idempotency_key)` constraint.
  - SQLite single-statement atomic upsert (`INSERT ... ON CONFLICT DO NOTHING`).
  - Replay detection on HTTP `202 Accepted` responses, returning both system `id` and `idempotency_key` along with an `idempotent_replay: true|false` indicator without duplicate queueing.
- **Delivery & Retry Policy:**
  - Strictly at-least-once delivery semantics; consumers deduplicate using the system-generated event `id` supplied in delivery headers and body.
  - Bounded exponential backoff with full jitter formula: `next_retry_at = now + random(0, min(base * 2^(attempt - 1), capMs))`.
  - Configurable parameters: base delay (default: 1,000 ms), maximum backoff cap (default: 60,000 ms), per-delivery timeout limit (`timeoutLimitMs`, default: 10,000 ms), and retry ceiling (`maxAttempts`, default: 5 attempts).
  - Status classification: `2xx` treated as successful; non-retryable `4xx` (400, 401, 403, 404, 410, 422, and other default 4xx per ADR-0004) immediately transition to terminal `failed` without further retries; retryable `4xx` (408, 409, 429) and `5xx` treated as retryable until `maxAttempts`; terminal `failed` state with attempt outcome `exhausted` once retry ceiling is reached.

### 2.3 Security & Protection

- **Constant-Time Ingestion Authentication & Access Control:**
  - Ingestion endpoints secured via Bearer token / API Key using `crypto.timingSafeEqual` over equal-length derived/hashed buffers with no early exits to prevent timing attacks.
  - Authenticated identity resolved to `client_id` and stamped onto all ingested event rows.
- **Tenant Data Isolation & BOLA/IDOR Prevention:**
  - Strict tenant boundary enforcement across all read/query endpoints; database queries scoped strictly by authenticated `client_id` (`WHERE id = :id AND client_id = :authClientId`). Unauthorized access attempts yield HTTP `404 Not Found`.
- **Cryptographic Delivery Signing:**
  - Outbound delivery payload signed using HMAC SHA-256 with timestamp (`timestamp.body`) to prevent replay attacks, transmitted via `x-webhook-signature` and `x-webhook-timestamp` headers.
- **SSRF Protection:**
  - Destination URL validation blocking private subnets (RFC 1918), loopback addresses (`127.0.0.1`, `localhost`), link-local addresses, and cloud metadata endpoints (`169.254.169.254`) prior to dispatch.

### 2.4 API & Observability

- **REST Endpoints:**
  - `POST /webhooks`: Ingest new webhook event (accepts `idempotency_key`, `payload`, optional `destination_url` with fallback to configured `WEBHOOK_URL`).
  - `GET /webhooks`: List events filtered by `status`, scoped to caller's `client_id`.
  - `GET /webhooks/:id`: Fetch current event status and delivery metadata by system `id` or `idempotency_key`, scoped to caller's `client_id`.
  - `GET /webhooks/:id/attempts`: Fetch the chronological attempt history and audit trail, scoped to caller's `client_id`.
- **Global Configuration Management:**
  - Runtime readable global configuration (`timeoutLimitMs`, `maxAttempts`) fetched per cycle/hot-reloaded.
- **Structured Logging:** Contextual JSON logs (`LOG_LEVEL`) capturing claims, dispatches, latency, attempt records, and lifecycle state transitions.

---

## 3. Explicitly Out-of-Scope (v1.0.0)

To maintain focus and avoid scope creep, the following capabilities are deferred to future iterations:

| Feature / Capability                     | Classification | Rationale & Future Target                                                                                    |
| :--------------------------------------- | :------------- | :----------------------------------------------------------------------------------------------------------- |
| **Per-Tenant Configuration**             | Deferred       | v1 relies strictly on global configuration parameters. Per-client limits deferred to v2.                     |
| **Administrative UI / Dashboard**        | Out-of-Scope   | Operators interact purely via HTTP APIs, CLI tooling, or direct SQL queries.                                 |
| **External Metrics (OTel / Prometheus)** | Deferred       | v1 provides structured JSON logs. Prometheus exporters deferred to v1.1.                                     |
| **Dead-Letter Queue (DLQ) Re-drive API** | Deferred       | Failed events remain stored as `failed`/`exhausted`. Manual SQL updates handle manual re-drives in v1.       |
| **Strict Event Ordering / Priorities**   | Out-of-Scope   | Webhooks are delivered via at-least-once semantics with independent backoffs; strict FIFO is not guaranteed. |
| **Distributed Multi-Node Coordination**  | Out-of-Scope   | No Raft, Zookeeper, or cross-instance gossip. Concurrency safety is enforced at the database row level.      |
| **Non-HTTP Protocols**                   | Out-of-Scope   | Supports HTTP/HTTPS webhooks only (no gRPC, WebSockets, or AMQP targets).                                    |
| **Consumer-Side Verification SDKs**      | Deferred       | Consumers implement verification using standard HMAC SHA-256 libraries.                                      |
| **Alternative Databases & Multi-Dialect**| Out-of-Scope   | v1.0.0 is SQLite-only. PostgreSQL, MySQL, MongoDB, Redis, and DynamoDB are deferred to v2.0.                 |

---

## 4. Key Constraints & Non-Negotiables

- **Zero External Broker Dependency:** No Redis, Kafka, or RabbitMQ. All coordination must rely on SQL ACID semantics.
- **Runtime & Type Safety:** Strict Node.js ≥ 24 runtime and TypeScript under `strict: true`.
- **Delivery Semantics:** At-least-once delivery; consumers must remain idempotent using the system-generated event `id`.
- **Quality Gates:** Vitest test suite with ≥80% total coverage and ≥95% coverage across critical ingestion, authentication, unified atomic claim, backoff, and HMAC/SSRF security code paths.
