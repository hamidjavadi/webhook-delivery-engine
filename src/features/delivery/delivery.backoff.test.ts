import { vi, describe, it, expect, afterEach } from 'vitest';
import { calculateNextRetryAt, type BackoffInput } from './delivery.backoff.js';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const NOW = '2026-10-21T18:00:00.000Z';
const NOW_MS = Date.parse(NOW); // 1761091200000

const POLICY = {
  baseDelayMs: 1_000,
  maxDelayMs: 60_000,
} as const;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Runs calculateNextRetryAt many times with a fixed Math.random and asserts
 * the returned nextRetryAt equals now + expectedDelayMs.
 */
function assertDelayMs(input: BackoffInput, mockRandom: number, expectedDelayMs: number): void {
  vi.spyOn(Math, 'random').mockReturnValue(mockRandom);
  const result = calculateNextRetryAt(input);
  const actualDelayMs = Date.parse(result.nextRetryAt) - NOW_MS;
  expect(actualDelayMs).toBe(expectedDelayMs);
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('calculateNextRetryAt', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  // -------------------------------------------------------------------------
  // Return shape
  // -------------------------------------------------------------------------

  it('returns an object with a nextRetryAt property', () => {
    const result = calculateNextRetryAt({ ...POLICY, attempt: 1, now: NOW });
    expect(result).toHaveProperty('nextRetryAt');
  });

  it('nextRetryAt is a valid ISO-8601 UTC string', () => {
    const result = calculateNextRetryAt({ ...POLICY, attempt: 1, now: NOW });
    const parsed = new Date(result.nextRetryAt);
    expect(parsed.toISOString()).toBe(result.nextRetryAt);
  });

  it('nextRetryAt is at or after now', () => {
    const result = calculateNextRetryAt({ ...POLICY, attempt: 1, now: NOW });
    expect(Date.parse(result.nextRetryAt)).toBeGreaterThanOrEqual(NOW_MS);
  });

  // -------------------------------------------------------------------------
  // Bounded exponential cap (before jitter)
  // -------------------------------------------------------------------------

  it('caps the delay at maxDelayMs when attempt is large', () => {
    // With random = 1.0 the full cap is applied
    vi.spyOn(Math, 'random').mockReturnValue(1);
    const result = calculateNextRetryAt({ ...POLICY, attempt: 100, now: NOW });
    const delayMs = Date.parse(result.nextRetryAt) - NOW_MS;
    expect(delayMs).toBeLessThanOrEqual(POLICY.maxDelayMs);
  });

  it('delay for attempt 1 is at most baseDelayMs (before jitter)', () => {
    vi.spyOn(Math, 'random').mockReturnValue(1);
    const result = calculateNextRetryAt({ ...POLICY, attempt: 1, now: NOW });
    const delayMs = Date.parse(result.nextRetryAt) - NOW_MS;
    expect(delayMs).toBeLessThanOrEqual(POLICY.baseDelayMs);
  });

  it('delay for attempt 2 is at most baseDelayMs * 2 (before jitter)', () => {
    vi.spyOn(Math, 'random').mockReturnValue(1);
    const result = calculateNextRetryAt({ ...POLICY, attempt: 2, now: NOW });
    const delayMs = Date.parse(result.nextRetryAt) - NOW_MS;
    expect(delayMs).toBeLessThanOrEqual(POLICY.baseDelayMs * 2);
  });

  it('delay for attempt 3 is at most baseDelayMs * 4 (before jitter)', () => {
    vi.spyOn(Math, 'random').mockReturnValue(1);
    const result = calculateNextRetryAt({ ...POLICY, attempt: 3, now: NOW });
    const delayMs = Date.parse(result.nextRetryAt) - NOW_MS;
    expect(delayMs).toBeLessThanOrEqual(POLICY.baseDelayMs * 4);
  });

  // -------------------------------------------------------------------------
  // Full jitter — Math.random = 0 gives 0 delay; = 1 gives full cap
  // -------------------------------------------------------------------------

  it('returns now when Math.random returns 0 (jitter floor)', () => {
    assertDelayMs({ ...POLICY, attempt: 1, now: NOW }, 0, 0);
  });

  it('returns now + baseDelayMs when attempt=1 and Math.random returns 1', () => {
    assertDelayMs({ ...POLICY, attempt: 1, now: NOW }, 1, POLICY.baseDelayMs);
  });

  it('returns now + baseDelayMs*2 when attempt=2 and Math.random returns 1', () => {
    assertDelayMs({ ...POLICY, attempt: 2, now: NOW }, 1, POLICY.baseDelayMs * 2);
  });

  it('returns now + baseDelayMs*4 when attempt=3 and Math.random returns 1', () => {
    assertDelayMs({ ...POLICY, attempt: 3, now: NOW }, 1, POLICY.baseDelayMs * 4);
  });

  it('caps at maxDelayMs even when exponent overflows (large attempt, random=1)', () => {
    assertDelayMs({ ...POLICY, attempt: 100, now: NOW }, 1, POLICY.maxDelayMs);
  });

  it('applies jitter as a fraction of the capped delay', () => {
    // attempt=1, cap=baseDelayMs=1000, random=0.5 → delay=500
    assertDelayMs({ ...POLICY, attempt: 1, now: NOW }, 0.5, 500);
  });

  it('applies jitter against the cap for a high attempt', () => {
    // attempt=100, cap=maxDelayMs=60000, random=0.25 → delay=15000
    assertDelayMs({ ...POLICY, attempt: 100, now: NOW }, 0.25, 15_000);
  });

  // -------------------------------------------------------------------------
  // Exact formula: delay = floor(rand * min(base * 2^(attempt-1), max))
  // -------------------------------------------------------------------------

  it('uses floor of the jittered value so delay is always an integer ms', () => {
    // random=0.3, base=1000, attempt=1 → floor(0.3 * 1000) = 300
    vi.spyOn(Math, 'random').mockReturnValue(0.3);
    const result = calculateNextRetryAt({ ...POLICY, attempt: 1, now: NOW });
    const delayMs = Date.parse(result.nextRetryAt) - NOW_MS;
    expect(Number.isInteger(delayMs)).toBe(true);
  });

  // -------------------------------------------------------------------------
  // Custom maxDelayMs smaller than base * 2^(attempt-1)
  // -------------------------------------------------------------------------

  it('respects a smaller custom maxDelayMs', () => {
    const policy = { baseDelayMs: 1_000, maxDelayMs: 2_000 };
    vi.spyOn(Math, 'random').mockReturnValue(1);
    const result = calculateNextRetryAt({ ...policy, attempt: 5, now: NOW });
    const delayMs = Date.parse(result.nextRetryAt) - NOW_MS;
    expect(delayMs).toBe(2_000); // capped
  });

  it('handles attempt >= 54 without numeric overflow (large-exponent guard)', () => {
    // exponent = 53 triggers the MAX_SAFE_INTEGER guard path.
    // Use a maxDelayMs large enough to not cap before the guard activates,
    // so the Number.MAX_SAFE_INTEGER branch is the one that actually executes.
    // With random=0 the delay is 0 and nextRetryAt equals now.
    vi.spyOn(Math, 'random').mockReturnValue(0);
    const result = calculateNextRetryAt({
      baseDelayMs: 1,
      maxDelayMs: Number.MAX_SAFE_INTEGER,
      attempt: 54,
      now: NOW,
    });
    expect(result.nextRetryAt).toBe(NOW);
  });

  // -------------------------------------------------------------------------
  // Input validation
  // -------------------------------------------------------------------------

  it('throws when attempt is less than 1', () => {
    expect(() => calculateNextRetryAt({ ...POLICY, attempt: 0, now: NOW })).toThrow();
  });

  it('throws when attempt is not a safe integer', () => {
    expect(() => calculateNextRetryAt({ ...POLICY, attempt: 1.5, now: NOW })).toThrow();
  });

  it('throws when baseDelayMs is zero', () => {
    expect(() =>
      calculateNextRetryAt({ baseDelayMs: 0, maxDelayMs: 1_000, attempt: 1, now: NOW }),
    ).toThrow();
  });

  it('throws when baseDelayMs is negative', () => {
    expect(() =>
      calculateNextRetryAt({ baseDelayMs: -1, maxDelayMs: 1_000, attempt: 1, now: NOW }),
    ).toThrow();
  });

  it('throws when maxDelayMs is zero', () => {
    expect(() =>
      calculateNextRetryAt({ baseDelayMs: 1_000, maxDelayMs: 0, attempt: 1, now: NOW }),
    ).toThrow();
  });

  it('throws when maxDelayMs is less than baseDelayMs', () => {
    expect(() =>
      calculateNextRetryAt({ baseDelayMs: 1_000, maxDelayMs: 500, attempt: 1, now: NOW }),
    ).toThrow();
  });

  it('throws when now is not a valid ISO-8601 timestamp', () => {
    expect(() => calculateNextRetryAt({ ...POLICY, attempt: 1, now: 'not-a-date' })).toThrow();
  });
});
