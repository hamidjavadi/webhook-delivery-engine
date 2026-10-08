# Retry Strategy

## Overview

The Webhook Delivery Engine implements **bounded exponential backoff** with **jitter** to handle transient network failures and server-side processing delays. Retries are **idempotent** and **stateless** - the same retry key is never processed multiple times.

---

## Retry Key Requirements

| Requirement      | Specification                                    |
| ---------------- | ------------------------------------------------ |
| **Format**       | UUID v4 (36 characters with dashes)              |
| **Length**       | Minimum 32 hex characters (without dashes)       |
| **Uniqueness**   | Must be globally unique per business transaction |
| **Immutability** | Client MUST NOT change between retries           |

---

## Retry Logic

### Step 1: Detect Retry Condition

```typescript
// At ingestion endpoint
const retryKey = req.body.retryKey;

if (!retryKey) {
  throw new RetryKeyMissingError();
}

if (!isValidUUID(retryKey)) {
  throw new InvalidRetryKeyFormat();
}
```

### Step 2: Check Retry State

```sql
-- Transactional check
SELECT webhook_id, status, last_attempt_at, retry_count
FROM webhooks
WHERE idempotency_key = ?
AND retry_key = ?
FOR UPDATE;
```

**Retry State Transitions:**

- `PENDING` → `PROCESSING` (on first attempt)
- `PROCESSING` → `DELIVERED` or `FAILED` (on retry)
- `DELIVERED` → `RETRY` (if processing fails)
- `FAILED` → `RETRY` (if processing fails)

### Step 3: Execute Retry

```typescript
// Retry logic
const maxRetries = config.maxRetries;
const backoffConfig = config.backoff;

for (let i = 0; i < maxRetries; i++) {
  try {
    await processWebhook();
    break; // Success
  } catch (error) {
    if (error.code === 'NETWORK_ERROR') {
      // Network error - wait before retry
      await wait(backoffConfig.baseDelay * Math.pow(2, i));
    } else {
      // Other error - mark as failed
      await updateStatus(webhookId, 'FAILED');
      break;
    }
  }
}
```

---

## Backoff Configuration

```typescript
interface BackoffConfig {
  baseDelay: number; // Initial delay in milliseconds
  maxDelay: number; // Maximum delay before capping
  jitterFactor: number; // Random factor (0-1)
  maxRetries: number; // Maximum retry attempts
}

const backoffConfig: BackoffConfig = {
  baseDelay: 1000, // 1 second initial delay
  maxDelay: 60000, // 60 second maximum delay
  jitterFactor: 0.5, // 50% random jitter
  maxRetries: 5, // 5 total retry attempts
};
```

---

## Jitter Implementation

Jitter is applied to backoff delays to prevent thundering herd:

```typescript
function applyJitter(delay: number, jitterFactor: number): number {
  const randomJitter = Math.random() * (delay * jitterFactor);
  return delay + randomJitter;
}
```

### Jitter Scenarios

| Scenario                | Jitter Behavior                        |
| ----------------------- | -------------------------------------- |
| **Normal retry**        | Random delay within ±50% of base delay |
| **Multiple retries**    | Each retry adds independent jitter     |
| **Max retries reached** | No additional delay, mark as failed    |

---

## Retry State Machine

```
┌─────────────┐
│   PENDING   │
└──────┬──────┘
       │
       ▼
┌─────────────┐
│  PROCESSING │
└──────┬──────┘
       │
       ├──────────────────────┐
       │                      │
       ▼                      ▼
┌─────────────┐          ┌─────────────┐
│ DELIVERED   │          │  FAILED     │
└─────────────┘          └─────────────┘
       │                      │
       │                      │
       │                      ▼
       │              ┌─────────────┐
       │              │  RETRY      │
       │              └─────────────┘
       │
       └─────────────────────────────────────┘
```

---

## Retry Key Preservation

### Rule 1: Never Change Retry Key

```typescript
// At ingestion endpoint
const retryKey = req.body.retryKey;

if (!retryKey) {
  throw new RetryKeyMissingError();
}

// Validate retry key format
if (!isValidUUID(retryKey)) {
  throw new InvalidRetryKeyFormat();
}
```

### Rule 2: Retry Key is Immutable

```typescript
// Process webhook with same retry key
await processWebhook({
  idempotency_key: 'uuid-v4',
  retry_key: 'uuid-v4', // Same key for all retries
});
```

### Rule 3: Retry Key Not Stored in Response

```typescript
// Response does NOT include retry_key
// Client should not cache retry_key for future retries
```

---

## Edge Cases

### 1. Network Failure During Processing

```
Request → Process Webhook → Network Error → Retry
```

- Retry key is preserved
- Status remains `PROCESSING` until retry succeeds or fails

### 2. Server-Side Processing Failure

```
Request → Process Webhook → Server Error → Retry
```

- Retry key is preserved
- Status transitions to `RETRY` after failed attempt

### 3. Max Retries Reached

```
Request → Process Webhook (1/5) → Process Webhook (2/5) → ... → Process Webhook (5/5) → FAILED
```

- Status becomes `FAILED`
- Retry key is NOT reused (idempotent)

---

## Implementation Notes

- **Idempotency**: Same retry key always returns same result
- **Stateless**: No state stored in response
- **Transaction**: All retry state changes use database transactions
- **Logging**: Include retry attempt number in logs for debugging

---

## Related Specs

- [`../README.md`](../README.md) - Project-wide guarantees
- [`idempotency-contracts.md`](./idempotency-contracts.md) - Idempotency key requirements
- [`webhook-lifecycle.md`](./webhook-lifecycle.md) - Status transition rules
