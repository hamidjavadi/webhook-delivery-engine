# WBS.md — Work Breakdown Structure

**Project:** Webhook Delivery Engine  
**Release Target:** v1.0.0  
**Status:** Approved / SDD Approved
**Schema Standard:** `[ID] Deliverable / Task | Dependencies | Owner | Estimate | Acceptance Criteria | Status`

---

## Summary Overview (Level 1 WBS)

- **WBS 1.0:** Project Setup, Tooling & Core Architecture Foundation
- **WBS 2.0:** Persistence Layer & Schema Migration (SQLite-focused)
- **WBS 3.0:** Ingestion Pipeline & Security Subsystems
- **WBS 4.0:** Concurrency-Safe Polling & Worker Engine
- **WBS 5.0:** Dispatch, HTTP Transport & Backoff Engine
- **WBS 6.0:** Public Interfaces (TS Library & Logging)
- **WBS 7.0:** Verification, Concurrency Testing & CI/CD Pipeline
- **WBS 8.0:** Documentation & Phase-Gate Review

---

## Detailed Work Breakdown (Levels 2 & 3)

### WBS 1.0: Project Setup, Tooling & Core Architecture Foundation

| Task ID | Task Description                     | Dependencies | Owner    | Est. | Acceptance Criteria                                                                                      | Status |
| :------ | :----------------------------------- | :----------- | :------- | :--- | :------------------------------------------------------------------------------------------------------- | :----- |
| **1.1** | **Repository & Environment Init**    | None         | Lead Eng | 2h   | Node.js ≥ 24.x target configured, strict TypeScript (`tsconfig.json`), ESLint, and Prettier established. | Done   |
| **1.2** | **Project Architecture & Contracts** | 1.1          | Lead Eng | 4h   | Core domain types defined (`WebhookEvent`, `AttemptRecord`, `DatabaseAdapter`, `EngineConfig`).          | Done   |

---

### WBS 2.0: Persistence Layer & Schema Migration (SQLite-focused)

| Task ID | Task Description                      | Dependencies  | Owner          | Est. | Acceptance Criteria                                                                                                                                                                                                                                                              | Status |
| :------ | :------------------------------------ | :------------ | :------------- | :--- | :------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | :----- |
| **2.1** | **DDL Schema Definitions**            | 1.2           | Data Eng       | 4h   | `webhook_events` & `webhook_event_attempts` DDL specs written for SQLite with explicit composite indexes on `(status, next_retry_at)` and `(event_id, attempt_number)`.                                                                                   | Done   |
| **2.2** | **Migration Runner Subsystem**        | 2.1           | Data Eng       | 4h   | Idempotent migration runner applying DDL migrations cleanly without external CLI tools.                                                                                                                                                     | Done   |
| **2.3** | **SQLite Adapter (`better-sqlite3`)** | 2.2           | Full-Stack Eng | 4h   | Implements all DatabaseAdapter operations with parameterized SQL, JSON/ISO timestamp round-trips, tenant/idempotency/lease invariants, WAL, busy_timeout=5000, and transactional claim/attempt state changes; verified with real SQLite integration tests. | Done |
| **2.4** | **PostgreSQL Adapter (`pg`)**         | 2.2           | Full-Stack Eng | 4h   | Connection pooling, parameterized queries, and dialect-specific atomic upsert (`ON CONFLICT DO NOTHING`) verified.                                                                                                                                                               | Deferred to v2.0  |
| **2.5** | **MySQL Adapter (`mysql2`)**          | 2.2           | Full-Stack Eng | 4h   | Parameterized queries, connection pooling, and atomic upsert (`INSERT IGNORE`) verified.                                                                                                                                                                                         | Deferred to v2.0  |
| **2.6** | **Atomic Claim Query Integration**    | 2.3 | Lead Eng       | 6h   | One SQLite conditional `UPDATE ... RETURNING` statement atomically claims only due rows and sets `processing`, lease timestamp, worker id, attempt count, and update time; cross-process tests prove no double-claims. | Done  |
| **2.7** | **Stale Lease Recovery Subsystem**    | 2.6           | Full-Stack Eng | 4h   | SQLite adapter atomically reclaims only `processing` rows older than `max(timeoutLimitMs + 30000 ms, 90000 ms)`, clears lease fields, and schedules retry at supplied `now + 10000 ms`; boundary/active-lease tests pass. Poll-loop invocation remains WBS 4.1. | Done |

---

### WBS 3.0: Ingestion Pipeline & Security Subsystems

| Task ID | Task Description                    | Dependencies  | Owner          | Est. | Acceptance Criteria                                                                                                                                 | Status                                                                                                                      |
| :------ | :---------------------------------- | :------------ | :------------- | :--- | :-------------------------------------------------------------------------------------------------------------------------------------------------- | :-------------------------------------------------------------------------------------------------------------------------- |
| **3.1** | **Constant-Time API-Key Authentication (Superseded)** | 1.2 | Security Eng | 3h | Historical implementation verified an API key and resolved its configured `clientId`. API-key authentication is no longer part of the v1 embedded-library scope. | Superseded |
| **3.2** | **Payload & URL Validation (SSRF)** | 1.2 | Security Eng | 4h | Validate the documented ingestion JSON shape; accept only absolute HTTPS destination URLs without credentials; reject malformed URLs and any literal/resolved IPv4/IPv6 address in loopback, private, link-local, unspecified, multicast, reserved, or metadata ranges before dispatch. | Done |
| **3.3** | **Idempotent Ingestion Handler** | 2.6, 3.2 | Full-Stack Eng | 4h | Validate parsed input and configured tenant identity, apply and validate WEBHOOK_URL fallback, atomically upsert by `(client_id, idempotency_key)`, and return an accepted result with system `id`, `idempotency_key`, replay flag, and pending status; duplicates never create another event. | Done; update required by 3.4 |
| **3.4** | **Host-Owned Ingestion Identity** | 3.3 | Full-Stack Eng | TBD | Remove API-key requirements from embedded engine configuration and ingestion; stamp the host-configured `clientId` on accepted events, reject caller-supplied identity, and verify idempotency and tenant-scoped reads. | Ready |

---

### WBS 4.0: Concurrency-Safe Polling & Worker Engine

| Task ID | Task Description                           | Dependencies | Owner       | Est. | Acceptance Criteria                                                                                                                               | Status |
| :------ | :----------------------------------------- | :----------- | :---------- | :--- | :------------------------------------------------------------------------------------------------------------------------------------------------ | :----- |
| **4.1** | **Polling Loop & Batch Claim Coordinator** | 2.6, 2.7     | Backend Eng | 5h   | Run configurable poll cycles; recover stale leases before claiming at most the configured batch size; hand only claimed events to the worker seam; wait between empty polls; continue after reported transient adapter failures; idle CPU overhead < 10%. No OS signal handling or dispatch draining. | Done |
| **4.2** | **Graceful Engine Shutdown**    | 4.1          | Backend Eng | 3h   | `stop()` stops polling, drains started dispatches, safely releases claimed-but-undispatched work, and closes engine-owned resources. The host owns OS signal registration and invokes `stop()` during shutdown. | Done |

---

### WBS 5.0: Dispatch, HTTP Transport & Backoff Engine

| Task ID | Task Description                               | Dependencies | Owner        | Est. | Acceptance Criteria                                                                                                                                                                                                                                                                      | Status |
| :------ | :--------------------------------------------- | :----------- | :----------- | :--- | :--------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | :----- |
| **5.1** | **HMAC-SHA256 Request Signer**                 | 1.2          | Security Eng | 3h   | Canonical header injection (`x-webhook-signature`, `x-webhook-timestamp`) computed across timestamp and raw body payload.                                                                                                                                                                | Done   |
| **5.2** | **HTTP Dispatcher & Timeout Controller**       | 5.1          | Backend Eng  | 5h   | Native fetch execution with `AbortController` bound to `timeoutLimitMs` (default: 10,000 ms); records status code, latency, and snippet.                                                                                                                                                 | Done   |
| **5.3** | **Backoff Calculator with Full Jitter**        | 1.2          | Backend Eng  | 3h   | Implements delay = min(base * 2^(attempt - 1), cap) with full jitter next_retry = now + rand(0, delay); unit tests verify boundaries.                                                                                                                                                    | Done   |
| **5.4** | **Delivery Result Processor & Attempt Logger** | 5.2, 5.3     | Backend Eng  | 4h   | 2xx transitions to `delivered`; non-retryable 4xx (400, 401, 403, 404, 410, 422, and other default 4xx per ADR-0004) write an attempt audit row with `outcome='exhausted'` and immediately transition to terminal `failed`; retryable 4xx (408, 409, 429), 5xx, and timeouts write an attempt audit row, increment `attempt_count`, and schedule retry or mark terminal `failed` with `outcome='exhausted'` at `maxAttempts`. Response snippet bounded to <= 1 KB. | Done |

---

### WBS 6.0: Public Interfaces (TS Library & Logging)

| Task ID | Task Description                          | Dependencies | Owner          | Est. | Acceptance Criteria                                                                                                                                                                                                                                                               | Status |
| :------ | :---------------------------------------- | :----------- | :------------- | :--- | :-------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | :----- |
| **6.1** | **Tenant-Scoped Query Service**            | 3.3, 5.4     | Full-Stack Eng | 5h   | Provide internal status lookup, listing, and attempt-history operations; all reads are scoped by configured `client_id`. | Done |
| **6.2** | **Embedded TypeScript Package & Engine Lifecycle** | 2.2, 2.3, 3.2, 3.3, 3.4, 4.1, 4.2, 5.4 | Full-Stack Eng | 10h | Public npm package exposes a documented, typed `createWebhookEngine(...)` entry point with programmatic ingestion and query methods. The factory composes migrations, storage, configured tenant identity, scheduler, and delivery dispatcher; startup completes migrations before accepting work. Published package metadata/build output exposes ESM and TypeScript declarations and is verified with `npm pack` plus a host-application install/import integration test. `start()` and `stop()` provide a tested lifecycle: stop polling, finish or safely release claimed-but-undispatched work, and close owned resources. Embedded use does not require a CLI or standalone process entry point. | Done; update required by 3.4 |
| **6.3** | **Structured JSON Logger**                | 1.2          | Full-Stack Eng | 2h   | Level-based structured JSON logs with automated redaction of sensitive payloads, request/delivery fields, and signing secrets.                                                                                                                                                  | Done  |
| **6.4** | **Host-Managed Runtime Client Registration** | 6.2, 3.4, 5.4 | Full-Stack Eng | TBD | Host application can register, update, and remove clients at runtime without rebuilding; engine creation resolves the configured client, and delivery selects that client's configuration and HMAC secret. Define safe rotation/removal semantics and verify tenant isolation and multi-instance behavior. | Deferred to v2.0.0 |

---

### WBS 7.0: Verification, Concurrency Testing & CI/CD Pipeline

| Task ID | Task Description                                 | Dependencies  | Owner        | Est. | Acceptance Criteria                                                                                                                                                                                                                                    | Status |
| :------ | :----------------------------------------------- | :------------ | :----------- | :--- | :----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | :----- |
| **7.1** | **Unit & Critical Path Test Suite**              | 3.2, 3.4, 5.3 | QA / Eng     | 6h   | Vitest suite achieving >= 95% coverage on critical paths (ingestion, configured tenant identity/isolation, atomic claim, retry scheduler/backoff, HMAC/SSRF) and >= 80% overall coverage. Ingestion p95 latency benchmarked under 50 ms. | Pending 3.4 |
| **7.2** | **Concurrency & Contention Stress Testing**      | 2.6, 4.1      | QA / Eng     | 8h   | Automated harness simulating >= 1,000 concurrent submissions and >= 100 parallel SQLite workers; exactly 1 job per tenant-key pair and 0 concurrent double-claims under at-least-once semantics. | Done  |
| **7.3** | **Fault Injection & Crash Recovery Integration** | 2.7, 4.2      | QA / Eng     | 5h   | Process abort simulation verifies stale lease reclamation and resumption without lost events.                                                                                                                                                          | Done  |
| **7.4** | **CI Workflow Setup**                            | 7.1, 7.2      | DevOps / Eng | 3h   | GitHub Actions workflow executing type checking, linting, unit tests, and SQLite integration/concurrency tests.                                                                                                                                       | Done  |

---

### WBS 8.0: Documentation & Phase-Gate Review

| Task ID | Task Description                     | Dependencies | Owner    | Est. | Acceptance Criteria                                                                                 | Status |
| :------ | :----------------------------------- | :----------- | :------- | :--- | :-------------------------------------------------------------------------------------------------- | :----- |
| **8.1** | **API & Architecture Documentation** | 6.1, 6.2     | Lead Eng | 3h   | Complete `README.md` and API usage documentation with code samples.                                 | Ready  |
| **8.2** | **Planning Phase Gate Audit**        | 1.1 - 8.1    | Lead Eng | 2h   | 100% compliance check against PRD, Scope, and `00-master-rules.md` checklist prior to starting SDD. | Ready  |
