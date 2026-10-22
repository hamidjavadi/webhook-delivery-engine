import type { AttemptOutcome, EventStatus } from '../../core/types.js';

/** Inputs needed to classify one completed outbound dispatch. */
export interface ClassifyDeliveryResultInput {
  /** HTTP response status, or null when dispatch did not receive a response. */
  readonly statusCode: number | null;
  /** 1-based attempt count reserved when the event was claimed. */
  readonly attemptCount: number;
  /** Configured maximum number of dispatch attempts. */
  readonly maxAttempts: number;
}

/** Terminal event transition and corresponding durable attempt outcome. */
export interface DeliveryClassification {
  readonly outcome: AttemptOutcome;
  readonly nextStatus: Extract<EventStatus, 'delivered' | 'retry' | 'failed'>;
}

const RETRYABLE_CLIENT_ERRORS: ReadonlySet<number> = new Set([408, 409, 429]);

/**
 * Classifies the HTTP result and attempt ceiling into the next event state.
 *
 * Only 2xx responses succeed. 4xx responses retry only for 408, 409, and 429;
 * other 4xx responses fail immediately. All other unsuccessful results retry
 * until `maxAttempts`. The existing `exhausted` outcome marks either kind of
 * terminal unsuccessful delivery.
 *
 * @param input - Dispatch status and configured retry limit.
 * @returns The persisted outcome and next event state.
 * @throws {RangeError} When the attempt count, limit, or status code is invalid.
 */
export function classifyDeliveryResult(input: ClassifyDeliveryResultInput): DeliveryClassification {
  if (!Number.isSafeInteger(input.attemptCount) || input.attemptCount < 1) {
    throw new RangeError('attemptCount must be a positive safe integer.');
  }
  if (!Number.isSafeInteger(input.maxAttempts) || input.maxAttempts < 1) {
    throw new RangeError('maxAttempts must be a positive safe integer.');
  }
  if (
    input.statusCode !== null &&
    (!Number.isSafeInteger(input.statusCode) || input.statusCode < 100 || input.statusCode > 599)
  ) {
    throw new RangeError('statusCode must be null or an HTTP status from 100 through 599.');
  }

  if (input.statusCode !== null && input.statusCode >= 200 && input.statusCode < 300) {
    return { outcome: 'success', nextStatus: 'delivered' };
  }

  if (
    input.statusCode !== null &&
    input.statusCode >= 400 &&
    input.statusCode < 500 &&
    !RETRYABLE_CLIENT_ERRORS.has(input.statusCode)
  ) {
    return { outcome: 'exhausted', nextStatus: 'failed' };
  }

  if (input.attemptCount >= input.maxAttempts) {
    return { outcome: 'exhausted', nextStatus: 'failed' };
  }

  return { outcome: 'retry_scheduled', nextStatus: 'retry' };
}
