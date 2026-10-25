# SDD — Webhook Retry Engine

| Field            | Value                                                    |
| ---------------- | -------------------------------------------------------- |
| **Status**       | Approved (v1.0.0); WBS 6.3 design approved |
| **Owner**        | Product Engineer (Hamid Javadi)                          |
| **Date**         | 2026-10-15                                               |
| **Version**      | 1.0.0                                                    |
| **Template**     | `.agent-rules/templates/SDD-template.md`                 |
| **Linked PRD**   | `PRD.md` (v1.0.0, Approved/Baseline)                     |
| **Linked Scope** | `scope.md` (v1.0.0, Approved/Baseline)                   |
| **Linked WBS**   | `WBS.md` (v1.0.0, Approved / Ready for SDD)              |
| **Linked Risks** | `risks.md`                                               |
| **Related ADRs** | `docs/02-design/adr/`                                      |

---

## 1. Context, Goals, and Constraints

### 1.1 Context

The Webhook Retry Engine is a lightweight, embeddable Node.js (≥ 24.x) and TypeScript library that delivers outgoing webhooks to external consumer endpoints with durable persistence, idempotent ingestion, bounded retries, and full attempt observability. Today, single-shot HTTP POSTs to the configured `WEBHOOK_URL` silently discard events on any transient failure (network error, HTTP 5xx, timeout, 429), re-deliver duplicates after restarts, and provide no audit trail. The engine closes these gaps without introducing external message brokers (no Redis, Kafka, or RabbitMQ — constraint C2).

### 1.2 Goals (traceable to PRD §4)

- **G1 — No silent loss:** every accepted event terminates in exactly one of `delivered`, `retry`, or `failed` with a complete recorded attempt history.
- **G2 — Idempotency:** duplicate ingestion of the same (`client_id`, `idempotency_key`) pair creates exactly one delivery job, including under ≥ 1000-subject concurrent submission.
- **G3/G4 — Reliability and concurrency safety:** bounded exponential backoff with full jitter; the driver-neutral claim contract is implemented for SQLite in v1.0 and guarantees no concurrent double-claims with WAL mode.
- **G5 — Security:** host-owned access to in-process ingestion; the engine stamps its configured tenant identity; HMAC SHA-256 signed deliveries with timestamp; strict tenant isolation (BOLA/IDOR prevention); SSRF-safe destination validation.
- **G6/G7 — Performance and observability:** p95 ingestion latency < 50 ms (SQLite local); idle claim overhead < 10% CPU; ≥ 200 events/s sustained ingestion; per-attempt records for 100% of attempts.
- **G8 — Quality:** Vitest coverage ≥ 80% overall and ≥ 95% on critical paths (ingestion, configured tenant identity/isolation, atomic claim, retry scheduler, HMAC).

### 1.3 Non-Goals (Out of Scope, per `scope.md` §3)

Per-tenant configuration and retry policies; admin UI/dashboard; Prometheus/OTel metrics export (structured JSON logs only); dead-letter re-drive/replay tooling; inter-event priority or ordering guarantees; multi-node scheduling coordination beyond the atomic claim guarantee; non-HTTP transports; signing schemes other than HMAC SHA-256; consumer-side verification SDK; alternative databases (MongoDB, Redis).

### 1.4 Constraints

| ID  | Constraint                        | Design Impact                                                                                                  |
| --- | --------------------------------- | -------------------------------------------------------------------------------------------------------------- |
| C1  | Node.js ≥ 24.x, TypeScript strict | Native `fetch`, `node:crypto` for UUIDs and HMAC, strict null checks throughout                              |
| C2  | Zero heavy brokers                | Embedded SQL persistence + in-process scheduler; queue semantics implemented over relational rows              |
| C3  | Master-rule governance            | Schema/API/technology choices finalized only at the design checkpoint with user approval                       |
| C4  | At-least-once delivery            | Consumers deduplicate by system-generated event `id` (delivered in header and body); no exactly-once guarantee |

---

## 2. Architecture and System Boundaries

### 2.1 High-Level View

```mermaid
flowchart LR
    subgraph Client["Producer Application"]
        P[Host application code]
    end
    subgraph Engine["Webhook Retry Engine (embedded library)"]
        API[Programmatic Library Methods]
        TENANT[Configured clientId binding]
        SSRF[URL & Payload Validator]
        ING[Idempotent Ingestion Handler]
        CFG[Global Config Provider]
        SCHED[Claim Scheduler]
        WORK[Delivery Worker]
        SIGN[HMAC Signing Module]
        DB[("Database Adapter Interface\nSQLite (v1.0)")]
    end
    Consumer["Webhook Consumer (external, HTTPS)"]

    P -->|enqueue| API --> TENANT --> SSRF --> ING --> DB
    CFG --> SCHED
    SCHED -->|atomic claim| DB --> WORK
    WORK --> SIGN -->|POST + HMAC headers| Consumer
    API -->|status / attempts, tenant-scoped| DB
```

### 2.2 System Boundaries

- **Inside the boundary:** programmatic ingestion and query methods, configured tenant identity binding, validation, idempotent enqueue, claim scheduler, delivery worker, backoff computation, HMAC signing, attempt audit persistence, DB adapters, migration runner, structured logging.
- **Outside the boundary:** the producer's application (embeds or calls the engine), the external webhook consumer (verifies HMAC at its own discretion), database server administration, reverse proxies/TLS termination.
- **Deployment mode:** v1 is a public npm package imported into a host Node.js process; the host owns its process and signal handlers. The package import entry point is not a CLI or process runner.

### 2.3 Data Flow Summary

Ingestion path (synchronous, fast): the embedded package accepts typed input through its public facade, which binds the engine instance's configured `clientId`. The shared handler validates the strict request schema, resolves and SSRF-validates the effective destination, constructs a server-owned event, and calls the adapter's atomic upsert on `UNIQUE(client_id, idempotency_key)` → returns an application-level result with `{ id, idempotency_key, idempotent_replay, status: "pending" }`. Delivery path (asynchronous): scheduler polls due rows → atomic conditional `UPDATE` claim → worker dispatch with HMAC-signed request → attempt row written → status transition (`delivered` / `retry` with `next_retry_at` / `failed`).

### 2.4 Embedded npm Package and Engine Lifecycle (WBS 6.2)

The package is consumed through the public root entry point. `src/index.ts` exports `createWebhookEngine(...)` plus the public TypeScript option, input, and result types. The package export map exposes this library interface; REST routes and an HTTP server are outside the supported v1 package surface. The library does not start an HTTP listener or register process signal handlers.

`createWebhookEngine(options)` returns a typed engine with `start()`, `stop()`, and programmatic ingestion and tenant-scoped query methods. The configured `clientId` is bound to that engine instance; callers cannot override it per request. `start()` applies pending migrations before starting the scheduler and resolving. Calls that enqueue or query events are accepted only after startup succeeds. The configured `workerCount` bounds active delivery callbacks; additional claimed events remain queued and undispatched. `stop()` is idempotent: it prevents queued callbacks from starting, stops polling and claiming, releases queued claims, waits for already-started callbacks (including attempt persistence) to finish within their configured request timeouts, and closes engine-owned resources. The host application installs signal handlers and awaits `stop()` during its shutdown. The structured logger records safe poll and delivery error context; optional `onError` receives the original error and, for delivery failures, the event.

v1 supports one configured client per engine instance. Because schedulers claim due events across all tenants in the database and dispatch signs with the instance's configured HMAC secret, multiple tenant configurations must not share a database file in v1. Host-managed runtime registration and tenant-specific dispatch configuration are deferred to v2.0.0 (WBS 6.4); the host will remain responsible for the source of client configuration.

The host supplies runtime configuration and a persistent SQLite location to the factory; the engine owns the adapter it creates and closes it on stop. The implementation reuses the existing ingestion validation/idempotency path, dispatcher, scheduler, and tenant-scoped adapter queries rather than exposing internal handlers or requiring the host to compose feature modules.

```mermaid
sequenceDiagram
    participant Host as Host Node.js Application
    participant Package as Public npm Package
    participant Engine as Composed Engine
    participant DB as SQLite Adapter
    participant Scheduler as Claim Scheduler
    participant Worker as Delivery Worker
    Host->>Package: import createWebhookEngine
    Package->>Engine: create from validated options
    Host->>Engine: start()
    Engine->>DB: apply pending migrations
    Engine->>Scheduler: start polling after migrations
    Engine-->>Host: start resolved
    Host->>Engine: enqueue/query using bound clientId
    Scheduler->>DB: recover leases and claim due events
    Scheduler->>Worker: dispatch claimed events
    Host->>Engine: stop()
    Engine->>Scheduler: stop polling and claiming
    Engine->>Worker: drain active dispatches
    Engine->>DB: release undispatched claims and close
    Engine-->>Host: stop resolved
```

### 2.5 Structured JSON Logger (WBS 6.3)

The engine uses the existing `pino` runtime dependency through `src/shared/logger.ts`. `createWebhookEngine` accepts an optional typed `logLevel`; when omitted it uses `LOG_LEVEL`, then defaults to `info`. Supported values are `fatal`, `error`, `warn`, `info`, `debug`, `trace`, and `silent`; invalid values fail during engine construction. Records are newline-delimited JSON written through Pino's standard output destination.

The composition root passes the logger through narrow logging callbacks so feature modules do not write directly to the console. Records identify lifecycle events such as engine start/stop, stale-lease recovery counts, accepted events, claims, dispatch starts, attempt outcomes and persistence results, and scheduler/delivery failures. Records may include event and tenant identifiers, attempt number, status code, latency, and safe error type. They must not include payloads, request bodies, arbitrary event headers, HMAC secrets, raw exception messages, or stacks.

Pino redaction removes known sensitive fields, credential-like values in host-provided data, HMAC key fields, payload/body fields, and nested event/request equivalents as defense in depth. Internal logging uses explicit safe fields and fixed error type labels rather than serializing `WebhookEvent` or raw error objects. The host remains free to configure process output routing; there is no added transport, file sink, or telemetry exporter.

Tests verify supported level selection and filtering, JSON record shape, event context, redaction of sensitive values at nested paths, and that poll/delivery errors do not leak raw messages or stacks.

---

## 3. Modules and Responsibilities

| Module                                 | Responsibility                                                                                                                                                                                                                                           | Key Dependencies                 |
| -------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------- |
| **Domain Types** (WBS 1.2)             | `WebhookEvent`, `AttemptRecord`, `DatabaseAdapter`, `EngineConfig` contracts; the stable seam all modules program against.                                                                                                                               | None                             |
| **Persistence Adapter** (WBS 2.3)      | Storage-owned `SqliteDatabaseAdapter` opens better-sqlite3, configures WAL, `busy_timeout=5000`, and foreign keys, applies SQLite migrations before returning, and implements `DatabaseAdapter` with parameterized SQL. PostgreSQL/MySQL adapters are deferred to v2.0. | Domain Types, Migration Runner   |
| **Migration Runner** (WBS 2.2)         | Idempotent, in-process SQLite DDL migrations; no external CLI. Version/hash ledger and transactional application of scripts under `src/storage/migrations/sql/sqlite/`. | SQLite connection                |
| **Host-Owned Identity** (WBS 3.4)    | Binds the `clientId` configured by the host to the engine instance; ingestion input cannot override it. The host controls access to the process and engine instance. | Engine configuration             |
| **Validator / SSRF Guard** (WBS 3.2)   | Strict Zod ingestion-body schema and absolute-HTTPS URL validation; resolves hostnames and rejects any unsafe IPv4/IPv6 answer before dispatch. Uses Node built-ins and fails closed on lookup errors or empty results. | Domain Types, Node DNS/net, Zod |
| **Ingestion Handler** (WBS 3.3 / 3.4) | Accepts parsed input and the engine-bound `clientId`; rejects invalid input before persistence, uses validated configured `WEBHOOK_URL` only when destination is omitted, constructs a server-owned pending event, and calls the atomic upsert. Returns the existing system id on replay without overwriting the accepted event. | DatabaseAdapter, Validator, configuration |
| **Claim Scheduler** (WBS 4.1)      | Poll loop: invokes SQLite stale-lease recovery once per cycle, then atomically claims due rows and emits claimed batches to workers.                                                                                                                           | Adapters, Config Provider        |
| **Delivery Worker** (WBS 5.x) | Per-event dispatch with `timeoutLimitMs` abort; outcome classification per ADR-0004 (2xx success; non-retryable 4xx terminally fail with `outcome='exhausted'`; retryable 408, 409, 429, 5xx, and timeouts retry until `maxAttempts`); atomically writes attempt rows and applies status transitions (FR-6). | Scheduler, HMAC Module, Adapters    |
| **HMAC Signing Module** (WBS 5.x)      | Computes `HMAC-SHA256(secret, timestamp + '.' + body)`; injects `x-webhook-signature` and `x-webhook-timestamp` headers; refuses unsigned dispatch (FR-13).                                                                                              | Config                           |
| **Config Provider** (WBS 5.x)          | Validates and exposes `timeoutLimitMs` (default 10 000), `maxAttempts` (default 5), backoff `base=1000`, `capMs=60000`, poll interval, batch size (default 10); re-read per cycle for hot-reload; safe fallback to defaults on invalid values (risk R5). | None                             |
| **Query Interface** (WBS 6.x)          | Tenant-scoped programmatic reads of event status and attempt history; every query carries `AND client_id = :configuredClientId`. | Adapters, Engine Configuration   |
| **Engine Composition & Lifecycle** (WBS 6.2) | Public package factory composes migrations, SQLite adapter, ingestion/query facade, scheduler, and delivery worker; exposes explicit asynchronous start/stop lifecycle for the host process. | Existing application modules |
| **Structured Logger** (WBS 6.3)        | Pino-backed JSON lifecycle logging with configured level and mandatory redaction of credentials, HMAC secrets, payloads, and request bodies (risk R6).                                                                                                      | Pino, Engine Composition         |

High cohesion / low coupling: every module depends only on the `DatabaseAdapter` and `EngineConfig` contracts; no module imports a concrete driver directly. This isolates dialect quirks (risk R7) behind the adapter seam.

### 3.1 Core Contract Invariants

- Canonical contracts live in `src/core/types.ts` and `src/core/ports.ts`; `EngineConfig` lives in `src/config/engine.config.ts`. The core has no runtime dependencies. All contract properties and nested JSON values are readonly. Domain timestamps use UTC ISO-8601 strings so they remain immutable and driver-agnostic.
- `WebhookEvent` carries the system `id`, tenant-scoped `idempotencyKey` and `clientId`, SSRF-validated `destinationUrl`, JSON `payload`, JSON `metadata`, delivery `headers`, lifecycle `status`, `attemptCount`, retry/lease fields, and creation/update timestamps. Event-specific headers are persisted as data; engine-owned signing and event-identification headers cannot be overridden by them.
- `AttemptRecord` is append-only and records `eventId`, its 1-based `attemptNumber`, `attemptedAt`, nullable HTTP `statusCode`, bounded nullable `responseSnippet`, nullable error description, nullable `latencyMs`, and an `outcome` of `success`, `retry_scheduled`, or `exhausted`. `exhausted` marks a terminal unsuccessful attempt, including an immediate permanent failure from a non-retryable response as well as retry exhaustion at `maxAttempts`.
- `DatabaseAdapter` owns atomic idempotent upsert, due-row claim, stale-lease recovery, worker-owned lease release, tenant-scoped event reads/listing, attempt-history reads, and atomic attempt-record-plus-event-transition operations. Claiming transitions eligible `pending`/`retry` rows to `processing`, sets lease metadata, and increments `attemptCount`. Appending an attempt and applying its resulting state transition are one database transaction; a transition succeeds only for the worker holding the lease. Read methods must scope by `clientId`.
- `EngineConfig` is readonly and groups worker concurrency, polling/batch limits, request timeout, and retry policy (`maxAttempts`, `baseDelayMs`, `maxDelayMs`). SDD defaults are timeout 10,000 ms, max attempts 5, base delay 1,000 ms, max delay 60,000 ms, and batch size 10. Concurrency and timing values must be positive safe integers; retry maximum must not be less than its base.

---

## 4. Data Model and Migration

### 4.1 `webhook_events` — one row per unique event (idempotency anchor)

| Column                      | Canonical Type      | Constraints / Notes                                                                |
| --------------------------- | ------------------- | ---------------------------------------------------------------------------------- |
| `id`                        | UUIDv4 (PK)         | System-generated, cryptographically random, non-enumerable; never client-supplied. |
| `idempotency_key`           | TEXT                | Client-supplied; uniqueness scoped per client.                                     |
| `client_id`                 | TEXT                | Bound from host configuration when the engine is created; part of `UNIQUE(client_id, idempotency_key)`. |
| `destination_url`           | TEXT                | Fully qualified HTTPS URL, SSRF-validated at ingestion.                            |
| `payload`                   | TEXT (JSON)         | Delivered body.                                                                    |
| `metadata`                  | TEXT (JSON)         | Immutable JSON metadata associated with the accepted event.                        |
| `headers`                   | TEXT (JSON)         | Event-specific outbound headers; reserved engine-owned headers are not overridable. |
| `status`                    | TEXT enum           | `pending` \| `processing` \| `delivered` \| `retry` \| `failed`.                   |
| `attempt_count`             | INTEGER, default 0  | Number of dispatches made.                                                         |
| `next_retry_at`             | TIMESTAMP, nullable | Indexed for claim query; NULL for fresh `pending` rows.                            |
| `locked_at`                 | TIMESTAMP, nullable | Lease acquisition time.                                                            |
| `locked_by`                 | TEXT, nullable      | Worker identifier holding the lease.                                               |
| `created_at` / `updated_at` | TIMESTAMP           | Row timestamps.                                                                    |

Indexes: PK on `id`; `UNIQUE(client_id, idempotency_key)` (idempotency anchor); `idx_webhook_events_due (status, next_retry_at)` (claim query).

### 4.2 `webhook_event_attempts` — append-only audit trail

| Column             | Type      | Notes                                                     |
| ------------------ | --------- | --------------------------------------------------------- |
| `id`               | TEXT      | SQLite text primary key.                                   |
| `event_id`         | TEXT      | NOT NULL, FK → `webhook_events.id` **ON DELETE CASCADE**. |
| `attempt_number`   | INTEGER   | 1-based ordinal.                                          |
| `attempted_at`     | TEXT      | UTC ISO-8601 attempt start.                               |
| `status_code`      | INTEGER   | NULL on network error/timeout.                            |
| `response_snippet` | TEXT      | Bounded ≤ 1 KB, contractually secret-free (A6).           |
| `error`            | TEXT      | Error text (e.g., `timeout`, `ECONNREFUSED`).             |
| `latency_ms`       | INTEGER   | Round-trip duration.                                      |
| `outcome`          | TEXT enum | `success` \| `retry_scheduled` \| `exhausted`; `exhausted` means terminal unsuccessful delivery, including permanent 4xx failure or reaching `maxAttempts`. |

Unique composite index: `uq_webhook_event_attempts_event_number (event_id, attempt_number)`, enforcing one append-only record per event attempt ordinal.

### 4.3 Dialect Mapping and Validation

- **SQLite (v1.0):** TEXT ids, JSON encoded as validated TEXT, ISO-8601 strings for timestamps, WAL mode, `busy_timeout = 5000 ms`, single-statement conditional `UPDATE ... RETURNING` claims, and `BEGIN IMMEDIATE` for multi-statement attempt/state transitions (mitigates R1).
- PostgreSQL and MySQL dialect mappings, schemas, drivers, and adapters are deferred to v2.0 and are not shipped or supported by the v1.0 runtime.
- Validation of all persisted values is enforced at the module boundary with Zod schemas at startup and ingestion.

### 4.4 SQLite Adapter Behavior

`src/storage/sqlite.adapter.ts` is the sole production module that imports `better-sqlite3` or contains adapter SQL. Its asynchronous `open` factory accepts a database filename, opens the connection, enables WAL, sets `busy_timeout=5000` and foreign-key enforcement, applies the bundled SQLite migration, and returns the adapter only after initialization succeeds. If setup or migration fails, it closes the connection and propagates the error. The adapter exposes `close()` for owner-controlled shutdown; downstream modules consume only `DatabaseAdapter`.

All writes are parameterized. JSON values are validated and serialized to JSON text at write boundaries and parsed/validated when read; timestamps are validated and stored as normalized UTC ISO-8601 strings. Tenant-scoped lookup/list/attempt queries always bind `client_id`. Pagination is bounded to 1–1,000 rows and orders by `(created_at, id)` to provide a stable cursor.

Claiming uses the single-statement atomic conditional `UPDATE ... RETURNING` pattern from ADR-0001. The inner ordered limited subquery selects only due `pending`/`retry` rows; the same `UPDATE` sets `processing`, lease owner/time, increments the reserved attempt count, updates the timestamp, and returns each claimed event. It does not select candidate IDs into application memory or issue a separate update/read query, and does not require an explicit surrounding transaction because the SQLite statement itself is atomic. Per the approved WBS 2.6 design checkpoint, `ClaimDueEventsInput.now` supplies one validated UTC ISO-8601 reference timestamp used for due-time comparison, lease acquisition, and update time. This preserves the driver-neutral contract and avoids lexically comparing ISO-8601 text with SQLite's differently formatted `CURRENT_TIMESTAMP`; all claim decisions within a call use the same clock value.

The SQLite adapter's stale-lease recovery accepts a caller-supplied UTC `now` and positive safe-integer `timeoutLimitMs`. It computes `staleThresholdMs = max(timeoutLimitMs + 30000, 90000)`, `staleBefore = now - staleThresholdMs`, and `nextRetryAt = now + 10000 ms`. A single parameterized `UPDATE` changes only rows with `status = 'processing' AND locked_at < staleBefore` to `retry`, clears `locked_at`/`locked_by`, and records the retry/update timestamps. The strict comparison preserves leases exactly at the cutoff; SQL statement atomicity prevents partial recovery. Invalid timeout or timestamp input rejects before writing. The adapter operation is implemented by WBS 2.7; the scheduler poll loop must call it once each cycle under WBS 4.1 and is not part of Task 2.7.

Lease release only changes a lease owned by the requesting worker and reverses its reserved attempt count. Attempt insertion and the corresponding terminal/retry event transition are one `BEGIN IMMEDIATE` transaction: validate the current lease and next attempt ordinal, append the audit row, update state and retry time, and clear lease fields. A stale owner or invalid transition returns `false` without partial writes; database/serialization errors reject the operation.

### 4.5 Migration Policy

Migrations are hand-written, forward-only SQL versioned in-repo under `src/storage/migrations/sql/sqlite/` and applied by the in-house SQLite runner. The runner owns `schema_migrations(version, checksum, applied_at)`, loads SQL files in version order, computes SHA-256 checksums, skips already-applied files with matching checksums, rejects changed or missing applied files, and applies each pending set within one SQLite `BEGIN IMMEDIATE`/`COMMIT` transaction (rolling back on failure). The DDL files do not start nested transactions. PostgreSQL and MySQL migrations are deferred to v2.0. No down-migrations or destructive auto-migrations are supported; a schema change requires an ADR (see §10).

The runner is implemented at `src/storage/migrations/runner.ts` against the SQLite connection surface, with all database operations confined to storage. Runtime composition awaits `SqliteDatabaseAdapter.open()` before starting the scheduler; that factory owns connection configuration and migrations. `src/app/bootstrap.ts` remains a lower-level migration seam for callers that manage a raw SQLite connection and must not be layered around `open()` for the same database. Automated migration/schema tests use Node.js `node:sqlite`; adapter integration tests use better-sqlite3 on temporary files. No PostgreSQL/MySQL test services or environment variables are required for v1.0. The core domain has no driver dependencies.

### 4.6 Sensitive Data and Retention

Secrets (HMAC secret and database credentials) live only in host-supplied configuration, never in the database, logs, or VCS. Payloads and response snippets are stored for the lifetime of the event row; retention beyond that is operator-managed (v1 provides no automatic purge — consistent with the out-of-scope DLQ/re-drive deferral).

---

## 5. Programmatic and Event Contracts

### 5.1 Outbound Delivery Contract (event egress)

- `POST` to `destination_url` with headers: `x-webhook-signature: sha256=<hex HMAC-SHA256(secret, timestamp + '.' + body)>`, `x-webhook-timestamp: <unix seconds>`, `x-webhook-event-id: <system id>`, and the event `id` embedded in the body (FR-11/FR-12, A2). No request is ever dispatched unsigned (FR-13).

#### WBS 5.2.a Connection Pinning (Approved)

For each dispatch, perform a fresh resolution through the existing SSRF address classifier and fail closed if resolution fails, returns no answers, or includes any unsafe answer. Keep the vetted address set internal to the dispatcher and pin the connection to one of those addresses through a request-scoped connector. The request authority remains the original URL hostname: preserve its HTTP `Host`, TLS SNI, certificate-chain validation, and hostname identity check. Do not reuse a connection across dispatch attempts. Keep redirects disabled (`redirect: 'error'`) so no unvalidated target is contacted. Connection, validation, and TLS failures must fail before an HTTP request is sent and must map to the existing generic transport-error result without logging the address or raw exception.

Approved option 1: Undici `fetch` with a per-dispatch `Agent`, an all-answer fresh resolution through the canonical validator, and a custom connector lookup that returns only the first vetted address. The per-dispatch Agent uses one connection, no pipelining, and no TLS session cache; it is closed after the response is consumed. Undici retains the original URL authority for `Host`, SNI, and certificate hostname validation. Node `https.request` was considered but rejected because replacing Fetch would require additional compatibility code for response streaming and redirect/error mapping. ADR-0006 records the accepted choice.

The test plan must include a DNS-rebinding regression that changes the resolver result after ingestion preflight and proves dispatch uses only the fresh vetted pin; rejected mixed/unsafe answers that open no connection; deterministic local TLS integration proving the requested SNI and certificate hostname are the original URL hostname; wrong-host certificate and connection failures that send no HTTP request; disabled redirect behavior; and regression coverage for timeout, signing headers, body, status, latency, and bounded response snippet.

---

### 5.2 Host-Owned Ingestion Identity Contract (WBS 3.4; FR-7–FR-10)

The host creates the engine with one non-empty `clientId`. The embedded library accepts calls through its in-process methods and does not require an API key or authenticate an external caller. The host is responsible for controlling access to the process and to code that holds the engine instance; any external API exposed by a host must enforce its own authentication and authorization.

The engine binds the configured `clientId` to its instance. Ingestion input must reject caller-supplied identity fields, and the handler stamps the bound identity onto every persisted event. The same configured identity scopes idempotency and all event and attempt-history reads. The tenant identity is immutable for an engine instance; runtime client registration and per-tenant dispatch configuration remain deferred to v2.0.0.

WBS 3.4 implements this contract: the public engine configuration has no API-key option, ingestion receives the configured `clientId` from the embedded composition root, and no authentication or unauthorized result is part of the programmatic ingestion flow. The unexported legacy HTTP server, transport routes, and API-key authenticator have been removed because external transport and caller authentication belong to the host application.

### 5.3 Payload and Destination Validation Contract (WBS 3.2; NFR-S6, AC14)

`src/features/ingestion/ingestion.schema.ts` exports the strict Zod schema for ingestion input and its inferred type. It accepts only a non-empty `idempotency_key`, a recursive JSON `payload`, and an optional string `destination_url`; omitted destination URLs are resolved to configured `WEBHOOK_URL` by the ingestion handler and that effective URL is subject to the same validation. Tenant identity and timestamps are server-derived and are not accepted from the caller.

`src/security/ssrf.ts` exports an asynchronous destination validator. It parses with the WHATWG `URL` implementation, requires `https:`, a hostname, and no username/password, and returns a discriminated validation result that contains no resolved addresses or raw resolver errors. Invalid syntax, unsupported protocols, embedded credentials, unsafe targets, empty DNS results, and resolver failures fail closed and map to one generic `422` destination error; schema violations map to `400`. Hostnames use Node's `lookup` with `{ all: true, verbatim: true }`; tests mock this DNS boundary with deterministic results. Validation opens no HTTP connection or socket to the destination.

IP literals are canonicalized by URL parsing and classified directly without DNS. `localhost` and any subdomain of `.localhost` are rejected explicitly, including trailing-dot/case variants. Other hostnames are resolved with Node's `node:dns/promises` lookup requesting all address records. If any returned A or AAAA address is unsafe, the whole hostname is rejected (including mixed public/private answers); an empty result or lookup error is rejected. The address classifier rejects IPv4/IPv6 loopback, unspecified, private (RFC 1918 and IPv6 ULA), link-local, multicast, reserved/special-use ranges, cloud metadata (`169.254.169.254`), and IPv4-mapped IPv6 addresses when the embedded IPv4 address is unsafe. Node's `node:net` IP parser and explicit CIDR comparisons are used; no IP-classification dependency is introduced.

This preflight lookup is not an address pin. DNS can change between validation and connection, so WBS 5.2 must revalidate and bind the connection to a safe resolved address, and redirects must be disabled or every redirect target must receive the same validation. WBS 3.2 does not implement dispatch, TLS configuration, or redirect handling. Unit tests mock the DNS boundary and make no external DNS/network requests.

### 5.4 Idempotent Ingestion Handler Contract (WBS 3.3 / 3.4; FR-1, FR-2, FR-8, FR-9, FR-18; AC1, AC2)

`src/features/ingestion/ingestion.handler.ts` exports the application handler. It receives a `DatabaseAdapter`, the engine-bound `clientId`, untrusted input (`unknown`), and the configured fallback `WEBHOOK_URL`. It validates the input and uses the configured identity before persisting through the adapter.

The handler processes input in this order:

1. Validate the parsed input with `ingestionRequestSchema.safeParse`. Reject unknown fields, caller-supplied identity, and malformed payloads with a generic invalid-request result that does not echo the payload or schema internals.
2. Select the supplied `destination_url` or, only when omitted, configured `WEBHOOK_URL`; run the selected URL through `validateDestinationUrl`. A rejected caller-supplied destination returns a generic invalid-destination result. A rejected configured fallback returns a generic invalid-default-destination result because this is an engine configuration fault. Both paths stop before persistence; resolver details and addresses are never included in results.
3. Construct a `WebhookEvent` using `randomUUID()` for `id`, the engine-bound `clientId`, the schema-validated idempotency key and payload, the canonical validated destination, empty metadata and event-specific headers, `status: 'pending'`, `attemptCount: 0`, null retry/lease fields, and one server-generated UTC timestamp for `createdAt` and `updatedAt`.
4. Call `DatabaseAdapter.upsertEvent` once. The adapter's unique constraint and atomic upsert are the concurrency boundary; the handler performs no check-then-insert, in-memory lock, or second persistence write. A rejected adapter promise propagates unchanged; it is not converted to a success-shaped result.
5. Return an accepted application result containing the stored event's `id`, `idempotency_key`, `idempotent_replay: !inserted`, and pending status. On replay, return the existing event id and do not overwrite the accepted payload, destination, or other stored state. Pending status is the ingestion acknowledgment; status queries remain authoritative if the event has advanced.

The handler result is a discriminated union: accepted, invalid request, invalid caller destination, or invalid configured fallback. There is no authentication or unauthorized result in the embedded ingestion contract. Database failures reject rather than forming a handler result. Rate limiting and external request parsing/authentication belong to a host that chooses to expose its own interface; WBS 3.3/3.4 do not add those transport concerns.

## 6. Key Flows

### 6.1 Idempotent Ingestion Flow

```mermaid
sequenceDiagram
    actor Host as Host Application
    participant Engine as Embedded Engine
    participant Handler as Ingestion Handler
    participant Schema as Request Schema
    participant Val as SSRF Validator
    participant DB as Database Adapter
    Host->>Engine: enqueue(input)
    Engine->>Handler: input + bound clientId + configured fallback
    Handler->>Schema: safeParse(input)
    alt invalid input
        Schema-->>Handler: validation failure
        Handler-->>Engine: invalid request result
        Engine-->>Host: invalid request result
    else valid input
        Schema-->>Handler: validated input
        Handler->>Val: Validate supplied URL or configured fallback
        alt destination invalid
            Val-->>Handler: invalid destination result
            Handler-->>Engine: invalid destination result
            Engine-->>Host: invalid destination result
        else valid destination
            Val-->>Handler: canonical validated URL
            Handler->>DB: Atomic upsert with bound clientId
            DB-->>Handler: stored event + inserted flag
            Handler-->>Engine: accepted result
            Engine-->>Host: accepted result
        end
    end
```

### 6.2 Claim, Deliver, and Retry Flow

```mermaid
sequenceDiagram
    participant Sched as Claim Scheduler
    participant DB as Database Adapter
    participant Work as Delivery Worker
    participant HMAC as HMAC Module
    participant Cons as Webhook Consumer
    Sched->>DB: Recover stale leases (now, timeoutLimitMs)
    DB-->>Sched: recovered row count
    Sched->>DB: Conditional UPDATE claim (due rows -> processing, locked_at, locked_by)
    DB-->>Sched: batch of claimed events (exactly-once per claim)
    Sched->>Work: dispatch(event)
    Work->>HMAC: sign(timestamp + '.' + body)
    Work->>Cons: POST + x-webhook-signature / x-webhook-timestamp
    Cons-->>Work: HTTP response (or timeout)
    Work->>DB: Write attempt row (status_code, latency, outcome)
    alt 2xx
        Work->>DB: status = delivered
    else non-retryable 4xx
        Work->>DB: status = failed, outcome = exhausted
    else failure, attempts < maxAttempts
        Work->>DB: status = retry, next_retry_at = now + random(0, min(1000*2^(n-1), 60000))
    else attempts >= maxAttempts
        Work->>DB: status = failed, last attempt outcome = exhausted
    end
```

### 6.3 Stale-Lease Recovery Flow (FR-5, AC9; ADR-0002)

The caller supplies one UTC reference time and the active `timeoutLimitMs` to the SQLite adapter. The adapter derives `staleThresholdMs = max(timeoutLimitMs + 30000, 90000)` and recovers only processing leases strictly older than `now - staleThresholdMs`. In one parameterized atomic `UPDATE`, it sets `status = 'retry'`, clears `locked_at` and `locked_by`, sets `next_retry_at = now + 10000 ms`, and updates the row timestamp. Active leases, rows at the cutoff, and rows not in `processing` are unchanged. Recovery errors propagate; invalid inputs are rejected before any write. Recovery returns the number of rows updated.

WBS 2.7 implements this adapter operation and its threshold/boundary tests. The WBS 4.1 scheduler poll loop is responsible for calling recovery once per cycle before claiming due events. This task does not implement that loop. The operation uses the supplied UTC reference time rather than SQLite's clock so cutoff and retry boundaries are deterministic and remain consistent with the adapter's ISO-8601 timestamp contract.

**Invariants:** no two live workers hold a claim on the same event (AC3); no attempt beyond `maxAttempts`; no retries after a terminal state (FR-16); every attempt is recorded before the next status transition (AC10).

---

## 7. Security, Privacy, and Failure Modes

### 7.1 Security and Privacy

- **Host-owned access and identity (NFR-S1):** the library accepts ingestion through in-process engine methods without per-call credentials. The host controls access to the process and engine instance; the engine stamps its immutable configured `clientId` and rejects caller-supplied identity (mitigates R3; AC7, AC12).
- **Delivery integrity and replay defense (NFR-S2):** HMAC SHA-256 over `timestamp.body` with the configured secret; timestamp material defeats replay of stale captures.
- **Tenant isolation (NFR-S7):** non-enumerable UUIDv4 ids plus mandatory `client_id` scoping on every read; cross-tenant attempts return `404` (BOLA/IDOR prevention).
- **SSRF protection (NFR-S6, AC14):** URL allow-policy enforcing HTTPS, resolving and rejecting loopback, RFC 1918, link-local, and `169.254.169.254` metadata targets before any socket is opened.
- **SSRF destination safety:** WBS 3.2 rejects unsafe literal/resolved IPv4/IPv6 addresses, malformed/non-HTTPS URLs, credentials in URLs, empty DNS results, and resolver failures before persistence. WBS 5.2.a repeats the full validation immediately before dispatch and pins the socket to a vetted address while retaining the URL hostname for TLS identity. The per-request Agent does not share sockets or TLS sessions across attempts, and redirects remain disabled.
- **SQL safety (NFR-S4):** parameterized/prepared statements exclusively in the SQLite adapter.
- **Secret hygiene (NFR-S3):** host-supplied HMAC and database secrets are not stored in the event database or emitted in logs; structured redaction covers sensitive host-provided values, HMAC secrets, and payloads (mitigates R6).
- **Rate limiting (NFR-S5):** external rate limiting is the host's responsibility if it exposes ingestion to callers; the embedded library provides no external rate-limiting interface in v1.
- **Privacy:** payloads are operator-supplied business data; storage is local to the configured database; no third-party data flows.

### 7.2 Failure Modes and Recovery

| Failure                            | Behavior                                                                                                          | Requirement  |
| ---------------------------------- | ----------------------------------------------------------------------------------------------------------------- | ------------ |
| Non-retryable 4xx                  | Attempt recorded with `outcome='exhausted'`; event becomes terminal `failed`, with no retry scheduled               | FR-17, ADR-0004 |
| Consumer 5xx / network error / 429 | Attempt recorded (`error` or `status_code`), backoff with full jitter applied, `retry` scheduled                  | FR-6, FR-14  |
| Delivery exceeds `timeoutLimitMs`  | Request aborted, attempt row with `error: timeout`, retry scheduled                                               | AC6          |
| Worker crash mid-dispatch          | Stale lease reclaimed after threshold; delivery may repeat (at-least-once, C4)                                    | FR-5, AC9    |
| Process restart                    | All events/attempts/config persist; scheduler resumes; in-flight rows reclaimed                                   | AC11, NFR-R1 |
| DB unavailability                  | Scheduler backs off and logs; host process remains healthy; ingestion returns `503`                               | NFR-R3       |
| SQLite write contention            | `BEGIN IMMEDIATE` + WAL + `busy_timeout`; throttled claim frequency; any move to PostgreSQL/MySQL requires the v2.0 adapter plan | R1 |
| Config misvalidation               | Safe fallback to defaults (base 1 s, cap 60 s, full jitter) on startup validation failure                         | R5           |

---

## 8. Observability, Performance, and Accessibility

- **Observability (G7):** structured JSON logs (`LOG_LEVEL`) for every lifecycle transition — claim, dispatch, attempt outcome, state change, recovery sweep. Attempt history is available through tenant-scoped programmatic queries. Log-based observability only in v1; Prometheus/OTel export deferred to v1.1.
- **Performance (G6, NFR-P1–P4):** p95 ingestion < 50 ms on local SQLite; claim poll interval configurable with idle CPU < 10%; batch claiming (default batch size 10) amortizes transaction overhead; ≥ 200 events/s sustained ingestion target.
- **Compatibility and accessibility:** backend library — UI accessibility standards do not apply. Compatibility: Node ≥ 24.x, TypeScript strict, SQLite in v1.0; PostgreSQL/MySQL adapters deferred to v2.0; embedded package mode (NFR-C4).

---

## 9. Testing and Deployment

### 9.1 Testing Strategy

| Layer              | Tooling                        | Coverage target                                                                     |
| ------------------ | ------------------------------ | ----------------------------------------------------------------------------------- |
| Unit               | Vitest                         | Backoff math, HMAC computation, SSRF guard, config validation, delivery result processing (AC16) |
| Integration        | Vitest + mock endpoints        | Handler validation/result contract, configured tenant identity and ingestion idempotency (AC1/AC2/AC7), retry lifecycle (AC4–AC6), restart recovery (AC11), SQLite adapter (AC15), non-retryable 4xx outcome (AC16) |
| SQLite concurrency | Vitest × SQLite                | ≥ 100 parallel claims with zero double-claims (AC3); ≥ 1,000 same-tenant duplicate ingestion submissions with one row and stable id (AC2) |
| Security suite     | Vitest                         | Host-owned access and identity (AC7), signatures (AC8/AC12), SSRF preflight and connection pinning (AC14/WBS 5.2.a), TLS hostname verification, tenant isolation |
| Fault injection    | Vitest                         | Worker crash recovery (AC9), DB outage backoff                                      |

Thresholds: ≥ 80% overall; ≥ 95% on ingestion, configured tenant identity/isolation, atomic claim, retry scheduler/backoff, HMAC, and SSRF validation paths (G8, AC13). WBS 3.3/3.4 tests cover strict parsed-body schema, caller-vs-config destination errors, successful new/replay response shapes, tenant isolation, immutable original rows on replay, propagated adapter failures, and the 1,000-submission SQLite concurrency criterion. Historical API-key authentication results are recorded in the test plan as historical evidence only. SSRF tests cover strict request schema behavior, URL syntax/protocol/credential rejection, IPv4/IPv6 special ranges, mapped addresses, all DNS answers, empty/error lookups, and no external network use. Verification requires actual recorded test results — claimed-but-not-run tests are prohibited by master rules.

**WBS 8.2.b verification (2026-10-25, `dev` at `d111b3e`):** The re-run
passed the 91-test SSRF/dispatcher suite and 401-test full suite. Overall
coverage was 98.54% statements/lines,
99.09% functions, and 95.53% branches. The dispatcher had 100% statements,
lines, and functions with 97.29% branches; SSRF validation had 98.75%
statements/lines, 100% functions, and 98.55% branches. The atomic-claim
coverage checker reported 100% in all dimensions for both claim helpers. See
`docs/04-testing/test-plan.md` and `docs/01-plan/phase-gate-audit.md` for the
commands, environment, and gate findings.

WBS 7.1 measures the public embedded `enqueue()` path against a temporary local
SQLite file. Complete engine construction, startup, and migrations before
timing; use a literal public IP fixture so validation performs no DNS lookup,
and never dispatch to the destination. Warm up with 100 unique requests, then
time three rounds of 500 unique requests using `performance.now()`. Calculate
each round's p95 with the nearest-rank method and report the median of the
three p95 values, alongside the Node/pnpm versions and host details. The
benchmark is an explicit local QA command rather than a timing assertion in
the normal test suite, since shared CI/host load can distort latency results.
Coverage runs remain the full Vitest suite with V8 instrumentation and report
overall plus each named critical module; tests use deterministic fixtures and
real SQLite where persistence contracts are exercised.

WBS 7.3 validates crash recovery without changing runtime behavior. In a
temporary on-disk SQLite database, a child Node process opens the real adapter,
claims a seeded event, and exits immediately without running adapter cleanup.
The parent verifies the committed `processing` lease survived the child exit,
then advances Vitest's clock beyond the existing
`max(timeoutLimitMs + 30000 ms, 90000 ms)` threshold. A real `ClaimScheduler`
cycle runs recovery before claiming; its worker seam must receive the event
again, proving that the persisted event was not lost. Assertions cover the
recovery retry delay and cleared old lease before the new claim. The fixture
uses supplied/fake timestamps, temporary files, and no network access. This
checks at-least-once resumption; it does not claim exactly-once dispatch across
the crash window. Keep the child isolated and await its exit before removing
the database directory.

### 9.2 Migration and Deployment

- Embedded deployment imports the public npm package into a host Node.js process; `start()` applies migrations before scheduler activation and `stop()` drains or safely releases work. The library import is not a process entry point.
- Embedded factory configuration (D4) is supplied by the host: SQLite location, default destination, delivery HMAC secret, configured client identity, and worker/retry settings; v1.0 has no API-key ingestion credential or PostgreSQL/MySQL connection settings.
- Rollback strategy: forward-only migrations; rollback is a previous release binary against a compatible schema (additive-only changes in v1.x).
- WBS traceability: design covers WBS 1.0–8.0; the implementation phase begins only after design-checkpoint approval per master rules.

---

## 10. Options, Trade-offs, and Related ADRs

| Decision               | Selected Option                                                                              | Rejected Alternatives & Rationale                                                                                      |
| ---------------------- | -------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| Queue substrate        | Relational tables + atomic conditional `UPDATE` claim                                        | External broker (Redis/Kafka/RabbitMQ) — violates lightweight-embeddable constraint C2 and adds operational surface    |
| Claim primitive        | SQLite conditional `UPDATE ... WHERE status IN ('pending','retry')` returning affected rows | Row-locking designs are unnecessary for v1's SQLite-only scope and require a separate dialect decision in v2.0                         |
| Delivery semantics     | At-least-once with consumer deduplication by system `id`                                     | Exactly-once — impossible across crash windows without two-phase consumer acknowledgement; out of scope (C4)           |
| Retry policy           | Bounded exponential backoff with **full jitter**                                             | Fixed-interval retries — thundering-herd risk on struggling endpoints (R5)                                             |
| Non-2xx classification      | HTTP 2xx success; non-retryable client errors (400, 401, 403, 404, 410, 422, other 4xx by default) transition immediately to terminal `failed` with `outcome='exhausted'`; retryable errors (408, 409, 429, 5xx, timeouts) retried with jittered backoff until `maxAttempts`, then fail with `outcome='exhausted'` (ADR-0004) | All non-2xx retryable indiscriminately — rejected per ADR-0004 to prevent worker queue starvation and DoS on dead/misconfigured endpoints (FR-17/A3) |
| Stale-lease recovery   | Scheduler invokes the SQLite adapter's atomic stale-lease sweep each poll cycle (WBS 4.1); threshold is `max(timeoutLimitMs + 30000 ms, 90000 ms)` and retry delay is 10 seconds (ADR-0002) | Heartbeat-only leases — extra write amplification; 2.7 adapter implementation is deliberately separate from the WBS 4.1 poll loop |
| Id generation          | Server-side UUIDv4 (non-enumerable)                                                          | Client-supplied ids — trust and enumeration risk; sequence ids — enumerable, BOLA-prone                                |
| Destination validation and connection pinning | ADR-0005: Node built-ins, HTTPS-only strict URL parsing, all-address DNS validation, and fail-closed handling. ADR-0006: per-dispatch Undici Agent pins the socket to a freshly vetted answer while retaining the original HTTPS hostname for SNI and certificate identity; redirects remain disabled. | URL syntax-only validation misses hostname SSRF; using only the preflight answer leaves DNS rebinding; a new IP library does not solve the connection boundary |

**Related ADRs:** [ADR-0001 — Atomic Claim](adr/ADR-0001-unified-atomic-claim-pattern.md); [ADR-0002 — Stale-Lease Recovery](adr/ADR-0002-stale-lease-recovery-mechanism.md); [ADR-0003 — Migration Runner](adr/ADR-0003-migration-runner-selection.md); [ADR-0004 — 4xx Classification](adr/ADR-0004-non-retryable-4xx-classification.md); [ADR-0005 — SSRF Validation](adr/ADR-0005-ssrf-destination-validation.md); [ADR-0006 — Connection Pinning](adr/ADR-0006-dispatch-connection-pinning.md). Future database dialects require separate design and validation.

**Traceability & approval:** this SDD is derived from and consistent with `PRD.md` (requirements FR-1–FR-20, NFR-S/P/R/C, AC1–AC16), `scope.md` (§2 in-scope, §3 exclusions), `WBS.md` (work packages 1.1–8.x), and the risk register (R-01–R-12). The WBS 5.2.a transport design in ADR-0006 was approved at the design checkpoint on 2026-10-24; implementation and its security tests were merged in PR #83 on 2026-10-25. The WBS 8.2.b retrospective phase-gate decision is Go with an explicitly accepted historical sequencing exception; the checkpoint approval is recorded in `docs/01-plan/phase-gate-audit.md`.

---


## 11. Feature-Based Directory Layout and Source Organization

To keep the codebase aligned with the feature seams defined in §3, the source tree is organized **feature-first**: ingestion, scheduler, and delivery own their handlers, schemas, and tests. The embedded composition root exposes tenant-scoped query methods through the database adapter; query methods do not form a separate HTTP feature. Cross-cutting concerns (contracts, security primitives, configuration, persistence, and logging) live in shared layers.

### 11.1 Directory Structure

```text
src/
├── index.ts                            # Public package root exports
├── app/                                # Embedded composition and lifecycle
│   ├── bootstrap.ts                    # Startup sequencing
│   ├── embedded.ts                     # createWebhookEngine and public methods
│   └── lifecycle.ts                    # Graceful shutdown and claim cleanup
├── config/
│   └── engine.config.ts                # Concurrency, timeout, and retry contracts
├── core/
│   ├── errors.ts                       # Typed domain errors
│   ├── ports.ts                        # Database adapter contract
│   └── types.ts                        # Event, attempt, and JSON types
├── features/
│   ├── delivery/                       # Dispatch, signing, retry, and result handling
│   ├── ingestion/                      # Strict schema and idempotent ingestion handler
│   └── scheduler/                      # Poll loop, recovery, and batch claiming
├── security/
│   └── ssrf.ts                         # HTTPS destination and address validation
├── shared/
│   └── logger.ts                       # Structured logging and redaction
└── storage/
    ├── migrations/                     # SQLite migration runner and SQL files
    └── sqlite.adapter.ts               # SQLite persistence implementation
```

### 11.2 Dependency Rules

- **features → core, storage, security, shared, config:** allowed. Features never import each other directly; cross-feature interaction goes through `core/ports.ts` interfaces (e.g., the scheduler consumes `DatabaseAdapter` contracts, not ingestion internals).
- **core** depends on nothing (pure types and contracts); **storage, security, shared, config** may depend on `core` only. Keep imports acyclic and enforce these boundaries in code review.
- **storage** is the only layer that imports database drivers (`better-sqlite3` in v1.0); all statements remain parameterized (NFR-S4). PostgreSQL/MySQL drivers are deferred to v2.0.
- **security** contains destination validation and other security primitives; the host owns any external caller authentication or rate limiting, while engine composition binds the configured tenant identity.
- **app/** is the only place that instantiates concrete adapters and wires features together (composition root). `src/index.ts` is the public npm import barrel and re-exports `createWebhookEngine` from `app/embedded.ts`.

### 11.3 Rationale

- **Change locality:** adding a consumer-facing capability (e.g., future re-drive tooling) is a new `src/features/<name>/` folder — no edits scattered across a layer-first tree.
- **Testability parity with §9:** feature tests are colocated with their implementation and mapped to acceptance criteria (AC1–AC14); project coverage targets are tracked by the test plan and CI.
- **Constraint fit:** the layout preserves the low-coupling rule of §3 (modules program against `DatabaseAdapter` and `EngineConfig` contracts) and keeps SQLite-specific behavior in `src/storage/sqlite.adapter.ts` and SQLite migrations.
- **Master-rule compliance:** layout finalized at design checkpoint; structural changes after approval require an ADR.

---

_End of SDD v1.0.0 — structured per `templates/SDD-template.md`; section order and required headings preserved._
