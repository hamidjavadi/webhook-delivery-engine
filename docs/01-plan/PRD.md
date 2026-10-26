# PRD — Webhook Retry Engine

| Field        | Value                                    |
| ------------ | ---------------------------------------- |
| **Status**   | Approved / Baseline                      |
| **Owner**    | Product Engineer (Hamid Javadi)          |
| **Date**     | 2026-10-15                               |
| **Version**  | 1.0.0                                    |
| **Template** | `.agent-rules/templates/PRD-template.md` |

---

## 1. Status, Owner, Date, Version

- **Status:** Approved / Baseline (v1.0.0) — stakeholder review and approval completed per 00-master-rules.md checkpoint.
- **Owner:** Hamid Javadi (Product Engineer)
- **Baseline Date:** 2026-10-16
- **Document Version:** 1.0.0

---

## 2. Problem and Evidence

### 2.1 Problem Statement

Systems that emit webhooks to external consumers currently fail silently or lose events whenever the target endpoint is temporarily unavailable (network errors, HTTP 5xx, timeouts, rate limits). There is no durable, idempotent, observable retry mechanism embedded in the application process. Consequences:

1. **Silent event loss** — a single failed POST means the event is never delivered; the consumer's state becomes permanently inconsistent.
2. **Duplicate delivery** — ad-hoc in-memory retries (or process restarts) re-send the same payload because there is no persisted delivery state.
3. **No retry policy** — retries are either absent, unbounded, or hammer a struggling endpoint with no backoff.
4. **No observability** — teams cannot answer "why was event X not delivered?" because attempts are not recorded.
5. **Restart fragility** — queued deliveries live in memory and vanish on restart.

### 2.2 Evidence

- **Codebase evidence (README.md):** the existing `webhook-delivery-engine` repository explicitly targets these gaps — its stated Key Goals are _Idempotent Ingestion_, _Durable Persistence_ (embedded SQLite), _Bounded Exponential Backoff_, and _Delivery Observability_. The existence of these goals confirms the problem was identified in the current solution.
- **Operational evidence (typical webhook failure profile):** industry-standard practice (Stripe, GitHub, Shopify) is that a meaningful percentage of webhook deliveries fail transiently (network blips, 5xx, TLS timeouts) and succeed on a later attempt — hence every major webhook platform ships persistent retry with exponential backoff and attempt logging.
- **Incident pattern:** single-shot HTTP POST to `WEBHOOK_URL` (see `.env`: `WEBHOOK_URL=https://example.com/webhook`) means one transient 503 discards the event permanently.

### 2.3 Desired Outcome

A lightweight, embeddable Node.js & TypeScript library that:

- accepts webhook events idempotently,
- persists events and per-attempt state in SQLite for v1.0.0,
- retries failed deliveries with bounded exponential backoff + jitter,
- signs outbound deliveries with HMAC SHA-256 and attributes ingested events to the host-configured client,
- exposes full attempt observability and configuration (timeout, max attempts).

---

## 3. Users and Needs

| #   | User / Persona                                 | Context                                     | Needs                                                                                                                                                     | Pain Today                                             |
| --- | ---------------------------------------------- | ------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------ |
| U1  | **Backend developer integrating the library**  | Embeds the engine in a Node.js ≥ 24 service | Simple typed methods to enqueue events; idempotency by client-scoped `idempotency_key`                                                                  | No off-the-shelf durable retry; hand-rolled retry code |
| U2  | **Ops / SRE engineer**                         | Monitors delivery health                    | Visibility into event states, attempt history, response codes, timestamps; ability to cap attempts and timeouts via config                                | No audit trail; cannot diagnose failed deliveries      |
| U3  | **Webhook consumer (external endpoint owner)** | Receives deliveries at `WEBHOOK_URL`        | Reliable, ordered-enough delivery; verifiable authenticity and the system-generated event `id` (header and body) that consumers can use for deduplication | Duplicates and forged deliveries                       |
| U4  | **Host application developer**                  | Calls the embedded engine from its process  | Simple programmatic ingestion with stable idempotency results; host controls which code can call the engine                                           | Durable delivery without an external ingestion service |
| U5  | **DBA / infrastructure owner**                 | Runs SQLite    | Engine works with safe concurrent claiming and manageable SQLite single-writer locking | SQLite schema and locking behavior                     |

**Primary needs summary:**

- N1: Idempotent ingestion (duplicate submissions → single delivery job).
- N2: Durable persistence of events and retry state across restarts.
- N3: Bounded exponential backoff with jitter, configurable via global config.
- N4: Concurrency-safe atomic claiming of due events across SQLite.
- N5: Security — host-owned in-process access, tenant identity fixed by engine configuration, and HMAC SHA-256-signed deliveries.
- N6: Observability — per-attempt records (timestamp, HTTP status, error, latency).

---

## 4. SMART Goals and Success Criteria

| ID  | Goal (SMART)                                                                                                                                                                                                                                                      | Metric                                                                          | Target                                                                                                                                              | Time-bound               |
| --- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------ |
| G1  | **Specific/Measurable:** Eliminate silent event loss — every accepted event is either delivered, in retry, or terminally failed with a recorded reason.                                                                                                           | Current state and complete attempt history recorded for 100% of accepted events | **100%** of accepted events                                                                                                                         | By v1.0.0 release        |
| G2  | **Idempotency:** Duplicate ingestion with the same `client_id` + `idempotency_key` pair creates exactly one delivery job.                                                                                                                                         | Duplicate ingestion test: unique jobs created / duplicate submissions           | **exactly 1** job per unique (`client_id`, `idempotency_key`) pair (≥ 1000-subject concurrency test passes)                                         | By October 23, 2026      |
| G3  | **Reliability of retries:** Transiently failing endpoint (5xx/timeout) is retried per bounded exponential backoff until `maxAttempts`.                                                                                                                            | Automated integration test with mock endpoint                                   | Retry schedule matches backoff spec ±jitter; no attempt beyond `maxAttempts`; 0 retries after terminal state                                        | By October 22, 2026      |
| G4  | **Concurrency safety:** Two or more workers never hold an active claim on the same due event simultaneously in SQLite. Under at-least-once semantics, duplicate outbound deliveries remain possible only across worker crashes/reclaims. | Parallel SQLite claim integration test                                          | **0** double-claims across ≥ 100 concurrent claims                                                                                                | Before DoD sign-off      |
| G5  | **Security:** In-process ingestion uses the engine's configured tenant identity, rejects caller-supplied identity fields, and all deliveries carry a valid HMAC SHA-256 signature.                                                                                | Ingestion and signature security tests                                          | Caller cannot select another `client_id`; signature verification passes; signing secret is not exposed                                            | Before DoD sign-off      |
| G6  | **Performance:** Programmatic ingestion latency and background claiming remain lightweight for an embeddable library.                                                                                                                                            | Load test                                                                       | p95 ingestion latency **< 50 ms** (SQLite local); claim loop overhead **< 10% CPU** at idle; throughput **≥ 200 events/s** ingestion                | Before v1.0.0            |
| G7  | **Observability:** Any event's full lifecycle is queryable.                                                                                                                                                                                                       | Programmatic query check                                                        | Attempt records include attempt number, timestamp, HTTP status/response, error, latency for **100%** of attempts                                    | By October 23, 2026      |
| G8  | **Quality:** Test coverage threshold met per master rules.                                                                                                                                                                                                        | Vitest coverage report                                                          | Overall **≥ 80%**; critical paths (ingestion, atomic claim, retry scheduler, tenant isolation, HMAC) **≥ 95%**                                       | Before DoD sign-off      |

**Success criteria (release gate):** G1–G5 and G7 fully met; G6 and G8 within stated thresholds; all acceptance criteria in §8 pass.

**Date basis for updated goal bounds:** G2's date is the passing 1,000-submission
concurrency verification recorded by commit `b0ebf1d` (2026-10-23); G3's date
is the retry processing implementation and tests recorded by commit `3a2329f`
(2026-10-22); G7's date is the embedded query/lifecycle and logging delivery
recorded by commits `9bf20ce` and `500938d` (2026-10-23). The stakeholder
approved these evidence-based completion dates on 2026-10-25.

---

## 5. Functional Requirements

> Priorities: **MUST** (v1 required), SHOULD, MAY.

### 5.1 Database Schema — `webhook_events`

Table: `webhook_events` — one row per unique event (idempotency anchor).

| Column Name       | Type                 | Constraints / Description                                                                                                                         |
| ----------------- | -------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| `id`              | TEXT (PK)           | System-generated cryptographically secure UUID string; unique per row and not the client-supplied idempotency key. |
| `idempotency_key` | String               | Client-supplied idempotency key; uniqueness is enforced per client via UNIQUE(`client_id`, `idempotency_key`).                                    |
| `client_id`       | String               | Tenant identity configured by the host for this engine instance and stamped on ingested events.                                                  |
| `destination_url` | String / Text        | Fully qualified HTTPS URL of the destination endpoint.                                                                                            |
| `payload`         | Text / JSON          | Event body/payload to be delivered.                                                                                                               |
| `metadata`        | Text / JSON          | Immutable JSON metadata associated with the event.                                                                                                |
| `headers`         | Text / JSON          | Event-specific outbound headers; engine-owned headers cannot be overridden.                                                                        |
| `status`          | Enum / String        | Current status: `pending`, `processing`, `delivered`, `retry`, `failed`.                                                                          |
| `attempt_count`   | Integer              | Current number of delivery attempts made (default `0`).                                                                                           |
| `next_retry_at`   | Timestamp / DateTime | Next scheduled dispatch time for retries (indexed).                                                                                               |
| `locked_at`       | Timestamp / DateTime | Timestamp when the worker acquired the row lease (nullable).                                                                                      |
| `locked_by`       | String               | Identifier of the worker holding the lease (nullable).                                                                                            |
| `created_at`      | Timestamp / DateTime | Creation timestamp.                                                                                                                               |
| `updated_at`      | Timestamp / DateTime | Last update timestamp.                                                                                                                            |

Indexes: `idx_webhook_events_due (status, next_retry_at)` for the claim query; PK on `id`; UNIQUE(`client_id`, `idempotency_key`) enforces per-client idempotency (the `id` itself is system-generated and globally unique across rows).

### 5.2 Database Schema — `webhook_event_attempts`

Table: `webhook_event_attempts` — append-only audit of every delivery attempt.

| Column             | Type             | Constraints                                            | Description                                    |
| ------------------ | ---------------- | ------------------------------------------------------ | ---------------------------------------------- |
| `id`               | TEXT             | PK                                                     | SQLite text row id                             |
| `event_id`         | TEXT             | NOT NULL, FK → `webhook_events.id` (ON DELETE CASCADE) | Parent event                                   |
| `attempt_number`   | INTEGER          | NOT NULL                                               | 1-based attempt ordinal                        |
| `attempted_at`     | TEXT             | NOT NULL                                               | UTC ISO-8601 attempt start time                |
| `status_code`      | INTEGER          | NULL                                                   | HTTP response status (NULL on network error)   |
| `response_snippet` | TEXT             | NULL                                                   | Truncated response body (bounded, e.g. ≤ 1 KB) |
| `error`            | TEXT             | NULL                                                   | Error text for network/timeout failures        |
| `latency_ms`       | INTEGER          | NULL                                                   | Round-trip duration                            |
| `outcome`          | TEXT enum        | NOT NULL                                               | `success` \| `retry_scheduled` \| `exhausted`  |

Unique composite index: `uq_webhook_event_attempts_event_number (event_id, attempt_number)`.

### 5.3 Global Config

Persisted/managed configuration consumed by the scheduler and delivery worker:

| Key              | Type    | Default | Description                                                                                                                                              |
| ---------------- | ------- | ------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `timeoutLimitMs` | integer | 10 000  | Per-delivery HTTP timeout in milliseconds. MUST be a positive integer; delivery aborts (network error) if exceeded.                                      |
| `maxAttempts`    | integer | 5       | Maximum delivery attempts per event. After `maxAttempts` failed attempts, event becomes `failed` (terminal), with final attempt recorded as `exhausted`. |

- MUST be readable by the scheduler on every cycle (hot-reload or per-cycle fetch) so ops can tune without redeploy.
- MUST be validated at load time (positive integers; `maxAttempts` ≥ 1).
- MUST be supplied by the host through the engine configuration; no admin interface is provided.

### 5.4 Idempotent Ingestion

- **FR-1 (MUST):** Ingesting an event with an existing (`client_id`, `idempotency_key`) pair MUST NOT create a second delivery job. The event `id` is system-generated and unique; idempotency is enforced by UNIQUE(`client_id`, `idempotency_key`) — the same `idempotency_key` submitted by different clients MUST be treated as distinct events. SQLite implements this with a single-statement atomic upsert against that unique constraint, returning whether the row was newly inserted.
- **FR-2 (MUST):** The ingestion result MUST return both identifiers — the system-generated `id` and the accepted `idempotency_key` — and MUST indicate accepted-new vs. duplicate-accepted with `idempotent_replay: true|false` so producers can detect replays and consumers can dedupe by `id`.

### 5.5 SQLite Atomic Claim

- **FR-3 (MUST):** The database-adapter claim operation MUST atomically select due events (`status IN ('pending','retry') AND (next_retry_at IS NULL OR next_retry_at <= now)`), mark them `processing`, and return them — such that no two workers can claim the same event.
- **FR-4 (MUST):** The v1 SQLite adapter must use an atomic conditional `UPDATE` targeting eligible rows, setting `status = 'processing'`, `locked_at`, and `locked_by` in the same operation. Other SQL dialects and their claim implementations are deferred to v2.0.
- **FR-5 (MUST):** Claimed events MUST be recoverable: if a worker crashes mid-delivery, the SQLite adapter MUST atomically return `processing` events whose `locked_at` is strictly older than `now - max(timeoutLimitMs + 30000 ms, 90000 ms)` to `retry`, clear `locked_at`/`locked_by`, and set `next_retry_at` to `now + 10000 ms`. The caller supplies one validated UTC `now`; the adapter validates `timeoutLimitMs`. A scheduler poll loop invokes recovery once per cycle when implemented under WBS 4.1.
- **FR-6 (MUST):** On delivery success → `status='delivered'`; on retryable failure with attempts < `maxAttempts` → `status='retry'` and `next_retry_at` set by backoff; on non-retryable failure or retryable failure with attempts ≥ `maxAttempts` → `status='failed'` with the final attempt row `outcome='exhausted'`.

#### 5.6 Host-Owned Ingestion Identity

- **FR-7 (MUST):** The v1 embedded library MUST accept ingestion through its in-process programmatic interface without requiring an API key on each call.
- **FR-8 (MUST):** The engine MUST use the `clientId` configured by the host when creating the engine; callers MUST NOT be able to select or override the event's `client_id` through ingestion input.
- **FR-9 (MUST):** The engine MUST stamp every accepted event with that configured `clientId`, preserving client-scoped idempotency and tenant-scoped reads.
- **FR-10 (MUST):** The host application is responsible for controlling access to the process and code that holds the engine instance. The embedded library does not provide an external caller authentication or authorization interface in v1.

### 5.7 HMAC SHA-256 Signing (Outbound Delivery)

- **FR-11 (MUST):** Every outbound delivery MUST include an HMAC SHA-256 signature of the request body, computed with a server-side signing secret, in headers (e.g., `x-webhook-signature: sha256=<hex>` and `x-webhook-timestamp`).
- **FR-12 (MUST):** Timestamp MUST be included in the signed material (e.g., `timestamp.body`) to mitigate replay.
- **FR-13 (MUST):** Signing secret MUST come from configuration; requests MUST NOT be delivered unsigned.

### 5.8 Exponential Backoff + Jitter

- **FR-14 (MUST):** Delay before retry _n_ (n = 1-based attempt just failed): `delay = min(base * 2^(n-1), capMs)` with **full jitter**: `next_retry_at = now + random(0, delay)`.
- **FR-15 (MUST):** Defaults: `base = 1000 ms`, `capMs = 60 000 ms` (configurable; caps respect `timeoutLimitMs` independence).
- **FR-16 (MUST):** Backoff stops at `maxAttempts`; no event is retried after terminal `failed`/`delivered`.
- **FR-17 (MUST):** Only 2xx responses count as success. **4xx errors are classified as follows:**
  - **Non-retryable (terminal fail):** 400 (Bad Request), 401 (Unauthorized), 403 (Forbidden), 404 (Not Found), 410 (Gone), 422 (Unprocessable Entity), and other unlisted 4xx responses. These errors are immediately recorded as `failed` with an audit row whose `outcome` is `exhausted`; no further delivery retries are scheduled.
  - **Retryable (with backoff + jitter):** 429 (Too Many Requests), 408 (Request Timeout), 409 (Conflict), 5xx responses, and transport/timeouts. These errors are retried with exponential backoff and full jitter until `maxAttempts` is exhausted; terminal failures use `outcome='exhausted'`.

### 5.9 Programmatic Ingestion & Observability

- **FR-18 (MUST):** The embedded library accepts ingestion input containing `idempotency_key` and JSON `payload`, plus optional `destination_url` falling back to configured `WEBHOOK_URL`. `client_id` is derived from engine configuration; callers MUST NOT supply identity, event id, or timestamps. The strict input schema rejects missing/invalid required fields and unknown fields. On acceptance, the result includes system `id`, `idempotency_key`, `idempotent_replay: true|false`, and `status: "pending"`. A malformed or unsafe configured fallback is a configuration error and must not persist an event.
- **FR-19 (MUST):** The embedded library provides methods to query event status and attempt history (list events by status; get an event with attempts), addressable by system-generated id and/or idempotency key. All reads MUST strictly enforce tenant isolation by scoping database queries to the configured `client_id` (`WHERE id = :id AND client_id = :configuredClientId`). A query for an event belonging to another client MUST return the same not-found result as an unknown event to prevent metadata leakage and BOLA/IDOR.
- **FR-20 (SHOULD):** Structured logging (`LOG_LEVEL`) of lifecycle transitions.
- **FR-21 (MUST):** The claim scheduler runs poll cycles using the configured
  interval, batch size, worker concurrency, and request timeout. Each cycle
  invokes stale-lease recovery exactly once before claiming due events, and
  only atomically claimed events may be passed to the worker-processing seam.
  An empty batch waits for the configured poll interval rather than polling
  continuously. A transient adapter failure is reported without terminating
  the host process, and polling resumes after a throttle interval. OS signal
  registration and in-flight dispatch draining remain WBS 4.2.

---

## 6. Non-Functional Requirements

### 6.1 Security

- NFR-S1 (MUST): The library exposes ingestion only through its in-process engine interface; host applications control access to the engine instance and configured tenant identity (§5.6).
- NFR-S2 (MUST): HMAC SHA-256 signatures with timestamp on all outbound deliveries (§5.7).
- NFR-S3 (MUST): Secrets (HMAC secret, DB credentials) only via environment/config; never logged, never in VCS.
- NFR-S4 (MUST): SQLite data access exclusively uses parameterized statements/prepared statements (no string-concatenated SQL).
- NFR-S5 (SHOULD): The host may apply call-rate controls around ingestion to protect the embedded database; the library provides no external rate-limiting interface in v1.
- NFR-S6 (MUST): **SSRF Protection:** The engine MUST accept only absolute HTTPS destination URLs without embedded credentials. Before dispatch, it MUST resolve hostnames and reject a URL if any resolved IPv4 or IPv6 address is loopback, unspecified, private (including RFC 1918 and IPv6 unique-local), link-local, multicast, reserved, or a cloud metadata target (including `169.254.169.254`). IPv4-mapped IPv6 addresses MUST be checked as their embedded IPv4 address. Literal IPs MUST be checked without DNS. The dispatcher MUST repeat address validation at connection time to reduce DNS-rebinding risk.
- NFR-S7 (MUST): **Tenant Isolation & BOLA/IDOR Prevention:** Although system-generated `id`s are returned upon ingestion and are cryptographically random/non-enumerable, the engine MUST enforce strict tenant boundary checks on all state-retrieval methods. No event or attempt audit record shall ever be read or mutated without matching the configured `client_id`.

### 6.2 Performance

- NFR-P1 (MUST): p95 ingestion latency < 50 ms (SQLite, local disk).
- NFR-P2 (MUST): Claim scheduler poll interval configurable; empty cycles wait
  between polls and idle CPU overhead remains < 10% in the local idle benchmark.
- NFR-P3 (MUST): Batch claiming (configurable batch size, default 10) to amortize transaction overhead.
- NFR-P4 (SHOULD): Ingestion throughput ≥ 200 events/s sustained on SQLite.

### 6.3 Reliability

- NFR-R1 (MUST): All state (events, attempts, config) persists across process restarts; no in-memory-only queue state.
- NFR-R2 (MUST): SQLite atomic claiming guarantees no duplicate concurrent delivery (G4).
- NFR-R3 (MUST): Graceful handling of DB unavailability: scheduler backs off and logs, does not crash the host process.
- NFR-R4 (MUST): Bounded retries — no infinite retry loops; terminal `failed` state after `maxAttempts`.
- NFR-R5 (SHOULD): Stale-claim recovery (FR-5) bounds the impact of worker crashes.

### 6.4 Compatibility

- NFR-C1 (MUST): Node.js ≥ 24.x; TypeScript (strict) per README prerequisites.
- NFR-C2 (MUST): v1.0.0 supports SQLite (`DATABASE_URL`) through the internal database-adapter interface; PostgreSQL and MySQL support are deferred to v2.0.
- NFR-C3 (MUST): The v1.0.0 schema and migrations are provided for SQLite; PostgreSQL and MySQL schemas are deferred to v2.0.
- NFR-C4 (SHOULD): Runs embedded as a library import in a host Node.js process.
- NFR-C5 (MAY): Package Manager pnpm or npm; Vitest test runner (per README scripts).

_(Accessibility/privacy: not applicable to an embeddable backend library; data security is governed by parameterized queries and strict secret isolation.)_

---

## 7. Scope

### 7.1 In-Scope (v1)

- SQLite schema and migrations for `webhook_events` and `webhook_event_attempts`.
- Idempotent event ingestion (single-statement upsert on UNIQUE(`client_id`, `idempotency_key`)) through the embedded library; system-generated event `id` returned alongside the client-supplied `idempotency_key`.
- SQLite database adapter using atomic conditional updates for concurrency safety.
- Delivery worker with per-delivery HTTP timeout (`timeoutLimitMs`).
- Bounded exponential backoff with full jitter; terminal `failed` state at `maxAttempts`.
- Host-configured client identity applied to all ingested events; no per-call API-key authentication in the embedded v1 interface.
- HMAC SHA-256 request signing with timestamp on all outbound deliveries.
- Attempt audit logging (`webhook_event_attempts`) and programmatic status/history queries.
- Structured logging, Vitest unit + integration suites (including SQLite concurrency and security tests), README/docs updates.
- **Concurrency Test:** Automated harness simulating ≥1,000 concurrent submissions with ≥100 parallel SQLite workers; exactly 1 job per tenant-key pair and 0 concurrent double-claims under at-least-once semantics.

### 7.2 Out-of-Scope (v1)

- Runtime client registration and multi-client dispatch configuration. v1 supports one configured client per engine instance; separate tenant identities and HMAC secrets require separately isolated engine/database configurations. Host-managed runtime registration is planned for v2.0.0.
- Per-tenant configuration and retry policies; v1 uses global configuration only.
- Admin UI / dashboard; metrics export to Prometheus/OTel (log-based observability only).
- REST endpoint server and route registration; callers use the embedded TypeScript library. The host may provide its own interface around the library.
- Dead-letter re-drive / manual replay tooling (data model supports future re-drive, but no v1 interface).
- Priority or ordering guarantees between events (per-event delivery only).
- Horizontal multi-node scheduling coordination beyond what the atomic claim guarantees.
- Non-HTTP transports (queues, gRPC), webhooks signing schemes other than HMAC SHA-256.
- Consumer-side signature verification SDK.
- Alternative databases (MongoDB, Redis, etc.).

---

## 8. Acceptance Criteria

| ID   | Criterion (Given/When/Then)                                                                                                                                                                                                                                                                            | Verification                                                   |
| ---- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------- |
| AC1  | Given valid ingestion input and a configured `clientId`, when the host calls the engine, then a single `webhook_events` row with that configured `client_id`, a system-generated unique `id`, and `status='pending'` exists, and the programmatic result returns both identifiers, `idempotent_replay=false`, and pending status. An omitted destination uses the configured `WEBHOOK_URL`, which receives the same URL validation. | Ingestion/SQLite integration test |
| AC2  | Given the same (`client_id`, `idempotency_key`) pair ingested N≥2 times (including concurrently), then exactly one delivery job exists, every result returns its same system id, subsequent calls are flagged `idempotent_replay=true`, and replay does not overwrite the accepted event; the same key from a different `client_id` creates a separate event. | Concurrency test, ≥1000 parallel submissions |
| AC3  | Given two or more workers claiming due events simultaneously in SQLite, then a single atomic conditional `UPDATE ... RETURNING` statement claims only due rows and no event is concurrently claimed by more than one worker; each due claim yields exactly one in-flight dispatch attempt.                                                                 | SQLite cross-process parallel claim integration test (G4, ADR-0001) |
| AC4  | Given a delivery failing with 500/timeout, then the event transitions `pending→processing→retry`, an attempt row is written, and `next_retry_at = now + random(0, min(1000·2^(n−1), 60000))`.                                                                                                          | Unit test on backoff math; integration test with mock endpoint |
| AC5  | Given attempts reach `maxAttempts` (default 5), then the event becomes `failed` and the last attempt row has `outcome='exhausted'`; no further deliveries occur.                                                                                                                                       | Integration test                                               |
| AC6  | Given a delivery exceeding `timeoutLimitMs`, then the request aborts, an attempt row with error `timeout` is recorded, and retry is scheduled.                                                                                                                                                         | Integration test with slow mock endpoint                       |
| AC7  | In-process ingestion requires no API key; accepted events use the engine's configured `clientId`, and caller-supplied identity fields are rejected.                                                                                                                                                  | Engine and ingestion tests |
| AC8  | Given any outbound delivery, then headers contain `x-webhook-signature: sha256=<hex>` and timestamp; recomputing HMAC SHA-256 over `timestamp.body` with the configured secret verifies the signature.                                                                                                 | Signature verification test                                    |
| AC9  | Given a worker crash while an event is `processing`, then only after `max(timeoutLimitMs + 30000 ms, 90000 ms)` has elapsed is its lease reset atomically to `retry`, with lease fields cleared and `next_retry_at = now + 10000 ms`; active/equal-cutoff leases remain unchanged. | SQLite adapter boundary integration tests; poll-cycle invocation is WBS 4.1 |
| AC10 | Given any attempt (success or failure), then `webhook_event_attempts` contains attempt number, timestamp, status code or error, and latency.                                                                                                                                                           | Query check                                                    |
| AC11 | Given restart of the process, then all events/attempts/config persist and the scheduler resumes without unrecorded attempts or dropped events (in-flight events reclaimed per at-least-once semantics).                                                                                                | Restart integration test                                       |
| AC12 | Given caller-supplied tenant identity or an unsigned outbound delivery, the caller cannot create an event under another `client_id`, and the delivery is never sent unsigned.                                                                                                                      | Ingestion identity and signature security tests (G5) |
| AC13 | Vitest suite passes; coverage ≥ 80% overall and ≥ 95% on critical paths (ingestion, atomic claim, retry scheduler, tenant isolation, HMAC).                                                                                                                                                               | `pnpm test` coverage report (G8)                               |
| AC14 | Ingestion schema accepts only the documented request fields and JSON payload; destination validation accepts absolute HTTPS URLs without credentials, rejects malformed URLs and any hostname/IP resolving to blocked IPv4/IPv6 ranges (loopback, private, link-local, unspecified, multicast, reserved, or metadata), and performs no dispatch for rejected destinations. | Schema and SSRF security tests (NFR-S6) |
| AC15 | Given a configured SQLite database, when the adapter is opened and used, then WAL and `busy_timeout=5000` are active; events and attempts round-trip with JSON text and ISO-8601 timestamps; adapter operations preserve tenant scoping, idempotency, lease ownership, and atomic attempt/state transitions. | better-sqlite3 integration tests |
| AC16 | Given a delivery response with a non-retryable 4xx status (including unlisted 4xx codes), then the event transitions directly from `processing` to `failed`, an attempt audit row is recorded with `outcome='exhausted'`, and no retry is scheduled. | Delivery worker unit/integration tests |

---

## 9. Dependencies and Assumptions

### 9.1 Dependencies

- **D1:** Node.js runtime ≥ 24.x; pnpm/npm; Vitest; TypeScript toolchain (per README).
- **D2:** v1.0.0 uses `better-sqlite3`; PostgreSQL (`pg`) and MySQL (`mysql2`) drivers are deferred to v2.0.
- **D3:** Consumer endpoint (`WEBHOOK_URL`) reachable over HTTPS and able to honor HMAC verification (verification itself is out of scope).
- **D4:** Host configuration available: `NODE_ENV`, `LOG_LEVEL`, `DATABASE_URL`, `WEBHOOK_URL`, configured `clientId`, and `HMAC_SECRET`. v1.0 has no API-key ingestion credential or PostgreSQL/MySQL connection settings.
- **D5:** Migration mechanism (hand-written SQL migrations or lightweight migrator) — selected at design checkpoint (ADR if non-trivial).

### 9.2 Assumptions (explicit, low-risk per master rules)

- **A1:** Single process instance in v1 (embedded library); horizontal multi-node deployment is not required for correctness of v1 (atomic claim still guards against accidental multi-worker within/across processes).
- **A2:** Events are delivered at-least-once; consumers are expected to deduplicate using the system-generated event `id` (exposed in both a delivery header, e.g. `x-webhook-event-id`, and the delivery body). Producer-side idempotency is separate and uses the client-supplied `idempotency_key` scoped by `client_id`.
- **A3:** 2xx responses are successful. Per FR-17 and accepted ADR-0004, 400, 401, 403, 404, 410, 422, and other unlisted 4xx responses are terminal failures; 408, 409, 429, 5xx responses, and transport/timeouts are retryable with full jitter until `maxAttempts`.
- **A4:** Global config is single-scope (no per-tenant overrides) in v1.
- **A5:** Clock skew within a single host is negligible; jitter/backoff use the host clock.
- **A6:** Stored response snippets ≤ 1 KB and free of secrets by contract with consumers.

---

## 10. Risks and Constraints

### 10.1 Risk Register

| ID     | Description                                                                                                                                 | Likelihood | Impact | Priority   | Owner          | Trigger                                                                                           | Preventive Action (Mitigation)                                                                                                                                           | Contingency Plan                                                                                           |
| ------ | ------------------------------------------------------------------------------------------------------------------------------------------- | ---------- | ------ | ---------- | -------------- | ------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------- |
| **R1** | **SQLite concurrency bottlenecks** — single-writer locking causes `SQLITE_BUSY` or degrades claim throughput under parallel workers. | Medium | Medium | **Medium** | Core Eng | Worker logs report `SQLITE_BUSY` or claim latency spikes > 200ms. | Use `BEGIN IMMEDIATE` transactions, configure `busy_timeout = 5000ms`, and tune small batch sizes (NFR-P3). | Gracefully throttle polling; any database expansion requires a separately scoped v2.0 decision. |
| **R2** | **SQLite atomic-claim regressions** — transaction or predicate changes permit duplicate claims. | Medium | High | **High** | Core Eng | SQLite multi-worker integration tests fail or duplicate delivery attempts appear in DB. | Validate the conditional `UPDATE` claim and lease ownership with concurrent SQLite tests (AC3). | Block release and fix the SQLite claim transaction before enabling workers. |
| **R3** | **Host exposes an embedded engine to untrusted callers** — host application code may allow untrusted users to invoke ingestion without its own authorization checks. | Low | High | **Medium** | Host App Owner | Untrusted input reaches engine methods without host authorization or validation. | Keep the engine in the host process and enforce any caller authentication/authorization at the host-owned boundary; the library does not authenticate external callers in v1. | Disable the exposed integration and add host-side access controls before accepting untrusted calls. |
| **R4** | **Orphaned `processing` records** — worker process crashes, OOMs, or disconnects mid-dispatch, leaving events stuck in `processing`.        | Medium     | High   | **High**   | Core Eng       | Events remain in `processing` state past the configured timeout without active worker heartbeats. | Atomically recover only leases older than `max(timeoutLimitMs + 30000 ms, 90000 ms)` on scheduler poll cycles (FR-5, AC9); the SQLite adapter operation is implemented in WBS 2.7 and poll-loop invocation in WBS 4.1. | Surface recovery failures and retry the sweep on a later poll cycle; do not reclaim leases inside the safe threshold. |
| **R5** | **Backoff / Jitter misconfiguration** — improper parameters trigger thundering herds on endpoints or excessive dispatch delays.             | Low        | Medium | **Low**    | Core Eng       | Endpoint reports 429/503 spikes or queue drain latency exceeds SLA.                               | Validate configuration schemas at startup (Zod/Valibot); enforce bounded full-jitter exponential backoff and cap max delays (§5.3, AC4).                                 | Fall back to hardcoded safe defaults (min: 1s, max: 60000ms, full-jitter) if user values fail validation.  |
| **R6** | **Secret leakage in logs** — payloads, delivery headers, or signing keys leaked in error stacks or diagnostic logs. | Low | High | **Medium** | Core Eng | Sensitive values detected in application log streams. | Enforce structured logging with automated redaction for delivery secrets, sensitive headers, and request payloads (NFR-S3). | Rotate compromised secrets and update logging sanitization to cover the leaked values. |
| **R7** | **Node.js 24 API drift** — runtime changes in native fetch, crypto, SQLite bindings, or SQLite APIs break behavior. | Low | Medium | **Low** | Core Eng | CI or automated smoke tests fail. | Pin supported dependency versions and test on Node.js 24.x. | Lock dependency versions and isolate SQLite driver behavior behind the storage adapter. |

---

### 10.2 Architectural Constraints

| ID     | Constraint                 | Description & Impact                                                                                                                                                                                                                                                                       | Governance / Compliance                                                                                                      |
| ------ | -------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------- |
| **C1** | **Runtime Environment**    | Node.js ≥ 24.x and TypeScript strict mode (`noImplicitAny`, `strictNullChecks`). No legacy Node support.                                                                                                                                                                                   | README & CI pipeline prerequisite.                                                                                           |
| **C2** | **Zero Heavy Brokers**     | Must remain lightweight, embeddable, and headless. No Redis, RabbitMQ, Kafka, or external broker dependencies.                                                                                                                                                                             | Embedded SQL persistence with in-process event scheduler.                                                                    |
| **C3** | **Master Rule Governance** | No unilateral modifications to scope, acceptance criteria, or thresholds without explicit user approval.                                                                                                                                                                                   | Phase-gate review checkpoints (§1 Status, §11 DoD approvers).                                                                |
| **C4** | **Delivery Semantics**     | Strictly **at-least-once** delivery semantics. Exactly-once is out of scope by design; consumers MUST deduplicate by the delivered system-generated event `id` (header or body). Producer-side idempotency of ingestion is enforced separately via UNIQUE(`client_id`, `idempotency_key`). | Expose the system-generated event `id` in each delivery (header and body) plus HMAC timestamps for downstream deduplication. |

---

## 11. Definition of Done (DoD) and Approvers

### 11.1 Definition of Done

An item/release is **Done** only when ALL of the following hold:

1. **Implementation:** All MUST functional requirements (§5) and MUST non-functional requirements (§6) implemented in TypeScript (strict), per the SDD derived from this PRD.
2. **Testing:** Vitest unit + integration suites pass (`pnpm test`); database integration tests run against SQLite; security tests (tenant identity enforcement, HMAC, idempotency) pass.
3. **Coverage:** Overall coverage **≥ 80%**; critical paths — ingestion, unified atomic claim, retry scheduler/backoff, tenant isolation, HMAC signing — **≥ 95%** (G8, AC13).
4. **Acceptance criteria:** Every criterion in §8 verified with actual recorded test results (no claimed-but-not-run tests, per master rules).
5. **Security review:** Host-owned access boundary, configured tenant identity, HMAC signing, parameterized SQL, and secret handling reviewed and confirmed (NFR-S1–S4, NFR-S6).
6. **Documentation:** README/docs updated (config keys, SQLite schema, delivery semantics: at-least-once + HMAC headers), clearly identifying PostgreSQL/MySQL as deferred to v2.0.
7. **Review:** Code reviewed and approved by Tech Lead; no unresolved critical/high defects.
8. **Consistency:** PRD/SDD/test plan artifacts consistent with the delivered behavior; scope changes only with explicit user approval.
9. **Checkpoint:** Planning→design→implementation→QA→deployment checkpoints completed with user approval per `00-master-rules.md`.

### 11.2 Approvers & Sign-Off Gates

| Role                         | Responsibility                                        | Approval gate                     | Threshold / Rule                                                                                      |
| ---------------------------- | ----------------------------------------------------- | --------------------------------- | ----------------------------------------------------------------------------------------------------- |
| Product Engineer (PRD Owner) | Scope, acceptance criteria, priorities                | PRD sign-off + release acceptance | Required (Explicit sign-off per phase checkpoint)                                                     |
| Tech Lead                    | Design (SDD), implementation quality, security review | SDD + code/DoD sign-off           | Required                                                                                              |
| QA Lead                      | Test plan, coverage report, AC verification           | QA sign-off                       | Required (Code Coverage: **≥ 80% overall, ≥ 95% for critical paths**)                                 |
| End User / Stakeholder       | Final acceptance per master-rules checkpoint          | Checkpoint approvals              | Explicit user checkpoint approval required before transitioning between SDLC phases per master rules. |

**Approval rule:** Release proceeds only upon explicit user checkpoint sign-off for phase transitions, combined with QA code coverage meeting the strict thresholds (**≥ 80% overall**, **≥ 95%** for critical paths: ingestion and tenant isolation, unified atomic claim, retry/backoff, and HMAC/SSRF security).

---

_End of PRD v1.0.0 — structured per `.agent-rules/templates/PRD-template.md`; section order and required headings preserved._

## Hosted Demo Addendum (Approved 2026-10-25)

### Problem and Users

Library consumers need a low-risk way to inspect real ingestion, retries, HMAC signing, and terminal failures without installing or running unfamiliar package code locally. The hosted demo serves the UI and embedded engine from one Node process and routes scenarios only to its own fixed HTTPS mock receiver.

### Goals and Acceptance

- Demonstrate immediate success, retry recovery, terminal 401, max-attempt exhaustion, SSRF rejection, and custom payload/idempotency against a fixed receiver.
- Show event state, attempts, timestamps, latency, and HMAC signature/timestamp metadata from bounded, run-scoped telemetry.
- Keep the demo in `examples/demo` as an independent pnpm project with its own lockfile and configs. Build and pack the root package before installing its tarball dependency; verify the consumer boundary without publishing to npm.
- Host on Render Free with an explicit notice that idle spin-down, restarts, and redeploys reset ephemeral SQLite and demo state. The service is not represented as continuously running or durable.
- Preserve the library's public API, production SSRF policy, pinned dispatcher, and current `failed` terminal state. Do not describe retry exhaustion as a DLQ.

### Constraints, Assumptions, and Exclusions

Express + Vite/React is the approved single-process stack. The server owns the engine, static assets, API, fixed mock receiver, and signal handling. External callers cannot select a target URL, client ID, signing secret, or engine configuration. The demo is educational and non-production; no user data persistence, arbitrary destination delivery, npm publication, multi-instance operation, new engine API, or DLQ/re-drive support is included. Render Free cold starts and ephemeral storage are accepted constraints.
