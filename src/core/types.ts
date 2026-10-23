/**
 * A JSON-compatible scalar value.
 */
export type JsonPrimitive = string | number | boolean | null;

/**
 * A JSON value whose arrays and object properties are readonly. Numbers must
 * be finite values to remain valid JSON.
 */
export type JsonValue =
  JsonPrimitive | readonly JsonValue[] | { readonly [key: string]: JsonValue };

/**
 * An immutable UTC timestamp encoded as an ISO-8601 string.
 *
 * Values crossing a persistence boundary must be normalized to UTC and remain
 * parseable by the JavaScript `Date` constructor.
 */
export type Timestamp = string;

/**
 * Lifecycle states persisted for a webhook event.
 */
export const EVENT_STATUSES = ['pending', 'processing', 'delivered', 'retry', 'failed'] as const;
export type EventStatus = (typeof EVENT_STATUSES)[number];

/**
 * Result recorded for a delivery attempt. `exhausted` means the event reached
 * a terminal unsuccessful state, either through a permanent response or by
 * reaching the configured retry limit.
 */
export const ATTEMPT_OUTCOMES = ['success', 'retry_scheduled', 'exhausted'] as const;
export type AttemptOutcome = (typeof ATTEMPT_OUTCOMES)[number];

/**
 * Durable webhook delivery work together with its immutable input and lease
 * state.
 *
 * `attemptCount` is the number of dispatch attempts started, `nextRetryAt` is
 * null when no retry is scheduled, and the lease fields are both null unless
 * the event is being processed. `metadata`, `payload`, and `headers` are
 * readonly data; engine-owned signing and event-identification headers must
 * not be overridden by values in `headers`.
 */
export interface WebhookEvent {
  /** System-generated, non-enumerable event identifier. */
  readonly id: string;
  /** Client-supplied key, unique within `clientId`. */
  readonly idempotencyKey: string;
  /** Authenticated tenant identifier used for all tenant-scoped reads. */
  readonly clientId: string;
  /** Fully qualified destination URL validated before persistence. */
  readonly destinationUrl: string;
  /** JSON body data delivered to the consumer. */
  readonly payload: JsonValue;
  /** Additional immutable JSON context associated with the event. */
  readonly metadata: Readonly<Record<string, JsonValue>>;
  /** Event-specific outbound headers, excluding reserved engine-owned names. */
  readonly headers: Readonly<Record<string, string>>;
  /** Current durable lifecycle state. */
  readonly status: EventStatus;
  /** Number of delivery attempts started for this event. */
  readonly attemptCount: number;
  /** Time at or after which a retry may be claimed, or null when not scheduled. */
  readonly nextRetryAt: Timestamp | null;
  /** Time at which the current processing lease was acquired, if any. */
  readonly lockedAt: Timestamp | null;
  /** Identifier of the worker holding the current lease, if any. */
  readonly lockedBy: string | null;
  /** Time at which the event was first persisted. */
  readonly createdAt: Timestamp;
  /** Time at which the event was most recently changed. */
  readonly updatedAt: Timestamp;
}

/**
 * Append-only audit data for one outbound delivery attempt.
 *
 * The attempt ordinal is 1-based. `statusCode` is null when no HTTP response
 * was received, `responseSnippet` is null when no response body exists and
 * must be bounded to at most 1 KB, and `error` contains a non-secret
 * description when dispatch failed.
 */
export interface AttemptRecord {
  /** Adapter-generated identifier for this audit row. */
  readonly id: string;
  /** Identifier of the event that was dispatched. */
  readonly eventId: string;
  /** 1-based ordinal matching the event's dispatch attempt counter. */
  readonly attemptNumber: number;
  /** UTC time at which this dispatch attempt began. */
  readonly attemptedAt: Timestamp;
  /** HTTP response status, or null when transport failed before a response. */
  readonly statusCode: number | null;
  /** Secret-free response excerpt bounded to at most 1 KB, if available. */
  readonly responseSnippet: string | null;
  /** Non-secret transport or delivery error description, if any. */
  readonly error: string | null;
  /** Round-trip duration in milliseconds, or null if it was not measured. */
  readonly latencyMs: number | null;
  /** Delivery result used to determine the event's next lifecycle state. */
  readonly outcome: AttemptOutcome;
}
