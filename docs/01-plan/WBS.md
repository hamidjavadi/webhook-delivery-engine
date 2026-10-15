# WBS.md — Work Breakdown Structure

**Project:** Webhook Delivery Engine  
**Release Target:** v1.0.0  
**Status:** Approved / Ready for SDD (System Design Document)  
**Schema Standard:** `[ID] Deliverable / Task | Dependencies | Owner | Estimate | Acceptance Criteria | Status`

---

## Summary Overview (Level 1 WBS)

- **WBS 1.0:** Project Setup, Tooling & Core Architecture Foundation
- **WBS 2.0:** Multi-Dialect Persistence Layer & Schema Migration
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
| **1.1** | **Repository & Environment Init**    | None         | Lead Eng | 2h   | Node.js ≥ 24.x target configured, strict TypeScript (`tsconfig.json`), ESLint, and Prettier established. | Ready  |
| **1.2** | **Project Architecture & Contracts** | 1.1          | Lead Eng | 4h   | Core domain types defined (`WebhookEvent`, `AttemptRecord`, `DatabaseAdapter`, `EngineConfig`).          | Ready  |

---

### WBS 2.0: Multi-Dialect Persistence Layer & Schema Migration

| Task ID | Task Description                      | Dependencies  | Owner          | Est. | Acceptance Criteria                                                                                                                                                                            | Status |
| :------ | :------------------------------------ | :------------ | :------------- | :--- | :--------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | :----- |
| **2.1** | **DDL Schema Definitions**            | 1.2           | Data Eng       | 4h   | `webhook_events` & `webhook_event_attempts` DDL specs written for SQLite, PostgreSQL, and MySQL with explicit composite indexes on `(status, next_retry_at)` and `(event_id, attempt_number)`. | Ready  |
| **2.2** | **Migration Runner Subsystem**        | 2.1           | Data Eng       | 4h   | Idempotent migration runner applying DDL migrations cleanly across all 3 supported DBMS dialects without external CLI tools.                                                                   | Ready  |
| **2.3** | **SQLite Adapter (`better-sqlite3`)** | 2.2           | Full-Stack Eng | 4h   | Full ACID execution, parameterized statements, synchronous WAL-mode support passing basic CRUD tests.                                                                                          | Ready  |
| **2.4** | **PostgreSQL Adapter (`pg`)**         | 2.2           | Full-Stack Eng | 4h   | Connection pooling, parameterized queries, and dialect-specific atomic upsert (`ON CONFLICT DO NOTHING`) verified.                                                                             | Ready  |
| **2.5** | **MySQL Adapter (`mysql2`)**          | 2.2           | Full-Stack Eng | 4h   | Parameterized queries, connection pooling, and atomic upsert (`INSERT IGNORE`) verified.                                                                                                       | Ready  |
| **2.6** | **Atomic Claim Query Integration**    | 2.3, 2.4, 2.5 | Lead Eng       | 6h   | Single atomic conditional `UPDATE` query per dialect claiming rows (`processing`, `locked_by`, `locked_at`) with zero double-claim risk under contention.                                      | Ready  |
| **2.7** | **Stale Lease Recovery Subsystem**    | 2.6           | Full-Stack Eng | 4h   | Query resets abandoned `processing` rows whose `locked_at` exceeds lease timeout back to `pending`/`retry`.                                                                                    | Ready  |

---

### WBS 3.0: Ingestion Pipeline & Security Subsystems

| Task ID | Task Description                    | Dependencies  | Owner          | Est. | Acceptance Criteria                                                                                                                                                | Status |
| :------ | :---------------------------------- | :------------ | :------------- | :--- | :----------------------------------------------------------------------------------------------------------------------------------------------------------------- | :----- |
| **3.1** | **Constant-Time Authentication**    | 1.2           | Security Eng   | 3h   | Bearer/API token verification via `crypto.timingSafeEqual` with pre-hashed buffers; returns HTTP 401 on missing/invalid credentials.                               | Ready  |
| **3.2** | **Payload & URL Validation (SSRF)** | 1.2           | Security Eng   | 4h   | Strict URL parser blocking IPv4/IPv6 private subnets (RFC 1918), loopback, link-local, and cloud metadata (`169.254.169.254`).                                     | Ready  |
| **3.3** | **Idempotent Ingestion Handler**    | 2.6, 3.1, 3.2 | Full-Stack Eng | 4h   | Single-statement insert returning `201 Created` (`idempotent_replay: false`) or `200 OK` (`idempotent_replay: true`) on replayed IDs without duplicate enqueueing. | Ready  |

---

### WBS 4.0: Concurrency-Safe Polling & Worker Engine

| Task ID | Task Description                           | Dependencies | Owner       | Est. | Acceptance Criteria                                                                                                   | Status |
| :------ | :----------------------------------------- | :----------- | :---------- | :--- | :-------------------------------------------------------------------------------------------------------------------- | :----- |
| **4.1** | **Polling Loop & Batch Claim Coordinator** | 2.6, 2.7     | Backend Eng | 5h   | Configurable polling interval with batch fetching of ready records; graceful throttle when queue is empty.            | Ready  |
| **4.2** | **Graceful Shutdown & Signal Handling**    | 4.1          | Backend Eng | 3h   | Clean SIGINT/SIGTERM lifecycle handling: in-flight requests finish or safely release leases; unclaims active batches. | Ready  |

---

### WBS 5.0: Dispatch, HTTP Transport & Backoff Engine

| Task ID | Task Description                               | Dependencies | Owner        | Est. | Acceptance Criteria                                                                                                                                                                                          | Status |
| :------ | :--------------------------------------------- | :----------- | :----------- | :--- | :----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | :----- |
| **5.1** | **HMAC-SHA256 Request Signer**                 | 1.2          | Security Eng | 3h   | Canonical header injection (`x-webhook-signature`, `x-webhook-timestamp`) computed across timestamp and raw body payload.                                                                                    | Ready  |
| **5.2** | **HTTP Dispatcher & Timeout Controller**       | 5.1          | Backend Eng  | 5h   | Native fetch execution with `AbortController` bound to `timeoutLimitMs` (default: 10,000 ms); records status code, latency, and snippet.                                                                     | Ready  |
| **5.3** | **Backoff Calculator with Full Jitter**        | 1.2          | Backend Eng  | 3h   | Implements delay = min(base * 2^(attempt - 1), cap) with full jitter next_retry = now + rand(0, delay); unit tests verify boundaries.                                                                        | Ready  |
| **5.4** | **Delivery Result Processor & Attempt Logger** | 5.2, 5.3     | Backend Eng  | 4h   | 2xx transitions to `delivered`; 4xx/5xx/network errors write attempt entry, update `attempt_count`, and mark `retry` or terminal `failed` if attempts >= maxAttempts. Response snippet truncated at <= 1 KB. | Ready  |

---

### WBS 6.0: Public Interfaces (REST API, TS Library & Logging)

| Task ID | Task Description                          | Dependencies | Owner          | Est. | Acceptance Criteria                                                                                                    | Status |
| :------ | :---------------------------------------- | :----------- | :------------- | :--- | :--------------------------------------------------------------------------------------------------------------------- | :----- |
| **6.1** | **REST HTTP Endpoints**                   | 3.3, 5.4     | Full-Stack Eng | 5h   | Fast, lean endpoints: `POST /webhooks`, `GET /webhooks/:id`, and `GET /webhooks/:id/attempts` conforming to PRD specs. | Ready  |
| **6.2** | **Programmatic TypeScript SDK Interface** | 4.1, 5.4     | Full-Stack Eng | 4h   | Embedded programmatic export (`createWebhookEngine(...)`) with direct event scheduling and query methods.              | Ready  |
| **6.3** | **Structured JSON Logger**                | 1.2          | Full-Stack Eng | 2h   | Level-based structured JSON logs with automated masking of sensitive auth tokens and secret keys.                      | Ready  |

---

### WBS 7.0: Verification, Concurrency Testing & CI/CD Pipeline

| Task ID | Task Description                                 | Dependencies  | Owner        | Est. | Acceptance Criteria                                                                                                                               | Status |
| :------ | :----------------------------------------------- | :------------ | :----------- | :--- | :------------------------------------------------------------------------------------------------------------------------------------------------ | :----- |
| **7.1** | **Unit & Critical Path Test Suite**              | 3.1, 3.2, 5.3 | QA / Eng     | 6h   | Vitest suite achieving >= 95% coverage on critical components (auth, SSRF, HMAC, jitter) and >= 80% overall coverage.                             | Ready  |
| **7.2** | **Concurrency & Contention Stress Testing**      | 2.6, 4.1      | QA / Eng     | 8h   | Automated harness simulating >= 1,000 concurrent submissions and >= 100 parallel workers across all 3 databases; zero double deliveries verified. | Ready  |
| **7.3** | **Fault Injection & Crash Recovery Integration** | 2.7, 4.2      | QA / Eng     | 5h   | Process abort simulation verifies stale lease reclamation and resumption without lost events.                                                     | Ready  |
| **7.4** | **CI Workflow Setup**                            | 7.1, 7.2      | DevOps / Eng | 3h   | GitHub Actions workflow executing type checking, linting, unit tests, and multi-database integration tests.                                       | Ready  |

---

### WBS 8.0: Documentation & Phase-Gate Review

| Task ID | Task Description                     | Dependencies | Owner    | Est. | Acceptance Criteria                                                                                 | Status |
| :------ | :----------------------------------- | :----------- | :------- | :--- | :-------------------------------------------------------------------------------------------------- | :----- |
| **8.1** | **API & Architecture Documentation** | 6.1, 6.2     | Lead Eng | 3h   | Complete `README.md` and API usage documentation with code samples.                                 | Ready  |
| **8.2** | **Planning Phase Gate Audit**        | 1.1 - 8.1    | Lead Eng | 2h   | 100% compliance check against PRD, Scope, and `00-master-rules.md` checklist prior to starting SDD. | Ready  |
