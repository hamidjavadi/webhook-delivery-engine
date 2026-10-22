import { describe, expect, it } from 'vitest';
import { classifyDeliveryResult } from './delivery.classify.js';

describe('classifyDeliveryResult', () => {
  it.each([
    { statusCode: 0, attemptCount: 1, maxAttempts: 5 },
    { statusCode: 600, attemptCount: 1, maxAttempts: 5 },
    { statusCode: 200, attemptCount: 0, maxAttempts: 5 },
    { statusCode: 200, attemptCount: 1, maxAttempts: 0 },
    { statusCode: 200, attemptCount: Number.MAX_SAFE_INTEGER + 1, maxAttempts: 5 },
  ])('rejects invalid classification input %#', (input) => {
    expect(() => classifyDeliveryResult(input)).toThrow(RangeError);
  });

  it.each([199, 300, 399])('retries unsuccessful non-client status %i', (statusCode) => {
    expect(classifyDeliveryResult({ statusCode, attemptCount: 1, maxAttempts: 5 })).toEqual({
      outcome: 'retry_scheduled',
      nextStatus: 'retry',
    });
  });

  it.each([200, 204, 299])('treats HTTP %i as successful', (statusCode) => {
    expect(classifyDeliveryResult({ statusCode, attemptCount: 1, maxAttempts: 5 })).toEqual({
      outcome: 'success',
      nextStatus: 'delivered',
    });
  });

  it.each(
    Array.from({ length: 100 }, (_, index) => 400 + index).filter(
      (statusCode) => ![408, 409, 429].includes(statusCode),
    ),
  )('marks non-retryable HTTP %i as terminal failure', (statusCode) => {
    expect(classifyDeliveryResult({ statusCode, attemptCount: 1, maxAttempts: 5 })).toEqual({
      outcome: 'exhausted',
      nextStatus: 'failed',
    });
  });

  it.each([null, 408, 409, 429, 500, 599])(
    'schedules another attempt for retryable result %s before the limit',
    (statusCode) => {
      expect(classifyDeliveryResult({ statusCode, attemptCount: 1, maxAttempts: 5 })).toEqual({
        outcome: 'retry_scheduled',
        nextStatus: 'retry',
      });
    },
  );

  it('marks a retryable response exhausted when the current attempt reaches maxAttempts', () => {
    expect(classifyDeliveryResult({ statusCode: 503, attemptCount: 5, maxAttempts: 5 })).toEqual({
      outcome: 'exhausted',
      nextStatus: 'failed',
    });
  });

  it('keeps a successful result successful on the final configured attempt', () => {
    expect(classifyDeliveryResult({ statusCode: 200, attemptCount: 5, maxAttempts: 5 })).toEqual({
      outcome: 'success',
      nextStatus: 'delivered',
    });
  });
});
