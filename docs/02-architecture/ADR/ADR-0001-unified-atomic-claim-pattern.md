# ADR-0001: Unified Atomic-Claim Pattern

- **Date:** 2026-10-16
- **Status:** Accepted
- **Decision-makers:** Product Engineer (Hamid Javadi)

## Context and Problem

The `webhook-delivery-engine` processes concurrent webhook dispatches using multiple worker instances against a relational database (SQLite, PostgreSQL, MySQL per C2/C3 requirements). We need a concurrency-safe atomic claim mechanism to select and lock pending delivery attempts so that no two active workers can claim or process the same delivery event concurrently (satisfying AC3 and preventing race conditions).

## Decision Factors

1. **Portability (R2):** Must support all target SQL dialects (SQLite, PostgreSQL, MySQL) without dialect-specific deadlocks or syntax failures.
2. **Simplicity & Dependency Footprint (C2):** Must remain lightweight, self-contained within relational SQL, avoiding external brokers like Redis, RabbitMQ, or Kafka.
3. **Concurrency Safety:** Must guarantee race-free claiming under high worker concurrency.
4. **Performance:** Minimal locking overhead and index scan efficiency.

## Options Considered

1. **`SELECT ... FOR UPDATE SKIP LOCKED` (PostgreSQL/MySQL 8+ specific):**
   - _Pros:_ Native row locking.
   - _Cons:_ Not supported in SQLite (violates R2 portability requirement). Rejected.
2. **Explicit Table/Row Locking (`BEGIN TRANSACTION; SELECT ...; UPDATE ... WHERE ...; COMMIT`):**
   - _Pros:_ Standard SQL.
   - _Cons:_ High contention, complex transaction isolation management across different drivers, prone to deadlocks. Rejected.
3. **Atomic Conditional Update Statement (Single Statement):**
   - _Pros:_ Executes as a single atomic statement at the database engine level across SQLite, Postgres, and MySQL. Works reliably without explicit row locks. Returns affected rows/IDs.
   - _Cons:_ Requires design pattern alignment for retrieving the claimed IDs.

## Decision

We adopt **Option 3: Atomic Conditional Update Statement** as our unified atomic-claim pattern.
Workers claim batches using a single conditional update statement:

```sql
UPDATE webhook_deliveries
SET status = 'processing',
    locked_at = CURRENT_TIMESTAMP,
    locked_by = :workerId,
    attempts = attempts + 1
WHERE id IN (
    SELECT id FROM webhook_deliveries
    WHERE status IN ('pending', 'retry')
      AND (next_retry_at IS NULL OR next_retry_at <= CURRENT_TIMESTAMP)
    ORDER BY created_at ASC
    LIMIT :batchSize
) RETURNING id;
```

## Consequences (positive, negative, risks/costs)

- **Positive:** Full portability across SQLite, PostgreSQL, and MySQL (satisfying R2); zero external broker dependency (satisfying C2); robust race-condition prevention (satisfying AC3).
- **Negative / Risks:** Requires careful index tuning on `(status, next_retry_at, created_at)` to prevent table scans during high-frequency polling.

## Migration/Review Plan and References

- **References:** SDD.md (§6.3, §10), WBS (Work Package 2.6–2.7).
- **Review Plan:** Validated during the design checkpoint review prior to worker implementation.
