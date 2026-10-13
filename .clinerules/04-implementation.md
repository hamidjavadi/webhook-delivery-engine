# Implementation Rules

- Cline MUST follow the repository's existing formatter, linter, language version, patterns, and architecture; before adding a dependency, assess its necessity, license, security, and maintenance impact, and record an ADR if it is an architectural decision.
- Cline MUST keep changes small, focused, understandable, and reviewable; apply SOLID principles and Clean Code appropriately, not as an excuse for premature abstraction.
- Cline MUST NOT go beyond the approved scope, contracts, and acceptance criteria (no scope creep). Unrelated refactoring, API/schema changes, data deletion, and sensitive configuration changes require authorization.
- Cline MUST prevent secrets from entering code, logs, or public sample files; validate input and handle errors securely and traceably. Avoid silent failures and purposeless catch blocks.
- Every commit MUST be small and use a Conventional Commit message (`type(scope): summary`; for example, `feat(api): ...`, `fix: ...`, `test: ...`, `docs: ...`). Cline MUST NOT create commits unless the user asks or grants permission.

## Code Review Checklist

- Are all acceptance criteria covered, and only the approved scope included?
- Was the prior failing test and the relevant/regression tests run?
- Have security, errors, edge cases, sensitive data, performance, and accessibility been reviewed?
- Are the API, schema, dependencies, configuration, and required documentation in sync?
- Is the code readable, free of unnecessary duplication/complexity, and consistent with repository standards?
- Do logs/telemetry avoid exposing sensitive information, and are operations reversible?

## Task DoD

A task is Done only when acceptance criteria are met, tests pass, coverage thresholds are satisfied, required lint/format/build checks succeed, affected documentation and ADRs are updated, changes are reviewed, and no hidden risks/limitations remain. Cline MUST NOT claim that unrun or blocked items are Done.
