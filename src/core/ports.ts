import type { AttemptRecord, EventStatus, Timestamp, WebhookEvent } from './types.js';

/**
 * The event returned from an idempotent upsert.
 *
 * When `inserted` is false, `event` is the existing row identified by the
 * same `(clientId, idempotencyKey)` pair.
 */
export interface EventUpsertResult {
  /** Newly inserted event or the existing idempotent match. */
  readonly event: WebhookEvent;
  /** Whether this call inserted a new event row. */
  readonly inserted: boolean;
}

/**
 * Parameters for atomically claiming a batch of due events.
 */
export interface ClaimDueEventsInput {
  /** Unique identifier persisted on each claimed lease. */
  readonly workerId: string;
  /** UTC reference time used to determine which events are due. */
  readonly now: Timestamp;
  /** Maximum number of eligible events to claim. */
  readonly limit: number;
}

/**
 * Parameters for atomically returning expired processing leases to the retry
 * queue.
 *
 * The adapter calculates the cutoff as
 * `now - max(timeoutLimitMs + 30000, 90000)` and schedules recovered events
 * for `now + 10000` milliseconds. A lease exactly at the cutoff is not stale.
 */
export interface RecoverStaleLeasesInput {
  /** UTC reference time used for the cutoff and retry schedule. */
  readonly now: Timestamp;
  /** Configured per-request timeout in milliseconds; must be a positive safe integer. */
  readonly timeoutLimitMs: number;
}

/**
 * Parameters for releasing an unstarted claim during graceful shutdown.
 *
 * The adapter only releases a lease owned by `workerId`; it restores the event
 * to `pending`, clears its lease, and reverses the attempt reservation made
 * when the event was claimed.
 */
export interface ReleaseEventLeaseInput {
  /** Identifier of the event whose lease is being released. */
  readonly eventId: string;
  /** Worker identifier that must still own the event lease. */
  readonly workerId: string;
  /** UTC time at which the lease is released. */
  readonly releasedAt: Timestamp;
}

/**
 * Parameters for atomically appending an attempt and changing its event state.
 *
 * The `nextRetryAt` invariant is enforced by the discriminated union: retry
 * transitions require a timestamp, while terminal transitions require null.
 */
export type RecordAttemptAndTransitionInput =
  | {
      /** Attempt row to append for the event. */
      readonly attempt: AttemptRecord & { readonly outcome: 'success' };
      /** Worker that must own the event lease. */
      readonly workerId: string;
      /** Successful attempts transition the event to delivered. */
      readonly nextStatus: 'delivered';
      /** Successful terminal delivery does not schedule a retry. */
      readonly nextRetryAt: null;
      /** UTC time at which the event state change is recorded. */
      readonly updatedAt: Timestamp;
    }
  | {
      /** Attempt row to append for the event. */
      readonly attempt: AttemptRecord & {
        readonly outcome: 'retry_scheduled';
      };
      /** Worker that must own the event lease. */
      readonly workerId: string;
      /** A retryable attempt transitions the event to retry. */
      readonly nextStatus: 'retry';
      /** Time at or after which the retry may be claimed. */
      readonly nextRetryAt: Timestamp;
      /** UTC time at which the event state change is recorded. */
      readonly updatedAt: Timestamp;
    }
  | {
      /** Attempt row to append for the event. */
      readonly attempt: AttemptRecord & { readonly outcome: 'exhausted' };
      /** Worker that must own the event lease. */
      readonly workerId: string;
      /** Terminal unsuccessful attempts transition the event to failed. */
      readonly nextStatus: 'failed';
      /** Terminal failure does not schedule a retry. */
      readonly nextRetryAt: null;
      /** UTC time at which the event state change is recorded. */
      readonly updatedAt: Timestamp;
    };

/**
 * Tenant-scoped event page query with optional status filtering and cursor
 * pagination.
 */
export interface ListEventsInput {
  /** Tenant that owns all returned rows. */
  readonly clientId: string;
  /** Optional lifecycle state to filter by. */
  readonly status?: EventStatus;
  /** Maximum number of events to return. */
  readonly limit: number;
  /** Opaque cursor from the preceding page, if one exists. */
  readonly cursor?: string;
}

/**
 * A page of events and the opaque cursor for the next page, when available.
 */
export interface EventPage {
  /** Tenant-scoped events in deterministic creation order. */
  readonly items: readonly WebhookEvent[];
  /** Cursor for the next page, or null when the result set is exhausted. */
  readonly nextCursor: string | null;
}

/**
 * Persistence boundary used by engine modules without depending on a database
 * driver.
 *
 * Implementations must use parameterized statements and preserve the
 * idempotency, tenant-isolation, lease-ownership, and append-only attempt
 * invariants described by each operation. Rejected promises represent
 * persistence failures and must not be converted to successful fallback
 * values.
 */
export interface DatabaseAdapter {
  /**
   * Inserts an event or returns the existing event for the same tenant/key
   * pair without creating a duplicate.
   *
   * @param event Complete validated event to insert.
   * @returns The inserted event or its idempotent existing match.
   */
  upsertEvent(event: WebhookEvent): Promise<EventUpsertResult>;

  /**
   * Atomically claims up to `limit` due pending/retry events for one worker.
   *
   * A successful claim sets `processing`, stamps the lease, and increments the
   * dispatch attempt counter in the same atomic database operation.
   *
   * @param input Claim owner, reference time, and maximum batch size.
   * @returns The claimed events with their updated lease and attempt state.
   */
  claimDueEvents(input: ClaimDueEventsInput): Promise<readonly WebhookEvent[]>;

  /**
   * Atomically returns processing events with expired leases to the retry
   * queue and clears their lease fields.
   *
   * @param input UTC reference time and per-request timeout used to derive the
   * stale cutoff and retry schedule.
   * @returns The number of leases recovered.
   */
  recoverStaleLeases(input: RecoverStaleLeasesInput): Promise<number>;

  /**
   * Releases a worker-owned event lease that has not started network dispatch.
   *
   * The event returns to `pending` and its claim-reserved attempt count is
   * reversed; a lease owned by a different worker must remain unchanged.
   *
   * @param input Event, expected lease owner, and release timestamp.
   * @returns Whether the adapter released the matching lease.
   */
  releaseEventLease(input: ReleaseEventLeaseInput): Promise<boolean>;

  /**
   * Appends the attempt and applies the resulting event transition atomically.
   *
   * The adapter must verify lease ownership, ensure the attempt belongs to the
   * event and is the next 1-based ordinal, match the attempt outcome to the
   * target event state, append no duplicate audit row, and clear the lease as
   * part of a successful transition. If the worker no longer owns the lease,
   * neither the attempt nor transition is written.
   *
   * @param input Attempt details, expected lease owner, and resulting state.
   * @returns Whether the attempt and state transition were committed.
   */
  recordAttemptAndTransition(input: RecordAttemptAndTransitionInput): Promise<boolean>;

  /**
   * Finds one event while enforcing its tenant boundary.
   *
   * @param eventId System-generated event identifier.
   * @param clientId Configured tenant that must own the event.
   * @returns The tenant-owned event, or null when not found.
   */
  findEventById(eventId: string, clientId: string): Promise<WebhookEvent | null>;

  /**
   * Finds an event by its tenant-scoped idempotency key.
   *
   * @param clientId Configured tenant that owns the idempotency namespace.
   * @param idempotencyKey Client-supplied key to find.
   * @returns The matching tenant-owned event, or null when not found.
   */
  findEventByIdempotencyKey(clientId: string, idempotencyKey: string): Promise<WebhookEvent | null>;

  /**
   * Lists events with tenant filtering, optional status filtering, and a
   * bounded cursor page.
   *
   * @param input Tenant identity and page constraints.
   * @returns A deterministic page containing only the requested tenant's rows.
   */
  listEvents(input: ListEventsInput): Promise<EventPage>;

  /**
   * Reads a tenant-owned event's append-only attempt history in attempt-number
   * order. Implementations must enforce ownership in the database query.
   *
   * @param eventId Identifier of the event whose attempts are requested.
   * @param clientId Configured tenant that must own the event.
   * @returns The event's attempts ordered by their 1-based ordinal.
   */
  listAttempts(eventId: string, clientId: string): Promise<readonly AttemptRecord[]>;
}
