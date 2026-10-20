import { describe, expect, it } from 'vitest';

import { createEngineConfig, defaultEngineConfig } from '../src/config/engine.config.js';
import type {
  AttemptRecord,
  DeliveryStatus,
  EngineConfig,
  WebhookEvent,
} from '../src/core/types.js';

describe('architecture contracts', () => {
  it('defines the stable webhook status and event contract used across modules', () => {
    const event: WebhookEvent = {
      id: 'evt_123',
      clientId: 'tenant-42',
      idempotencyKey: 'idem-123',
      destinationUrl: 'https://example.com/webhook',
      payload: { hello: 'world' },
      status: 'pending',
      attemptCount: 0,
      nextRetryAt: null,
      createdAt: '2026-10-20T00:00:00.000Z',
      updatedAt: '2026-10-20T00:00:00.000Z',
      lockedAt: null,
      lockedBy: null,
    };

    const status: DeliveryStatus = event.status;

    expect(status).toBe('pending');
    expect(event.id).toBe('evt_123');
    expect(event.payload).toEqual({ hello: 'world' });
  });

  it('records per-attempt audit metadata with typed outcome and error details', () => {
    const attempt: AttemptRecord = {
      id: 'att_001',
      eventId: 'evt_123',
      attemptNumber: 1,
      attemptedAt: '2026-10-20T00:00:00.000Z',
      statusCode: 200,
      responseSnippet: 'ok',
      error: null,
      latencyMs: 128,
      outcome: 'success',
    };

    expect(attempt.outcome).toBe('success');
    expect(attempt.statusCode).toBe(200);
    expect(attempt.error).toBeNull();
  });

  it('creates a safe engine config with documented defaults', () => {
    const config: EngineConfig = createEngineConfig({
      maxAttempts: 7,
      timeoutMs: 15_000,
    });

    expect(config.maxAttempts).toBe(7);
    expect(config.timeoutMs).toBe(15_000);
    expect(config.baseBackoffMs).toBe(defaultEngineConfig.baseBackoffMs);
    expect(config.requireHttps).toBe(true);
    expect(config.pollIntervalMs).toBeGreaterThan(0);
  });
});
