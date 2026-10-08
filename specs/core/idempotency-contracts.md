# Idempotency Contracts

## Overview

The Webhook Delivery Engine guarantees **exactly-once delivery semantics** through strict
idempotency key management. Every incoming webhook must include an `idempotency_key` field
that uniquely identifies the request across all retries and resubmissions.

---

## Idempotency Key Requirements

| Requirement      | Specification                                        |
| ---------------- | ---------------------------------------------------- |
| **Format**       | UUID v4 (36 characters with dashes) or custom string |
| **Length**       | Minimum 32 hex characters (without dashes)           |
| **Uniqueness**   | Must be globally unique per business transaction     |
| **Immutability** | Client MUST NOT change between retries               |

---

## Request Flow

### Step 1: Key Extraction & Validation

```typescript
// Pseudocode at ingestion endpoint
const idempotencyKey = req.body.idempotencyKey;

if (!idempotencyKey) {
  throw new IdempotencyKeyMissingError();
}

if (!isValidUUID(idempotencyKey) && !isConfiguredCustomFormat) {
  throw new InvalidIdempotencyKeyFormat();
}
```

### Step 2: Existing Record Lookup

```sql
-- Transactional check
SELECT webhook_id, status, last_attempt_at, attempt_count
FROM webhooks
WHERE idempotency_key = ?
FOR UPDATE; -- Optimistic locking for race conditions
```

**Scenario A: Key Not Found** → Insert new record, return `201 Created`  
**Scenario B: Key Exists - PENDING/PROCESSING** → Return existing webhook (queue exists)  
**Scenario C: Key Exists - DELIVERED/FAILED** → Idempotent duplicate, skip processing

### Step 3: Duplicate Detection Response

```typescript
interface DuplicateResponse {
  error: 'IDEMPOTENCY_KEY_EXISTS';
  existingId: string; // UUID of original webhook
  status: 'DELIVERED' | 'FAILED' | 'PROCESSING' | 'PENDING';
  lastAttemptAt?: string; // When was it last processed
}
```

### Error Response Codes

| Code              | When                                   | Body Example                                                                 |
| ----------------- | -------------------------------------- | ---------------------------------------------------------------------------- |
| `400 Bad Request` | Missing or invalid idempotency_key     | `{"error":"INVALID_IDEMPOTENCY_KEY","message":"Required field missing"}`     |
| `409 Conflict`    | Duplicate key found, already processed | `{"error":"IDEMPOTENCY_KEY_EXISTS","existingId":"...","status":"DELIVERED"}` |

---

## Edge Cases

### 1. Clock Skew Issues

If client retries with original key after processing complete, treat as duplicate:

```
Original Request → Processed → Client retries later (clock skew)
                          ↓
              Return existing record with status
```

### 2. Key Rotation Scenarios

Some clients may rotate keys mid-stream (e.g., session renewal):

```
Rule: Only allow key rotation AFTER successful delivery.
     New idempotency_key becomes the primary key only after DELIVERED status.
```

### 3. Maximum Retention Period

Idempotency keys are stored indefinitely in our SQLite database, but clients
should implement their own TTL (typically 24-48 hours) if they manage the key lifecycle.

---

## Implementation Notes

- Validation happens at HTTP handler layer BEFORE queueing
- Database query uses `FOR UPDATE` to prevent race conditions
- Duplicate detection returns cached webhook state without re-processing
- Logs include `idempotency_key_hash` for tracing duplicate clusters

---

## Related Specs

- [`../README.md`](../README.md) - Project-wide guarantees
- [`webhook-lifecycle.md`](./webhook-lifecycle.md) - Status transition rules
- [`retry-strategy.md`](./retry-strategy.md) - Retry key preservation
