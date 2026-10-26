# ADR-0007: Hosted Demo Composition and Render Free Constraints

- Date: 2026-10-25
- Status: Approved design; implementation checkpoint pending
- Decision-makers: Product Engineer, Tech Lead, stakeholder

## Context

The library is an embedded Node.js package with SQLite and an in-process scheduler. The hosted showcase must exercise the real public package without publishing it first, run its UI and API in one persistent web-service process, and preserve the production SSRF policy. The approved host is Render Free, whose service may sleep and whose local filesystem is ephemeral; demo data loss and cold starts are accepted and must be disclosed.

## Decision Factors

- The demo must remain a separate consumer project with its own package manifest, lockfile, and tool configuration, and import the root package through its public export.
- The demo should use a single long-lived Node process to own Express, the engine lifecycle, mock receiver, and static UI.
- Browser input must not select arbitrary outbound destinations or engine security settings.
- Demo deliveries must use the existing HTTPS validation and connection pinning without exceptions.
- Free-tier lifecycle and storage limitations must be visible to users; a live deployment requires its own approval.

## Options Considered

1. **Express + Vite/React, independent pnpm project consuming a package tarball, Render Free:** one process, separate dependency/test/tooling boundary, and no publication. State resets on sleep/restart/redeploy and cold starts are accepted.
2. **Next.js, workspace, Render Free:** viable Node hosting, but couples UI framework server behavior to the embedded engine lifecycle without a needed benefit for this small demo.
3. **Paid Render with persistent disk:** supports always-on service and durable local SQLite, but adds recurring cost beyond the approved Free-tier scope.
4. **Generic user-provided target URLs or transport bypass:** rejected because it creates an outbound request proxy or weakens SSRF guarantees.

## Decision

Use Express to serve a Vite-built React UI and API from one Node.js 24+ process in `examples/demo`. Keep its pnpm lockfile and tool configurations local to that project. Build and pack the root package with `pnpm pack`, then install that tarball into the demo project to verify the published-package boundary. Instantiate the real public engine API with demo-only SQLite and secret configuration. Use one server-configured, fixed public HTTPS receiver URL and enumerated response scenarios. Custom ingestion accepts bounded payload/idempotency input only. Never bypass URL validation, address resolution/pinning, TLS identity checks, or redirect rejection. Maintain bounded run-scoped telemetry and expose sanitized event/attempt views, not process logs or arbitrary engine records. Run on Render Free with disclosed sleep and reset behavior.

Retry exhaustion is shown using the engine's terminal `failed` state. It must not be represented as a dead-letter queue. No public library API change, package publication, external database, or live deployment is included in this decision.

## Consequences

- Render Free is suitable only for an educational transient-state demo; scenarios may be delayed by cold start and prior run data can disappear.
- Receiver configuration needs a valid public HTTPS demo origin; absent or unsafe configuration makes the app unready rather than permitting localhost or a transport bypass.
- The demo requires server-side limits for JSON size, scenario rates, run access, and telemetry retention because it is publicly reachable.
- The public package's normal build and API surface remain the consumer integration boundary.
- A future requirement for always-on scheduling or durable SQLite requires a new decision and paid service/storage plan.

## Verification

Packed-package consumer smoke test; demo route/UI and scenario integration tests; HMAC receiver tests; SSRF rejection test; startup/health/shutdown tests; root regression suite; demo typecheck, lint, and production build. No validation results are claimed until those commands have run.

## References

- `docs/01-plan/PRD.md` Hosted Demo Addendum
- `docs/01-plan/scope.md` Hosted Demo Scope Addendum
- `docs/01-plan/WBS.md` WBS 9.0
- `docs/02-design/SDD.md` §12
- ADR-0005 SSRF destination validation
- ADR-0006 address pinning at dispatch
- Render Free service constraints (current official Render documentation)
