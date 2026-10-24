import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { SqliteDatabaseAdapter } from '../storage/sqlite.adapter.js';
import type { WebhookEvent } from '../core/types.js';

vi.mock('../security/ssrf.js', () => ({
  validateDestinationUrl: async (url: string) => ({ valid: true, url }),
}));

const { logger, createLoggerMock } = vi.hoisted(() => {
  const logger = {
    fatal: vi.fn(),
    error: vi.fn(),
    warn: vi.fn(),
    info: vi.fn(),
    debug: vi.fn(),
    trace: vi.fn(),
  };
  return { logger, createLoggerMock: vi.fn(() => logger) };
});

vi.mock('../shared/logger.js', () => ({
  createStructuredLogger: createLoggerMock,
  resolveLogLevel: (explicit: string | undefined, environment: string | undefined) =>
    explicit ?? environment ?? 'info',
}));

import { createWebhookEngine } from './embedded.js';

const directories: string[] = [];

afterEach(async () => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  for (const method of Object.values(logger)) method.mockClear();
  createLoggerMock.mockClear();
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true })));
});

function makeEvent(id: string, payload: WebhookEvent['payload']): WebhookEvent {
  const now = new Date().toISOString();
  return {
    id,
    idempotencyKey: id,
    clientId: 'tenant-a',
    destinationUrl: 'https://consumer.example/hooks',
    payload,
    metadata: {},
    headers: {},
    status: 'pending',
    attemptCount: 0,
    nextRetryAt: null,
    lockedAt: null,
    lockedBy: null,
    createdAt: now,
    updatedAt: now,
  };
}

function makeEngine(databasePath: string, logLevel: 'debug' | null = 'debug') {
  return createWebhookEngine({
    databasePath,
    clientId: 'tenant-a',
    hmacSecret: 'hmac-secret-value',
    defaultDestinationUrl: 'https://consumer.example/hooks',
    ...(logLevel === null ? {} : { logLevel }),
    config: {
      concurrency: { workerCount: 1, batchSize: 2, pollIntervalMs: 60_000 },
      timeoutLimitMs: 1_000,
      retry: { maxAttempts: 3, baseDelayMs: 100, maxDelayMs: 1_000 },
    },
  });
}

describe('embedded engine structured logging', () => {
  it('uses LOG_LEVEL when no per-engine level is supplied', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'webhook-engine-log-level-'));
    directories.push(directory);
    vi.stubEnv('LOG_LEVEL', 'warn');

    const engine = makeEngine(join(directory, 'engine.sqlite'), null);
    await engine.start();
    await engine.stop();

    expect(createLoggerMock).toHaveBeenCalledWith({ level: 'warn' });
  });

  it('logs stale-lease recovery counts', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'webhook-engine-recovery-log-'));
    directories.push(directory);
    vi.spyOn(SqliteDatabaseAdapter.prototype, 'recoverStaleLeases').mockResolvedValue(2);

    const engine = makeEngine(join(directory, 'engine.sqlite'));
    await engine.start();
    await vi.waitFor(() =>
      expect(logger.warn).toHaveBeenCalledWith(
        { event: 'scheduler.stale_leases_recovered', recoveredCount: 2 },
        expect.any(String),
      ),
    );
    await engine.stop();
  });

  it('logs accepted event identity without the idempotency key or payload', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'webhook-engine-ingestion-log-'));
    directories.push(directory);
    const engine = makeEngine(join(directory, 'engine.sqlite'));
    await engine.start();
    const result = await engine.enqueue({
      idempotency_key: 'private-idempotency-key',
      payload: { customerSecret: 'private-payload-value' },
    });
    await engine.stop();

    expect(result.statusCode).toBe(202);
    if (result.statusCode !== 202) throw new Error('Expected ingestion to be accepted.');
    const ingestionRecord = logger.info.mock.calls.find(
      ([fields]) => fields.event === 'ingestion.accepted',
    );
    expect(ingestionRecord?.[0]).toMatchObject({
      event: 'ingestion.accepted',
      eventId: result.body.id,
      clientId: 'tenant-a',
    });
    expect(JSON.stringify(ingestionRecord)).not.toContain('private-idempotency-key');
    expect(JSON.stringify(ingestionRecord)).not.toContain('private-payload-value');
  });

  it('logs lifecycle and delivery records without serializing event data', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'webhook-engine-logging-'));
    directories.push(directory);
    const databasePath = join(directory, 'engine.sqlite');
    const seed = await SqliteDatabaseAdapter.open(databasePath);
    await seed.upsertEvent(makeEvent('event-1', { private: 'payload-private-value' }));
    seed.close();
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('', { status: 200 })));

    const engine = makeEngine(databasePath);
    await engine.start();
    await vi.waitFor(() =>
      expect(logger.info).toHaveBeenCalledWith(
        expect.objectContaining({ event: 'delivery.attempt.completed', eventId: 'event-1' }),
        expect.any(String),
      ),
    );
    await engine.stop();

    expect(createLoggerMock).toHaveBeenCalledWith({ level: 'debug' });
    const records = JSON.stringify(logger.info.mock.calls);
    expect(records).toContain('engine.started');
    expect(records).toContain('delivery.claimed');
    expect(records).toContain('delivery.dispatch.started');
    expect(records).toContain('delivery.attempt.completed');
    expect(records).toContain('engine.stopped');
    expect(records).not.toContain('payload-private-value');
    expect(records).not.toContain('hmac-secret-value');
  });

  it('logs scheduler failures by safe error type without raw messages', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'webhook-engine-logging-error-'));
    directories.push(directory);
    const error = new Error('private payload and credential details');
    error.name = 'private-name-with-sensitive-data';
    vi.spyOn(SqliteDatabaseAdapter.prototype, 'recoverStaleLeases').mockRejectedValue(error);
    const engine = makeEngine(join(directory, 'engine.sqlite'));
    await engine.start();
    await vi.waitFor(() => expect(logger.error).toHaveBeenCalled());
    await engine.stop();

    expect(logger.error).toHaveBeenCalledWith(
      expect.objectContaining({ event: 'scheduler.poll.failed', errorType: 'Error' }),
      expect.any(String),
    );
    expect(JSON.stringify(logger.error.mock.calls)).not.toContain(
      'private payload and credential details',
    );
  });
});
