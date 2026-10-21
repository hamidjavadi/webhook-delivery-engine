import { describe, expect, it } from 'vitest';
import { ingestionRequestSchema } from './ingestion.schema.js';

describe('ingestionRequestSchema', () => {
  it('accepts the documented request fields with a recursive JSON payload', () => {
    const request = {
      idempotency_key: 'request-1',
      payload: {
        event: 'updated',
        values: [null, true, 12, { source: 'billing' }],
      },
      destination_url: 'https://consumer.example/hooks',
    };

    expect(ingestionRequestSchema.safeParse(request).success).toBe(true);
  });

  it('accepts an omitted destination URL for configured fallback handling', () => {
    const request = { idempotency_key: 'request-1', payload: null };

    expect(ingestionRequestSchema.safeParse(request).success).toBe(true);
  });

  it('rejects missing or blank required fields', () => {
    expect(ingestionRequestSchema.safeParse({ payload: {} }).success).toBe(false);
    expect(ingestionRequestSchema.safeParse({ idempotency_key: '   ' }).success).toBe(false);
    expect(ingestionRequestSchema.safeParse({ idempotency_key: 'request-1' }).success).toBe(false);
  });

  it('rejects unknown fields including caller-controlled identity and timestamps', () => {
    const request = {
      idempotency_key: 'request-1',
      payload: {},
      id: 'caller-id',
      client_id: 'caller-tenant',
      created_at: '2026-10-21T12:00:00.000Z',
    };

    expect(ingestionRequestSchema.safeParse(request).success).toBe(false);
  });

  it('rejects non-JSON values and non-finite numbers in payloads', () => {
    const withUndefined = { idempotency_key: 'request-1', payload: { value: undefined } };
    const withNaN = { idempotency_key: 'request-1', payload: { value: Number.NaN } };

    expect(ingestionRequestSchema.safeParse(withUndefined).success).toBe(false);
    expect(ingestionRequestSchema.safeParse(withNaN).success).toBe(false);
  });

  it('rejects a non-string destination URL', () => {
    const request = {
      idempotency_key: 'request-1',
      payload: {},
      destination_url: 42,
    };

    expect(ingestionRequestSchema.safeParse(request).success).toBe(false);
  });
});
