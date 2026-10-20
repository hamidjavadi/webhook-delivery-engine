# Test Plan — Core Architecture Contracts

- **Status:** Active
- **Version:** 1.0.0
- **Owner:** Engineering
- **Scope:** WBS Task 1.2 domain types, database port, and engine configuration contracts.

## Goals and Out of Scope

Verify that the immutable event and attempt types represent the approved SDD
fields, that the adapter contract exposes persistence operations with tenant and
lease boundaries, and that configuration can express bounded concurrency,
timeouts, and retry policy. Database-driver behavior, runtime configuration
parsing, and delivery logic remain outside this task.

## Strategy and Layers (Unit / Integration / E2E)

- **Unit/contract:** Compile-time structural fixtures and small deterministic
  Vitest assertions in `tests/core/contracts.test.ts`.
- **Integration:** Not applicable; no database implementation is introduced.
- **E2E:** Not applicable; no running application or transport exists yet.

## Test Cases and Acceptance-Criteria Traceability

| Test case | Contract coverage |
| --- | --- |
| Event includes JSON payload/metadata, delivery headers, lifecycle and lease state | `WebhookEvent` |
| Attempt captures response/transport failure and outcome | `AttemptRecord` |
| Adapter can be consumed through atomic claim, upsert, and attempt-transition signatures | `DatabaseAdapter` |
| Configuration carries concurrency, timeout, and bounded retry values | `EngineConfig` |
| Strict TypeScript compilation | All exported contracts and readonly structural fixtures |

## Environment, Data, and Prerequisites

Run with the repository's pnpm lockfile, Node.js version from `.nvmrc` (Node
24+ per `package.json`), and installed project dependencies. Fixtures use
synthetic identifiers, a reserved `.example` destination, and no credentials or
external services.

## Tools and Test Execution

- `pnpm test -- tests/core/contracts.test.ts`
- `pnpm exec tsc --noEmit --project tsconfig.json`
- `pnpm lint`
- `pnpm exec prettier --check` on changed TypeScript and Markdown files

## Security, Accessibility, Performance, and Regression

This is a type-contract change with no runtime/network behavior. Review tenant
scoping in every read operation, worker ownership on lease operations, reserved
header protection, immutable JSON shapes, and the response-snippet bound.
Existing full-suite tests are the regression check; accessibility and
performance testing do not apply to these contracts.

## Coverage: minimum 80% overall, 95% for critical paths

The repository-wide thresholds remain 80% overall and 95% on critical paths.
The contracts are declarations rather than executable business logic; this
task's verification is structural type checking and contract fixtures. No
coverage exception is claimed, and no runtime coverage percentage is inferred
from compile-time type declarations.

## Entry/Exit Criteria and Go/No-Go

- **Entry:** Approved SDD contract boundary, existing strict TypeScript and
  Vitest configuration, and the pre-implementation contract test.
- **Exit:** Contract test, strict type-check, formatter, and lint pass; no
  `any` or duplicate contract definitions are introduced.
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
