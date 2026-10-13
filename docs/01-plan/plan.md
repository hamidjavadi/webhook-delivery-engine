# Implementation Plan — Webhook Retry Engine

**Product:** Webhook Retry Engine v1.0  
**Source of truth:** `01-plan/prd.md` (Finalized v1.0), supplemented by the ingestion, lifecycle, retry, testing, deployment, and ADR documents.  
**Status:** Planned; contract discrepancies below must be resolved before the API/schema are frozen.

## 1. Objective and scope

Deliver an embeddable Node.js ≥24 / TypeScript HTTP service that accepts webhook events, durably records each event once, and posts it to the configured **`WEBHOOK_URL`**. It must survive restarts, record each delivery attempt, and retry transient failures with bounded exponential backoff and jitter. The v1 design is a single-process Express 5 service, an in-process delivery worker (concurrency 1), and embedded `better-sqlite3` with WAL. Pino provides structured logs; Zod validates requests and Vitest exercises behavior.

In scope:

- ingestion and idempotency;
- durable storage and lifecycle transitions;
- outbound delivery and timeout/error classification;
- bounded retries and exhaustion;
- status/health/list/statistics queries and manual retry as specified by the finalized PRD;
- validation, logging, tests, and deployment checks.

Out of scope for v1:

- multi-tenant/fan-out destinations, distributed workers or cross-process locking, and a dashboard. Exactly-once effects at the receiver are not promised; receiver-side idempotency remains necessary.

## 2. Contract decisions and reconciliation

### Ingestion endpoint and request

Implement the explicitly requested ingestion contract as **`POST /webhooks`** with JSON fields:

```json
{
  "idempotencyKey": "stable-key",
  "payload": { "example": true },
  "timestamp": "2025-01-15T10:00:00.000Z",
  "metadata": { "source": "producer" }
}
```

- `idempotencyKey` is stable across retries and used for deduplication;
- `payload` is a JSON object;
- `timestamp` and `metadata` are optional.

Validate before writing. Persist a canonical event key/digest, payload, metadata, timestamps, status, attempt count, and configured maximum attempts. A repeated key must not create or deliver a second job; return the existing event/status according to the finalized response contract.

**Contract discrepancy to resolve:** the finalized PRD defines `POST /events`, snake_case event fields (`event_id`, `event_type`, optional `idempotency_key`), a 202 new/200 duplicate response, and a SHA-256 `event_key`; `02-design/ingest-webhook.md` and the user-requested contract define `POST /webhooks` and `idempotencyKey`/`payload`/`timestamp`/`metadata`. Before API freeze, record the chosen canonical path and response shape in an ADR and align PRD, ingestion spec, status lookup, and tests. This plan honors `/webhooks` and the stated camelCase request for the ingestion entry point, while retaining the finalized PRD's reliability and retry policy; do not silently implement incompatible request schemas.

### Lifecycle terminology

The requirements use two status vocabularies. Preserve the finalized PRD's storage/state-machine values as canonical unless an ADR approves a migration:

| Canonical PRD value | Meaning / requested or design-doc equivalent                                                |
| ------------------- | ------------------------------------------------------------------------------------------- |
| `pending`           | PENDING; queued and waiting for first or next due attempt                                   |
| `in_flight`         | PROCESSING; worker currently owns the attempt                                               |
| `delivered`         | COMPLETED (requested) / DELIVERED (design docs); successful terminal state                  |
| `failed`            | FAILED; permanent failure, terminal until manual retry                                      |
| `dead`              | EXHAUSTED (requested); retryable failures reached max attempts, terminal until manual retry |

The lifecycle/design docs additionally use `RETRY`; in the finalized PRD a retryable failure below the limit returns to `pending` with a future `next_attempt_at`, not a separate persisted `RETRY` state. Keep the transition behavior consistent and settle the public status spelling across API/docs before release. Do not represent `COMPLETED`/`EXHAUSTED` as separate database values without an approved schema/API decision.

## 3. Work plan and deliverables

### M1 — Configuration, schema, and persistence

- Parse and validate `PORT`, `NODE_ENV`, `LOG_LEVEL`, `DATABASE_PATH`, `WEBHOOK_URL`, and retry/timeout knobs from environment.
- Use SQLite WAL, foreign keys, and a bounded busy timeout. Add/migrate `events` and append-only `attempts` storage as defined in PRD; enforce unique event-key deduplication and indexes for due jobs and attempt history.
- Implement transaction-safe inserts, lookups, atomic due-job claims, attempt recording, and lifecycle updates. Keep payload JSON canonical and never log secrets.
- On startup recover stale `in_flight` work to due `pending`, marking an unfinished attempt as timeout as specified by the PRD.
- **Exit checks:** schema/migration tests pass; repeated idempotency keys yield one event; transaction/state-transition tests pass; persistence survives close/reopen.

### M2 — HTTP API and validation

- Build Express routes and Zod schemas. Implement `POST /webhooks` using the selected contract and duplicate behavior (contract discrepancy must be resolved/documented).
- Implement PRD read/operations endpoints: `GET /health`, `GET /events/:event_id`, `GET /events?status=&limit=&offset=`, `POST /events/:event_id/retry`, and `GET /stats`; align route identifiers if the `/webhooks` contract is selected.
- Return structured validation, not-found, and conflict errors; reject malformed input without inserting. Health succeeds only when `SELECT 1` completes within one second.
- Manual retry is allowed only for `failed`/`dead`; reset attempt count and error, return to `pending`, and preserve attempt history. Other states return conflict.
- **Exit checks:** endpoint tests cover success, duplicate, validation, not-found, and invalid manual-retry state with the selected API contract.

### M3 — Delivery worker, classification, retries

- Run one in-process polling worker (default poll interval 1000 ms, concurrency 1); claim only due `pending` work atomically.
- POST the event to configured **`WEBHOOK_URL`**, enforce `DELIVERY_TIMEOUT_MS` (default 10000) with `AbortSignal.timeout`, capture response status, latency, timestamps, and error details, and apply the documented HTTP classification.
- Success: HTTP 2xx → `delivered`. Permanent failure: 3xx or non-retryable 4xx → `failed`. Retryable: 408/425/409/429, 5xx listed in PRD, network/DNS errors; timeout is recorded as timeout and retried. Honor `Retry-After` only when within the configured cap.
- Use bounded exponential backoff **with jitter**, configurable with defaults: `MAX_ATTEMPTS=5` total attempts, `BACKOFF_BASE_MS=2000`, `BACKOFF_FACTOR=2`, `BACKOFF_MAX_MS=300000`, `BACKOFF_JITTER_MS=500`, and `WORKER_POLL_INTERVAL_MS=1000`. For failure number _n_ with another attempt available: `min(max, base × factor^(n−1)) + random(0, jitter)`; set `next_attempt_at` accordingly. When attempts are exhausted, transition to `dead` (EXHAUSTED equivalent), never schedule another automatic attempt.
- Stop polling on shutdown; wait at most 5 seconds for in-flight delivery, persist its result, and close the DB.
- **Exit checks:** deterministic backoff/jitter-bound tests; integration tests for 2xx, 500→retry, 400→failed, timeout→retry, all-attempts-fail→dead, restart recovery, and no duplicate delivery claims.

### M4 — Observability, end-to-end verification, release readiness

- Emit structured Pino records for each state transition and attempt including event ID/key, attempt number, outcome, HTTP status, latency, and next-attempt time; redact credentials and secrets.
- Make `/stats` counts match DB contents and compute success rate and 24-hour p50/p95 latency as specified in the PRD.
- Verify idempotency, FIFO due-job processing, timeout enforcement, retry configuration, restart durability, and manual retry. Check SSRF protections and target URL configuration/security before production use.
- Run `pnpm lint`, `pnpm test`, and `pnpm build`; meet PRD coverage goals (≥80% overall, ≥95% critical paths where applicable). Complete staging smoke/E2E, database integrity, security/dependency/secret checks, and deployment/rollback readiness per `04-deployment/runbook.md`.
- **Exit checks:** all required quality gates pass; acceptance criteria in `01-plan/prd.md` are verified; documentation and API/status terminology are aligned; staging verification is recorded.

## 4. Acceptance criteria

1. Same idempotency key (or the PRD fallback event identity if retained) creates exactly one durable job; replay does not redeliver.
2. Invalid/missing required fields or non-object payload are rejected before persistence.
3. A 2xx delivery reaches `delivered`/COMPLETED and records HTTP status, latency, and finish time.
4. Permanent 4xx/redirect failure reaches `failed` after the first attempt; transient HTTP/network/timeout failures retry within the cap and then reach `dead`/EXHAUSTED.
5. Default retry delays use 2, 4, 8, and 16 seconds plus 0–500 ms jitter; maximum exponential component is 300 seconds; 5 total attempts maximum.
6. Restart recovers stale in-flight work without losing or double-claiming events; SQLite/WAL preserves state.
7. Status, health, statistics, manual retry, structured attempt logs, and configured target behavior pass their contract tests.
8. `pnpm lint`, `pnpm test`, and `pnpm build` pass; deployment runbook and required security/operational checks are complete.

## 5. Key risks and decisions

- **API/status conflicts:** finalized PRD uses `/events`, snake_case, and `pending/in_flight/delivered/failed/dead`; design/requested docs use `/webhooks`, camelCase, and uppercase alternate states. Resolve once in an ADR and synchronize all specs/tests before schema/API freeze.
- **Target URL security:** `WEBHOOK_URL` is security-sensitive; validate configuration and prevent SSRF/internal-network access in accordance with the PRD.
- **Delivery semantics:** durable retries and deduplication prevent duplicate jobs locally, but cannot guarantee exactly-once side effects at arbitrary receivers.
- **Single process:** SQLite WAL and one worker suit v1; do not scale multiple independent workers without a redesigned locking/claim strategy.

## 6. Document references

- `01-plan/prd.md` — finalized requirements, data model, retry formula, endpoints, tests, and milestones.
- `01-plan/webhook-lifecycle.md` — lifecycle and success criteria (contains alternate status vocabulary).
- `02-design/ingest-webhook.md` — `/webhooks` request and response behavior.
- `02-design/idempotency-contracts.md` — key stability and duplicate semantics.
- `02-design/retry-strategy.md` — retry concepts (align numeric defaults to finalized PRD).
- `02-design/adr/0001-sqlite-with-wal-journal.md` — SQLite/WAL decision.
- `03-testing/test-plan.md`, `03-testing/status-check.md` — verification requirements.
- `04-deployment/runbook.md` — release, rollback, and operational checks.
