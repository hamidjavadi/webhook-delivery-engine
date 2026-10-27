# Deployment and Operations Runbook

- **Status:** Pre-release; production deployment is not approved.
- **Owner:** Project engineering (Hamid Javadi).
- **Scope:** SQLite v1.0 runtime and operational readiness.

## Deployment Architecture

The primary v1 deliverable is a TypeScript library embedded in a host Node.js
24+ application. The host owns its process, any external interface, and signal
handlers. The package requires no CLI or standalone process entry point. The
engine factory owns the SQLite adapter, applies migrations before starting the
scheduler, and provides an awaited stop operation that drains active dispatches,
releases claimed-but-undispatched work, and closes engine-owned resources.
SQLite uses WAL mode and a 5-second busy timeout. PostgreSQL and MySQL are not
supported in v1.0.

The supported v1 package interface is programmatic; it does not provide REST
endpoints or authenticate external ingestion callers. The host controls access
to the engine instance and must provide its own authentication and authorization
if it exposes an external interface. The engine binds its configured `clientId`
to ingested events. WBS 3.4 is implemented and locally verified; engine configuration
and programmatic ingestion do not require API-key authentication. Scheduler
polling and stale-lease recovery run after the host has awaited `engine.start()`.

Ingestion validates the configured destination before persistence, and the
dispatcher revalidates and pins the resolved address when connecting. Redirects
must be disabled or validated against the same destination policy.

## Prerequisites

- Node.js 24 or later. Package consumers install the published release with
  npm; project maintainers use pnpm 10.4.1 for the locked development build.
- After the public release is available, host applications install it with
  `npm install webhook-delivery-engine`.
- A writable, persistent local filesystem for the SQLite database; do not put
  the database on a filesystem that does not support SQLite locking semantics.
- Runtime configuration supplied to the factory by the host application,
  including the SQLite location, configured `clientId`, default destination,
  delivery signing secret, and worker/retry settings. The v1 interface has no
  API-key ingestion credential.
- The host application must await `engine.start()` before using engine methods
  and await `engine.stop()` during shutdown. It owns SIGINT/SIGTERM handlers.
- For production data, a verified database backup and an operator authorized
  to stop the host process and restore the prior application version.

Never copy production credentials into `.env.example`, logs, command output, or
test fixtures. Restrict database-file and secret access to the service account.

## Deploy and Verify

Public package publication and production deployment require release approval.
For a development/release-candidate package build:

1. Install locked dependencies with `pnpm install --frozen-lockfile`.
2. Run `pnpm build`, `pnpm test`, and `pnpm lint`; require all to pass.
3. Run `npm pack --dry-run` and confirm the public root entry point, ESM output,
   declaration files, and SQLite migration assets are included.
4. Create the package tarball with `npm pack` and install it into an isolated
   host-application fixture. Import `createWebhookEngine`, configure a
   `clientId` without an API key, start it, enqueue and query an event, verify
   the configured tenant identity is used and caller-supplied identity is
   rejected, stop it, and verify migrations, dispatch, and resource cleanup.
   Confirm the packaged interface still creates an engine without an API key
   and scopes event reads to its configured `clientId` before release approval.
5. Publish to the public npm registry only after package validation, review,
   and release approval. A consuming host configures persistent storage and
   secrets, then awaits engine start/stop as part of its own lifecycle.

### v1.0.0 Dependency Audit Exception — Approved 2026-10-27

The stakeholder approved publishing v1.0.0 despite `pnpm audit --prod`
reporting high-severity GHSA-mrhx-c7xc-m3w5 for resolved `zod@3.25.76`.
The recursive ingestion payload schema accepts unbounded arrays, so adversarial
oversized collections may exhaust memory during validation. This is a release
exception, not a clean audit result or an implementation fix. Host applications
must bound payload size and validate untrusted input before passing it to the
engine, and must enforce their own access controls around ingestion. The
exception expires for release purposes after v1.0.0; resolve the finding and
require a clean audit before any subsequent package release. The approval and
technical exit criteria are recorded in `docs/04-testing/test-plan.md` and
`docs/01-plan/risks.md`.

For storage recovery changes, verify behavior with
`pnpm exec vitest run src/storage/sqlite.adapter.test.ts`. For WBS 3.2 URL
validation, verify the deterministic suite with
`pnpm exec vitest run src/security/ssrf.test.ts
src/features/ingestion/ingestion.schema.test.ts`. Run the full release checks
above before any future release candidate. Automated deployment, health
probes, and live environment checks are not configured.

## Health, Monitoring, and Alerts

The v1 design uses structured JSON logs; external metrics and health probes are
not available. The host application remains responsible for process health,
signals, and service-level readiness. Monitor engine startup/migration
failures, SQLite busy/locking errors, disk capacity, queued/retry counts, and
processing leases older than the configured threshold. Alert on persistent
database errors, an increasing stale-processing count, or missing scheduler
poll activity. Stale-lease recovery runs as part of scheduler polling after
`engine.start()`; before startup, the engine does not process queued events.

## Rollback and Recovery

No production rollback is authorized for this pre-release revision. For an
approved future rollout:

1. Stop event intake and the scheduler before changing application artifacts.
2. Create and verify a consistent SQLite backup using SQLite's online backup
   mechanism; do not copy only the main database file while WAL writes are
   active.
3. Roll back to the prior application artifact only if it is compatible with
   the current forward-only schema. Migrations have no down-migrations.
4. If the prior artifact cannot safely use the current schema, restore the
   verified pre-deployment backup under an approved recovery procedure.
5. Restart only after database integrity, migration state, and a controlled
   smoke delivery have been verified.

Never delete or rewrite the live database to resolve a migration or recovery
failure. Preserve the database and logs for investigation and escalate to the
project engineering owner.

## Hosted Demo Operations (WBS 9.0; Render Free; Pre-Deployment)

The hosted demo is a separate, non-production Express + Vite/React pnpm project. One Node.js 24+ process owns the Express API/static assets, fixed HTTPS mock receiver, and embedded engine. Build the root package with pnpm, then install and build `examples/demo` with its own lockfile; no registry publication is needed for this deployment. The app must expose `/api/health` with not-ready status until engine startup and migrations complete.

Render Free may spin the service down after inactivity, has cold-start delay, and does not provide persistent disk. The demo's local SQLite file, in-memory run index, and scenario counters are transient and can reset on sleep/restart/redeploy. The UI must disclose this. Configure a public HTTPS receiver origin for the same demo service; if missing or invalid, fail startup/readiness. No loopback exception or custom dispatcher is permitted. Only fixed scenario and receiver destinations are accepted. Do not use this demo for production event data.

### Build, Start, and Verify

The Render Blueprint should pin Node.js 24+, install the root package with pnpm, build and pack the root library into `examples/demo/.package`, then install from the demo's own pnpm lockfile and run its production build. Start the demo's production Node server bound to Render's `PORT` and all interfaces. Verify deployment only after separate deployment approval:

1. Confirm `/api/health` becomes ready only after engine migrations finish.
2. Trigger immediate success, retry recovery, terminal 401, retry exhaustion (`failed`), and SSRF rejection; confirm attempt history and status through the UI.
3. Confirm requests target only the configured HTTPS demo receiver and signed headers verify there.
4. Confirm SIGTERM invokes and awaits `engine.stop()` and the process exits within the platform grace window.
5. Confirm the public API does not return raw Pino logs, stack traces, secrets, or another run's event data.
6. Observe and document the expected reset after a service restart; do not treat lost demo records as a recovery defect.

### Demo Rollback and Disablement

If the public API allows a caller-selected URL, leaks cross-run data/secrets, bypasses the production SSRF checks, or creates unbounded load, disable scenario ingestion or roll back the demo deployment immediately. Preserve sanitized diagnostics, fix and revalidate locally, then require approval before redeploy. A paid persistent service is outside this approved plan and requires a new cost decision.

## Troubleshooting and Escalation

- **Migration/startup failure:** keep the service stopped, preserve the SQLite
  file and logs, and verify the configured path, permissions, and migration
  ledger before retrying.
- **SQLite busy/locked errors:** check for competing processes, disk health,
  and WAL sidecar files; retain the configured 5-second busy timeout and
  surface persistent errors rather than treating them as successful writes.
- **Events remain `processing`:** confirm the WBS 4.1 scheduler is deployed and
  invoking `recoverStaleLeases` each poll cycle with the current timeout and
  UTC clock. Do not manually reset rows while workers may still be active.
- **Owner/escalation:** project engineering owner, Hamid Javadi. No production
  on-call rota or paging integration is configured.
