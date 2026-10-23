import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import * as publicApi from './index.js';
import { SqliteDatabaseAdapter } from './storage/sqlite.adapter.js';
import type { WebhookEvent } from './core/types.js';
import { ClaimScheduler } from './features/scheduler/scheduler.js';

vi.mock('./security/ssrf.js', () => ({
  validateDestinationUrl: async (url: string) => ({ valid: true, url }),
}));

const directories: string[] = [];

afterEach(async () => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true })));
});

describe('public package root', () => {
  it('exports the embedded engine factory and public API types at runtime', () => {
    expect(typeof publicApi.createWebhookEngine).toBe('function');
  });

  it('opens a migrated SQLite database before accepting queries and closes on stop', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'webhook-engine-'));
    directories.push(directory);
    const engine = publicApi.createWebhookEngine({
      databasePath: join(directory, 'engine.sqlite'),
      clientId: 'tenant-1',
      apiKey: 'api-key',
      hmacSecret: 'hmac-secret',
      defaultDestinationUrl: 'https://consumer.example/hooks',
      config: {
        concurrency: { workerCount: 2, batchSize: 10, pollIntervalMs: 60_000 },
        timeoutLimitMs: 1000,
        retry: { maxAttempts: 3, baseDelayMs: 100, maxDelayMs: 1000 },
      },
    });

    await expect(engine.listEvents({ limit: 10 })).rejects.toThrow(/must be started/);
    await Promise.all([engine.start(), engine.start()]);
    await engine.start();
    const result = await engine.enqueue({ idempotency_key: 'consumer-key', payload: { ok: true } });
    expect(result).toMatchObject({ statusCode: 202, body: { idempotency_key: 'consumer-key' } });
    await expect(engine.listEvents({ limit: 10 })).resolves.toMatchObject({
      items: [expect.objectContaining({ idempotencyKey: 'consumer-key', clientId: 'tenant-1' })],
      nextCursor: null,
    });
    await expect(engine.getEvent('consumer-key')).resolves.toMatchObject({
      idempotencyKey: 'consumer-key',
      clientId: 'tenant-1',
    });
    const page = await engine.listEvents({ limit: 10 });
    const eventId = page.items[0]?.id;
    expect(eventId).toBeDefined();
    await expect(engine.getEvent(eventId!)).resolves.toMatchObject({ id: eventId });
    await expect(engine.listAttempts(eventId!)).resolves.toEqual([]);
    await expect(engine.listAttempts('missing')).resolves.toEqual([]);
    await expect(engine.getEvent('missing')).resolves.toBeNull();
    await engine.stop();
    await engine.stop();
    await expect(engine.getEvent('missing')).rejects.toThrow(/must be started/);
    await expect(engine.start()).rejects.toThrow(/cannot start/);
  });

  it('rejects invalid engine configuration before opening storage', () => {
    expect(() =>
      publicApi.createWebhookEngine({
        databasePath: ':memory:',
        clientId: 'tenant-1',
        apiKey: 'api-key',
        hmacSecret: 'hmac-secret',
        defaultDestinationUrl: 'https://consumer.example/hooks',
        config: {
          concurrency: { workerCount: 0, batchSize: 10, pollIntervalMs: 50 },
          timeoutLimitMs: 1000,
          retry: { maxAttempts: 3, baseDelayMs: 100, maxDelayMs: 1000 },
        },
      }),
    ).toThrow(/positive safe integers/);
    expect(() =>
      publicApi.createWebhookEngine({
        databasePath: ':memory:',
        clientId: 'tenant-1',
        apiKey: 'api-key',
        hmacSecret: 'hmac-secret',
        defaultDestinationUrl: 'https://consumer.example/hooks',
        config: {
          concurrency: { workerCount: 1, batchSize: 1, pollIntervalMs: 50 },
          timeoutLimitMs: 1000,
          retry: { maxAttempts: 3, baseDelayMs: 200, maxDelayMs: 100 },
        },
      }),
    ).toThrow(/maxDelayMs/);
    expect(() =>
      publicApi.createWebhookEngine({
        databasePath: ':memory:',
        clientId: 'tenant-1',
        apiKey: '',
        hmacSecret: 'hmac-secret',
        defaultDestinationUrl: 'https://consumer.example/hooks',
        config: {
          concurrency: { workerCount: 1, batchSize: 1, pollIntervalMs: 50 },
          timeoutLimitMs: 1000,
          retry: { maxAttempts: 3, baseDelayMs: 100, maxDelayMs: 1000 },
        },
      }),
    ).toThrow(/apiKey/);
  });

  it('closes an engine that cannot open its configured database', async () => {
    const engine = publicApi.createWebhookEngine({
      databasePath: join(tmpdir(), 'missing-webhook-engine-dir', 'engine.sqlite'),
      clientId: 'tenant-1',
      apiKey: 'api-key',
      hmacSecret: 'hmac-secret',
      defaultDestinationUrl: 'https://consumer.example/hooks',
      config: {
        concurrency: { workerCount: 1, batchSize: 1, pollIntervalMs: 10 },
        timeoutLimitMs: 1000,
        retry: { maxAttempts: 3, baseDelayMs: 100, maxDelayMs: 1000 },
      },
    });
    await expect(engine.start()).rejects.toThrow();
    await expect(engine.stop()).resolves.toBeUndefined();
  });

  it('waits for startup before stopping when stop is called during startup', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'webhook-engine-start-stop-'));
    directories.push(directory);
    const engine = publicApi.createWebhookEngine({
      databasePath: join(directory, 'engine.sqlite'),
      clientId: 'tenant-1',
      apiKey: 'api-key',
      hmacSecret: 'hmac-secret',
      defaultDestinationUrl: 'https://consumer.example/hooks',
      config: {
        concurrency: { workerCount: 1, batchSize: 1, pollIntervalMs: 60_000 },
        timeoutLimitMs: 1000,
        retry: { maxAttempts: 3, baseDelayMs: 100, maxDelayMs: 1000 },
      },
    });
    const starting = engine.start();
    const stopping = engine.stop();
    await expect(Promise.all([starting, stopping])).resolves.toEqual([undefined, undefined]);
    await expect(engine.listEvents({ limit: 1 })).rejects.toThrow(/must be started/);
  });

  it('closes SQLite when scheduler startup fails after migrations', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'webhook-engine-scheduler-fail-'));
    directories.push(directory);
    vi.spyOn(ClaimScheduler.prototype, 'start').mockImplementation(() => {
      throw new Error('scheduler failed');
    });
    const databasePath = join(directory, 'engine.sqlite');
    const engine = publicApi.createWebhookEngine({
      databasePath,
      clientId: 'tenant-1',
      apiKey: 'api-key',
      hmacSecret: 'hmac-secret',
      defaultDestinationUrl: 'https://consumer.example/hooks',
      config: {
        concurrency: { workerCount: 1, batchSize: 1, pollIntervalMs: 10 },
        timeoutLimitMs: 1000,
        retry: { maxAttempts: 3, baseDelayMs: 100, maxDelayMs: 1000 },
      },
    });
    await expect(engine.start()).rejects.toThrow('scheduler failed');
    const database = await SqliteDatabaseAdapter.open(databasePath);
    database.close();
    await engine.stop();
  });

  it('drains started dispatches and releases claims that have not started', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'webhook-engine-drain-'));
    directories.push(directory);
    const databasePath = join(directory, 'engine.sqlite');
    const seed = await SqliteDatabaseAdapter.open(databasePath);
    const createdAt = new Date().toISOString();
    const makeEvent = (id: string, offset: number): WebhookEvent => ({
      id,
      idempotencyKey: id,
      clientId: 'tenant-1',
      destinationUrl: 'https://consumer.example/hooks',
      payload: { id },
      metadata: {},
      headers: {},
      status: 'pending',
      attemptCount: 0,
      nextRetryAt: null,
      lockedAt: null,
      lockedBy: null,
      createdAt: new Date(Date.parse(createdAt) + offset).toISOString(),
      updatedAt: createdAt,
    });
    await seed.upsertEvent(makeEvent('started', 0));
    await seed.upsertEvent(makeEvent('queued', 1));
    seed.close();

    let finishRequest!: (response: Response) => void;
    vi.stubGlobal(
      'fetch',
      vi.fn(
        () =>
          new Promise<Response>((resolve) => {
            finishRequest = resolve;
          }),
      ),
    );
    const engine = publicApi.createWebhookEngine({
      databasePath,
      clientId: 'tenant-1',
      apiKey: 'api-key',
      hmacSecret: 'hmac-secret',
      defaultDestinationUrl: 'https://consumer.example/hooks',
      config: {
        concurrency: { workerCount: 1, batchSize: 2, pollIntervalMs: 60_000 },
        timeoutLimitMs: 10_000,
        retry: { maxAttempts: 3, baseDelayMs: 100, maxDelayMs: 1000 },
      },
    });
    await engine.start();
    await vi.waitFor(() => expect(globalThis.fetch).toHaveBeenCalledTimes(1));

    let stopped = false;
    const stopping = engine.stop().then(() => {
      stopped = true;
    });
    const repeatedStop = engine.stop();
    await Promise.resolve();
    expect(stopped).toBe(false);
    expect(globalThis.fetch).toHaveBeenCalledTimes(1);

    finishRequest(new Response('', { status: 200 }));
    await stopping;
    await repeatedStop;
    const verify = await SqliteDatabaseAdapter.open(databasePath);
    await expect(verify.findEventById('started', 'tenant-1')).resolves.toMatchObject({
      status: 'delivered',
      attemptCount: 1,
    });
    await expect(verify.findEventById('queued', 'tenant-1')).resolves.toMatchObject({
      status: 'pending',
      attemptCount: 0,
      lockedBy: null,
    });
    verify.close();
  });

  it('forwards scheduler failures to the configured error callback', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'webhook-engine-error-'));
    directories.push(directory);
    const onError = vi.fn();
    vi.spyOn(SqliteDatabaseAdapter.prototype, 'recoverStaleLeases').mockRejectedValue(
      new Error('temporary database error'),
    );
    const engine = publicApi.createWebhookEngine({
      databasePath: join(directory, 'engine.sqlite'),
      clientId: 'tenant-1',
      apiKey: 'api-key',
      hmacSecret: 'hmac-secret',
      defaultDestinationUrl: 'https://consumer.example/hooks',
      config: {
        concurrency: { workerCount: 1, batchSize: 1, pollIntervalMs: 60_000 },
        timeoutLimitMs: 1000,
        retry: { maxAttempts: 3, baseDelayMs: 100, maxDelayMs: 1000 },
      },
      onError,
    });
    await engine.start();
    await vi.waitFor(() => expect(onError).toHaveBeenCalledWith(expect.any(Error), undefined));
    await engine.stop();
  });

  it('does not dispatch a claim returned after shutdown has begun', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'webhook-engine-late-claim-'));
    directories.push(directory);
    let returnClaim!: (events: readonly WebhookEvent[]) => void;
    const claimed = new Promise<readonly WebhookEvent[]>((resolve) => {
      returnClaim = resolve;
    });
    const claimDueEvents = vi
      .spyOn(SqliteDatabaseAdapter.prototype, 'claimDueEvents')
      .mockReturnValue(claimed);
    const fetch = vi.fn();
    vi.stubGlobal('fetch', fetch);
    const engine = publicApi.createWebhookEngine({
      databasePath: join(directory, 'engine.sqlite'),
      clientId: 'tenant-1',
      apiKey: 'api-key',
      hmacSecret: 'hmac-secret',
      defaultDestinationUrl: 'https://consumer.example/hooks',
      config: {
        concurrency: { workerCount: 1, batchSize: 1, pollIntervalMs: 60_000 },
        timeoutLimitMs: 1000,
        retry: { maxAttempts: 3, baseDelayMs: 100, maxDelayMs: 1000 },
      },
    });
    await engine.start();
    await vi.waitFor(() => expect(claimDueEvents).toHaveBeenCalledTimes(1));
    const stopping = engine.stop();
    const now = new Date().toISOString();
    returnClaim([
      {
        id: 'late-claim',
        idempotencyKey: 'late-claim',
        clientId: 'tenant-1',
        destinationUrl: 'https://consumer.example/hooks',
        payload: {},
        metadata: {},
        headers: {},
        status: 'processing',
        attemptCount: 1,
        nextRetryAt: null,
        lockedAt: now,
        lockedBy: 'test-worker',
        createdAt: now,
        updatedAt: now,
      },
    ]);
    await stopping;
    expect(fetch).not.toHaveBeenCalled();
  });

  it('emits a process warning when poll errors have no configured handler', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'webhook-engine-warning-'));
    directories.push(directory);
    vi.spyOn(SqliteDatabaseAdapter.prototype, 'recoverStaleLeases').mockRejectedValue(
      'temporary poll failure',
    );
    const emitWarning = vi.spyOn(process, 'emitWarning').mockImplementation(() => undefined);
    const engine = publicApi.createWebhookEngine({
      databasePath: join(directory, 'engine.sqlite'),
      clientId: 'tenant-1',
      apiKey: 'api-key',
      hmacSecret: 'hmac-secret',
      defaultDestinationUrl: 'https://consumer.example/hooks',
      config: {
        concurrency: { workerCount: 1, batchSize: 1, pollIntervalMs: 60_000 },
        timeoutLimitMs: 1000,
        retry: { maxAttempts: 3, baseDelayMs: 100, maxDelayMs: 1000 },
      },
    });
    await engine.start();
    await vi.waitFor(() =>
      expect(emitWarning).toHaveBeenCalledWith(expect.stringContaining('temporary poll failure'), {
        code: 'WEBHOOK_ENGINE_ERROR',
      }),
    );
    await engine.stop();
  });

  it('reports delivery persistence failures with the event to onError', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'webhook-engine-delivery-error-'));
    directories.push(directory);
    const databasePath = join(directory, 'engine.sqlite');
    const seed = await SqliteDatabaseAdapter.open(databasePath);
    const now = new Date().toISOString();
    await seed.upsertEvent({
      id: 'failing-event',
      idempotencyKey: 'failing-event',
      clientId: 'tenant-1',
      destinationUrl: 'https://consumer.example/hooks',
      payload: {},
      metadata: {},
      headers: {},
      status: 'pending',
      attemptCount: 0,
      nextRetryAt: null,
      lockedAt: null,
      lockedBy: null,
      createdAt: now,
      updatedAt: now,
    });
    seed.close();
    vi.spyOn(SqliteDatabaseAdapter.prototype, 'recordAttemptAndTransition').mockRejectedValue(
      new Error('attempt storage failed'),
    );
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('', { status: 200 })));
    const onError = vi.fn();
    const engine = publicApi.createWebhookEngine({
      databasePath,
      clientId: 'tenant-1',
      apiKey: 'api-key',
      hmacSecret: 'hmac-secret',
      defaultDestinationUrl: 'https://consumer.example/hooks',
      config: {
        concurrency: { workerCount: 1, batchSize: 1, pollIntervalMs: 60_000 },
        timeoutLimitMs: 1000,
        retry: { maxAttempts: 3, baseDelayMs: 100, maxDelayMs: 1000 },
      },
      onError,
    });
    await engine.start();
    await vi.waitFor(() =>
      expect(onError).toHaveBeenCalledWith(
        expect.any(Error),
        expect.objectContaining({ id: 'failing-event' }),
      ),
    );
    await engine.stop();
  });
});
