# Test Plan — Webhook Delivery Engine

- **Status:** Active
- **Version:** 1.0.0
- **Owner:** Engineering
- **Scope:** WBS Tasks 1.2, 2.1, and 2.2: core domain contracts, the SQLite raw
  schema, and the in-house SQLite migration runner. PostgreSQL and MySQL are
  deferred to v2.0 and are not part of v1.0 validation.

## Goals and Out of Scope

Verify that immutable event and attempt types represent the approved SDD fields,
that the adapter contract exposes persistence operations with tenant and lease
boundaries, and that configuration can express bounded concurrency, timeouts,
and retry policy. Verify fresh SQLite schema creation and inspection,
constraints and indexes. Verify migration ordering, checksum ledger, idempotent
reapplication, drift and missing-file detection, SQLite transactional rollback,
and startup ordering. Database-driver adapters, runtime configuration parsing,
and delivery logic remain outside this scope.

## Strategy and Layers (Unit / Integration / E2E)

- **Unit/contract:** Compile-time structural fixtures and small deterministic
  Vitest assertions in `tests/core/contracts.test.ts`.
- **Integration:** Node's built-in `node:sqlite` applies migrations to fresh
  in-memory and on-disk databases. These local tests require no external DB
  services or test credentials.
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
| Strict TypeScript compilation | All exported contracts and readonly structural fixtures |

## Environment, Data, and Prerequisites

Run with the repository's pnpm lockfile, Node.js version from `.nvmrc` (Node
24+ per `package.json`), and installed project dependencies including the
Node.js `node:sqlite` support. Fixtures use synthetic identifiers, a reserved
`.example` destination, and no credentials or external services.

## Tools and Test Execution

- `pnpm test`
- `pnpm exec vitest run --coverage`
- `pnpm exec tsc --noEmit --project tsconfig.json`
- `pnpm lint`
- `pnpm exec prettier --check` on changed TypeScript and Markdown files

## Security, Accessibility, Performance, and Regression

Review tenant idempotency uniqueness, state/status constraints, lease field
consistency, FK cascade behavior, checksums, and transaction rollback after partial DDL. SQLite unit/integration tests use isolated in-memory or temporary on-disk databases. PostgreSQL/MySQL checks are out of v1.0 scope. Accessibility
and performance testing do not apply to these storage contracts.

## Coverage: minimum 80% overall, 95% for critical paths

The repository-wide thresholds remain 80% overall and 95% on critical paths.
Coverage applies to executable runner and bootstrap code; SQL declarations are
not treated as executable source. Record the measured result or report a
coverage-tooling limitation without treating an unmeasured threshold as met.

## Entry/Exit Criteria and Go/No-Go

- **Entry:** Approved SDD contract boundary, existing strict TypeScript and
  Vitest configuration, Node `node:sqlite` support, and pre-implementation tests.
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
