import type { AttemptRecord, Timestamp, WebhookEvent } from '../../src/core/types.js';
import type { DatabaseAdapter } from '../../src/core/ports.js';
import type { EngineConfig } from '../../src/config/engine.config.js';

const createdAt: Timestamp = '2026-10-20T12:00:00.000Z';

const event: WebhookEvent = {
  id: 'event-1',
  idempotencyKey: 'request-1',
  clientId: 'client-1',
  destinationUrl: 'https://consumer.example/hooks',
  payload: { action: 'updated', count: 2 },
  metadata: { source: 'billing', tags: ['invoice'] },
  headers: { 'x-source': 'billing' },
  status: 'processing',
  attemptCount: 1,
  nextRetryAt: null,
  lockedAt: createdAt,
  lockedBy: 'worker-1',
  createdAt,
  updatedAt: createdAt,
};

const attempt = {
  id: 'attempt-1',
  eventId: event.id,
  attemptNumber: 1,
  attemptedAt: createdAt,
  statusCode: null,
  responseSnippet: null,
  error: 'timeout',
  latencyMs: 10_000,
  outcome: 'retry_scheduled',
} as const satisfies AttemptRecord;

const responseAttempt = {
  id: 'attempt-2',
  eventId: event.id,
  attemptNumber: 2,
  attemptedAt: createdAt,
  statusCode: 503,
  responseSnippet: 'temporarily unavailable',
  error: null,
  latencyMs: 125,
  outcome: 'retry_scheduled',
} as const satisfies AttemptRecord;

const config: EngineConfig = {
  concurrency: {
    workerCount: 4,
    batchSize: 10,
    pollIntervalMs: 1_000,
  },
  timeoutLimitMs: 10_000,
  retry: {
    maxAttempts: 5,
    baseDelayMs: 1_000,
    maxDelayMs: 60_000,
  },
};

describe('core domain contracts', () => {
  it('models immutable event payload, metadata, headers, and delivery state', () => {
    expect(event).toMatchObject({
      payload: { action: 'updated', count: 2 },
      metadata: { source: 'billing', tags: ['invoice'] },
      headers: { 'x-source': 'billing' },
      status: 'processing',
      attemptCount: 1,
      lockedBy: 'worker-1',
    });
  });

  it('models HTTP responses and transport failures in attempt audit records', () => {
    expect(attempt).toMatchObject({
      eventId: event.id,
      attemptNumber: 1,
      statusCode: null,
      error: 'timeout',
      outcome: 'retry_scheduled',
    });
    expect(responseAttempt).toMatchObject({
      statusCode: 503,
      responseSnippet: 'temporarily unavailable',
      error: null,
      latencyMs: 125,
    });
  });

  it('exposes atomic persistence operations through the database adapter', async () => {
    const adapter: DatabaseAdapter = {
      async upsertEvent(input) {
        return { event: input, inserted: true };
      },
      async claimDueEvents() {
        return [event];
      },
      async recoverStaleLeases() {
        return 0;
      },
      async releaseEventLease() {
        return true;
      },
      async recordAttemptAndTransition() {
        return true;
      },
      async findEventById() {
        return event;
      },
      async findEventByIdempotencyKey() {
        return event;
      },
      async listEvents() {
        return { items: [event], nextCursor: null };
      },
      async listAttempts() {
        return [attempt];
      },
    };

    const upsert = await adapter.upsertEvent(event);
    const claimed = await adapter.claimDueEvents({
      workerId: 'worker-1',
      now: createdAt,
      limit: 1,
    });
    const recorded = await adapter.recordAttemptAndTransition({
      attempt,
      workerId: 'worker-1',
      nextStatus: 'retry',
      nextRetryAt: createdAt,
      updatedAt: createdAt,
    });

    expect(upsert.inserted).toBe(true);
    expect(claimed).toEqual([event]);
    expect(recorded).toBe(true);
  });

  it('groups positive concurrency, timeout, and retry policy limits', () => {
    expect(config).toMatchObject({
      concurrency: {
        workerCount: 4,
        batchSize: 10,
        pollIntervalMs: 1_000,
      },
      timeoutLimitMs: 10_000,
      retry: {
        maxAttempts: 5,
        baseDelayMs: 1_000,
        maxDelayMs: 60_000,
      },
    });
  });
});
