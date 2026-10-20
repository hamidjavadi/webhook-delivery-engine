# Test Plan — Webhook Delivery Engine

- **Status:** Active
- **Version:** 1.0.0
- **Owner:** Engineering
- **Scope:** WBS Tasks 1.2 and 2.1: core domain contracts and initial raw SQL
  schema definitions for SQLite, PostgreSQL, and MySQL.

## Goals and Out of Scope

Verify that immutable event and attempt types represent the approved SDD fields,
that the adapter contract exposes persistence operations with tenant and lease
boundaries, and that configuration can express bounded concurrency, timeouts,
and retry policy. Verify fresh SQLite schema creation and inspection, constraints
and indexes, and static DDL contracts for the unconfigured PostgreSQL/MySQL
targets. Database-driver adapters, runtime configuration parsing, and delivery
logic remain outside this scope.

## Strategy and Layers (Unit / Integration / E2E)

- **Unit/contract:** Compile-time structural fixtures and small deterministic
  Vitest assertions in `tests/core/contracts.test.ts`.
- **Integration:** Node's built-in `node:sqlite` applies the SQLite migration
  to a fresh in-memory database inside a transaction; schema inspection verifies columns,
  indexes, foreign keys, and constraints. PostgreSQL and MySQL SQL is checked
  with deterministic static assertions until those database services and
  drivers are introduced by their adapter tasks.
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
| PostgreSQL and MySQL DDL include approved state sets, FKs, and composite indexes | Static dialect checks |
| MySQL uses `VARCHAR(255)` tenant-scoped uniqueness | MySQL migration and SDD mapping |
| Strict TypeScript compilation | All exported contracts and readonly structural fixtures |

## Environment, Data, and Prerequisites

Run with the repository's pnpm lockfile, Node.js version from `.nvmrc` (Node
24+ per `package.json`), and installed project dependencies including the
Node.js `node:sqlite` support. Fixtures use synthetic identifiers, a reserved
`.example` destination, and no credentials or external services. PostgreSQL and
MySQL service instances are not configured in this repository.

## Tools and Test Execution

- `pnpm test`
- `pnpm exec tsc --noEmit --project tsconfig.json`
- `pnpm lint`
- `pnpm exec prettier --check` on changed TypeScript and Markdown files

## Security, Accessibility, Performance, and Regression

Review tenant idempotency uniqueness, state/status constraints, lease field
consistency, FK cascade behavior, and the 1 KB response-snippet bound. SQLite
integration uses an in-memory DB only. Static PostgreSQL/MySQL checks do not
replace later live adapter integration testing. Accessibility and performance
testing do not apply to these schema contracts.

## Coverage: minimum 80% overall, 95% for critical paths

The repository-wide thresholds remain 80% overall and 95% on critical paths.
This task primarily adds SQL declarations; coverage is reported only for
executable testable code and is not inferred from schema files or static SQL
assertions. No coverage exception is claimed.

## Entry/Exit Criteria and Go/No-Go

- **Entry:** Approved SDD contract boundary, existing strict TypeScript and
  Vitest configuration, Node `node:sqlite` support, and pre-implementation tests.
- **Exit:** Full applicable tests (including fresh SQLite schema inspection),
  static dialect assertions, strict type-check, formatter, and lint pass; no
  duplicate contract definitions are introduced.
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
