# Deployment, Release, and Coverage

## Overview

This document defines the deployment, release, and coverage procedures for the Webhook Delivery Engine.

## CI/CD and Environments

The pipeline MUST include appropriate lint/format, unit testing, integration testing, build, security/dependency and secret checks, coverage measurement, and artifact packaging; E2E tests and release approval should run at the appropriate stage. Failure of a required control MUST block promotion unless an approved, documented exception exists.

### Dev Environment

- Development and initial validation; non-real data and managed secrets
- Local testing and development

### Staging Environment

- As similar to production as possible; smoke/E2E tests and review of migrations, access, and operational readiness
- Pre-production validation

### Production Environment

- Controlled deployment with required approval, health monitoring, least privilege, and change logging
- Production deployment

## Deployment Architecture

- **Database:** SQLite with WAL mode for durability
- **Storage:** Embedded database for persistence
- **API:** RESTful endpoints for status queries
- **Retry Engine:** Idempotent delivery with exponential backoff

## Prerequisites

- Node.js >= 24.x
- pnpm or npm
- Environment variables configured
- Database initialized

## Deployment Steps

### 1. Build

```bash
pnpm build
```

### 2. Deploy to Staging

```bash
pnpm deploy staging
```

### 3. Deploy to Production

```bash
pnpm deploy production
```

### 4. Verify Deployment

```bash
pnpm verify
```

## Verification Checklist

- [ ] All unit tests pass
- [ ] All integration tests pass
- [ ] All E2E tests pass
- [ ] Coverage >= 80% overall
- [ ] Coverage >= 95% for critical paths
- [ ] No security vulnerabilities
- [ ] Database integrity verified
- [ ] API endpoints respond correctly
- [ ] Status transitions work as expected
- [ ] Idempotency guarantees verified
- [ ] Timeout handling verified
- [ ] Error handling verified

## Rollback Procedure

### Stop Criteria

- Critical bugs or security issues
- Performance degradation
- Database corruption
- API endpoint failures

### Decision Authority

- Backend team lead
- Engineering manager

### Approved Steps

1. Identify affected service
2. Check backup data
3. Deploy rollback script
4. Verify rollback success
5. Monitor service health

### Data and Migration Compatibility

- All data preserved in backup
- No data loss during rollback
- No migration required

### Backup/Restore

- Automatic backup before deployment
- Manual backup if automatic fails
- Restore from backup on rollback

### Communications

- Notify stakeholders of deployment
- Update documentation
- Inform users of any changes

### Post-Rollback Smoke Check

- Verify service is operational
- Check error logs
- Confirm status transitions work

## Health Checks

- API endpoint health check
- Database connection test
- Retry engine status check
- Response time monitoring

## Monitoring/Alerts

- Critical errors
- High error rates
- Slow response times
- Database connection issues

## Troubleshooting

- Check error logs
- Verify database connectivity
- Check retry engine status
- Review API response times

## Escalation/Owner

- Backend team lead
- Engineering manager

## Recovery/Backup

- Automatic backups
- Manual backup procedures
- Recovery testing

## Runbook Version

v1.0

---

## Related Documents

- [Product Requirements Document](../01-plan/prd.md)
- [ADR 0001 — SQLite with WAL Journal](../02-design/adr/0001-sqlite-with-wal-journal.md)
- [Test Plan](../03-testing/test-plan.md)
- [Status Check Endpoint](../03-testing/status-check.md)
