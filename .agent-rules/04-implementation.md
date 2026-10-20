# Implementation Rules

- Agent MUST follow the repository's existing formatter, linter, language version, patterns, and architecture; before adding a dependency, assess its necessity, license, security, and maintenance impact, and record an ADR if it is an architectural decision.
- Agent MUST keep changes small, focused, understandable, and reviewable; apply SOLID principles and Clean Code appropriately, not as an excuse for premature abstraction.
- Agent MUST NOT go beyond the approved scope, contracts, and acceptance criteria (no scope creep). Unrelated refactoring, API/schema changes, data deletion, and sensitive configuration changes require authorization.
- Agent MUST prevent secrets from entering code, logs, or public sample files; validate input and handle errors securely and traceably. Avoid silent failures and purposeless catch blocks.
- Every commit MUST be small and use a Conventional Commit message (`type(scope): summary`; for example, `feat(api): ...`, `fix: ...`, `test: ...`, `docs: ...`). Agent MUST NOT create commits unless the user asks or grants permission.

## Code Review Checklist

- Are all acceptance criteria covered, and only the approved scope included?
- Was the prior failing test and the relevant/regression tests run?
- Have security, errors, edge cases, sensitive data, performance, and accessibility been reviewed?
- Are the API, schema, dependencies, configuration, and required documentation in sync?
- Is the code readable, free of unnecessary duplication/complexity, and consistent with repository standards?
- Do logs/telemetry avoid exposing sensitive information, and are operations reversible?

### Single Source of Truth (SSOT) & Anti-Duplication Rule:

- **No Duplicate Types or Queries:** Every database model, query statement, schema interface, and domain type MUST have a single, canonical source of truth within its designated module (e.g., Domain Types module / SDD.md specs).
- **Import Exclusively:** Inline type declarations, duplicate SQL/ORM query snippets, or redundant definitions across files are strictly prohibited. All consumers must import from the official SSOT module.
- **Audit during Implementation:** During code implementation and review, explicitly verify that no new types or queries are duplicated. Refactor any discovered duplicates immediately.

## Task DoD

A task is Done only when acceptance criteria are met, tests pass, coverage thresholds are satisfied, required lint/format/build checks succeed, affected documentation and ADRs are updated, changes are reviewed, and no hidden risks/limitations remain. Agent MUST NOT claim that unrun or blocked items are Done.

## Task Execution & Git Workflow

- **Single-Task Scope:** Execute exactly ONE task per user prompt. Never auto-advance to subsequent tasks in `milestones-and-tasks.md`.
- **CRITICAL: Zero-Tolerance Fail-Fast Policy for Steps 1–3:** Steps 1, 2, and 3 below are hard gates. Each command MUST exit with code 0 before the next step may begin. If any command in Steps 1–3 fails or exits non-zero, Agent MUST STOP immediately, report the exact failure to the user, and MUST NOT proceed to any later step.
- **Step 1: Create GitHub Issue First + Gate:** Before starting any work or creating a branch, create a GitHub issue for the task and require a successful exit (code 0):
  ```bash
  gh issue create --title "<task-id>: <short-description>" --body "<task requirements & acceptance criteria>"
  ```
  - **Gate:** Command MUST exit 0 (issue created). On failure: STOP and report; do not create a branch.
- **Step 2: Sync Default Branch + Gate:** Before creating a new branch, switch to the `dev` branch and pull the latest changes from the remote repository:
  ```bash
  git checkout dev
  git pull origin dev
  ```
  - **Gate:** Both commands MUST exit 0. On failure: STOP and report; do not create a branch.
- **Step 3: Create Linked Branch + Gate:** Branch off the updated `dev` branch and reference the issue number in the branch name:
  - Format: `<type>/<issue-number>-<short-description>` (e.g., `feat/12-add-webhook-retry`)
  ```bash
  git checkout -b <type>/<issue-number>-<short-description>
  ```
  - **Gate:** Command MUST exit 0. On failure: STOP and report.
- **Step 4: Implement & Commit:** Only proceed here after Steps 1–3 have all passed with exit code 0. Apply required changes following TDD and project standards. Commit changes using Conventional Commits linked to the issue:
  - Format: `type(scope): <description> (closes #<issue-number>)`
- **Step 5: Push to Remote:** Push the local branch and commit to GitHub:
  ```bash
  git push -u origin <branch-name>
  ```
- **Step 6: Open Pull Request & Stop:** Once Task DoD is fully satisfied:
  1. Create a PR targeting the `dev` branch:
     ```bash
     gh pr create --base dev --title "<type>(<scope>): <summary>" --body "Closes #<issue-number>"
     ```
  2. STOP execution immediately. Wait for user review and merge before proceeding.
