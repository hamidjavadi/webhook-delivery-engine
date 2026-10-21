# ADR-0001: Unified Atomic-Claim Pattern

- **Date:** 2026-10-16
- **Status:** Accepted
- **Decision-makers:** Product Engineer (Hamid Javadi)

## Context and Problem

The v1.0.0 `webhook-delivery-engine` processes concurrent webhook dispatches using multiple workers against SQLite. We need a concurrency-safe atomic claim mechanism so that no two active workers can claim or process the same delivery event concurrently (satisfying AC3 and preventing race conditions). PostgreSQL and MySQL support is deferred to v2.0; this decision does not assert cross-dialect behavior.

## Decision Factors

1. **SQLite Compatibility (R2):** Must work with SQLite (better-sqlite3) without row-lock syntax or dialect-specific deadlocks.
2. **Simplicity & Dependency Footprint (C2):** Must remain lightweight, self-contained within SQLite, avoiding external brokers like Redis, RabbitMQ, or Kafka.
3. **Concurrency Safety:** Must guarantee race-free claiming under high worker concurrency.
4. **Performance:** Minimal locking overhead and index scan efficiency.

## Options Considered

1. **Explicit Table/Row Locking (`BEGIN TRANSACTION; SELECT ...; UPDATE ... WHERE ...; COMMIT`):**
   - _Pros:_ Standard SQL.
   - _Cons:_ High contention, complex transaction isolation management across different drivers, prone to deadlocks. Rejected.
2. **Atomic Conditional Update Statement (Single Statement):**
   - _Pros:_ Executes as a single atomic statement at the database engine level in SQLite. Works reliably without explicit row locks. Returns affected rows/IDs.
   - _Cons:_ Requires design pattern alignment for retrieving the claimed IDs.

## Decision

We adopt an **Atomic Conditional Update Statement** as the SQLite v1.0 claim pattern. SQLite workers claim batches using:

```sql
UPDATE webhook_events
SET status = 'processing',
    locked_at = CURRENT_TIMESTAMP,
    locked_by = :workerId,
    attempt_count = attempt_count + 1
WHERE id IN (
    SELECT id FROM webhook_events
    WHERE status IN ('pending', 'retry')
      AND (next_retry_at IS NULL OR next_retry_at <= CURRENT_TIMESTAMP)
    ORDER BY created_at ASC
    LIMIT :batchSize
) RETURNING id;
```

## Consequences (positive, negative, risks/costs)

- **Positive:** SQLite-native atomicity (satisfying R2); zero external broker dependency (satisfying C2); robust race-condition prevention (satisfying AC3).
- **Negative / Risks:** Requires careful index tuning on `(status, next_retry_at, created_at)` to prevent table scans during high-frequency polling. Other SQL engines require a separate design and validation in v2.0.

## Migration/Review Plan and References

- **References:** SDD.md (§6.3, §10), WBS (Work Package 2.6–2.7).
- **Review Plan:** Validated during the design checkpoint review prior to worker implementation.
