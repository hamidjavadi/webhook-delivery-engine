import { randomUUID } from 'node:crypto';
import { Buffer } from 'node:buffer';
import type { RetryPolicy } from '../../config/engine.config.js';
import type { DatabaseAdapter, RecordAttemptAndTransitionInput } from '../../core/ports.js';
import type { AttemptRecord, EventStatus, Timestamp, WebhookEvent } from '../../core/types.js';
import { calculateNextRetryAt } from './delivery.backoff.js';
import { classifyDeliveryResult } from './delivery.classify.js';
import { dispatchEvent, type DispatchInput } from './delivery.dispatcher.js';
import type { OnClaimCallback } from '../scheduler/scheduler.js';

/** Narrow persistence boundary required by one delivery attempt. */
export type DeliveryAttemptAdapter = Pick<DatabaseAdapter, 'recordAttemptAndTransition'>;

/** Dependencies for processing one claimed event. */
export interface DeliveryProcessorOptions {
  readonly adapter: DeliveryAttemptAdapter;
  readonly hmacSecret: string;
  readonly timeoutLimitMs: number;
  readonly retry: RetryPolicy;
  /** Optional transport seam, primarily useful for deterministic tests. */
  readonly dispatch?: (input: DispatchInput) => ReturnType<typeof dispatchEvent>;
  /** UTC time source, called once before dispatch and once before persistence. */
  readonly now?: () => Timestamp;
  /** Identifier source for the append-only attempt row. */
  readonly createId?: () => string;
  /** Called after persistence returns the attempt transition result. */
  readonly onAttemptCompleted?: (event: WebhookEvent, result: DeliveryAttemptCompletion) => void;
}

/** Safe, payload-free summary of an attempt and its persistence result. */
export interface DeliveryAttemptCompletion {
  readonly outcome: AttemptRecord['outcome'];
  readonly nextStatus: Extract<EventStatus, 'delivered' | 'retry' | 'failed'>;
  readonly statusCode: number | null;
  readonly latencyMs: number;
  readonly persisted: boolean;
}

/** Processing failure callback for the scheduler-compatible worker adapter. */
export type DeliveryWorkerErrorHandler = (error: unknown, event: WebhookEvent) => void;

/** Dependencies for adapting the async processor to the scheduler callback. */
export interface DeliveryWorkerOptions extends DeliveryProcessorOptions {
  readonly onError: DeliveryWorkerErrorHandler;
  /** Called after dispatch starts with the promise that includes persistence. */
  readonly onDispatchStarted?: (event: WebhookEvent, work: Promise<boolean>) => void;
}

/**
 * Dispatches one claimed event, classifies its result, and atomically records
 * the attempt with the resulting event transition.
 *
 * `WebhookEvent.attemptCount` is already reserved by the claim operation, so
 * it is also this attempt's 1-based audit ordinal. A lost lease is returned as
 * `false` by the adapter without writing a stale attempt or state transition.
 *
 * @param event - Processing event returned by the atomic claim operation.
 * @param options - Adapter, signing, timeout, retry, and optional test seams.
 * @returns Whether the adapter committed the attempt and state transition.
 * @throws When the event has no active lease or a dependency fails.
 */
export async function processDeliveryAttempt(
  event: WebhookEvent,
  options: DeliveryProcessorOptions,
): Promise<boolean> {
  if (event.status !== 'processing' || event.lockedBy === null) {
    throw new Error('The event must have an active processing lease before dispatch.');
  }
  if (!Number.isSafeInteger(event.attemptCount) || event.attemptCount < 1) {
    throw new RangeError('event.attemptCount must be a positive safe integer.');
  }

  const attemptedAt = (options.now ?? defaultNow)();
  const dispatch = options.dispatch ?? dispatchEvent;
  const result = await dispatch({
    event,
    hmacSecret: options.hmacSecret,
    timeoutLimitMs: options.timeoutLimitMs,
  });
  const updatedAt = (options.now ?? defaultNow)();
  const classification = classifyDeliveryResult({
    statusCode: result.statusCode,
    attemptCount: event.attemptCount,
    maxAttempts: options.retry.maxAttempts,
  });
  const nextRetryAt =
    classification.outcome === 'retry_scheduled'
      ? calculateNextRetryAt({
          attempt: event.attemptCount,
          baseDelayMs: options.retry.baseDelayMs,
          maxDelayMs: options.retry.maxDelayMs,
          now: updatedAt,
        }).nextRetryAt
      : null;

  const attempt: AttemptRecord = {
    id: (options.createId ?? randomUUID)(),
    eventId: event.id,
    attemptNumber: event.attemptCount,
    attemptedAt,
    statusCode: result.statusCode,
    responseSnippet: truncateSnippet(result.responseSnippet),
    error: result.error ?? fallbackError(result.statusCode, classification.outcome),
    latencyMs: result.latencyMs,
    outcome: classification.outcome,
  };

  const transition: RecordAttemptAndTransitionInput = createTransition(
    attempt,
    event.lockedBy,
    classification.outcome,
    nextRetryAt,
    updatedAt,
  );
  const persisted = await options.adapter.recordAttemptAndTransition(transition);
  options.onAttemptCompleted?.(event, {
    outcome: classification.outcome,
    nextStatus: transition.nextStatus,
    statusCode: result.statusCode,
    latencyMs: result.latencyMs,
    persisted,
  });
  return persisted;
}

/**
 * Creates a synchronous callback accepted by `ClaimScheduler` while keeping
 * delivery and database failures observable through the required error hook.
 *
 * @param options - Processor dependencies and mandatory error handler.
 * @returns A scheduler-compatible callback that starts one async attempt.
 */
export function createDeliveryWorker(options: DeliveryWorkerOptions): OnClaimCallback {
  return (event) => {
    const work = processDeliveryAttempt(event, options);
    options.onDispatchStarted?.(event, work);
    void work.catch((error: unknown) => {
      options.onError(error, event);
    });
  };
}

function createTransition(
  attempt: AttemptRecord,
  workerId: string,
  outcome: AttemptRecord['outcome'],
  nextRetryAt: Timestamp | null,
  updatedAt: Timestamp,
): RecordAttemptAndTransitionInput {
  switch (outcome) {
    case 'success':
      return {
        attempt: { ...attempt, outcome },
        workerId,
        nextStatus: 'delivered',
        nextRetryAt: null,
        updatedAt,
      };
    case 'retry_scheduled':
      // This path is reached only after calculating the retry timestamp for
      // the discriminated retry_scheduled outcome above.
      return {
        attempt: { ...attempt, outcome },
        workerId,
        nextStatus: 'retry',
        nextRetryAt: nextRetryAt!,
        updatedAt,
      };
    case 'exhausted':
      return {
        attempt: { ...attempt, outcome },
        workerId,
        nextStatus: 'failed',
        nextRetryAt: null,
        updatedAt,
      };
  }
}

function fallbackError(
  statusCode: number | null,
  outcome: AttemptRecord['outcome'],
): string | null {
  if (outcome === 'success') return null;
  return statusCode === null ? 'network error' : `HTTP ${statusCode}`;
}

function defaultNow(): Timestamp {
  return new Date().toISOString();
}

function truncateSnippet(snippet: string | null): string | null {
  if (snippet === null || Buffer.byteLength(snippet, 'utf8') <= 1024) return snippet;

  let byteLength = 0;
  let truncated = '';
  for (const character of snippet) {
    const characterBytes = Buffer.byteLength(character, 'utf8');
    if (byteLength + characterBytes > 1024) break;
    truncated += character;
    byteLength += characterBytes;
  }
  return truncated;
}
