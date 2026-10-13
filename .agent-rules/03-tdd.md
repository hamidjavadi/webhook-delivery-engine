# Test-Driven Development Rules

- Agent MUST follow the strict **Red → Green → Refactor** cycle: first write a relevant test and observe it fail as expected (Red); then write the minimum production code needed to make it pass (Green); then refactor while keeping it green.
- Agent MUST NOT write production code for new/changed behavior before a corresponding failing test exists. If testability or reproducing the failure is not possible, explain the blocker and obtain approval before making an exception.
- Tests MUST have a clear Arrange–Act–Assert (AAA) structure, be independent and deterministic, and have one primary reason to fail.
- Test names MUST describe the behavior and expectation (for example, `returns_..._when_...` or the repository's usual pattern) and follow the project's language/framework conventions.
- Tests MUST be placed in the structure corresponding to the code and repository conventions; each test must be testable and runnable individually. Test data should be small and readable.
- Coverage target: at least **80% overall coverage** and **95% for critical paths** (authentication/authorization, payments, sensitive data, irreversible operations, or critical product flows). Line coverage alone does not demonstrate quality; test branches and edge behaviors too. A lower threshold requires explicit user approval and a recorded rationale/mitigation plan.
- Use mocks only for external/non-deterministic boundaries or slow/costly dependencies; do not over-mock internal logic. A real integration test is required for the connection contract. Do not use secrets or real user data in tests.
- Before commit, run the relevant tests and the required project suite; report actual execution results, coverage, and limitations. Do not hide/remove flaky or failing tests.
