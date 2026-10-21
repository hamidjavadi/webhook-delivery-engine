# Deployment and Operations Runbook

- **Status:** Pre-release; production deployment is not approved.
- **Owner:** Project engineering (Hamid Javadi).
- **Scope:** SQLite v1.0 runtime and operational readiness.

## Deployment Architecture

The intended deployment is either an embedded Node.js process or a single
Node.js service using one local SQLite database on persistent storage. SQLite
uses WAL mode and a 5-second busy timeout; startup migrations run before
application components start. PostgreSQL and MySQL are not supported in v1.0.

**Release blocker:** the application entry point, HTTP server, and WBS 4.1
polling loop are not implemented yet. WBS 2.7 supplies the atomic stale-lease
recovery operation, but no background process invokes it until the poll loop
is delivered. WBS 3.1 supplies a credential authenticator, but no HTTP route
extracts credentials or maps its unauthorized result to an actual response yet.
Do not deploy this revision as a functioning delivery service or rely on
automatic stale-lease recovery or HTTP authentication.

WBS 3.2 adds a strict ingestion-body schema and HTTPS destination preflight
validation. This validation has no HTTP transport integration and is not a
connection pin; before enabling outbound delivery, the dispatcher must validate
and pin resolved addresses at connection time and disable redirects or
revalidate every redirect target to prevent DNS rebinding.

## Prerequisites

- Node.js 24 or later and pnpm 10.4.1.
- A writable, persistent local filesystem for the SQLite database; do not put
  the database on a filesystem that does not support SQLite locking semantics.
- Runtime configuration supplied outside version control: `NODE_ENV`,
  `PORT`, `LOG_LEVEL`, `DATABASE_URL`, `WEBHOOK_URL`, `API_KEY`, and
  `HMAC_SECRET`.
- A verified database backup and an operator authorized to stop the process
  and restore the prior application artifact.
- For any release candidate, WBS 4.1 poll-loop integration and the remaining
  production entry point are required before rollout.

Never copy production credentials into `.env.example`, logs, command output, or
test fixtures. Restrict database-file and secret access to the service account.

## Deploy and Verify

Production deployment is blocked until the release blocker above is resolved
and approved. For a development/release-candidate build:

1. Install locked dependencies with `pnpm install --frozen-lockfile`.
2. Run `pnpm build`, `pnpm test`, and `pnpm lint`; require all to pass.
3. Set runtime configuration through the deployment secret/configuration
   manager, create the persistent database directory, and verify its owner and
   permissions.
4. Start the built application only after its entry point and scheduler exist.
   The current repository does not yet provide a runnable production entry
   point or health endpoint.
5. Verify startup migration completion, database writability, scheduler
   activity, and successful delivery to a controlled test endpoint before
   enabling production traffic.

For storage recovery changes, verify behavior with
`pnpm exec vitest run src/storage/sqlite.adapter.test.ts`. For WBS 3.2 URL
validation, verify the deterministic suite with
`pnpm exec vitest run src/security/ssrf.test.ts
src/features/ingestion/ingestion.schema.test.ts`. Run the full release checks
above before any future release candidate. Automated deployment, health
probes, and live environment checks are not configured.

## Health, Monitoring, and Alerts

The v1 design uses structured JSON logs; external metrics and health probes are
not available. Once the runtime is implemented, monitor startup/migration
failures, SQLite busy/locking errors, disk capacity, queued/retry counts, and
processing leases older than the configured threshold. Alert on persistent
database errors, an increasing stale-processing count, or missing scheduler
poll activity. Until WBS 4.1 is integrated, stale-processing alerts require
operator attention; recovery will not run automatically.

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
