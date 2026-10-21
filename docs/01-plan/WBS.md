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
- **WBS 6.0:** Public Interfaces (REST API, TS Library & Logging)
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
| **2.6** | **Atomic Claim Query Integration**    | 2.3 | Lead Eng       | 6h   | SQLite conditional `UPDATE` query atomically claims eligible rows and sets `processing`, lease timestamp, and worker id without concurrent double-claims. | Ready  |
| **2.7** | **Stale Lease Recovery Subsystem**    | 2.6           | Full-Stack Eng | 4h   | Reclaims abandoned `processing` rows past lease/timeout thresholds; implements recovery policy per SDD design-checkpoint decision.                                                                                                                                               | Ready  |

---

### WBS 3.0: Ingestion Pipeline & Security Subsystems

| Task ID | Task Description                    | Dependencies  | Owner          | Est. | Acceptance Criteria                                                                                                                                 | Status                                                                                                                      |
| :------ | :---------------------------------- | :------------ | :------------- | :--- | :-------------------------------------------------------------------------------------------------------------------------------------------------- | :-------------------------------------------------------------------------------------------------------------------------- |
| **3.1** | **Constant-Time Authentication**    | 1.2           | Security Eng   | 3h   | Bearer/API token verification via `crypto.timingSafeEqual` with pre-hashed buffers; returns HTTP 401 on missing/invalid credentials.                | Ready                                                                                                                       |
| **3.2** | **Payload & URL Validation (SSRF)** | 1.2           | Security Eng   | 4h   | Strict URL parser blocking IPv4/IPv6 private subnets (RFC 1918), loopback, link-local, and cloud metadata (`169.254.169.254`).                      | Ready                                                                                                                       |
| **3.3** | **Idempotent Ingestion Handler**    | 2.6, 3.1, 3.2 | Full-Stack Eng | 4h   | Single-statement atomic upsert per tenant returning HTTP `202 Accepted` with system-generated `id`, `idempotency_key`, and `idempotent_replay: true | false`indicator without duplicate enqueueing; falls back to configured`WEBHOOK_URL`if optional`destination_url` is omitted. | Ready |

---

### WBS 4.0: Concurrency-Safe Polling & Worker Engine

| Task ID | Task Description                           | Dependencies | Owner       | Est. | Acceptance Criteria                                                                                                                               | Status |
| :------ | :----------------------------------------- | :----------- | :---------- | :--- | :------------------------------------------------------------------------------------------------------------------------------------------------ | :----- |
| **4.1** | **Polling Loop & Batch Claim Coordinator** | 2.6, 2.7     | Backend Eng | 5h   | Configurable polling interval with batch fetching (default batch size: 10); claim loop idle overhead < 10% CPU with graceful throttle when empty. | Ready  |
| **4.2** | **Graceful Shutdown & Signal Handling**    | 4.1          | Backend Eng | 3h   | Clean SIGINT/SIGTERM lifecycle handling: in-flight requests finish or safely release leases; unclaims active batches.                             | Ready  |

---

### WBS 5.0: Dispatch, HTTP Transport & Backoff Engine

| Task ID | Task Description                               | Dependencies | Owner        | Est. | Acceptance Criteria                                                                                                                                                                                                                                                                      | Status |
| :------ | :--------------------------------------------- | :----------- | :----------- | :--- | :--------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | :----- |
| **5.1** | **HMAC-SHA256 Request Signer**                 | 1.2          | Security Eng | 3h   | Canonical header injection (`x-webhook-signature`, `x-webhook-timestamp`) computed across timestamp and raw body payload.                                                                                                                                                                | Ready  |
| **5.2** | **HTTP Dispatcher & Timeout Controller**       | 5.1          | Backend Eng  | 5h   | Native fetch execution with `AbortController` bound to `timeoutLimitMs` (default: 10,000 ms); records status code, latency, and snippet.                                                                                                                                                 | Ready  |
| **5.3** | **Backoff Calculator with Full Jitter**        | 1.2          | Backend Eng  | 3h   | Implements delay = min(base * 2^(attempt - 1), cap) with full jitter next_retry = now + rand(0, delay); unit tests verify boundaries.                                                                                                                                                    | Ready  |
| **5.4** | **Delivery Result Processor & Attempt Logger** | 5.2, 5.3     | Backend Eng  | 4h   | 2xx transitions to `delivered`; non-retryable 4xx (400, 401, 403, 404, 410, 422, default 4xx per ADR-0004) write attempt audit row and immediately transition to terminal `failed`; retryable 4xx (408, 409, 429), 5xx, and timeouts write attempt audit row, increment `attempt_count`, and schedule retry or mark terminal `failed` with `outcome='exhausted'` at `maxAttempts`. Response snippet bounded to <= 1 KB. | Ready  |

---

### WBS 6.0: Public Interfaces (REST API, TS Library & Logging)

| Task ID | Task Description                          | Dependencies | Owner          | Est. | Acceptance Criteria                                                                                                                                                                                                                                                               | Status |
| :------ | :---------------------------------------- | :----------- | :------------- | :--- | :-------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | :----- |
| **6.1** | **REST HTTP Endpoints**                   | 3.3, 5.4     | Full-Stack Eng | 5h   | Endpoints: `POST /webhooks`, `GET /webhooks` (filtered by status), `GET /webhooks/:id` (by system `id` or `idempotency_key`), and `GET /webhooks/:id/attempts`. All read queries strictly scoped by caller `client_id` (BOLA/IDOR prevention returning 404 on mismatched tenant). | Ready  |
| **6.2** | **Programmatic TypeScript SDK Interface** | 4.1, 5.4     | Full-Stack Eng | 4h   | Embedded programmatic export (`createWebhookEngine(...)`) with direct event scheduling and query methods.                                                                                                                                                                         | Ready  |
| **6.3** | **Structured JSON Logger**                | 1.2          | Full-Stack Eng | 2h   | Level-based structured JSON logs with automated masking of sensitive auth tokens and secret keys.                                                                                                                                                                                 | Ready  |

---

### WBS 7.0: Verification, Concurrency Testing & CI/CD Pipeline

| Task ID | Task Description                                 | Dependencies  | Owner        | Est. | Acceptance Criteria                                                                                                                                                                                                                                    | Status |
| :------ | :----------------------------------------------- | :------------ | :----------- | :--- | :----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | :----- |
| **7.1** | **Unit & Critical Path Test Suite**              | 3.1, 3.2, 5.3 | QA / Eng     | 6h   | Vitest suite achieving >= 95% coverage on critical paths (ingestion, atomic claim, retry scheduler/backoff, auth, HMAC/SSRF) and >= 80% overall coverage. Ingestion p95 latency benchmarked under 50 ms.                                               | Ready  |
| **7.2** | **Concurrency & Contention Stress Testing**      | 2.6, 4.1      | QA / Eng     | 8h   | Automated harness simulating >= 1,000 concurrent submissions and >= 100 parallel SQLite workers; exactly 1 job per tenant-key pair and 0 concurrent double-claims under at-least-once semantics. | Ready  |
| **7.3** | **Fault Injection & Crash Recovery Integration** | 2.7, 4.2      | QA / Eng     | 5h   | Process abort simulation verifies stale lease reclamation and resumption without lost events.                                                                                                                                                          | Ready  |
| **7.4** | **CI Workflow Setup**                            | 7.1, 7.2      | DevOps / Eng | 3h   | GitHub Actions workflow executing type checking, linting, unit tests, and SQLite integration/concurrency tests.                                                                                                                                       | Ready  |

---

### WBS 8.0: Documentation & Phase-Gate Review

| Task ID | Task Description                     | Dependencies | Owner    | Est. | Acceptance Criteria                                                                                 | Status |
| :------ | :----------------------------------- | :----------- | :------- | :--- | :-------------------------------------------------------------------------------------------------- | :----- |
| **8.1** | **API & Architecture Documentation** | 6.1, 6.2     | Lead Eng | 3h   | Complete `README.md` and API usage documentation with code samples.                                 | Ready  |
| **8.2** | **Planning Phase Gate Audit**        | 1.1 - 8.1    | Lead Eng | 2h   | 100% compliance check against PRD, Scope, and `00-master-rules.md` checklist prior to starting SDD. | Ready  |
