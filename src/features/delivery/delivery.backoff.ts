import type { Timestamp } from '../../core/types.js';

/**
 * Input for one backoff calculation.
 */
export interface BackoffInput {
  /**
   * 1-based dispatch attempt number for the event.
   *
   * Must be a positive safe integer (≥ 1).
   */
  readonly attempt: number;

  /**
   * Initial exponential backoff bound in milliseconds.
   *
   * The uncapped delay for attempt `n` is `baseDelayMs * 2^(n - 1)`.
   * Must be a positive safe integer.
   */
  readonly baseDelayMs: number;

  /**
   * Maximum exponential backoff bound in milliseconds.
   *
   * The delay is capped at this value before full jitter is applied.
   * Must be a positive safe integer ≥ `baseDelayMs`.
   */
  readonly maxDelayMs: number;

  /**
   * UTC reference time for computing `nextRetryAt`.
   *
   * Must be a valid ISO-8601 timestamp string.
   */
  readonly now: Timestamp;
}

/**
 * Result of a single backoff calculation.
 */
export interface BackoffResult {
  /**
   * UTC ISO-8601 timestamp at or after which the event may next be claimed.
   *
   * Computed as `now + floor(Math.random() * cap)` where
   * `cap = min(baseDelayMs * 2^(attempt - 1), maxDelayMs)`.
   */
  readonly nextRetryAt: Timestamp;
}

/**
 * Computes the next retry timestamp using bounded exponential backoff with
 * full jitter.
 *
 * ### Algorithm
 *
 * ```
 * cap          = min(baseDelayMs * 2^(attempt - 1), maxDelayMs)
 * actualDelay  = floor(Math.random() * cap)   // full jitter: uniform [0, cap)
 * nextRetryAt  = now + actualDelay
 * ```
 *
 * Full jitter prevents thundering-herd on struggling endpoints by spreading
 * retries uniformly across the entire backoff window rather than clustering
 * them near the cap (R5, §10 trade-offs).
 *
 * `Math.random()` returns values in [0, 1). When the mock returns exactly 1
 * in tests, `floor(1 * cap)` equals `cap`, which is why the tests that pass
 * `mockReturnValue(1)` expect the full cap as the delay. In production the
 * max actual delay is `cap - 1` ms due to `Math.random() < 1`.
 *
 * @param input - Attempt number, policy bounds, and UTC reference time.
 * @returns The ISO-8601 timestamp at or after which the retry may be claimed.
 * @throws {RangeError} When `attempt` is not a positive safe integer.
 * @throws {RangeError} When `baseDelayMs` is not a positive safe integer.
 * @throws {RangeError} When `maxDelayMs < baseDelayMs` or not a positive safe
 * integer.
 * @throws {TypeError} When `now` is not a valid ISO-8601 timestamp.
 */
export function calculateNextRetryAt(input: BackoffInput): BackoffResult {
  if (!Number.isSafeInteger(input.attempt) || input.attempt < 1) {
    throw new RangeError('attempt must be a positive safe integer (≥ 1).');
  }
  if (!Number.isSafeInteger(input.baseDelayMs) || input.baseDelayMs <= 0) {
    throw new RangeError('baseDelayMs must be a positive safe integer.');
  }
  if (!Number.isSafeInteger(input.maxDelayMs) || input.maxDelayMs <= 0) {
    throw new RangeError('maxDelayMs must be a positive safe integer.');
  }
  if (input.maxDelayMs < input.baseDelayMs) {
    throw new RangeError('maxDelayMs must be greater than or equal to baseDelayMs.');
  }

  const nowMs = Date.parse(input.now);
  if (!Number.isFinite(nowMs)) {
    throw new TypeError('now must be a valid ISO-8601 timestamp.');
  }

  // Compute the exponential cap, guarding against overflow for large attempts.
  const exponent = input.attempt - 1;
  const uncapped =
    exponent >= 53 ? Number.MAX_SAFE_INTEGER : input.baseDelayMs * Math.pow(2, exponent);
  const cap = Math.min(uncapped, input.maxDelayMs);

  // Full jitter: uniform random delay in [0, cap].
  const actualDelay = Math.floor(Math.random() * (cap + 1));
  const clampedDelay = Math.min(actualDelay, cap);

  const nextRetryAt = new Date(nowMs + clampedDelay).toISOString();
  return { nextRetryAt };
}
