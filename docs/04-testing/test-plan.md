# Test Plan — Webhook Delivery Engine

- **Status:** Active
- **Version:** 1.0.0
- **Owner:** Engineering
- **Scope:** WBS Tasks 1.2, 2.1, 2.2, and 2.3: core domain contracts, SQLite
  schema/migrations, and the better-sqlite3 storage adapter. PostgreSQL and
  MySQL are deferred to v2.0 and are not part of v1.0 validation.

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

## Strategy and Layers (Unit / Integration / E2E)

- **Unit/contract:** Compile-time structural fixtures and small deterministic
  Vitest assertions in `tests/core/contracts.test.ts`.
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
DDL, and parameter binding. SQLite tests use isolated in-memory or temporary
on-disk databases. PostgreSQL/MySQL checks are out of v1.0 scope. Accessibility
and performance testing do not apply to these storage contracts.

## Coverage: minimum 80% overall, 95% for critical paths

The repository-wide thresholds remain 80% overall and 95% on critical paths.
Coverage applies to executable runner, adapter, and bootstrap code; the adapter
and other critical storage operations target at least 95% coverage while
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
