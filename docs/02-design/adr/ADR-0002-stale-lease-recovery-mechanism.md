# ADR-0002: Stale-Lease Recovery Mechanism for Orphaned In-Flight Webhook Events

- **Date:** 2026-10-16
- **Status:** Accepted
- **Decision-makers:** Product Engineer (Hamid Javadi)

---

## Context and Problem

In the Webhook Delivery Engine architecture, tasks (webhook delivery attempts) are claimed atomically by worker instances and transitioned to the `processing` state (`locked_at`, `locked_by`).

However, worker instances may crash unexpectedly due to Out-Of-Memory (OOM) kills, network partitions, or infrastructure failures while processing an active delivery. When this happens:

1. The task remains permanently stuck in the `processing` state.
2. The event is orphaned, violating reliability guarantees and the at-least-once delivery contract (**FR-5, AC9**, and system goals **G1**).
3. The database risks accumulating stale locks that prevent future retries.

We need a deterministic, low-overhead mechanism to automatically recover stale leases and transition orphaned tasks back into the active dispatch queue without causing duplicate race conditions.

---

## Decision Factors

1. **Reliability & Consistency:** Guarantee that no task remains permanently locked after a worker failure, bounded by a configured time window.
2. **Database Performance & Write Amplification:** Avoid excessive write load (e.g., frequent heartbeat updates) that could trigger SQLite concurrency bottlenecks (`SQLITE_BUSY`).
3. **SQLite v1.0 Scope:** Keep recovery compatible with the single-node SQLite deployment; additional database engines are deferred to v2.0.
4. **Operational Simplicity:** Keep the recovery logic transparent, testable, and straightforward to monitor via structured logging.

---

## Options Considered

| Option                                               | Description                                                                                                                                                | Pros                                                                                                | Cons                                                                                           |
| :--------------------------------------------------- | :--------------------------------------------------------------------------------------------------------------------------------------------------------- | :-------------------------------------------------------------------------------------------------- | :--------------------------------------------------------------------------------------------- |
| **1. Active Worker Heartbeat**                       | Workers periodically update `locked_at` timestamp while processing active requests.                                                                        | Immediate detection of worker failure.                                                              | High write amplification; increases database write load proportionally to active worker count. |
| **2. Startup-Only Reset Sweep**                      | Reset all stuck `processing` tasks to `retry` exclusively when the application boots up.                                                                   | Zero runtime overhead during normal operation.                                                      | Fails to recover tasks if workers crash _after_ startup and the scheduler remains running.     |
| **3. Scheduler-Driven Stale-Claim Sweep (Selected)** | The background scheduler periodically scans for `processing` tasks where `locked_at < now - staleThreshold` during poll cycles and resets them to `retry`. | Low runtime overhead; no worker-side background heartbeats required; robust against sudden crashes. | Bounded delay equal to the poll cycle interval before recovery initiates.                      |

---

## Decision

We have chosen **Option 3: Scheduler-Driven Stale-Claim Sweep**.

### Implementation Details:

1. **Threshold Rule:**
   $$\text{staleThreshold} = \max(\text{REQUEST\_TIMEOUT\_MS} + 30000\text{ms}, 90000\text{ms})$$
   This ensures active, long-running webhooks are never prematurely reclaimed.
2. **Atomic Recovery Query:**
   During each scheduler poll cycle, execute a single atomic SQL statement to reclaim stale leases:

```sql
UPDATE webhook_events
   SET status = 'retry',
      locked_at = NULL,
      locked_by = NULL,
      next_retry_at = datetime('now', '+10 seconds')
   WHERE status = 'processing'
         AND locked_at < datetime('now', '-90 seconds');
```

## References

- [`SDD.md`](../SDD.md) (§6.3 stale-lease recovery flow).
- [`WBS.md`](../../01-plan/WBS.md) (Tasks 2.7 and 4.1).
