# Deployment and Operations Runbook

- **Status:** Pre-release; production deployment is not approved.
- **Owner:** Project engineering (Hamid Javadi).
- **Scope:** SQLite v1.0 runtime and operational readiness.

## Deployment Architecture

The primary v1 deliverable is a public npm package embedded in a host Node.js
24+ application. The host owns its process, HTTP listener, and signal handlers;
no CLI or standalone process entry point is required to use the package. The
engine factory owns the SQLite adapter, applies migrations before starting the
scheduler, and provides an awaited stop operation that drains active dispatches,
releases claimed-but-undispatched work, and closes engine-owned resources.
SQLite uses WAL mode and a 5-second busy timeout. PostgreSQL and MySQL are not
supported in v1.0.

**Embedded package release blocker:** the repository does not yet provide the
public npm package entry point or composed `createWebhookEngine(...)` lifecycle
specified by WBS 6.2. The server factory and WBS 6.1 routes are available, but
the scheduler, dispatcher, storage, and public API are not yet assembled into
the package factory. Do not install or operate this repository revision as a
functioning delivery engine.

Standalone HTTP service operation is optional and separate from embedded
package use. `src/app/http.server.ts` creates a server but does not listen or
start a process. A standalone service still needs its own runnable composition
entry point; that runner is not required for the public npm package. Until the
engine lifecycle is implemented, no process invokes WBS 2.7 stale-lease
recovery automatically.

WBS 3.2 adds a strict ingestion-body schema and HTTPS destination preflight
validation, now integrated with WBS 6.1 HTTP routes. This validation is not a
connection pin; before enabling outbound delivery, the dispatcher must validate
and pin resolved addresses at connection time and disable redirects or
revalidate every redirect target to prevent DNS rebinding.

## Prerequisites

- Node.js 24 or later. Package consumers install the published release with
  npm; project maintainers use pnpm 10.4.1 for the locked development build.
- After the public release is available, host applications install it with
  `npm install webhook-delivery-engine`.
- A writable, persistent local filesystem for the SQLite database; do not put
  the database on a filesystem that does not support SQLite locking semantics.
- Runtime configuration supplied to the factory by the host application,
  including the SQLite location, default destination, and delivery signing
  secret. Keep any HTTP API key configuration in the host when exposing the
  optional HTTP transport.
- The host application must await `engine.start()` before using engine methods
  and await `engine.stop()` during shutdown. It owns SIGINT/SIGTERM handlers.
- For production data, a verified database backup and an operator authorized
  to stop the host process and restore the prior application version.

Never copy production credentials into `.env.example`, logs, command output, or
test fixtures. Restrict database-file and secret access to the service account.

## Deploy and Verify

Public package release is blocked until WBS 6.2 is implemented and approved.
For a development/release-candidate package build:

1. Install locked dependencies with `pnpm install --frozen-lockfile`.
2. Run `pnpm build`, `pnpm test`, and `pnpm lint`; require all to pass.
3. Run `npm pack --dry-run` and confirm the public root entry point, ESM output,
   declaration files, and SQLite migration assets are included.
4. Create the package tarball with `npm pack` and install it into an isolated
   host-application fixture. Import `createWebhookEngine`, start it, enqueue and
   query an event, stop it, and verify migrations, dispatch, and resource
   cleanup.
5. Publish to the public npm registry only after package validation, review,
   and release approval. A consuming host configures persistent storage and
   secrets, then awaits engine start/stop as part of its own lifecycle.

For an optional standalone HTTP service, separately provide a runnable host
entry point that composes the engine and HTTP server factory. The current
`pnpm dev` and `pnpm start` scripts do not yet provide a functioning service
runner or health endpoint; this does not block embedding the published package.

For storage recovery changes, verify behavior with
`pnpm exec vitest run src/storage/sqlite.adapter.test.ts`. For WBS 3.2 URL
validation, verify the deterministic suite with
`pnpm exec vitest run src/security/ssrf.test.ts
src/features/ingestion/ingestion.schema.test.ts`. Run the full release checks
above before any future release candidate. Automated deployment, health
probes, and live environment checks are not configured.
For the WBS 6.1 REST transport, run
`pnpm exec vitest run src/app/http.server.test.ts`; this uses a loopback HTTP
listener and an isolated temporary SQLite database without external services.

## Health, Monitoring, and Alerts

The v1 design uses structured JSON logs; external metrics and health probes are
not available. The host application remains responsible for process health,
signals, and service-level readiness. Monitor engine startup/migration
failures, SQLite busy/locking errors, disk capacity, queued/retry counts, and
processing leases older than the configured threshold. Alert on persistent
database errors, an increasing stale-processing count, or missing scheduler
poll activity. Until WBS 6.2 integrates the poll lifecycle, stale-processing
recovery will not run automatically.

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
