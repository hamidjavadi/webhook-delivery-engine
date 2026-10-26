# Test Plan — Webhook Delivery Engine

- **Status:** Active
- **Version:** 1.0.0
- **Owner:** Engineering
- **Scope:** WBS Tasks 1.2, 2.1, 2.2, 2.3, 2.6, 2.7, 3.2, 3.3, 3.4, 4.1, 5.2, 5.2.a, 5.3, 5.4, 6.1, 6.2, 6.3, 7.1, and 7.2: core domain
  contracts, SQLite schema/migrations, the better-sqlite3 storage adapter,
  atomic claim, configured tenant identity, ingestion input validation and
  SSRF URL validation, atomic idempotent ingestion, poll-cycle coordination, outbound
  HTTP dispatch/backoff, result classification, attempt recording, and the
  embedded engine's programmatic ingestion and tenant-scoped query methods.
  WBS 7.1 adds repository-wide and
  critical-path coverage measurement plus a controlled local ingestion p95
  benchmark; it does not change runtime behavior. WBS 7.2 adds concurrent
  multi-tenant idempotency and independent-process SQLite claim stress checks;
  it does not change runtime behavior. WBS 7.3 adds a child-process crash and
  restart recovery integration check; it does not change runtime behavior
  unless the harness exposes a defect in the approved recovery flow.
  PostgreSQL and MySQL are deferred to v2.0 and are not part of v1.0 validation.

## Goals and Out of Scope

Verify that immutable event and attempt types represent the approved SDD fields,
that the adapter contract exposes persistence operations with tenant and lease
boundaries, and that configuration can express bounded concurrency, timeouts,
and retry policy. Verify fresh SQLite schema creation and inspection,
constraints and indexes. Verify migration ordering, checksum ledger, idempotent
reapplication, drift and missing-file detection, SQLite transactional rollback,
and startup ordering. For Task 2.3, verify each DatabaseAdapter operation
against a real better-sqlite3 database, including transaction rollback,
concurrent claims, tenant isolation, lease-owner checks, JSON/timestamp mapping,
and SQL-injection-shaped input. Runtime configuration parsing and delivery
logic remain outside this scope.
For Task 2.6, verify the claim executes as one conditional `UPDATE ... RETURNING`
statement and run competing independent processes against a shared temporary
SQLite file; every event id must be returned to at most one worker.
For Task 2.7, verify the adapter computes the stale cutoff from
`max(timeoutLimitMs + 30000 ms, 90000 ms)` using the supplied UTC `now`, resets
only strictly expired `processing` leases, clears lease fields, schedules
retry at `now + 10000 ms`, rejects invalid inputs without writes, and leaves
active, cutoff-equal, and non-processing rows unchanged. Poll-loop invocation
is deferred to WBS 4.1.
WBS 3.1 API-key authentication is superseded and is not part of the current v1
test scope; its completed test results remain below as historical evidence.
WBS 3.4 verifies engine creation requires no API key, binds the configured
`clientId`, and stamps it onto accepted events. It rejects caller-supplied
tenant identity and confirms query methods remain scoped to that configured
identity. The host boundary is documented as responsible for access control if
it exposes ingestion to external callers.
For Task 3.2, verify the ingestion schema accepts only `idempotency_key`,
JSON `payload`, and optional `destination_url`; malformed/missing fields and
unknown keys are rejected. Verify only absolute HTTPS URLs without credentials
are accepted, literal IPv4/IPv6 addresses are classified correctly, and every
resolved A/AAAA result is checked. Cover loopback, RFC 1918, IPv6 unique-local,
link-local, unspecified, multicast, reserved, IPv4-mapped, and cloud metadata
addresses, including mixed public/private DNS answers. Resolver tests use
deterministic mocked DNS answers; no external DNS or network is contacted.

For Task 3.3/3.4, verify the handler accepts validated parsed input and uses
only the engine-bound tenant identity. Verify it uses the configured
`WEBHOOK_URL` only when the optional destination is
omitted, and applies the same SSRF validation to that fallback. Verify new
events return the documented accepted programmatic result and duplicate submissions
return the same stored event id with replay=true without overwriting the
original event. Include independent tenant keys, concurrent calls to the real
SQLite adapter at the PRD threshold (at least 1,000 submissions across
multiple tenant/key pairs), invalid schema/destination cases, caller-supplied
identity attempts, and propagated storage errors. WBS 3.3/3.4 remain part of
the embedded library contract. An invalid
configured fallback must return a generic 500 configuration error and leave
the adapter untouched.

For Task 4.1, verify each poll cycle calls stale-lease recovery once before
claiming due events, passes configured timeout and batch values, and sends only
claimed events to the worker seam. Verify empty batches wait for the configured
interval, adapter failures are reported without ending the scheduler, and later
cycles resume. Use real SQLite integration tests for recovery/claim ordering
and a bounded local idle benchmark to measure scheduler CPU overhead against
the 10% target. OS signal registration and in-flight dispatch draining are
excluded because they belong to WBS 4.2.
For Task 7.3, use a temporary on-disk SQLite database and a child Node process
to persist an event claim and terminate abruptly while it is `processing`.
After child exit, verify the lease and event remain persisted, advance the
supplied recovery time past the approved stale threshold, and use the real
adapter and scheduler path to reclaim and claim the event again. Assert the
event is not lost and that recovery leaves its lease fields cleared until a
new claim is made. Keep the test deterministic by supplying timestamps; do not
wait 90 seconds or contact external services. This is at-least-once recovery:
the test verifies resumption, not exactly-once dispatch across a crash.
For Task 5.4, verify 2xx success, permanent 4xx classification (including
unlisted 4xx defaults), retryable 408/409/429 and 5xx/network failures, retry
exhaustion at `maxAttempts`, lease-owner enforcement, and atomic attempt/state
updates against a real SQLite adapter. Verify attempt ordinals use the claim's
reserved `attemptCount`, error descriptions do not expose transport internals,
and persisted response snippets stay within 1,024 UTF-8 bytes. Worker failures
are reported through the scheduler callback seam.

For WBS 5.2.a, after design approval, add a deterministic DNS-rebinding test
that supplies a changed answer after ingestion preflight and proves the socket
uses only a fresh vetted pin. Verify unsafe, mixed, empty, and failed answers
open no connection; use a local HTTPS fixture to prove the original destination
hostname is retained for SNI and certificate identity; and verify a wrong-host
certificate or connection failure sends no HTTP request. Verify redirects are
not followed and retain timeout, signing, body, status, latency, and response
snippet behavior. Tests must not contact external DNS or destinations. Run the
focused dispatcher suite first, then the required project suite and coverage
checks before marking WBS 5.2.a Done; record actual environment and results.
## Strategy and Layers (Unit / Integration / E2E)

### WBS 7.1 Execution Plan (Issue #64)

- Reconcile executable source coverage against WBS 7.1, including ingestion,
  configured tenant identity/isolation, atomic SQLite claims,
  scheduler/backoff, HMAC, and SSRF.
- Add only deterministic tests for uncovered branches or behavior, following
  existing module and integration-test conventions. Preserve real SQLite
  integration at persistence boundaries and avoid external network calls.
- Run the complete Vitest suite with V8 coverage; report lines, statements,
  functions, and branches overall and per critical module. Thresholds remain
  ≥80% overall and ≥95% for each critical path. Run
  `node scripts/check-claim-coverage.mjs` after Vitest to enforce the atomic
  claim method and its comparator independently of unrelated adapter paths.
- Measure the public embedded `enqueue()` path using a temporary SQLite file:
  complete startup/migrations first, warm up with 100 unique requests, then
  time three rounds of 500 unique requests using `performance.now()`. Use a
  public IP literal to avoid DNS and do not dispatch to the destination.
  Report each round's nearest-rank p95 and their median, along with Node/pnpm
  versions and host details. Treat the <50 ms target as inconclusive if the
  host environment is noisy; keep the benchmark out of regular CI assertions.
- Exit only when coverage thresholds pass, the p95 result is recorded, and
  type-check, lint, build, formatting, and diff checks pass. Record actual
  commands/results and Go/No-Go below after execution.

### WBS 7.1 QA Results

- **Environment:** Node.js v24.16.0; pnpm 10.4.1; Vitest 3.2.7; Linux x64;
  temporary on-disk better-sqlite3 database; synthetic request data.
- **TDD red checks:** Adding the 95% SQLite adapter branch gate exposed 89.03%
  aggregate branch coverage. The focused comparator test then failed because
  `compareClaimedEvents` was not yet extracted. The helper was extracted with
  unchanged ordering behavior and the test passed.
- **Final tests:** `pnpm test --coverage` passed (21 files, 397 tests).
- **Overall coverage:** 98.52% lines/statements, 99.16% functions, and 95.71%
  branches. The repository's 80% overall gate passes.
- **Critical paths (historical baseline):** Ingestion handler/schema,
  authentication, HMAC,
  and backoff are 100% across all four coverage dimensions. SSRF is 98.68%
  lines/statements, 98.46% branches, and 100% functions. Scheduler is 95.89%
  lines/statements, 96% branches, and 100% functions. SQLite adapter aggregate
  coverage is 96.88% lines/statements, 97.72% functions, and 91.92% branches;
  the focused `claimDueEvents` method and `compareClaimedEvents` comparator
  each report 100% lines, statements, functions, and branches through
  `node scripts/check-claim-coverage.mjs`.
- These measurements predate the v1 scope change. WBS 7.1 coverage and the
  ingestion benchmark were rerun after WBS 3.4 replaced authentication with
  configured tenant identity/isolation; the new results follow below.
- **Ingestion p95:** `pnpm benchmark:ingestion` measured 500 requests per round
  after 100 warm-ups. Nearest-rank p95 values were 0.3059 ms, 0.2477 ms, and
  0.2283 ms; median p95 was 0.2477 ms against the <50 ms target. The fetch
  guard recorded zero dispatch attempts. Startup/migration time was excluded.
- **Build/lint/format:** `pnpm build` and `pnpm lint` passed. Prettier check
  passed for all changed source, configuration, and documentation files.
- **Open bugs/limitations:** None identified. The adapter aggregate branch
  percentage includes defensive parsing and persistence code outside the
  atomic-claim critical path; the claim-specific checker enforces the 95%
  threshold for the actual claim method and comparator.
- **Go/No-Go:** Go for WBS 7.1 coverage and local ingestion latency criteria.
  WBS 7.2–7.4 were still open at the time of that task's verification and are
  not included in its result.

### WBS 7.2 QA Results

- **Environment:** Node.js v24.16.0; pnpm 10.4.1 as declared by the project;
  Vitest 3.2.7; temporary on-disk better-sqlite3 databases; synthetic data.
- **Ingestion stress:** 1,000 concurrent requests across 10 tenants and 10
  keys per tenant produced 100 stored events, one stable event id for each
  tenant/key pair, and 900 idempotent replays.
- **Claim contention stress:** 100 independent Node.js worker processes raced
  to claim 1,000 due events. All 1,000 ids were unique, with persisted
  `processing` status, `attempt_count = 1`, and lease owner matching the worker
  that returned each event.
- **Focused tests:** The ingestion handler file passed (9 tests); the SQLite
  adapter file passed (36 tests), including the 100-process stress case.
- **Final tests and coverage:** `pnpm exec vitest run --coverage` passed (21
  files, 397 tests). Coverage was 98.52% lines/statements, 99.16% functions,
  and 95.71% branches; all configured overall and critical-path thresholds
  passed. `node scripts/check-claim-coverage.mjs` also passed with 100% lines,
  statements, functions, and branches for both `claimDueEvents` and
  `compareClaimedEvents`.
- **Build/lint/format/diff:** `pnpm build`, `pnpm lint`, Prettier check on
  changed source and documentation, and `git diff --check` passed.
- **TDD note:** This task adds stress verification only and does not change
  production behavior; the expanded tests passed against the existing
  implementation, so no production change or artificial failing assertion was
  introduced.
- **Failed tests/open bugs:** None.
- **Go/No-Go:** Go for WBS 7.2 concurrency and contention acceptance criteria.

### WBS 7.3 QA Results (Issue #68)

- **Environment:** Node.js v24.16.0; pnpm 12.6.0; Vitest 3.2.7; Linux x64;
  temporary on-disk SQLite database with the real `better-sqlite3` adapter.
  The project-pinned pnpm 10.4.1 signature could not be verified because the
  configured registry was unreachable; validation commands completed under
  pnpm 12.6.0.
- **Crash injection:** A separate Node process claimed the seeded event and
  exited with code 73 immediately after the claim, without closing the adapter.
  The parent confirmed the persisted `processing` status, first attempt count,
  lease timestamp, and crashed worker id.
- **Recovery and resumption:** The real scheduler ran with deterministic fake
  time beyond the 90-second minimum stale threshold. Recovery returned the
  event to `retry`, cleared the old lease, and scheduled the retry 10 seconds
  later. The next poll claimed the same event with attempt count 2 and a new
  worker id; the event remained persisted. No 90-second sleep or network call
  was used.
- **TDD note:** This is a verification-only WBS task. The focused integration
  test passed on its first run against the existing recovery implementation;
  no artificial failing assertion or production change was introduced.
- **Tests and coverage:** Focused crash/recovery test passed (1 test). The
  complete Vitest suite passed (21 files, 398 tests): 98.52% statements/lines,
  99.16% functions, and 95.72% branches overall. Scheduler coverage was 95.89%
  lines/statements, 100% functions, and 96.15% branches.
- **Build/lint/format/diff:** `pnpm build`, `pnpm lint`, Prettier check on all
  changed files, and `git diff --check` passed.
- **Open bugs/limitations:** The abrupt-exit case verifies recovery after a
  committed claim, not a crash during an uncommitted SQLite transaction;
  delivery remains at-least-once across the crash window. The pinned pnpm
  signature limitation is recorded above; the requested test, build, lint,
  formatting, and diff checks all completed successfully.
- **Go/No-Go:** Go for WBS 7.3 crash recovery and resumption criteria.

### WBS 7.4 CI Workflow Results (Issue #71)

- **Workflow:** `.github/workflows/ci.yml` runs on pushes, pull requests, and
  manual dispatch using Node.js 24.18.0 and pnpm 10.4.1. It installs the frozen
  lockfile, type-checks, lints, runs the full Vitest suite with coverage,
  enforces the focused SQLite atomic-claim coverage check, and builds the
  package. The Vitest suite includes the SQLite integration, concurrency, and
  crash-recovery tests.
- **Environment:** Node.js v24.16.0; pnpm 10.4.1; Vitest 3.2.7; Linux x64;
  repository's frozen dependency installation.
- **Tests and checks:** `pnpm exec tsc --noEmit`, `pnpm lint`,
  `pnpm exec vitest run --coverage`, `node scripts/check-claim-coverage.mjs`,
  and `pnpm build` passed locally under Node.js v24.16.0. Vitest passed 21
  files and 398 tests, including
  1,000 concurrent ingestion submissions and 100 independent SQLite workers
  claiming 1,000 events. Overall coverage was 98.52% statements/lines, 99.16%
  functions, and 95.73% branches. Both `claimDueEvents` and
  `compareClaimedEvents` reported 100% in all four coverage dimensions.
- **CI failure and correction:** GitHub Actions ran Node.js v24.21.0 and failed
  during Vitest startup when `better-sqlite3` crashed in
  `RemoveEnvironmentCleanupHook`, followed by Vitest's `ERR_IPC_CHANNEL_CLOSED`.
  The same suite passes locally on Node.js v24.16.0 with both the default and
  single-worker pools. CI is pinned to Node.js v24.18.0, before the observed
  runtime cleanup-hook change, to keep this workflow on the v24 line. Both
  replacement GitHub Actions runs passed (push run 39974007786 and pull
  request run 39974013769).
- **Failed checks/open bugs:** Initial Node.js v24.21.0 runs failed as
  described. CI currently validates Node.js v24.18.0; compatibility with later
  Node.js 24 releases remains an open native-addon compatibility issue.
- **Go/No-Go:** Go for WBS 7.4 workflow setup; both push and pull request CI
  runs pass.

- **Unit/contract:** Compile-time structural fixtures and small deterministic
  Vitest assertions in `tests/core/contracts.test.ts`. API-key tests are kept
  only as historical results; WBS 3.4 provides host-configured identity tests.
- **Integration:** Node's built-in `node:sqlite` continues to verify the runner;
  better-sqlite3 adapter tests use isolated temporary on-disk databases with
  the native driver and real schema. No external DB service or credentials are
  required.
- **Host-application E2E:** No separate host-application E2E suite is
  configured; package integration tests cover the embedded engine lifecycle.

## Test Cases and Acceptance-Criteria Traceability

| Test case | Contract coverage |
| --- | --- |
| Event includes JSON payload/metadata, delivery headers, lifecycle and lease state | `WebhookEvent` |
| Attempt captures response/transport failure and outcome | `AttemptRecord` |
| Adapter can be consumed through atomic claim, upsert, and attempt-transition signatures | `DatabaseAdapter` |
| Configuration carries concurrency, timeout, and bounded retry values | `EngineConfig` |
| SQLite initial migration runs from scratch and registers in `schema_migrations` | SQLite migration script |
| SQLite due-event and unique attempt indexes have the required column order | Schema inspection |
| SQLite enforces per-client idempotency, attempt ordinal uniqueness, foreign keys, and cascade | Schema constraints |
| SQLite migrations apply in version order, record checksums, and skip on re-run | `src/storage/migrations/runner.test.ts` |
| Drifted checksums and applied versions missing from disk are rejected | Migration ledger validation |
| Application start callback runs only after migrations succeed | `src/app/bootstrap.test.ts` |
| Adapter startup enables WAL/foreign keys, sets `busy_timeout=5000`, and applies migrations | `src/storage/sqlite.adapter.test.ts` |
| Upsert and event reads preserve tenant-scoped idempotency and JSON/ISO timestamp mappings | SQLite adapter integration tests |
| Event listing orders stably, scopes tenants, and enforces a maximum page size of 1,000 | SQLite adapter integration tests |
| Due claims are exclusive and lease changes obey worker ownership | SQLite adapter integration tests |
| One atomic `UPDATE ... RETURNING` statement selects due ordered rows, reserves attempts, stamps leases, and returns complete claimed events | `src/storage/sqlite.adapter.test.ts` |
| Competing independent processes claim a shared due-event batch with zero duplicate ids and no attempt-count drift | `src/storage/sqlite.adapter.test.ts` |
| At least 100 independent SQLite worker processes claim 1,000 due events with no duplicate ids and matching persisted lease owners | WBS 7.2 cross-process SQLite stress test |
| An abruptly terminated child process leaves its event persisted and eligible for recovery; the real SQLite recovery and scheduler path reclaims it without event loss | WBS 7.3 crash/restart integration test |
| Recovery uses the 90-second minimum when timeout is at or below 60 seconds and uses timeout + 30 seconds above that boundary | `src/storage/sqlite.adapter.test.ts` |
| Recovery returns only strictly expired processing leases to retry, clears lease fields, and schedules retry 10 seconds after supplied now | `src/storage/sqlite.adapter.test.ts` |
| Active leases, cutoff-equal leases, and non-processing rows remain unchanged; invalid recovery inputs reject without partial writes | `src/storage/sqlite.adapter.test.ts` |
| Engine creation requires no API key and binds the configured `clientId` to ingestion and query methods | `src/index.test.ts`, `src/app/embedded.test.ts` |
| Accepted events use the configured tenant identity; caller-supplied identity fields are rejected | `src/features/ingestion/ingestion.handler.test.ts`, `src/index.test.ts` |
| Cross-tenant/unknown event lookups return the same not-found result within the configured tenant scope | `src/index.test.ts`, `src/storage/sqlite.adapter.test.ts` |
| Ingestion body accepts exactly the documented fields and JSON-compatible payload | WBS 3.2 schema unit tests |
| Destination URL rejects non-HTTPS, malformed, or credential-bearing URLs | WBS 3.2 URL validation tests |
| Unsafe IPv4/IPv6 literals and any unsafe DNS answer are rejected, including mapped and mixed DNS results | WBS 3.2 SSRF unit tests |
| Handler accepts strict schema output and uses only the engine-bound configured `clientId` as tenant | WBS 3.3/3.4 handler unit tests |
| Omitted destination selects configured `WEBHOOK_URL`, then undergoes the same SSRF validation; supplied safe destination is preserved | WBS 3.3 handler unit tests |
| Invalid or unsafe configured fallback returns a generic 500 configuration error without persistence | WBS 3.3 handler unit tests |
| Programmatic ingestion returns generated id, key, replay flag, and pending status; duplicate returns the same id with replay=true and does not overwrite the persisted event | WBS 3.3/3.4 handler/SQLite integration tests |
| At least 1,000 concurrent submissions across tenant/key pairs yield exactly one stored row and stable replay identity per pair | WBS 3.3 and 7.2 SQLite concurrency integration tests |
| Invalid schema, destination, and storage cases are surfaced without a successful result or partial event write | WBS 3.3/3.4 handler/SQLite integration tests |
| Every poll cycle recovers stale leases before atomically claiming a configured-size batch and passes only claimed events to the worker seam | WBS 4.1 scheduler unit and SQLite integration tests |
| Empty queue cycles throttle for the configured poll interval; transient adapter failures are reported and polling resumes | WBS 4.1 scheduler unit tests |
| Idle scheduler CPU overhead stays below 10% in the documented local benchmark | WBS 4.1 performance test |
| Attempt append and event transition commit or roll back atomically | SQLite adapter integration tests |
| All adapter operations bind untrusted values as SQL parameters | SQLite adapter integration tests |
| Strict TypeScript compilation | All exported contracts and readonly structural fixtures |

## Environment, Data, and Prerequisites

Run with the repository's pnpm lockfile, Node.js version from `.nvmrc` (Node
24+ per `package.json`), and installed project dependencies including a
working better-sqlite3 native binding and Node.js `node:sqlite` support. The
repository explicitly permits the better-sqlite3 install script through
`pnpm.onlyBuiltDependencies`; `node-gyp` is a development dependency for
building the binding when a matching prebuilt binary is unavailable. Fixtures
use synthetic identifiers, a reserved `.example` destination, and no
credentials or external services.

## Tools and Test Execution

- `pnpm test`
- `pnpm exec vitest run --coverage`
- `pnpm exec tsc --noEmit --project tsconfig.json`
- `pnpm lint`
- `pnpm exec prettier --check` on changed TypeScript and Markdown files

## Security, Accessibility, Performance, and Regression

Review tenant idempotency uniqueness, state/status constraints, lease field
consistency, FK cascade behavior, checksums, transaction rollback after partial
DDL, parameter binding, and atomic claim correctness under process contention.
SQLite tests use isolated in-memory or temporary on-disk databases.
PostgreSQL/MySQL checks are out of v1.0 scope. Accessibility and performance
testing do not apply to these storage contracts.

## Coverage: minimum 80% overall, 95% for critical paths

The repository-wide thresholds remain 80% overall and 95% on critical paths.
Coverage applies to executable runner, adapter, bootstrap, and security code;
configured tenant identity/isolation and other critical paths target at least 95% coverage while
repository-wide coverage remains at least 80%. SQL declarations are not treated
as executable source. Record measured results or report a tooling limitation
without treating an unmeasured threshold as met.

## Entry/Exit Criteria and Go/No-Go

- **Entry:** Approved SDD contract boundary, existing strict TypeScript and
  Vitest configuration, Node `node:sqlite` support, working better-sqlite3
  native binding, and pre-implementation tests.
- **Exit:** Full applicable tests (including fresh SQLite runner/schema checks),
  strict type-check, build, formatter, and lint pass; no duplicate contract
  definitions are introduced. PostgreSQL/MySQL tests are scheduled with their
  v2.0 implementation, not skipped as part of v1.0.
- **Go/No-Go:** Go only after all applicable exit checks pass; otherwise report
  the exact failing command and keep the task open.

## Bugs, Triage, and Results Reporting

Record command output and environment with task results. A failed compile or
test blocks completion; no failures are suppressed. At implementation
completion, append actual command results and the Go/No-Go decision here.

### Task 1.2 Results

- **Environment:** Node.js v24.16.0; pnpm 10.4.1.
- **TDD red check:** Before production contracts existed,
  `pnpm exec tsc --noEmit --project tsconfig.json` failed with unresolved core
  contract imports as expected.
- **Final tests:** `pnpm test` passed (1 file, 4 tests).
- **Final type-check:** `pnpm exec tsc --noEmit --project tsconfig.json` passed.
- **Final lint:** `pnpm lint` passed with zero warnings.
- **Final formatting:** Prettier check passed for all changed files. The initial
  check identified three TypeScript files that needed formatting; they were
  formatted and the check was rerun successfully.
- **Diff hygiene:** `git diff --check` passed.
- **Coverage:** Not measured. The deliverables are erased type declarations
  with structural contract tests; no executable critical-path implementation
  was added, so no overall or critical-path percentage is claimed.
- **Open bugs:** None identified in this task's contract scope.
- **Go/No-Go:** Go for Task 1.2 contract implementation; project-wide coverage
  thresholds remain to be measured when executable paths are added.

### Task 2.1 Results

> Historical results below include static DDL checks for dialect files that
> have since been removed from the v1.0 codebase. They are not current support
> or validation claims; PostgreSQL/MySQL implementation and tests are deferred
> to v2.0.

- **Environment:** Node.js v24.16.0; pnpm 10.4.1; Node `node:sqlite` SQLite
  v3.53.0.
- **TDD red check:** Before migration files were added,
  `pnpm test -- tests/storage/schema.test.ts` failed with `ENOENT` for the
  missing SQLite migration as expected.
- **Resolved test-environment issue:** The first SQLite integration attempt
  could not load the installed `better-sqlite3` native binding; rebuilding it
  did not provide the binary. The test now uses Node's built-in SQLite engine,
  which is available under the project's Node 24 runtime. An initial schema
  assertion also showed SQLite does not preserve names for table-declared
  unique constraints, so the attempt-ordinal constraint is now an explicitly
  named unique index and its column order is inspected.
- **Final tests:** `pnpm test` passed (2 files, 9 tests), including live fresh
  SQLite migration/inspection and static PostgreSQL/MySQL DDL contract checks.
- **Type-check:** `pnpm exec tsc --noEmit --project tsconfig.json` passed.
- **Lint:** `pnpm lint` passed with zero warnings.
- **Formatting:** Prettier check passed for all changed Markdown and TypeScript
  files. The repository has no SQL formatter/parser configured; an initial
  check on `.sql` files could not infer a parser, so migration SQL was reviewed
  and exercised where supported.
- **Diff hygiene:** `git diff --check` passed.
- **Coverage:** Not measured; these changes are SQL declarations and migration
  integration tests, not executable production logic.
- **Limitations:** No PostgreSQL/MySQL service or driver is configured, so those
  dialects received static SQL contract checks only. Live adapter coverage
  remains for the respective adapter tasks.
- **Open bugs:** None found within the approved DDL scope.
- **Go/No-Go:** Go for Task 2.1 under the approved SQLite-live and
  PostgreSQL/MySQL-static verification scope.

### Task 2.2 Results

> Historical results below describe the earlier multi-dialect implementation
> and are superseded by the v1.0 SQLite-only support decision. Current
> SQLite-only validation is recorded in the latest scope-alignment result.

- **Environment:** Node.js v24.16.0; pnpm 10.4.1; SQLite via Node's built-in
  `node:sqlite`.
- **TDD red checks:** The initial runner test failed because `runner.ts` was
  absent. A later regression test failed because comment-only MySQL SQL was
  incorrectly eligible for ledger recording; the parser was corrected to
  reject files without executable statements.
- **Final tests:** `pnpm test` passed (4 files, 28 passed); the 2 optional live
  PostgreSQL/MySQL integration tests were skipped because their test URLs are
  not configured.
- **Coverage:** `pnpm exec vitest run --coverage` passed the configured
  executable-source thresholds: 98.67% lines/statements, 100% functions, and
  92.92% branches overall. The migration runner has 98.64% line coverage,
  100% function coverage, and 92.79% branch coverage.
- **Build/type-check:** `pnpm build` and
  `pnpm exec tsc --noEmit --project tsconfig.json` passed. The build verified
  that all three dialect SQL files are copied alongside the compiled runner.
- **Lint/format/diff:** `pnpm lint`, Prettier checks, and `git diff --check`
  passed.
- **Limitations:** No PostgreSQL/MySQL test services were configured, so their
  environment-gated live integration runs remain unverified here. Unit tests
  exercise PostgreSQL transaction/rollback behavior and MySQL statement
  splitting/ledger failure behavior; SQL DDL contracts are also statically
  checked.
- **Open bugs:** None identified within the approved runner and startup-seam
  scope.
- **Go/No-Go:** Go for Task 2.2 under the approved conditional live-database
  test scope.

### v1.0 Database-Scope Alignment Results

- **Scope change:** PostgreSQL/MySQL driver support, migration code, SQL files,
  and related live/static tests were removed from the v1.0 runtime and deferred
  to v2.0. SQLite migration and schema tests remain active.
- **Environment:** Node.js v24.16.0; pnpm 10.4.1.
- **Tests:** `pnpm test` passed (5 files, 20 tests); SQLite migration runner,
  startup ordering, and schema inspection tests passed.
- **Coverage:** `pnpm exec vitest run --coverage` passed configured thresholds:
  97.35% statements/lines, 100% functions, and 92.59% branches overall.
- **Build/type-check/lint:** `pnpm build`,
  `pnpm exec tsc --noEmit --project tsconfig.json`, and `pnpm lint` passed.
- **Formatting/diff:** Prettier check and `git diff --check` passed.
- **Go/No-Go:** Go for SQLite-only v1.0 database support; PostgreSQL/MySQL
  implementation and validation remain deferred to v2.0.

### Task 2.3 Results

- **Environment:** Node.js v24.16.0; pnpm 10.4.1; better-sqlite3 11.10.0 on
  temporary on-disk SQLite databases.
- **Native driver setup:** pnpm initially ignored the better-sqlite3 install
  script and no Node 24 prebuilt binary was available. With explicit approval,
  `better-sqlite3` was added to `pnpm.onlyBuiltDependencies`, `node-gyp` was
  added as a development dependency, and the native binding compiled
  successfully.
- **TDD red checks:** Adapter tests first failed because the implementation
  module did not exist. Regression tests then exposed an incorrect `inserted`
  result for a repeated upsert, permissive non-ISO timestamp parsing, and
  failure to reject in-memory SQLite when WAL could not be enabled. A due-claim
  test also caught a pending row with a future retry time being claimed early.
  Each behavior was corrected and the tests passed.
- **Final tests:** `pnpm exec vitest run --coverage` passed (6 files, 47 tests),
  including 27 adapter integration tests using the actual better-sqlite3
  driver.
- **Coverage:** 96.65% overall lines/statements, 98.03% functions, and 90.81%
  branches. The adapter measured 96.42% lines/statements, 97.67% functions,
  and 90.20% branches. Critical adapter line and function coverage exceeded
  95%; the branch result is recorded separately because defensive branches for
  invalid SQLite row shapes cannot all be produced through the strict schema.
- **Build/type-check/lint:** `pnpm build`,
  `pnpm exec tsc --noEmit --project tsconfig.json`, and `pnpm lint` passed.
- **Formatting/diff:** Prettier check and `git diff --check` passed.
- **Limitations:** PostgreSQL/MySQL remain deferred to v2.0. The adapter test
  suite uses real SQLite files and validates transaction rollback, tenant
  isolation, SQL parameter binding, lease ownership, pagination, and startup
  pragmas.
- **Open bugs:** None identified in the approved SQLite adapter scope.
- **Go/No-Go:** Go for WBS Task 2.3 under the approved SQLite-only v1.0 scope.

### Task 2.6 Results

- **Environment:** Node.js v24.16.0; pnpm 10.4.1; better-sqlite3 11.10.0
  using a shared temporary on-disk SQLite database.
- **TDD red checks:** A claim-contract test failed against the prior
  SELECT/UPDATE/SELECT implementation because it did not contain one
  conditional `UPDATE ... RETURNING` statement. A concurrent due-claim test
  caught pending events with future retry timestamps being eligible; the claim
  predicate was tightened to include only due `pending` and `retry` rows.
- **Cross-process test:** Four independent Node.js processes each claimed one
  batch from the same database; all 24 events were claimed exactly once, six
  per process, with matching lease owners and `attempt_count = 1`.
- **Final tests, coverage, build, lint, type-check, format, and diff results:**
- **Final tests:** `pnpm exec vitest run --coverage` passed (6 files, 49
  tests). The cross-process contention test also passed five consecutive
  independent runs.
- **Coverage:** 96.23% overall lines/statements, 98.03% functions, and 89.79%
  branches. The storage adapter measured 95.85% lines/statements, 97.67%
  functions, and 88.81% branches. The claim method was exercised by the
  boundary, source-contract, and cross-process tests; reported line/function
  coverage exceeds 95%.
- **Build/type-check/lint:** `pnpm build`,
  `pnpm exec tsc --noEmit --project tsconfig.json`, and `pnpm lint` passed.
- **Formatting/diff:** Prettier checks and `git diff --check HEAD` passed.
- **Validation note:** Vitest 3.2.7 does not support the attempted
  `--repeat-each` option; the repeated cross-process test was instead run five
  times in a shell loop, and all five runs passed.
- **Open bugs:** None identified in the approved SQLite atomic-claim scope.
- **Go/No-Go:** Go for WBS Task 2.6 under the approved SQLite-only v1.0 scope.

### Task 2.7 Results

- **Environment:** Node.js v24.16.0; pnpm 10.4.1; real temporary SQLite
  databases through better-sqlite3.
- **TDD red check:** Four stale-recovery tests failed against the old
  cutoff/timestamp contract, confirming the missing dynamic threshold and
  validation behavior before implementation.
- **Final tests:** `pnpm exec vitest run --coverage` passed (6 files, 52 tests).
  Recovery tests cover the 90-second minimum, the timeout-plus-30-second
  threshold above 60 seconds, strict cutoff behavior, active and non-processing
  leases, 10-second retry scheduling, cleared lease fields, and invalid inputs
  without writes.
- **Coverage:** 96.32% overall lines/statements, 98.03% functions, and 90.04%
  branches. The SQLite adapter measured 95.98% lines/statements, 97.67%
  functions, and 89.18% branches.
- **Build/type-check/lint:** `pnpm build`,
  `pnpm exec tsc --noEmit --project tsconfig.json`, and `pnpm lint` passed.
- **Formatting/diff:** Prettier checks and `git diff --check` passed.
- **Open bugs/limitations:** No adapter defects identified. WBS 4.1 must invoke
  `recoverStaleLeases` once per poll cycle; Task 2.7 deliberately does not add
  that poll loop.
- **Go/No-Go:** Go for WBS Task 2.7's approved SQLite adapter recovery scope;
  the scheduler integration remains outside this task.

### Task 3.1 Results — Superseded API-Key Authentication (Historical)

These results document the previously implemented API-key authentication
contract and its tests. That contract is superseded for v1 and its implementation
and tests have been removed. The results below are retained as historical
execution evidence, not as current v1 acceptance evidence.

- **Environment:** Node.js v24.16.0; pnpm 10.4.1; Vitest 3.2.7.
- **TDD red check:** `pnpm exec vitest run src/security/auth.test.ts` failed
  because `src/security/auth.ts` did not yet exist, as expected.
- **Focused coverage note:** Running the auth test file alone with global
  coverage enabled showed 100% auth-module coverage but exited non-zero because
  the repository-wide 80% threshold includes unexecuted app/storage modules.
  The complete coverage suite was used for the final threshold result.
- **Final tests:** `pnpm exec vitest run --coverage` passed (7 files, 56 tests),
  including all four authentication tests for valid identity resolution,
  identical unauthorized results across missing/incorrect/unequal-length
  credentials, secret non-disclosure, and invalid configuration.
- **Coverage:** 96.49% overall lines/statements, 98.14% functions, and 90.61%
  branches. `src/security/auth.ts` measured 100% lines/statements, functions,
  and branches.
- **Build/type-check/lint:** `pnpm build`,
  `pnpm exec tsc --noEmit --project tsconfig.json`, and `pnpm lint` passed.
- **Formatting/diff:** Prettier check and `git diff --check` passed.
- **Open bugs/limitations:** No defects were identified in the historical
  authentication primitive. The primitive is outside current v1 scope and has
  been removed under WBS 3.4.
- **Go/No-Go:** Historical go for WBS Task 3.1 only; not a current v1 scope
  approval.

### Task 3.2 Results

- **Environment:** Node.js v24.16.0; pnpm 10.4.1; Vitest 3.2.7.
- **TDD red check:** The new schema and SSRF test files initially failed because
  their production modules did not exist. After implementation, all focused
  tests passed. Interim strict type-check/lint findings in the DNS test seam
  and URL control-character check were corrected before final verification.
- **Final tests:** `pnpm exec vitest run --coverage` passed (9 files, 109
  tests). The 53 Task 3.2 tests cover strict request fields, recursive JSON
  values, unsupported/malformed/credential-bearing URLs, IPv4 and IPv6
  special-use ranges, non-canonical IPv4 forms, IPv4-mapped IPv6, mixed DNS
  answers, empty results, resolver failures, and safe error results. DNS test
  answers are mocked deterministically; no external DNS or destination
  network request is made.
- **Coverage:** 96.99% overall lines/statements, 98.46% functions, and 92.44%
  branches. `src/features/ingestion/ingestion.schema.ts` measured 100% for
  lines, statements, functions, and branches. `src/security/ssrf.ts` measured
  98.68% lines/statements, 100% functions, and 98.41% branches; per-file 95%
  thresholds are enforced in Vitest for both critical modules.
- **Build/type-check/lint:** `pnpm build`,
  `pnpm exec tsc --noEmit --project tsconfig.json`, and `pnpm lint` passed.
- **Formatting/diff:** Prettier checks and `git diff --check` passed.
- **Open risks/limitations:** The validator performs preflight DNS validation,
  not connection pinning. WBS 5.2 must revalidate/pin the resolved address and
  disable redirects or validate each redirect before dispatch.
- **Go/No-Go:** Go for the WBS 3.2 validator and request-schema scope. No
  end-to-end ingestion or dispatch claim is made; those integrations are
  downstream work.

### Task 3.3 Results

- **Environment:** Node.js v24.16.0; pnpm 10.4.1; Vitest 3.2.7.
- **TDD red check:** The new handler test file initially failed because the
  ingestion handler module did not exist. After implementation, all focused
  handler tests passed, including the real-SQLite duplicate-submission test.
- **Final tests:** `pnpm exec vitest run --coverage` passed (10 files, 118
  tests). Under the former scope, the handler suite verified authentication
  and schema short-circuits,
  supplied and fallback destination validation, generated event fields, new
  event and replay responses, storage error propagation, tenant isolation, and
  1,000 concurrent duplicate submissions across two SQLite adapter instances.
- **Coverage:** 97.16% overall statements/lines, 92.88% branches, and 98.48%
  functions. `src/features/ingestion/ingestion.handler.ts` measured 100% for
  statements, lines, branches, and functions.
- **Build/type-check/lint:** `pnpm run build`,
  `pnpm exec tsc --noEmit --project tsconfig.json`, and `pnpm run lint` passed.
- **Formatting/diff:** Prettier checks and `git diff --check` passed.
- **Limitations:** These results include the former authenticated-handler
  contract; WBS 3.4 results below record its replacement. Raw request parsing
  remains outside the product scope.
- **Go/No-Go:** Historical go for the WBS 3.3 implementation under its former
  contract.

### Task 3.4 Results — Host-Owned Ingestion Identity

- **Environment:** Node.js v24.16.0; Vitest 3.2.7; SQLite via better-sqlite3.
- **TDD red check:** The first focused run after updating tests to remove
  `apiKey` failed as expected: the embedded factory still required the option,
  and the handler still expected an authentication result. A first full
  coverage run then measured 94.44% branches for `src/app/embedded.ts`, below
  its 95% gate; a configured-client validation test closed the missing branch.
- **Final tests:** `pnpm exec vitest run --coverage` passed (19 files, 384
  tests). Coverage includes keyless engine creation, configured `clientId`
  stamping, rejection of caller-supplied identity, tenant-scoped reads,
  idempotency/replay behavior, and the 1,000-submission SQLite concurrency
  test. Obsolete internal HTTP/authentication tests were removed with those
  unsupported modules.
- **Coverage:** 98.46% lines/statements, 99.06% functions, and 95.49% branches
  overall. `src/app/embedded.ts` measured 100% lines/statements/functions and
  95.89% branches; `src/features/ingestion/ingestion.handler.ts` measured
  100% in all four dimensions.
- **Ingestion benchmark:** `pnpm benchmark:ingestion` measured 1,500 requests
  after 100 warm-ups. Median round p95 was 0.23972 ms against the 50 ms target;
  zero dispatch attempts occurred, and the benchmark passed.
- **Build/type-check/lint:** `pnpm build`,
  `pnpm exec tsc --noEmit --project tsconfig.json`, and `pnpm lint` passed.
- **Limitations:** Generic logger redaction for API-key-like field names is
  retained as defense in depth. External transport and caller authentication
  remain the host application's responsibility.
- **Go/No-Go:** Go for WBS 3.4 implementation and verification.

### Task 5.4 Results

- **Environment:** Node.js v24; Vitest 3.2.7; SQLite via better-sqlite3 for
  adapter integration tests.
- **TDD red check:** The classifier and worker test files initially failed to
  load their missing production modules, as expected. The new classification
  cases then passed, followed by worker tests and real SQLite adapter tests.
- **Final tests:** `pnpm exec vitest run --coverage` passed (17 files, 359
  tests). This includes HTTP classification boundaries, dispatch-to-attempt
  mapping, worker error reporting, UTF-8 snippet byte limits, lease-loss
  handling, and SQLite atomic attempt/state transition coverage.
- **Coverage:** 97.76% overall lines/statements, 98.86% functions, and 94.47%
  branches. The classifier measured 100% in all dimensions; the delivery worker
  measured 100% lines/statements/functions and 97.14% branches. Both new
  modules have enforced 95% thresholds.
- **Lint/format/diff:** ESLint passed with zero warnings; Prettier check passed
  on changed files; `git diff --check` passed.
- **Type-check/build:** `pnpm build` passed after `tsconfig.json` was updated to
  compile application sources and exclude test files. Vitest still discovers
  and runs the test files independently; the production build does not
  type-check test files.
- **Open bugs:** None found in the WBS 5.4 implementation. Full-repository
  production-source build validation passed.
- **Go/No-Go:** Go for WBS 5.4 behavior, coverage, lint, and production build.

### Task 6.2 Implementation Checkpoint

- **Environment:** Node.js v24.16.0; pnpm 10.4.1; Vitest 3.2.7; better-sqlite3
  with temporary on-disk SQLite databases.
- **TDD red check:** The package-root test first failed because `src/index.ts`
  did not exist. The lifecycle drain test first failed because the shutdown
  coordinator had no dispatch tracking API.
- **Focused lifecycle validation:** The lifecycle suite confirms shutdown
  waits for started work while releasing undispatched leases. The public engine
  integration seeds two due rows with `workerCount: 1`, holds the started HTTP
  request, calls `stop()`, then confirms one persisted delivery and one
  released pending event without a second fetch.
- **Final tests:** `pnpm exec vitest run --coverage` passed (19 files, 383
  tests). This includes package-root export, migration-before-query, tenant
  binding, ingestion/query facade behavior, and the started-versus-queued
  shutdown lifecycle.
- **Coverage:** 98.15% overall lines/statements, 99.12% functions, and 94.95%
  branches. `src/app/embedded.ts` has 100% lines/functions and 96.61% branches;
  lifecycle coverage is 100% in all dimensions. All configured 95% critical
  thresholds pass.
- **Build/lint/format:** `pnpm build` passed, including TypeScript declaration
  output and migration asset copy. `pnpm lint` and Prettier checks passed.
- **Package validation:** `pnpm pack --pack-destination /tmp` produced a
  tarball containing the ESM root, declarations, runtime modules, README,
  license, and SQLite migration SQL. `npm install` installed the tarball and
  runtime dependencies into a fresh temporary consumer app; a package-root
  import then started SQLite migrations, queried events, and stopped cleanly.
  pnpm 12 required native build-script approval for `better-sqlite3`, which is
  documented for consumers. No registry publish was performed.
- **Open work:** Changes are awaiting review before commit/PR. Public registry
  publication remains a separate release action.
- **Go/No-Go:** Go for implementation review and PR preparation. Do not publish
  until the release process is separately approved.

### Task 6.3 Implementation Checkpoint

- **Environment:** Node.js v24; pnpm 10.4.1; Vitest 3.2.7; temporary on-disk
  SQLite databases and the installed Pino dependency.
- **TDD red check:** The logger tests initially failed because
  `src/shared/logger.ts` did not exist. Embedded logging tests then failed
  because the engine emitted no structured records.
- **Focused tests:** Logger tests verify level precedence and validation,
  JSON output and threshold filtering, and removal of sensitive fields at root
  and nested request/event paths. Engine tests cover configured levels,
  ingestion-safe context, recovery counts, claim/dispatch/attempt lifecycle
  records, and scheduler errors without raw messages or stacks.
- **Final tests:** `pnpm test --coverage` passed (21 files, 393 tests).
- **Coverage:** 98.29% overall lines/statements, 99.15% functions, and 95.00%
  branches. `src/shared/logger.ts` measured 100% in all dimensions; its 95%
  critical-path thresholds passed.
- **Build/lint/format:** `pnpm build`, `pnpm lint`, changed-file Prettier check,
  and `git diff --check` passed.
- **Package validation:** `pnpm pack --pack-destination /tmp` included the
  compiled logger module and declarations. A package-root smoke check imported
  the built factory, started SQLite migrations, queried an empty event page,
  and stopped cleanly.
- **Open work:** Review and branch publication remain; no commit or PR has been
  created for WBS 6.3.
- **Go/No-Go:** Go for implementation review; no registry publish or deployment
  was performed.

### Task 5.2.a Results (Issue #82)

- **Environment:** Node.js v24.16.0; pnpm 10.4.1; Vitest 3.2.7; Undici
  8.12.3. Connection tests use a local HTTPS server and test-only certificate;
  no external DNS lookup or destination is contacted.
- **TDD evidence:** Resolver tests were first run against the missing dispatch
  resolver and failed as expected. Dispatcher tests then demonstrated the
  missing fresh-resolution and request-scoped-Agent behavior before the
  implementation was added.
- **Security coverage:** Tests prove dispatch-time resolution catches an
  answer changed since ingestion preflight; unsafe/mixed/empty/failed results
  open no connection; a local HTTPS server receives a request through the
  vetted address with the original hostname as SNI; incorrect certificate
  identity and connection failure send no HTTP request; redirects are not
  followed. Existing timeout, signature, body, status, latency, and response
  snippet behavior remains covered.
- **Final tests:** `pnpm exec vitest run --coverage` passed (20 files, 401
  tests).
- **Coverage:** 98.54% overall statements/lines, 99.09% functions, and 95.53%
  branches. The dispatcher measured 100% statements, lines, and functions with
  97.29% branch coverage; SSRF validation measured 98.75% statements/lines,
  100% functions, and 98.55% branches.
- **Other checks:** `pnpm exec tsc --noEmit --project tsconfig.json`,
  `pnpm lint`, `pnpm build`, and Prettier checks on changed source and
  documentation passed. `git diff --check` is recorded after the final
  documentation update.
- **Open limitations:** The request-scoped Agent adds per-dispatch connection
  setup overhead. The WBS 8.2.b phase-gate review accepted the historical
  sequencing deviation and verified the R-03 mitigation; the residual High
  risk rating remains unchanged.
- **Go/No-Go:** Go for WBS 5.2.a implementation and review; the DNS-rebinding
  dispatch gap is covered by the tests above.

### WBS 8.2.b Phase-Gate QA Results (Issue #84)

- **Date/environment:** 2026-10-25; Node.js v24.16.0; Vitest 3.2.7. pnpm was
  used to invoke the project commands; a standalone pnpm version probe did
  not return, so its version is not claimed for this run. Tests use synthetic
  data, deterministic mocked DNS, temporary SQLite databases, and local TLS;
  no external DNS or destination was contacted.
- **Security-focused tests:** `pnpm exec vitest run
  src/security/ssrf.test.ts
  src/features/delivery/delivery.dispatcher.test.ts
  src/features/delivery/delivery.dispatcher.pin.test.ts` passed: 3 files,
  91 tests.
- **Full tests and coverage:** `pnpm exec vitest run --coverage` passed:
  20 files, 401 tests. Overall coverage was 98.54% statements/lines, 99.09%
  functions, and 95.53% branches. `delivery.dispatcher.ts` measured 100%
  statements/lines/functions and 97.29% branches; `ssrf.ts` measured 98.75%
  statements/lines, 100% functions, and 98.55% branches.
- **Additional critical-path check:** `node
  scripts/check-claim-coverage.mjs` passed. Both `claimDueEvents` and
  `compareClaimedEvents` measured 100% statements, lines, functions, and
  branches, exceeding the 95% atomic-claim threshold.
- **Other checks:** `pnpm lint`, `pnpm exec tsc --noEmit --project
  tsconfig.json`, and `pnpm build` passed. Prettier checks on all seven updated
  records and `git diff --check` passed after the documentation edits.
- **Failures/open bugs:** No test, lint, type-check, or build failures; no
  implementation defect was found by this QA run. The Planning-to-SDD audit
  sequencing deviation was explicitly accepted by the stakeholder on
  2026-10-25. PRD goals G2/G3/G7 now use approved evidence-based completion
  dates of October 23, October 22, and October 23, 2026, respectively.
- **Go/No-Go:** Go with accepted historical sequencing exception. WBS 5.2.a
  security implementation and its test/coverage criteria pass; approval and
  the decision are recorded in `docs/01-plan/phase-gate-audit.md`.
- **Re-run:** On 2026-10-25 against merged `dev` at `d111b3e`, the same focused
  and full test commands, coverage, claim-coverage checker, lint, type-check,
  and build all passed with identical counts and coverage results. The
  re-audit found no new traceability or implementation findings. The
  stakeholder approved the checkpoint disposition on 2026-10-25, as recorded
  in `docs/01-plan/phase-gate-audit.md`.

## Hosted Demo Test Plan Addendum (WBS 9.0; Local QA In Progress)

- **Separate consumer project:** install the root package using its pnpm lockfile; build and pack the library, then install and run the demo from `examples/demo` using its own pnpm lockfile and packed package dependency. The demo's clean install/import verifies the package contents and public export without registry publication.
- **Server lifecycle:** start readiness only after engine migrations; verify static UI and health/API share one listener; SIGTERM/SIGINT stop intake and await `engine.stop()`.
- **Scenario integration:** exercise fixed receiver 200, retryable 503 recovery to 2xx, terminal 401, persistent 503 through configured max attempts ending `failed`, SSRF rejection, and bounded custom payload/idempotency. Assert attempt sequence, final engine state, and no receiver hit for rejected destinations.
- **Receiver security:** verify HMAC signature/timestamp and body binding, invalid/missing signature rejection, and that the demo secret is never returned or logged.
- **API security:** verify no route accepts arbitrary URL/clientId/secret/config; payload and key bounds, JSON content type, scenario allowlist, rate limits, unguessable run IDs, cross-run access rejection, bounded retention, and sanitized errors.
- **UI integration:** verify scenario controls, status polling, attempt timeline, signature/timestamp metadata, and visible Render Free sleep/reset disclosure; no raw logs or stack traces.
- **Host verification limitation:** local loopback receivers must remain rejected by production SSRF policy. Full self-receiver end-to-end behavior therefore requires the approved public HTTPS Render origin after deployment approval; local pre-deploy QA covers route/receiver behavior and existing dispatcher/SSRF tests without adding a bypass.
- **Quality:** demo unit/integration tests, packed-package install/import smoke, demo typecheck/lint/build, and root security/full suites plus coverage. Report actual results separately; no planned check is a pass until executed.

### Local Validation Record — 2026-10-25

- **Passed:** root package `npm run build`.
- **Passed:** demo TypeScript and Vite production build via `npm run build` from `examples/demo`.
- **Passed:** root `npm run lint`, including demo TypeScript/TSX sources.
- **Not run:** automated tests, pnpm frozen-lockfile installation, runtime scenario smoke, and live Render checks. These remain open; build and lint results do not establish scenario correctness or deployment readiness.

### Local Validation Record — 2026-10-26 (Standalone Project QA)

- **Environment:** Node.js v24.16.0, Linux x64, pnpm 10.4.1, Vitest 3.2.7.
- **Install and package boundary:** root `pnpm install --frozen-lockfile` and the independent demo `pnpm install --frozen-lockfile` passed. The demo dependency resolves from the root `pnpm pack` tarball; importing and building against its public package entry passed. The demo's project-local `.npmrc` uses the hoisted node linker so the SQLite native install can find `node-gyp` when this host has no prebuilt binary.
- **Tests and coverage:** demo `pnpm test` passed (2 files, 9 tests); root `pnpm test` passed (20 files, 401 tests). Root coverage passed at 98.54% statements/lines, 95.54% branches, and 99.09% functions. Demo-specific coverage was not measured separately.
- **Lint and build:** root and demo lint passed; root build and demo TypeScript/Vite production build passed.
- **Runtime smoke:** production server returned HTTP 200 with `{"status":"ready"}` from `/api/health`; SIGTERM shut the process down with exit code 0. The SQLite file was isolated under `/tmp`.
- **Not run:** delivery scenarios against a public HTTPS receiver, deployed Render health checks, and remote UI behavior. Sandbox loopback connection attempts returned `EPERM`; no SSRF exception or local receiver bypass was introduced.
- **Decision:** local pre-deployment checks pass. Hosted scenario and Render verification remain open, and no deployment has been performed.
