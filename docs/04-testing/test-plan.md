# Test Plan — Webhook Delivery Engine

- **Status:** Active
- **Version:** 1.0.0
- **Owner:** Engineering
- **Scope:** WBS Tasks 1.2, 2.1, 2.2, 2.3, 2.6, 2.7, 3.1, and 3.2: core domain
  contracts, SQLite schema/migrations, the better-sqlite3 storage adapter,
  atomic claim, authentication, ingestion input validation, and SSRF URL
  validation. PostgreSQL and MySQL are deferred to v2.0 and are not part of
  v1.0 validation.

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
For Task 3.1, verify a valid configured API key resolves only to its configured
`clientId`; absent, invalid, and unequal-length credentials produce a uniform
unauthorized result. Confirm SHA-256 pre-hashing plus
`crypto.timingSafeEqual`, and verify secrets are never included in results,
errors, or logs.
For Task 3.2, verify the ingestion schema accepts only `idempotency_key`,
JSON `payload`, and optional `destination_url`; malformed/missing fields and
unknown keys are rejected. Verify only absolute HTTPS URLs without credentials
are accepted, literal IPv4/IPv6 addresses are classified correctly, and every
resolved A/AAAA result is checked. Cover loopback, RFC 1918, IPv6 unique-local,
link-local, unspecified, multicast, reserved, IPv4-mapped, and cloud metadata
addresses, including mixed public/private DNS answers. Resolver tests use
deterministic mocked DNS answers; no external DNS or network is contacted.

## Strategy and Layers (Unit / Integration / E2E)

- **Unit/contract:** Compile-time structural fixtures and small deterministic
  Vitest assertions in `tests/core/contracts.test.ts`; API-key authentication
  is exercised by `src/security/auth.test.ts`.
- **Integration:** Node's built-in `node:sqlite` continues to verify the runner;
  better-sqlite3 adapter tests use isolated temporary on-disk databases with
  the native driver and real schema. No external DB service or credentials are
  required.
- **E2E:** Not applicable; no running application or transport exists yet.

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
| Recovery uses the 90-second minimum when timeout is at or below 60 seconds and uses timeout + 30 seconds above that boundary | `src/storage/sqlite.adapter.test.ts` |
| Recovery returns only strictly expired processing leases to retry, clears lease fields, and schedules retry 10 seconds after supplied now | `src/storage/sqlite.adapter.test.ts` |
| Active leases, cutoff-equal leases, and non-processing rows remain unchanged; invalid recovery inputs reject without partial writes | `src/storage/sqlite.adapter.test.ts` |
| Valid configured API key resolves its configured `clientId` | WBS 3.1 authentication unit tests |
| Missing, invalid, and unequal-length API keys produce the same unauthorized result without exposing credentials | WBS 3.1 authentication unit tests |
| Credential comparison uses equal-length SHA-256 digests and `crypto.timingSafeEqual` | WBS 3.1 authentication implementation and tests |
| Ingestion body accepts exactly the documented fields and JSON-compatible payload | WBS 3.2 schema unit tests |
| Destination URL rejects non-HTTPS, malformed, or credential-bearing URLs | WBS 3.2 URL validation tests |
| Unsafe IPv4/IPv6 literals and any unsafe DNS answer are rejected, including mapped and mixed DNS results | WBS 3.2 SSRF unit tests |
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
authentication and other critical paths target at least 95% coverage while
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

### Task 3.1 Results

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
- **Open bugs/limitations:** No authentication defects identified. This task
  provides an auth primitive, not a server or header-extraction middleware;
  future HTTP routes must map its unauthorized result to an actual HTTP 401
  and must use the returned `clientId` for tenant scoping.
- **Go/No-Go:** Go for WBS Task 3.1 authentication primitive; route integration
  remains in downstream API work.

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
  disable redirects or validate each redirect before dispatch. The HTTP
  transport remains responsible for malformed raw JSON parsing and mapping
  schema/destination failures to HTTP 400/422.
- **Go/No-Go:** Go for the WBS 3.2 validator and request-schema scope. No
  end-to-end ingestion or dispatch claim is made; those integrations are
  downstream work.
