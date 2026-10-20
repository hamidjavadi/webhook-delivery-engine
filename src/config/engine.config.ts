/**
 * Worker and polling limits used by the engine.
 *
 * Every value must be a positive safe integer. `batchSize` must be greater
 * than zero and should not exceed the adapter's practical claim limit.
 */
export interface EngineConcurrency {
  /** Maximum number of events processed concurrently. */
  readonly workerCount: number;
  /** Maximum number of events claimed in one poll cycle. */
  readonly batchSize: number;
  /** Milliseconds between scheduler polls when no work is immediately due. */
  readonly pollIntervalMs: number;
}

/**
 * Bounded exponential retry policy used after retryable delivery failures.
 *
 * Delay before jitter is `min(baseDelayMs * 2 ** (attempt - 1), maxDelayMs)`;
 * full jitter selects a delay from zero through that bound.
 */
export interface RetryPolicy {
  /** Maximum number of dispatch attempts before terminal exhaustion. */
  readonly maxAttempts: number;
  /** Initial exponential backoff bound in milliseconds. */
  readonly baseDelayMs: number;
  /** Maximum exponential backoff bound in milliseconds. */
  readonly maxDelayMs: number;
}

/**
 * Immutable runtime configuration required by the delivery engine.
 *
 * Configuration providers validate positive safe-integer limits and require
 * `retry.maxDelayMs >= retry.baseDelayMs` before the engine starts. Documented
 * SDD v1 defaults are batch size 10, a 10,000 ms request timeout, 5 attempts,
 * and 1,000/60,000 ms retry bounds; worker count and poll interval remain
 * provider-selected values.
 */
export interface EngineConfig {
  /** Bounded worker and polling concurrency controls. */
  readonly concurrency: EngineConcurrency;
  /** Maximum duration of a single outbound HTTP request in milliseconds. */
  readonly timeoutLimitMs: number;
  /** Retry ceiling and bounded exponential backoff settings. */
  readonly retry: RetryPolicy;
}
