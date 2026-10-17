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

## Task DoD

A task is Done only when acceptance criteria are met, tests pass, coverage thresholds are satisfied, required lint/format/build checks succeed, affected documentation and ADRs are updated, changes are reviewed, and no hidden risks/limitations remain. Agent MUST NOT claim that unrun or blocked items are Done.

## Task Execution & Git Workflow

- **Single-Task Scope:** Execute exactly ONE task per user prompt. Never auto-advance to subsequent tasks in `milestones-and-tasks.md`.
- **1. Create GitHub Issue First:** Before starting any work or creating a branch, create a GitHub issue for the task:
  ```bash
  gh issue create --title "<task-id>: <short-description>" --body "<task requirements & acceptance criteria>"
  ```
- **2. Sync Default Branch:** Before creating a new branch, switch to the `dev` branch and pull the latest changes from the remote repository:
  ```bash
  git checkout dev
  git pull origin dev
  ```
- **3. Create Linked Branch:** Branch off the updated `dev` branch and reference the issue number in the branch name:
  - Format: `<type>/<issue-number>-<short-description>` (e.g., `feat/12-add-webhook-retry`)
  ```bash
  git checkout -b <type>/<issue-number>-<short-description>
  ```
- **4. Implement & Commit:** Apply required changes following TDD and project standards. Commit changes using Conventional Commits linked to the issue:
  - Format: `type(scope): <description> (closes #<issue-number>)`
- **5. Push to Remote:** Push the local branch and commit to GitHub:
  ```bash
  git push -u origin <branch-name>
  ```
- **6. Open Pull Request & Stop:** Once Task DoD is fully satisfied:
  1. Create a PR targeting the `dev` branch:
     ```bash
     gh pr create --base dev --title "<type>(<scope>): <summary>" --body "Closes #<issue-number>"
     ```
  2. STOP execution immediately. Wait for user review and merge before proceeding.
