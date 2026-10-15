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
  - `webhook_events`: Durable queue holding event status, payload, next retry timestamp, attempt count, and worker claim locks.
  - `webhook_event_attempts`: Append-only audit log recording timestamps, HTTP status codes, latencies, response body snippets (capped at 1 KB), and execution outcomes (`success`, `retry_scheduled`, `exhausted`).
- **Multi-Dialect Database Adapters:**
  - Unified adapter interface with native driver support for:
    - SQLite (`better-sqlite3`)
    - PostgreSQL (`pg`)
    - MySQL (`mysql2`)
- **Atomic Claim Mechanism:**
  - Driver-agnostic conditional `UPDATE` ensuring zero double-claims under high concurrent execution.
  - Built-in stale claim recovery for crashed or stalled worker processes.

### 2.2 Core Ingestion & Delivery Engine

- **Idempotent Ingestion:**
  - Single-statement atomic upserts (`ON CONFLICT DO NOTHING` / `INSERT IGNORE`).
  - Replay detection returning HTTP `200` with an `idempotent_replay: true` indicator without duplicate queueing.
- **Delivery & Retry Policy:**
  - Bounded exponential backoff with full jitter formula: `min(base * 2^(attempt - 1), capMs)`.
  - Configurable base delay (default: 1,000 ms), maximum backoff cap (default: 60 s), timeout limit (default: 10,000 ms), and retry threshold (default: 5 attempts).
  - Status classification: `2xx` treated as successful; `4xx` (including `429`) and `5xx` treated as retryable; non-retryable terminal failures upon reaching max attempts.

### 2.3 Security & Protection

- **Constant-Time Ingestion Authentication:**
  - Ingestion endpoints secured via Bearer token / API Key using `crypto.timingSafeEqual` to eliminate timing attacks.
- **Cryptographic Delivery Signing:**
  - HMAC SHA-256 payload signing delivered via `x-webhook-signature` and `x-webhook-timestamp` headers.
- **SSRF Protection:**
  - Enforced destination URL validation blocking private subnets, loopback addresses, RFC1918 networks, and cloud metadata endpoints (`169.254.169.254`).

### 2.4 API & Observability

- **REST Endpoints:**
  - `POST /webhooks`: Ingest new webhook event.
  - `GET /webhooks/:id`: Fetch current event status and delivery metadata.
  - `GET /webhooks/:id/attempts`: Fetch the chronological attempt history and audit trail.
- **Structured Logging:** Contextual JSON logs for claims, dispatches, and final state transitions.

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

---

## 4. Key Constraints & Non-Negotiables

- **Zero External Broker Dependency:** No Redis, Kafka, or RabbitMQ. All coordination must rely on SQL ACID semantics.
- **Runtime & Type Safety:** Strict Node.js ≥ 24 runtime and TypeScript under `strict: true`.
- **Delivery Semantics:** At-least-once delivery; consumers must remain idempotent.
- **Quality Gates:** Vitest test suite with ≥80% total coverage and ≥95% coverage across critical ingestion and claiming code paths.
