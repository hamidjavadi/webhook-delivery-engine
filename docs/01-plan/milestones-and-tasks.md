# Milestones and Tasks — Webhook Retry Engine

## Overview

This tracker turns the existing implementation plan into reviewable GitHub work. It does not supersede `plan.md` or the finalized PRD. The source plan names four milestones:

- **M1 configuration/schema/persistence**;
- **M2 HTTP API/validation**;
- **M3 delivery worker/classification/retries**;
- **M4 observability/E2E/release readiness**.

### Status convention

- `[ ]` Not started / not verified
- `[x]` Complete only after its acceptance criteria have been demonstrated and the change merged
- Use a GitHub issue/PR for each task; link the issue/PR from the task when the work starts. Do not mark a parent task complete while any acceptance criterion is unmet.

### Branch and commit guidance

- Branch names use lowercase kebab-case and a type prefix: `feat/`, `fix/`, `docs/`, `test/`, `chore/`, or `security/` (examples are provided per task). Use one focused branch per issue.
- Issue titles start with a Conventional Commit type and scope, e.g. `feat(storage): add durable event and attempt persistence`. Keep the issue title and eventual commit subject aligned; include a breaking-change note when a frozen API/schema contract changes.
- PRs should identify the task ID, summarize behavior, link tests/evidence, and update the relevant docs. Do not freeze or implement competing contracts by inference.

### Source and traceability

Derived from `docs/01-plan/plan.md` (milestones, exit checks, discrepancies and risks), `docs/01-plan/prd.md` (finalized requirements and retry policy), plus `docs/01-plan/webhook-lifecycle.md`, `docs/02-design/ingest-webhook.md`, `docs/02-design/idempotency-contracts.md`, `docs/02-design/retry-strategy.md`, `docs/02-design/adr/0001-sqlite-with-wal-journal.md`, `docs/03-testing/test-plan.md`, `docs/03-testing/status-check.md`, and `docs/04-deployment/runbook.md`.

> **Contract freeze blocker:** The conflict is unresolved in the source plan and MUST be resolved and recorded before API/schema freeze. The finalized PRD specifies `POST /events`, snake_case event fields, 202 new / 200 duplicate, and canonical PRD statuses (`pending`, `in_flight`, `delivered`, `failed`, `dead`). The ingestion/lifecycle/status design documents specify `/webhooks`, camelCase and alternate uppercase status vocabularies. Do not silently combine or choose between them. Complete M1-01 first; use its approved decision to align API, schema, status lookup, docs, and tests. Other unresolved design choices are explicit tasks below.

---

## M1 — Configuration, schema, and persistence

### Tasks

- [ ] **M1-01** `docs(api): resolve and record API and status contract before freeze` — Create an ADR comparing the conflicting PRD and design contracts. Decide and document the canonical ingestion path/request/response/duplicate behavior, public status vocabulary and mapping, and status lookup identifier/shape. Obtain engineering approval; update PRD/design references needed to make the decision unambiguous. **Branch:** `docs/resolve-api-status-contract`.
  - **Acceptance criteria:** ADR records context, options, decision, rationale, consequences, owner/date, and approval status; explicitly addresses `/events` vs `/webhooks`, field naming/required fields, new/duplicate response codes and bodies, status values, and lookup route/identifier. No implementation silently mixes contracts. API/schema freeze is blocked until this ADR is approved and dependent docs/tests are identified for alignment. Trace: `plan.md` #2, #5; `prd.md` #3; `ingest-webhook.md`; `webhook-lifecycle.md`; `status-check.md`.

- [ ] **M1-02** `feat(config): validate service and retry environment settings` — Implement typed environment parsing for `PORT`, `NODE_ENV`, `LOG_LEVEL`, `DATABASE_PATH`, `WEBHOOK_URL`, and retry/timeout/poll settings. Use the approved PRD defaults unless a documented decision changes them. **Branch:** `feat/config-validation`.
  - **Acceptance criteria:** Valid settings parse to typed values; invalid, missing-required, or out-of-range settings fail startup with actionable errors and no secrets; tests cover defaults, valid overrides, and invalid values. Retry defaults match PRD #5.1 (5 attempts, 2000ms base, factor 2, 300000ms cap, 500ms jitter, 10000ms delivery timeout, 1000ms poll). Trace: `plan.md` M1; `prd.md` #2.2, #5.1.

- [ ] **M1-03** `feat(storage): add SQLite WAL schema and migrations` — Implement the approved event and append-only attempt schema using embedded `better-sqlite3`; enable WAL, foreign keys, and bounded busy timeout. **Branch:** `feat/sqlite-schema-migrations`.
  - **Acceptance criteria:** Migration creates the PRD event/attempt fields, status constraints, unique canonical `event_key`, foreign key and due-job/attempt indexes; migration is safe to run repeatedly; tests verify schema constraints and migration behavior. Preserve the selected canonical contract from M1-01 without inventing alternate persisted statuses. Trace: `plan.md` M1; `prd.md` ##2.2, 4; `adr/0001-sqlite-with-wal-journal.md`.

- [ ] **M1-04** `feat(storage): persist events and attempts transactionally` — Implement canonical event serialization/digest, idempotent insert/lookup, atomic due-job claim, state transitions, and append-only attempt recording. **Branch:** `feat/transactional-event-storage`.
  - **Acceptance criteria:** Same canonical dedupe key creates one durable event; each state transition and claim is transaction-safe; attempts retain history and are unique by event/attempt number; repeated transitions do not corrupt state; close/reopen preserves records. Tests exercise duplicate insert, transaction rollback, due-claim concurrency boundary, and state rules. Trace: `plan.md` M1 and acceptance criteria 1, 6; `prd.md` ##2.2, 4.2, 5.4.

- [ ] **M1-05** `fix(storage): recover interrupted in-flight deliveries on startup` — On startup, recover stale `in_flight` work to due `pending` and mark its unfinished attempt as timeout as specified by the PRD. **Branch:** `fix/startup-inflight-recovery`.
  - **Acceptance criteria:** Restart integration test verifies unfinished work becomes eligible again, unfinished attempt has timeout outcome, and event is not lost or double-claimed; terminal events remain unchanged. Trace: `plan.md` M1 exit checks; `prd.md` attempt outcome and state machine; `plan.md` acceptance criterion 6.

### M1 exit criteria

- [ ] M1-01 ADR approved and contract conflicts/dependent document updates explicitly tracked before any API/schema freeze.
- [ ] Configuration, migration/schema, transaction/state-transition and restart-persistence tests pass.
- [ ] Repeated idempotency produces one event; close/reopen and interrupted-work recovery are verified.

---

## M2 — HTTP API and validation

### Tasks

- [ ] **M2-01** `feat(api): implement ingestion using the approved contract` — Implement the approved ingestion endpoint and request/duplicate behavior with Zod validation before persistence. **Branch:** `feat/approved-ingestion-api`.
  - **Acceptance criteria:** Contract tests assert exact path, request fields, success/duplicate status codes and response bodies from M1-01; invalid/missing fields and non-object payload are rejected before insert; a duplicate key creates no second job. If the selected contract differs from the PRD, ADR and all affected specs/tests are updated. Trace: `plan.md` M2; `prd.md` #3.1; `ingest-webhook.md`; M1-01.

- [ ] **M2-02** `feat(api): add health event query list and statistics routes` — Implement health, single-event/detail-with-attempts, paginated/filterable listing, and statistics endpoints using the approved route and identifier contract. **Branch:** `feat/event-query-api`.
  - **Acceptance criteria:** Tests cover successful results, unknown identifier (404), status filtering, limit/offset boundaries and response schemas; health returns success only when `SELECT 1` completes within one second; route/identifier and status values match M1-01. Trace: `plan.md` M2; `prd.md` ##3.2, 7; `status-check.md` (reconcile via M1-01).

- [ ] **M2-03** `feat(api): add guarded manual retry operation` — Permit manual retry only for the approved terminal retryable statuses, with attempt counter/error reset, current retry configuration snapshot and preserved attempt history. **Branch:** `feat/manual-event-retry`.
  - **Acceptance criteria:** Tests verify eligible states return to due `pending`; attempt count/error reset and history remains; unsupported states return the documented 409 conflict; unknown event returns 404. Status terms follow the approved contract, not an assumed mapping. Trace: `plan.md` M2; `prd.md` ##3.2, 5.4.

- [ ] **M2-04** `feat(api): standardize validation not-found and conflict errors` — Implement structured errors and request correlation as specified by the selected contract. **Branch:** `feat/api-error-contract`.
  - **Acceptance criteria:** Contract tests assert validation (400), not-found (404), conflict (409), and internal (500) response shape/codes; invalid requests never write data; error output does not expose secrets or unsafe internals. Trace: `plan.md` M2; `prd.md` #3; `ingest-webhook.md` (reconcile via M1-01).

- [ ] **M2-05** `test(api): cover selected endpoint contracts and validation boundaries` — Add route-level tests for all selected endpoints and documented edge cases. **Branch:** `test/api-contract-coverage`.
  - **Acceptance criteria:** Tests cover ingestion new/duplicate/invalid, query success/not-found, list filters/pagination, health DB check, stats response, retry valid/invalid states, and structured errors; tests use the approved contract fixture/schema. Trace: `plan.md` M2 exit checks; `test-plan.md`.

### M2 exit criteria

- [ ] Every API route and response matches the approved M1-01 contract; PRD/design/status lookup docs and tests are aligned.
- [ ] Endpoint tests cover success, duplicate, validation, not-found, conflict and manual-retry state behavior; invalid ingestion has no persistence side effect.

---

## M3 — Delivery worker, classification, and retries

### Tasks

- [ ] **M3-01** `feat(worker): poll and atomically claim due events` — Add a single in-process polling worker, default one-second polling and concurrency one, claiming only due pending work. **Branch:** `feat/due-event-worker`.
  - **Acceptance criteria:** Integration test confirms not-yet-due events are skipped, due events are claimed once, FIFO due-job behavior is verified where required, and no concurrent duplicate claim occurs. Trace: `plan.md` M3; `prd.md` ##2.1, 5.4; `webhook-lifecycle.md` FIFO requirement.

- [ ] **M3-02** `feat(worker): deliver events with timeout and attempt records` — POST event to configured `WEBHOOK_URL`; enforce configured timeout with `AbortSignal.timeout`; persist attempt start/finish, HTTP status, latency, outcome and error detail. **Branch:** `feat/webhook-delivery-attempts`.
  - **Acceptance criteria:** Tests prove target configuration is used, timeout abort is enforced, attempt data is persisted on success/failure, and credentials/secrets are not persisted in logs/errors. Trace: `plan.md` M3; `prd.md` ##2.1, 4.2, 5.1.

- [ ] **M3-03** `feat(worker): classify HTTP network and timeout outcomes` — Implement the PRD classification; redirects and permanent 4xx fail, listed transient statuses/network failures retry, timeouts are recorded as timeout and retried. **Branch:** `feat/delivery-outcome-classification`.
  - **Acceptance criteria:** Table-driven tests cover 2xx, 3xx, retryable 408/425/409/429, 500/502/503/504, other 4xx, DNS/network/reset and timeout; outcome and next action match PRD #5.3; redirects are not followed. Trace: `plan.md` M3; `prd.md` #5.3.

- [ ] **M3-04** `feat(worker): schedule bounded exponential backoff with jitter` — Schedule transient retries using configured limits and additive jitter; honor `Retry-After` only within the configured cap. **Branch:** `feat/retry-backoff-jitter`.
  - **Acceptance criteria:** Deterministic/injected-random tests verify formula and bounds: default base delays 2/4/8/16 seconds plus 0–500ms jitter, 300000ms exponential cap, valid capped Retry-After handling; attempt 5 exhaustion transitions to `dead` with no next automatic attempt; permanent error transitions to `failed`. Trace: `plan.md` M3; `prd.md` ##5.1–5.3.

- [ ] **M3-05** `feat(server): stop worker and drain delivery on shutdown` — Stop polling on SIGTERM/SIGINT, wait at most five seconds for in-flight delivery, persist result, and close database. **Branch:** `feat/graceful-worker-shutdown`.
  - **Acceptance criteria:** Shutdown tests confirm no new claims after stop, bounded drain, durable result and database close; timeout/drain edge case does not leave work silently untracked. Trace: `plan.md` M3; `prd.md` #2.2.

- [ ] **M3-06** `test(worker): verify retry lifecycle and restart recovery end to end` — Add integration coverage for successful delivery, retry then success, permanent failure, timeout, exhaustion, restart recovery and duplicate-claim protection. **Branch:** `test/worker-retry-lifecycle`.
  - **Acceptance criteria:** Tests assert attempts, status, next-attempt time and final outcome for 2xx, 500→retry, 400→failed, timeout→retry, all attempts fail→dead, restart recovery and no duplicate delivery claims. Trace: `plan.md` M3 exit checks; `test-plan.md`; `prd.md` ##5.3–5.4.

### M3 exit criteria

- [ ] Worker only claims due work atomically and delivers to configured `WEBHOOK_URL` with timeout and complete attempt records.
- [ ] Classification, backoff/jitter, `Retry-After`, max attempts and terminal outcomes match the finalized PRD and pass deterministic/integration tests.
- [ ] Restart recovery, no-double-claim behavior and graceful shutdown are demonstrated.

---

## M4 — Observability, E2E, and release readiness

### Tasks

- [ ] **M4-01** `feat(observability): emit structured redacted delivery logs` — Emit Pino state-transition and attempt records with event ID/key, attempt number, outcome, HTTP status, latency and next-attempt time. **Branch:** `feat/structured-delivery-logs`.
  - **Acceptance criteria:** Tests or captured-log assertions verify required fields for success, retry and failure; credentials/secrets are redacted; logs use configured level and do not contain raw secrets. Trace: `plan.md` M4; `prd.md` ##1.1, 2.2; `runbook.md`.

- [ ] **M4-02** `feat(api): calculate statistics from persisted event and attempt data` — Implement `/stats` counts, success rate and 24-hour p50/p95 delivery latency per PRD. **Branch:** `feat/delivery-statistics`.
  - **Acceptance criteria:** Fixture-backed tests compare every count/rate/percentile to independently computed expected values, including empty and boundary windows; counts reconcile to database rows. Trace: `plan.md` M4; `prd.md` ##3.2, 7.

- [ ] **M4-03** `security(worker): validate target URL and prevent SSRF` — Verify configured target URL validation and protections against internal-network destinations before production use; resolve any remaining policy choices explicitly rather than assuming them. **Branch:** `security/target-url-ssrf-protection`.
  - **Acceptance criteria:** Tests cover malformed URLs and prohibited internal destinations according to a documented security policy; allowed target behavior is documented; no secret credentials appear in logs. Trace: `plan.md` M4 and #5; `prd.md` #8 (security); `webhook-lifecycle.md` security requirements.

- [ ] **M4-04** `test(e2e): verify durable idempotent delivery and operations flows` — Run E2E verification for ingestion, dedupe, delivery/retry, status/detail, health, stats, manual retry and restart durability against the selected API contract. **Branch:** `test/end-to-end-acceptance`.
  - **Acceptance criteria:** E2E evidence records environment/commands/results; verifies FIFO behavior where applicable, timeout/retry configuration, status transitions, restart durability and manual retry; all contract assertions match the approved ADR. Trace: `plan.md` M4; `test-plan.md`; PRD acceptance criteria.

- [ ] **M4-05** `chore(ci): enforce required quality and security gates` — Configure/verify lint, formatting, unit/integration/E2E tests, build, dependency/security and secret checks, coverage and artifact packaging. **Branch:** `chore/required-ci-gates`.
  - **Acceptance criteria:** CI blocks promotion on required gate failure unless an approved documented exception exists; `pnpm lint`, `pnpm test`, `pnpm build` pass; overall coverage is at least 80% and critical-path coverage at least 95% where applicable; no unreviewed security/secret findings. Trace: `plan.md` M4; `test-plan.md`; `runbook.md` CI/CD and verification checklist.

- [ ] **M4-06** `docs(release): complete staging verification and rollback readiness` — Align docs/API/status terminology; complete staging smoke/E2E, DB integrity, operational, deployment and rollback review. **Branch:** `docs/staging-release-readiness`.
  - **Acceptance criteria:** Staging verification is recorded; database integrity and health/API/status checks pass; backup/restore, rollback owner/steps, monitoring/alerts and security/dependency checks are reviewed; all PRD acceptance criteria are linked to evidence; docs contain no unresolved contract contradictions. Trace: `plan.md` M4 exit checks; `runbook.md`; `prd.md`.

### M4 exit criteria

- [ ] Structured logs are useful and redacted; statistics match persisted data.
- [ ] E2E acceptance evidence and staging smoke checks pass; restart, idempotency, FIFO, timeout, retries and manual retry are verified.
- [ ] `pnpm lint`, `pnpm test`, `pnpm build`, coverage and security/dependency/secret controls meet required gates.
- [ ] API/status terminology and documentation are aligned to the approved ADR; deployment, monitoring, backup and rollback readiness are recorded.
