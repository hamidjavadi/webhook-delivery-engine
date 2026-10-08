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

```typescript
// On first webhook ingestion
const webhookId = generateWebhookId();
await updateStatus(webhookId, 'PROCESSING');
```

**Conditions:**

- No existing record for this idempotency_key
- No existing record with this retry_key
- No existing record with this webhook_id

---

### PROCESSING → DELIVERED

```typescript
// On successful delivery
await updateStatus(webhookId, 'DELIVERED');
```

**Conditions:**

- HTTP 200 OK response
- No network errors
- No server-side errors
- No idempotency key collision

---

### PROCESSING → FAILED

```typescript
// On delivery failure
await updateStatus(webhookId, 'FAILED');
```

**Conditions:**

- HTTP 5xx error
- Network timeout
- Server-side processing error
- Idempotency key collision

---

### DELIVERED → RETRY

```typescript
// On processing failure
await updateStatus(webhookId, 'RETRY');
```

**Conditions:**

- Processing failed (network error, server error)
- Retry key is preserved
- Status is NOT updated to FAILED

---

### RETRY → DELIVERED

```typescript
// On successful retry
await updateStatus(webhookId, 'DELIVERED');
```

**Conditions:**

- Retry key is preserved
- Status is NOT updated to FAILED
- Processing succeeds

---

### RETRY → FAILED

```typescript
// On failed retry
await updateStatus(webhookId, 'FAILED');
```

**Conditions:**

- Retry key is preserved
- Status is NOT updated to DELIVERED
- Processing fails

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

- [`../README.md`](../README.md) - Project-wide guarantees
- [`idempotency-contracts.md`](./idempotency-contracts.md) - Idempotency key requirements
- [`retry-strategy.md`](./retry-strategy.md) - Retry key preservation
