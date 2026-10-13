# PRD — Webhook Lifecycle

- Status / owner / date / version:
- Problem and evidence:
- Users and needs:
- SMART goals and success criteria:
- Functional requirements:
- Non-functional requirements (security, performance, accessibility, privacy):
- Scope: in-scope / out-of-scope:
- Acceptance criteria:
- Dependencies and assumptions:
- Risks and constraints:
- DoD and approvers:

# Webhook Lifecycle

## Overview

The Webhook Delivery Engine manages the complete lifecycle of webhook events from ingestion to delivery. All status transitions are **idempotent** and **stateless** - the same status is never processed multiple times.

---

## Status Transitions

### Status Definitions

| Status       | Description                         | When                      |
| ------------ | ----------------------------------- | ------------------------- |
| `PENDING`    | Webhook received, not yet processed | On first ingestion        |
| `PROCESSING` | Webhook being processed             | During processing         |
| `DELIVERED`  | Webhook successfully delivered      | After successful delivery |
| `FAILED`     | Webhook delivery failed             | After failed delivery     |
| `RETRY`      | Webhook in retry queue              | After failed processing   |

---

## Status Transition Rules

### PENDING → PROCESSING

**Conditions:**

- No existing record for this idempotency_key
- No existing record with this retry_key
- No existing record with this webhook_id

```typescript
// On first webhook ingestion
const webhookId = generateWebhookId();
await updateStatus(webhookId, 'PROCESSING');
```

### PROCESSING → DELIVERED

**Conditions:**

- HTTP 200 OK response
- No network errors
- No server-side errors
- No idempotency key collision

```typescript
// On successful delivery
await updateStatus(webhookId, 'DELIVERED');
```

### PROCESSING → FAILED

**Conditions:**

- HTTP 5xx error
- Network timeout
- Server-side processing error
- Idempotency key collision

```typescript
// On delivery failure
await updateStatus(webhookId, 'FAILED');
```

### DELIVERED → RETRY

**Conditions:**

- Processing failed (network error, server error)
- Retry key is preserved
- Status is NOT updated to FAILED

```typescript
// On processing failure
await updateStatus(webhookId, 'RETRY');
```

### RETRY → DELIVERED

**Conditions:**

- Retry key is preserved
- Status is NOT updated to FAILED
- Processing succeeds

```typescript
// On successful retry
await updateStatus(webhookId, 'DELIVERED');
```

### RETRY → FAILED

**Conditions:**

- Retry key is preserved
- Status is NOT updated to DELIVERED
- Processing fails

```typescript
// On failed retry
await updateStatus(webhookId, 'FAILED');
```

---

## Idempotency Rules

### Rule 1: Status is Never Updated Twice

```typescript
// Status transitions are idempotent
await updateStatus(webhookId, 'DELIVERED');
await updateStatus(webhookId, 'DELIVERED'); // No change
```

### Rule 2: Retry Key is Preserved

```typescript
// Same retry key always returns same status
await processWebhook({
  idempotency_key: 'uuid-v4',
  retry_key: 'uuid-v4',
});
// Always returns same status
```

### Rule 3: Duplicate Processing is Blocked

```typescript
// If webhook already processed, do not process again
await processWebhook({
  idempotency_key: 'uuid-v4',
  retry_key: 'uuid-v4',
});
// Returns existing status without re-processing
```

---

## Timeout Handling

### Processing Timeout

```typescript
// Maximum processing time per webhook
const processingTimeout = config.processingTimeout; // 30 seconds

// Timeout handling
const startTime = Date.now();
try {
  await processWebhook();
  if (Date.now() - startTime > processingTimeout) {
    throw new ProcessingTimeoutError();
  }
} catch (error) {
  if (error instanceof ProcessingTimeoutError) {
    await updateStatus(webhookId, 'FAILED');
  }
}
```

### Delivery Timeout

```typescript
// Maximum delivery time per webhook
const deliveryTimeout = config.deliveryTimeout; // 60 seconds

// Timeout handling
const startTime = Date.now();
try {
  await sendWebhook();
  if (Date.now() - startTime > deliveryTimeout) {
    throw new DeliveryTimeoutError();
  }
} catch (error) {
  if (error instanceof DeliveryTimeoutError) {
    await updateStatus(webhookId, 'FAILED');
  }
}
```

---

## Failure States

### Failed State Transitions

```
DELIVERED → RETRY → FAILED
```

**Conditions:**

- Processing fails (network error, server error)
- Retry key is preserved
- Status transitions to RETRY
- Retry attempts are counted
- Max retries reached → FAILED

---

### Failed State Response

```typescript
interface FailedResponse {
  error: 'WEBHOOK_DELIVERY_FAILED';
  status: 'FAILED';
  retryKey: string; // Original retry key
  lastAttemptAt?: string; // When last attempt was made
  maxRetries?: number; // Total retry attempts
}
```

---

## Edge Cases

### 1. Duplicate Processing

```
Request 1 → Process Webhook → DELIVERED
Request 2 (same idempotency_key) → Process Webhook → DELIVERED
```

- Both requests return same status
- No duplicate processing

### 2. Retry Queue

```
Request 1 → Process Webhook → FAILED
Request 2 (same idempotency_key) → Process Webhook → RETRY
Request 3 (same idempotency_key) → Process Webhook → DELIVERED
```

- Retries are queued
- Status is updated to RETRY
- Processing succeeds on retry

### 3. Concurrent Processing

```
Request 1 → Process Webhook → DELIVERED
Request 2 → Process Webhook → DELIVERED
```

- Both requests processed independently
- No race conditions

---

## Implementation Notes

- **Idempotency**: Same status is never processed multiple times
- **Stateless**: No state stored in response
- **Transaction**: All status changes use database transactions
- **Logging**: Include status transition details in logs

---

## Related Specs

- [`../README.md`](../01-plan/prd.md) - Project-wide guarantees
- [`idempotency-contracts.md`](../02-design/idempotency-contracts.md) - Idempotency key requirements
- [`retry-strategy.md`](../02-design/retry-strategy.md) - Retry key preservation

---

## SMART Goals and Success Criteria

### SMART Goals

| Goal                     | Description                                             | Success Criteria                            |
| ------------------------ | ------------------------------------------------------- | ------------------------------------------- |
| **Zero-Infra Setup**     | Deploy webhook engine with zero infrastructure overhead | <5 minutes to deploy to staging environment |
| **100% Durability**      | Ensure webhook delivery is 100% reliable                | Zero delivery failures in production        |
| **Strict FIFO Ordering** | Maintain first-in-first-out processing order            | All queued webhooks processed in order      |
| **Lightweight Memory**   | Keep memory footprint minimal                           | <100MB memory usage under load              |

### Success Criteria

- [ ] Deployed to staging environment in <5 minutes
- [ ] Zero delivery failures in staging
- [ ] FIFO ordering verified with test data
- [ ] Memory usage <100MB under 1000 concurrent requests
- [ ] Idempotency verified with duplicate requests
- [ ] Retry queue works correctly
- [ ] All status transitions idempotent
- [ ] No duplicate processing of same webhook
- [ ] Processing timeout enforced (30s)
- [ ] Delivery timeout enforced (60s)
- [ ] Failed state transitions correct
- [ ] Failed response includes all required fields
- [ ] Logging includes status transition details
- [ ] No race conditions in concurrent processing
- [ ] All tests pass with 80%+ coverage
- [ ] Security audit passes

---

## Functional Requirements

### Core Functionality

1. **Webhook Ingestion**
   - Accept webhook payloads from various sources
   - Parse and validate webhook data
   - Generate unique idempotency keys
   - Store webhook metadata in database

2. **Status Management**
   - Track webhook status through all states
   - Support idempotent status updates
   - Maintain retry queue for failed webhooks
   - Enforce FIFO ordering for queued webhooks

3. **Processing**
   - Execute webhook logic with timeout protection
   - Handle processing failures gracefully
   - Implement retry logic with exponential backoff
   - Enforce processing timeout (30s)

4. **Delivery**
   - Send webhook to destination
   - Track delivery success/failure
   - Support delivery timeout (60s)

5. **Idempotency**
   - Prevent duplicate processing
   - Preserve retry keys across retries
   - Return existing status on duplicate requests

6. **Error Handling**
   - Handle HTTP errors (5xx)
   - Handle network errors
   - Handle server-side errors
   - Return appropriate error responses

7. **Logging**
   - Log all status transitions
   - Include webhook ID, status, and timestamp
   - Log errors with context

---

### API Endpoints

| Endpoint                      | Method | Description            |
| ----------------------------- | ------ | ---------------------- |
| `/webhooks`                   | POST   | Ingest webhook payload |
| `/webhooks/{idempotency_key}` | GET    | Get webhook status     |
| `/webhooks/{idempotency_key}` | PUT    | Update webhook status  |
| `/webhooks/{idempotency_key}` | DELETE | Delete webhook record  |

---

### Data Model

```
webhook_id: string (UUID)
idempotency_key: string (UUID)
retry_key: string (UUID)
status: string (PENDING/PROCESSING/DELIVERED/FAILED/RETRY)
payload: string (JSON)
created_at: timestamp
updated_at: timestamp
```

---

## Non-Functional Requirements

### Security

- **SSRF Prevention**: Block requests to internal network addresses
- **Input Validation**: Validate all webhook payloads
- **Secrets**: Never store or log secrets
- **Authentication**: Support optional authentication
- **Authorization**: Enforce role-based access control

### Performance

- **Memory**: <100MB under 1000 concurrent requests
- **Latency**: <100ms for status queries
- **Throughput**: Handle 1000+ concurrent requests
- **Database**: Use SQLite with WAL mode for durability

### Reliability

- **Durability**: 100% delivery guarantee
- **Idempotency**: Same status never processed twice
- **FIFO**: Process queued webhooks in order
- **Timeouts**: Enforce processing and delivery timeouts

### Scalability

- **Concurrency**: Handle 1000+ concurrent requests
- **Memory**: <100MB under load
- **Database**: SQLite with WAL for durability

### Maintainability

- **Code**: Follow existing conventions
- **Documentation**: Comprehensive docs
- **Testing**: 80%+ coverage
- **Logging**: Include status transitions

---

## Related Documents

- [Product Requirements Document](./prd.md)
- [Webhook Ingestion](../02-design/ingest-webhook.md)
- [Idempotency Contracts](../02-design/idempotency-contracts.md)
- [Retry Strategy](../02-design/retry-strategy.md)
- [ADR 0001 — SQLite with WAL Journal](../02-design/adr/0001-sqlite-with-wal-journal.md)
- [Test Plan](../03-testing/test-plan.md)
- [Runbook](../04-deployment/runbook.md)
