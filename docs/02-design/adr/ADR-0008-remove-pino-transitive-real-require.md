# ADR-0008: Remove Pino and Its Trivial `real-require` Dependency

- Date: 2026-10-28
- Status: Accepted 2026-10-28
- Decision-makers: Project stakeholder and engineering owner

## Context and Problem

Socket flagged `real-require@0.2.0` for WBS 13.3. The lockfile shows it is
transitive through both `pino@9.14.0` and `thread-stream@3.2.0`; it is not a
direct project dependency. Editing the installed dependency is transient, and
adding a replacement external package conflicts with WBS 13.3. Inlining a
helper into `src/utils` cannot make Pino or thread-stream import that utility
without patching third-party packages.

The engine's Pino-backed logger is private to the package implementation. The
engine uses only `fatal`, `error`, `warn`, `info`, `debug`, and `trace` methods,
level filtering, JSON output, an optional writable destination used by tests,
and configured redaction. The root public API exports `LogLevel`, not Pino
types or a Pino logger instance.

## Decision Factors

- Remove `real-require@0.2.0` and avoid a replacement external dependency.
- Preserve the engine's JSON log shape, level selection/filtering, destination
  injection, and removal of sensitive fields.
- Keep the root public API and documented logging configuration compatible.
- Keep the implementation and behavior covered by deterministic unit tests.

## Options Considered

1. **Keep Pino and accept the transitive package:** low implementation cost, but
   fails the approved WBS 13.3 acceptance criterion.
2. **Patch Pino and thread-stream:** removes the package while retaining Pino,
   but creates maintained patches to third-party packages and duplicates a
   helper that cannot be shared through this project's `src/utils` module.
3. **Replace the private Pino-backed logger with a small Node.js stream-based
   JSON logger:** removes Pino and its dependent package tree, adds no external
   dependency, and keeps the engine's existing logger boundary. This requires
   explicit tests for output, level filtering, and redaction.

## Decision

Use option 3: keep `src/shared/logger.ts` as the composition boundary,
implement serialization and sensitive-field filtering in a focused internal
utility under `src/utils/`, and remove Pino from the root dependencies.
Preserve the logger methods and output behavior that the engine currently
uses. The stakeholder approved this decision on 2026-10-28.

## Consequences (positive, negative, risks/costs)

- Positive: `real-require`, Pino, and its logging-only transitive dependency
  chain can be removed without introducing another dependency; root and packed
  demo dependency trees can agree on that removal.
- Positive: the logger implementation is owned and testable in this codebase.
- Negative: the project takes responsibility for correct JSON serialization,
  level filtering, destination writes, and redaction behavior currently
  provided by Pino.
- Risk: formatting or redaction differences could affect log consumers or
  expose sensitive values; golden-shape and redaction tests are required.
- Compatibility: no engine public API or configuration change is proposed.

## Migration/Review Plan and References

Write failing focused tests first, then implement the logger utility, run the
focused tests and required project checks, and confirm `real-require` is absent
from the root and standalone demo dependency trees and lockfiles. Review `src/shared/logger.ts`,
`src/utils/`, package metadata, the WBS, SDD, and QA record together. This
decision is linked to WBS 13.3 and Socket finding `real-require@0.2.0`.
