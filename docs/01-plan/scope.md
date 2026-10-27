# Project Scope Specification: Webhook Retry Engine

**Document Version:** 1.0.0  
**Phase:** 01-Plan  
**Status:** Approved / Baseline  
**Reference PRD:** `PRD.md` (v1.0.0)

---

## 1. Executive Summary & Purpose

The **Webhook Retry Engine** is an embeddable Node.js library designed to deliver outgoing HTTP webhooks with guaranteed durability, strict idempotency, bounded exponential backoff, and full execution observability without external message brokers (such as Redis, Kafka, or RabbitMQ).

---

## 2. In-Scope (v1.0.0)

### 2.1 Persistence & Data Schema

- **Dual-Table Schema:**
  - `webhook_events`: Durable queue holding system-generated non-enumerable event `id` (PK, UUIDv4/UUIDv7), client-supplied `idempotency_key`, host-configured `client_id`, destination URL, payload, event status (`pending`, `processing`, `delivered`, `retry`, `failed`), attempt count, next retry timestamp, and worker claim lease metadata (`locked_at`, `locked_by`).
  - `webhook_event_attempts`: Append-only audit log recording event foreign key (`event_id`), attempt ordinal, attempt timestamp, HTTP status codes, latencies, response body snippets (bounded to ≤ 1 KB), error descriptions, and execution outcomes (`success`, `retry_scheduled`, `exhausted`). `exhausted` denotes a terminal unsuccessful attempt, whether caused by a non-retryable response or reaching `maxAttempts`.
- **Database Adapter:** Implement the canonical `DatabaseAdapter` contract using `better-sqlite3`; enable WAL and `busy_timeout=5000`, parameterize all SQL, and preserve idempotency, tenant-scoped reads, worker lease ownership, and atomic attempt/state transitions. PostgreSQL and MySQL are deferred to v2.0.
- **Atomic Claim Mechanism:**
  - A single SQLite conditional `UPDATE ... RETURNING` statement per batch, selecting only due rows and ensuring no concurrent double-claim across worker processes per ADR-0001; the adapter contract remains driver-neutral.
  - SQLite stale-lease recovery for worker crashes or network partitions: atomically transition only `processing` rows with `locked_at < now - max(timeoutLimitMs + 30000 ms, 90000 ms)` to `retry`, clear lease ownership, and set retry eligibility to `now + 10000 ms`. The adapter operation is WBS 2.7; the scheduler poll loop that invokes it is WBS 4.1.
  - **WBS 4.1 poll coordinator:** run configurable poll cycles, call stale-lease recovery before each atomic due-event claim, limit claims to the configured batch size, and hand only claimed events to the worker seam. Empty cycles wait for the configured interval; transient adapter failures are reported without terminating the host process. OS signal registration and in-flight dispatch draining remain WBS 4.2.

### 2.2 Core Ingestion & Delivery Engine

- **Idempotent Ingestion & Tenant Isolation:**
  - System-generated cryptographically secure `id` assigned per event; callers supply `idempotency_key` and payload, may optionally provide a destination URL, and cannot supply or override `client_id`.
  - Per-tenant idempotency enforced via `UNIQUE(client_id, idempotency_key)` constraint.
  - SQLite single-statement atomic upsert (`INSERT ... ON CONFLICT DO NOTHING`).
  - Programmatic replay result returns both system `id` and `idempotency_key` along with an `idempotent_replay: true|false` indicator without duplicate queueing.
- **Delivery & Retry Policy:**
  - Strictly at-least-once delivery semantics; consumers deduplicate using the system-generated event `id` supplied in delivery headers and body.
  - Bounded exponential backoff with full jitter formula: `next_retry_at = now + random(0, min(base * 2^(attempt - 1), capMs))`.
  - Configurable parameters: base delay (default: 1,000 ms), maximum backoff cap (default: 60,000 ms), per-delivery timeout limit (`timeoutLimitMs`, default: 10,000 ms), and retry ceiling (`maxAttempts`, default: 5 attempts).
  - Status classification: `2xx` treated as successful; non-retryable `4xx` (400, 401, 403, 404, 410, 422, and other default 4xx per ADR-0004) immediately transition to terminal `failed` without further retries and record outcome `exhausted`; retryable `4xx` (408, 409, 429), `5xx`, and timeouts are retried until `maxAttempts`, after which the event transitions to terminal `failed` with outcome `exhausted`.

### 2.3 Security & Protection

- **Host-Owned Ingestion Access and Identity:**
  - v1 ingestion is called programmatically by the host from the same process; the library does not require an API key or provide external caller authentication.
  - The host controls access to the process and engine instance. The engine binds one `clientId` and one delivery HMAC secret at creation and stamps that configured identity onto all ingested event rows; ingestion input cannot override it.
  - Do not run multiple tenant configurations against the same SQLite database in v1: schedulers claim due events across tenants and dispatch uses the engine instance's HMAC secret.
- **Tenant Data Isolation & BOLA/IDOR Prevention:**
  - Strict tenant boundary enforcement across all read/query operations; database queries scoped strictly by configured `client_id` (`WHERE id = :id AND client_id = :configuredClientId`). Unknown and cross-tenant records return the same not-found result.
- **Cryptographic Delivery Signing:**
  - Outbound delivery payload signed using HMAC SHA-256 with timestamp (`timestamp.body`) to prevent replay attacks, transmitted via `x-webhook-signature` and `x-webhook-timestamp` headers.
- **SSRF Protection:**
  - Validate the documented ingestion request schema and accept only absolute HTTPS destination URLs without credentials.
  - Resolve hostnames before dispatch and reject unsafe IPv4/IPv6 results, including loopback, private, link-local, unspecified, multicast, reserved, IPv4-mapped private addresses, and cloud metadata endpoints. Revalidate/pin resolved destinations at connection time in the dispatcher to mitigate DNS rebinding.

### 2.4 Programmatic Interface & Observability

- **Programmatic engine interface:** Ingest events and query event status and attempt history through the embedded TypeScript library, with reads scoped to the configured `client_id`.
- **WBS 3.3 delivery boundary:** Implement the ingestion application handler and its stable result contract within the embedded library.
- **Global Configuration Management:**
  - Runtime readable global configuration (`timeoutLimitMs`, `maxAttempts`) fetched per cycle/hot-reloaded.
- **Structured Logging:** Contextual JSON logs (`LOG_LEVEL`) capturing claims, dispatches, latency, attempt records, and lifecycle state transitions.

---

## 3. Explicitly Out-of-Scope (v1.0.0)

To maintain focus and avoid scope creep, the following capabilities are deferred to future iterations:

| Feature / Capability                     | Classification | Rationale & Future Target                                                                                    |
| :--------------------------------------- | :------------- | :----------------------------------------------------------------------------------------------------------- |
| **Runtime Client Registration & Multi-Client Dispatch** | Deferred | v1 binds one client identity and HMAC secret per engine instance. Host-managed runtime registration, credential rotation, and tenant-specific dispatch configuration are planned for v2.0.0. Until then, isolate each tenant in a separate database file. |
| **Per-Tenant Configuration**             | Deferred       | v1 relies strictly on global configuration parameters. Per-client limits deferred to v2.0.                     |
| **Administrative UI / Dashboard**        | Out-of-Scope   | Operators use host application tooling or direct SQL queries.                                                |
| **External Metrics (OTel / Prometheus)** | Deferred       | v1 provides structured JSON logs. Prometheus exporters deferred to v1.1.                                     |
| **Dead-Letter Queue (DLQ) Re-drive Tooling** | Deferred       | Failed events remain stored as `failed`/`exhausted`. Manual SQL updates handle manual re-drives in v1.       |
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
- **Quality Gates:** Vitest test suite with ≥80% total coverage and ≥95% coverage across critical ingestion, tenant identity/isolation, unified atomic claim, backoff, and HMAC/SSRF security code paths.

## 5. Hosted Demo Scope Addendum (Approved 2026-10-25)

This addendum defines a separate, non-production consumer demo for the embedded library. It does not change the public engine API or v1 package behavior.

### In Scope

- `examples/demo` as an independent pnpm consumer project with its own manifest, lockfile, scripts, tests, and lint/build configs. Build and pack the root package before installing the tarball dependency so the demo exercises the package contents and public exports users receive.
- Express API and Vite/React static UI served by one Node.js 24+ process, with `/api/health` and clean awaited engine shutdown on SIGTERM/SIGINT.
- Render Free deployment, explicitly documenting spin-down, wake latency, and ephemeral SQLite/demo state reset on restart or redeploy.
- Fixed scenario destinations only: the demo's public HTTPS mock receiver. The UI/API do not accept arbitrary destination URLs. The library retains its existing full SSRF validation and pinned HTTPS dispatch.
- Scenario ingestion, bounded event/attempt telemetry, status polling, HMAC header inspection, and a clear disclosure that the hosted demo uses the actual engine and transient local SQLite.
- Scenarios: immediate 2xx; retryable 503 then 2xx; terminal 401; retryable failure through max attempts ending `failed`; SSRF rejection; custom payload/idempotency input sent only to the fixed receiver.

### Out of Scope

- Package publication, production use, persistent customer data, authentication for arbitrary webhook targets, arbitrary URL ingestion, library API/schema changes, database alternatives, horizontal scaling, and DLQ/re-drive claims.
- Public exposure of process logs, raw stack traces, signing secrets, or unbounded payload/attempt history.
- Claiming that Render Free keeps the process continuously active or preserves SQLite data across sleep/restart/redeploy.

### Acceptance Criteria

1. A clean checkout can install/build the root package and independently install/build/launch the demo without publishing the root package.
2. The demo server starts the real public `createWebhookEngine` API on an isolated SQLite file, serves the UI/API in the same process, and stops the engine cleanly on termination signals.
3. Each fixed scenario produces the documented real engine state and attempt history; retry exhaustion is shown as `failed`, never labeled as DLQ.
4. Mock deliveries reach only the configured demo receiver using HTTPS through the unchanged production destination validation and dispatch-time address pinning; SSRF attempts are rejected.
5. Custom ingestion validates payload and idempotency key while selecting the fixed receiver server-side; callers cannot provide a URL, client identity, secret, or engine config.
6. UI shows scoped scenario state, attempts, timings, and delivery signature/timestamp metadata without exposing runtime secrets or raw process logs.
7. Render Free blueprint/build/start/health behavior and ephemeral-state caveat are documented; actual hosted deployment remains a separate approval gate.
8. Root library public API and existing package files remain unchanged; a packed-package consumer smoke test, demo tests, typecheck, lint, and build pass before implementation is marked done.

## 6. Demo UI Enhancements Scope (Issue #91; Planning)

### In Scope

- Robust polling/state merging for active runs through conclusive terminal state.
- Per-card replay preserving scenario parameters, including custom payload and idempotency key, with the new run prepended.
- Run/attempt-scoped server signature verification against captured raw body, timestamp, and signature using the server-held secret; API returns only valid/invalid.
- Per-attempt measured latency and observed retry schedule context without claiming unavailable jitter precision.
- Copy actions for payload JSON, idempotency key, and signature with accessible result announcements.
- Reliability & Retries and Security & Guardrails trigger groups, keyboard access, and narrow-screen usability.
- Demo-local source changes and planning/design/test records.

### Out of Scope

Exposing HMAC secrets or browser-side verification; library API/retry algorithm changes; arbitrary destinations or new scenarios; durable history; dependencies; deployment or publishing.

### Acceptance Criteria

1. Polling tracks `ingesting`, `pending`, `processing`, and `retry`, tolerates transient failures, prevents stale overwrites, and stops after terminal state with no scheduled retry.
2. Replay preserves original scenario parameters, prepends a distinct run, and surfaces expected idempotency conflicts clearly.
3. Verification is bound to captured bytes and run/attempt association; tests cover valid, invalid, unknown run, and unknown attempt; no secret is returned.
4. Attempt rows show measured latency; retry timing is identified as scheduled/observed and uses actual timestamps.
5. Copy actions transfer exact displayed values and announce success/failure accessibly.
6. Grouped controls are keyboard accessible and usable on narrow viewports.
7. Demo tests, typecheck, lint, and production build pass with no root library source/public API changes.

## 7. Delivery Timeline Responsive Layout Scope (Issue #101; Approved 2026-10-27)

### In Scope

- Reflow delivery timeline records to prevent the Replay control from covering record content at medium widths.
- At small widths, place result/ID/status in row one, dispatch time/attempts/elapsed time in row two, and separate Replay/expand buttons in row three.
- Give the expand button a distinct icon and color while retaining accessible naming, keyboard operation, and expansion state.
- Add focused UI tests for content grouping, responsive structure, and independent button interactions.

### Out of Scope

Changes to telemetry/API behavior, event data, retry calculations, library source/public API, dependencies, deployment, or unrelated page layout.

### Acceptance Criteria

1. At medium widths Replay does not overlap the timestamp, expand control, or other record content.
2. At small widths records present the requested three row groups without clipping or messy control collisions.
3. Expand is a separate accessible button styled consistently with Replay, with a distinct icon and color; both controls work independently.
4. Existing record values and status/expansion behavior are preserved; focused tests, demo tests, lint, and production build pass.

## 8. Demo Version Display (WBS 12.1; Approved Scope)

Display the root package's current version in the demo's top brand area. Read the value from the root `package.json` so the UI does not maintain a duplicate version string. This is a demo presentation change only; package behavior, APIs, deployment, and versioning policy are unchanged.

### Acceptance Criteria

1. The top brand area shows `v` followed by the current root package version.
2. A page-rendering test verifies the package version is present before the hero section.
3. Demo tests, lint, and production build pass.
