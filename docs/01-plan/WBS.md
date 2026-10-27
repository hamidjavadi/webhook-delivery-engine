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
| **3.3** | **Idempotent Ingestion Handler** | 2.6, 3.2 | Full-Stack Eng | 4h | Validate parsed input and configured tenant identity, apply and validate WEBHOOK_URL fallback, atomically upsert by `(client_id, idempotency_key)`, and return an accepted result with system `id`, `idempotency_key`, replay flag, and pending status; duplicates never create another event. | Done; WBS 3.4 follow-up complete |
| **3.4** | **Host-Owned Ingestion Identity** | 3.3 | Full-Stack Eng | 6h | Remove API-key requirements from embedded engine configuration and ingestion; stamp the host-configured `clientId` on accepted events, reject caller-supplied identity, and verify idempotency and tenant-scoped reads. | Done |

#### WBS 3.4 Subtasks

| Task ID | Deliverable | Dependency | Owner | Est. | Acceptance Criterion | Status |
| :--- | :--- | :--- | :--- | :--- | :--- | :--- |
| **3.4.a** | Remove API key from embedded configuration | 3.3 | Full-Stack Eng | 1h | Public engine creation and enqueue work without an API-key option or authentication result. | Done |
| **3.4.b** | Bind ingestion identity to configured client | 3.4.a | Full-Stack Eng | 2h | Accepted events use the engine's configured `clientId`; strict input rejects caller-supplied identity; idempotency and tenant-scoped reads remain covered. | Done |
| **3.4.c** | Remove unsupported REST/authentication modules | 3.4.a | Full-Stack Eng | 1h | Unreferenced internal HTTP server, routes, API-key authenticator, and their transport-specific tests are removed; package root remains the supported interface. | Done |
| **3.4.d** | Verify behavior and update records | 3.4.b, 3.4.c | Full-Stack Eng | 2h | Focused and full suites, coverage, type-check, lint, build, and ingestion benchmark pass; WBS, SDD, test plan, README, roadmap, and runbook reflect the result. | Done |

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
| **5.2** | **HTTP Dispatcher & Timeout Controller**       | 5.1          | Backend Eng  | 5h   | Native fetch execution with `AbortController` bound to `timeoutLimitMs` (default: 10,000 ms); records status code, latency, and snippet.                                                                                                                                                 | Done; connection pinning completed in 5.2.a |
| **5.3** | **Backoff Calculator with Full Jitter**        | 1.2          | Backend Eng  | 3h   | Implements delay = min(base * 2^(attempt - 1), cap) with full jitter next_retry = now + rand(0, delay); unit tests verify boundaries.                                                                                                                                                    | Done   |
| **5.4** | **Delivery Result Processor & Attempt Logger** | 5.2, 5.3     | Backend Eng  | 4h   | 2xx transitions to `delivered`; non-retryable 4xx (400, 401, 403, 404, 410, 422, and other default 4xx per ADR-0004) write an attempt audit row with `outcome='exhausted'` and immediately transition to terminal `failed`; retryable 4xx (408, 409, 429), 5xx, and timeouts write an attempt audit row, increment `attempt_count`, and schedule retry or mark terminal `failed` with `outcome='exhausted'` at `maxAttempts`. Response snippet bounded to <= 1 KB. | Done |

#### WBS 5.2 Follow-up

| Task ID | Deliverable | Dependency | Owner | Est. | Acceptance Criterion | Status |
| :--- | :--- | :--- | :--- | :--- | :--- | :--- |
| **5.2.a** | Pin validated destination addresses at connection time | 3.2, 5.2 | Backend / Security Eng | 8h (provisional) | Dispatch connects only to an address validated for the request while preserving HTTPS hostname, SNI, and certificate checks; redirects remain disabled or each redirect target is validated and pinned. Tests prove DNS changes after preflight cannot route the request to an unsafe address, and no request is sent on validation, connection, or TLS identity failure. | Done; issue #82 |

---

### WBS 6.0: Public Interfaces (TS Library & Logging)

| Task ID | Task Description                          | Dependencies | Owner          | Est. | Acceptance Criteria                                                                                                                                                                                                                                                               | Status |
| :------ | :---------------------------------------- | :----------- | :------------- | :--- | :-------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | :----- |
| **6.1** | **Tenant-Scoped Query Service**            | 3.3, 5.4     | Full-Stack Eng | 5h   | Provide internal status lookup, listing, and attempt-history operations; all reads are scoped by configured `client_id`. | Done |
| **6.2** | **Embedded TypeScript Package & Engine Lifecycle** | 2.2, 2.3, 3.2, 3.3, 3.4, 4.1, 4.2, 5.4 | Full-Stack Eng | 10h | Public npm package exposes a documented, typed `createWebhookEngine(...)` entry point with programmatic ingestion and query methods. The factory composes migrations, storage, configured tenant identity, scheduler, and delivery dispatcher; startup completes migrations before accepting work. Published package metadata/build output exposes ESM and TypeScript declarations and is verified with `npm pack` plus a host-application install/import integration test. `start()` and `stop()` provide a tested lifecycle: stop polling, finish or safely release claimed-but-undispatched work, and close owned resources. Embedded use does not require a CLI or standalone process entry point. | Done; WBS 3.4 follow-up complete |
| **6.3** | **Structured JSON Logger**                | 1.2          | Full-Stack Eng | 2h   | Level-based structured JSON logs with automated redaction of sensitive payloads, request/delivery fields, and signing secrets.                                                                                                                                                  | Done  |
| **6.4** | **Host-Managed Runtime Client Registration** | 6.2, 3.4, 5.4 | Full-Stack Eng | TBD | Host application can register, update, and remove clients at runtime without rebuilding; engine creation resolves the configured client, and delivery selects that client's configuration and HMAC secret. Define safe rotation/removal semantics and verify tenant isolation and multi-instance behavior. | Deferred to v2.0.0 |

---

### WBS 7.0: Verification, Concurrency Testing & CI/CD Pipeline

| Task ID | Task Description                                 | Dependencies  | Owner        | Est. | Acceptance Criteria                                                                                                                                                                                                                                    | Status |
| :------ | :----------------------------------------------- | :------------ | :----------- | :--- | :----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | :----- |
| **7.1** | **Unit & Critical Path Test Suite**              | 3.2, 3.4, 5.3 | QA / Eng     | 6h   | Vitest suite achieving >= 95% coverage on critical paths (ingestion, configured tenant identity/isolation, atomic claim, retry scheduler/backoff, HMAC/SSRF) and >= 80% overall coverage. Ingestion p95 latency benchmarked under 50 ms. | Done; revalidated after 3.4 |
| **7.2** | **Concurrency & Contention Stress Testing**      | 2.6, 4.1      | QA / Eng     | 8h   | Automated harness simulating >= 1,000 concurrent submissions and >= 100 parallel SQLite workers; exactly 1 job per tenant-key pair and 0 concurrent double-claims under at-least-once semantics. | Done  |
| **7.3** | **Fault Injection & Crash Recovery Integration** | 2.7, 4.2      | QA / Eng     | 5h   | Process abort simulation verifies stale lease reclamation and resumption without lost events.                                                                                                                                                          | Done  |
| **7.4** | **CI Workflow Setup**                            | 7.1, 7.2      | DevOps / Eng | 3h   | GitHub Actions workflow executing type checking, linting, unit tests, and SQLite integration/concurrency tests.                                                                                                                                       | Done  |

---

### WBS 8.0: Documentation & Phase-Gate Review

| Task ID | Task Description                     | Dependencies | Owner    | Est. | Acceptance Criteria                                                                                 | Status |
| :------ | :----------------------------------- | :----------- | :------- | :--- | :-------------------------------------------------------------------------------------------------- | :----- |
| **8.1** | **API & Architecture Documentation** | 6.1, 6.2     | Lead Eng | 3h   | Complete `README.md` and API usage documentation with code samples.                                 | Done; PR #78 merged |
| **8.2** | **Planning Phase Gate Audit**        | 1.1 - 8.1    | Lead Eng | 2h   | 100% compliance check against PRD, Scope, and `00-master-rules.md` checklist prior to starting SDD. | Retrospective audit; sequencing deviation accepted; exception-based Go recorded 2026-10-25 |

#### WBS 8.2 Follow-up Actions

| Task ID | Deliverable | Dependency | Owner | Est. | Acceptance Criterion | Status |
| :--- | :--- | :--- | :--- | :--- | :--- | :--- |
| **8.2.a** | Reconcile planning and design records with merged implementation | 8.2 | Lead Eng | 2h | SDD, roadmap, and risk records reflect the current host-owned identity, completed WBS tasks, dispatcher security gap, and current acceptance criteria; historical API-key evidence remains clearly labeled historical. | Done; issue #80 |
| **8.2.b** | Re-run phase-gate audit and record decision | 5.2.a, 8.2.a | Lead Eng | 1h | Audit findings are closed or explicitly accepted by the stakeholder; traceability, risk gates, and approval records are complete, and the resulting Go/No-Go decision is recorded. | Done; exception-based Go and stakeholder approval recorded 2026-10-25 (issue #84) |

### WBS 9.0: Hosted Interactive Demo (Approved Scope; In Progress)

| Task ID | Task Description | Dependencies | Owner | Est. | Acceptance Criteria | Status |
| :--- | :--- | :--- | :--- | :--- | :--- | :--- |
| **9.1** | Standalone consumer and demo server | 6.2 | Full-Stack Eng | 4h | `examples/demo` has independent pnpm manifest/lock/config; root build and pack precede demo install; Express and Vite production assets run in one Node 24+ process; no public library API change. | Done; local acceptance criteria reviewed and recorded install, packed-package, build, tests, lint, readiness, and SIGTERM checks pass; deployment-specific smoke remains outside 9.1 |
| **9.2** | Fixed HTTPS mock receiver and scenario API | 9.1, 3.2, 5.2.a | Backend / Security Eng | 5h | Built-in scenarios use only the configured public HTTPS receiver through the real dispatcher; 200, 503-then-200, 401, max-attempt `failed`, and SSRF rejection behave as specified; no arbitrary URL input or SSRF bypass. | Done per stakeholder direction; implementation is present and ngrok smoke was reported working; full scenario matrix through the real dispatcher is not recorded, and public-host verification remains open |
| **9.3** | Bounded telemetry and interactive UI | 9.2 | Full-Stack Eng | 6h | UI lists run-scoped event state and attempt history, timings, and HMAC metadata; custom payload/idempotency input is bounded and destination is server-selected; no raw logs/secrets. | Done per stakeholder confirmation; APIs and remaining behavior confirmed working; deployment checks remain under 9.4/9.5 |
| **9.4** | Render Free configuration and operations | 9.1, 9.2 | DevOps / Eng | 3h | Blueprint, health endpoint, Node runtime, build/start commands, signal shutdown, and Free spin-down/ephemeral reset disclosure are documented and verified locally. Live deployment requires separate approval. | Done per stakeholder confirmation (2026-10-27); Render is live and reported working; current live checks were not independently rerun in this review |
| **9.5** | Consumer smoke, QA, and records | 9.1-9.4 | QA / Eng | 4h | Packed-package install/import smoke, scenario/API/UI tests, demo typecheck/lint/build, and root regression checks pass; SDD, ADR, test plan, WBS, roadmap, risk register, and runbook contain actual results. | Done per stakeholder confirmation (2026-10-27); packed install/import and local quality results are recorded in the test plan; stakeholder reports live Render demo and API/UI behavior working; detailed live scenario outputs were not independently captured |

### WBS 10.0: Demo UI Enhancements (Issue #91; In Progress)

| Task ID | Task Description | Dependencies | Owner | Est. | Acceptance Criteria | Status |
| :--- | :--- | :--- | :--- | :--- | :--- | :--- |
| **10.1** | Plan and design demo UI/API changes | 9.3 | Product / Full-Stack Eng | 2h | PRD, scope, SDD, test plan, and risk register trace issue requirements; server-side verification contract is approved before implementation. | Done; planning/design artifacts and verification boundary approved |
| **10.2** | Polling, replay, and attempt telemetry UI | 10.1 | Full-Stack Eng | 4h | Polling safely tracks runs to terminal state; replay preserves inputs; attempt rows show measured latency and honest retry schedule context. | **Done; PR #93 merged.** Scoped coverage accepted for 10.2 (11 UI tests; 88.8% statements, 80% branches); demo-wide coverage was deferred to 10.5; 30 demo tests, lint, and build passed; custom replays preserve scenario/payload and use a fresh idempotency key to avoid deduplication |
| **10.3** | Scoped signature verification endpoint and UI | 10.2 | Backend / Security Eng | 3h | Verification uses captured bytes and server secret; returns boolean only; valid/invalid and scope tests pass. | **Done; PR #95 merged.** 33 demo tests, lint, and build passed; `signature.ts` coverage was 100% in all dimensions; demo-wide coverage tracked to 10.5 |
| **10.4** | Copy actions, scenario grouping, accessibility polish | 10.3 | Full-Stack Eng | 3h | Copy values are exact and announced; scenario groups and controls are keyboard accessible and usable on narrow screens. | **Done; PR #97 merged.** 36 demo tests passed; demo UI coverage was 90.77% statements, 85% branches, and 79.16% functions; lint/build passed; demo-wide coverage tracked to 10.5 |
| **10.5** | Focused QA and records | 10.2-10.4 | QA / Eng | 3h | Demo tests, typecheck, lint, production build pass; test plan and WBS record actual results; no root library API/source change. | **Done; PRs #99 and #100 merged.** 44 demo tests passed; overall statements/lines 83.53%, branches 78.16%, functions 84.09%; HMAC module 100%; root regression suite passed; lint/build passed; QA records updated; no library source/API changes |

### WBS 11.0: Delivery Timeline Responsive Layout Improvement (Issue #101; In Progress)

| Task ID | Task Description | Dependencies | Owner | Est. | Acceptance Criteria | Status |
| :--- | :--- | :--- | :--- | :--- | :--- | :--- |
| **11.1** | Improve delivery timeline record layout on medium and small screens | 10.5 | Full-Stack Eng | 2h | At medium widths, identity occupies row one and metrics plus Replay/expand controls share row two without overlap; on small screens each record uses three rows: result, ID, and status; dispatch time, attempts, and time taken; then Replay and expand controls. Expand is a separate button styled like Replay with a distinct icon and color; record content and interactions remain accessible. | **Done; PRs #102 and #103 merged.** 45 demo tests passed; coverage was 83.70% statements/lines, 78.47% branches, and 86.36% functions; lint/build passed. Browser viewport rendering was not separately exercised; medium layout and button styling were refined and accepted by the user |

### WBS 12.0: Demo Version Display

| Task ID | Task Description | Dependencies | Owner | Est. | Acceptance Criteria | Status |
| :--- | :--- | :--- | :--- | :--- | :--- | :--- |
| **12.1** | Display the package version in the demo header | 9.3 | Full-Stack Eng | 0.5h | The top brand area displays the current root package version, sourced from `package.json`; a page-rendering test verifies the displayed value appears before the hero section; demo tests, lint, and production build pass. | Done locally; 45 demo tests pass, lint and build pass; awaiting review |
