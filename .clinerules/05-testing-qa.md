# QA and Testing Strategy

Cline MUST create/update the project strategy in `docs/04-testing/test-plan.md` (using `templates/test-plan-template.md`) and specify at least scope, approach, environment/data, responsibilities, entry/exit criteria, coverage, regression, and reporting.

## Test Pyramid

- **Unit:** Largest in number; logic and boundaries, fast and isolated.
- **Integration:** Module contracts, database, message broker, and services; use real/local dependencies where possible.
- **E2E:** Fewer tests for critical end-to-end user flows; stable and limited to acceptance criteria.

Cline MUST write tests at the appropriate layer and must not invert the test pyramid. In addition to happy paths, test errors, boundaries, permissions, compatibility, and sensitive behaviors. Tests must be repeatable, isolated, and free of real data/secrets.

## Regression and Triage

- Every fixed bug MUST have a reproducing test that fails before the fix and passes afterward.
- Before merge/release, run relevant tests and an appropriately scoped regression suite; do not remove or silently ignore failures.
- Severity: **SEV-1 Critical** (data leak/loss, security incident, primary service unavailable): stop release and escalate immediately; **SEV-2 High** (important capability impaired, limited workaround): urgent priority; **SEV-3 Medium** (limited impact/available workaround): scheduled; **SEV-4 Low** (minor/cosmetic): backlog. Determine severity by impact, scope, likelihood, and available workaround, and record the rationale.
- Cline MUST include test, environment, version, reproduction steps, expected/actual result, severity, and non-sensitive evidence in the bug report.

The QA output must record actual results, version/environment, tests run and failed, overall and critical-path coverage, open bugs, and the Go/No-Go decision. TDD coverage thresholds are mandatory.
