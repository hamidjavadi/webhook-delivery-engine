# Deployment, Release, and Coverage

Agent MUST create/update the runbook at `docs/04-deployment/runbook.md`. Agent MUST propose/configure a pipeline appropriate to the repository and claim success only when supported by actual tool output.

## CI/CD and Environments

The pipeline MUST include appropriate lint/format, unit testing, integration testing, build, security/dependency and secret checks, coverage measurement, and artifact packaging; E2E tests and release approval should run at the appropriate stage. Failure of a required control MUST block promotion unless an approved, documented exception exists.

- **dev:** Development and initial validation; non-real data and managed secrets.
- **staging:** As similar to production as possible; smoke/E2E tests and review of migrations, access, and operational readiness.
- **prod:** Controlled deployment with required approval, health monitoring, least privilege, and change logging.

Agent MUST separate environments, configuration, and secrets; never put secrets in the repository or logs. Destructive/incompatible migrations require a compatibility and rollback plan.

## Coverage, Version, and Release Checklist

- CI MUST enforce at least 80% overall coverage and 95% for critical paths; store/publish coverage reports and trends. A drop below the threshold, even if overall coverage rises, MUST block release unless the user grants an explicit, documented exception.
- Use Semantic Versioning (`MAJOR.MINOR.PATCH`); an incompatible API/schema change is MAJOR, a compatible feature is MINOR, and a compatible fix is PATCH. Clearly label prereleases.
- Checklist: DoD and QA approved; CI green; security/permissions and coverage reviewed; release notes and version; migration/backup; staging approval; health/dashboard/alerts; release approval; support owner and window specified.
- **Rollback:** Document in advance the stop/rollback criteria, decision authority, approved steps/commands, data and migration compatibility, backup/restore, communications, and post-rollback smoke check. If safe rollback is not possible, define a forward-fix path and data protection; do not perform production operations without authorized approval.

The runbook MUST include deployment architecture, prerequisites, deploy/verify/rollback procedures, health checks, monitoring/alerts, troubleshooting, escalation/owner, and recovery/backup. Before proceeding to release, run the master-rules checkpoint.
