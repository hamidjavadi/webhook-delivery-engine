import { Buffer } from 'node:buffer';
import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AttemptRecord, Timestamp, WebhookEvent } from '../core/types.js';
import type { EngineConfig } from '../config/engine.config.js';
import { ClaimScheduler } from '../features/scheduler/scheduler.js';
import { compareClaimedEvents, SqliteDatabaseAdapter } from './sqlite.adapter.js';

const timestamp = '2026-10-20T12:00:00.000Z';

function createEvent(overrides: Partial<WebhookEvent> = {}): WebhookEvent {
  return {
    id: 'event-1',
    idempotencyKey: 'key-1',
    clientId: 'client-1',
    destinationUrl: 'https://consumer.example/hooks',
    payload: { message: 'hello' },
    metadata: { source: 'test' },
    headers: { 'content-type': 'application/json' },
    status: 'pending',
    attemptCount: 0,
    nextRetryAt: null,
    lockedAt: null,
    lockedBy: null,
    createdAt: timestamp,
    updatedAt: timestamp,
    ...overrides,
  };
}

describe('compareClaimedEvents', () => {
  it('orders by timestamp and id while returning zero for equal keys', () => {
    const older = createEvent({
      id: 'event-a',
      createdAt: '2026-10-20T11:59:00.000Z',
    });
    const newer = createEvent({
      id: 'event-z',
      createdAt: '2026-10-20T12:01:00.000Z',
    });
    const sameTimeEarlierId = createEvent({ id: 'event-a' });
    const sameTimeLaterId = createEvent({ id: 'event-z' });

    expect(compareClaimedEvents(older, newer)).toBe(-1);
    expect(compareClaimedEvents(newer, older)).toBe(1);
    expect(compareClaimedEvents(sameTimeEarlierId, sameTimeLaterId)).toBe(-1);
    expect(compareClaimedEvents(sameTimeLaterId, sameTimeEarlierId)).toBe(1);
    expect(compareClaimedEvents(sameTimeEarlierId, sameTimeEarlierId)).toBe(0);
  });
});

function createAttempt(
  overrides: Omit<Partial<AttemptRecord>, 'outcome'> = {},
): AttemptRecord & { readonly outcome: 'success' } {
  return {
    id: 'attempt-1',
    eventId: 'event-1',
    attemptNumber: 1,
    attemptedAt: timestamp,
    statusCode: 200,
    responseSnippet: '{"ok":true}',
    error: null,
    latencyMs: 12,
    outcome: 'success',
    ...overrides,
  };
}

function createRetryAttempt(
  overrides: Omit<Partial<AttemptRecord>, 'outcome'> = {},
): AttemptRecord & { readonly outcome: 'retry_scheduled' } {
  return {
    ...createAttempt(),
    id: 'attempt-retry',
    statusCode: 503,
    responseSnippet: null,
    error: 'upstream unavailable',
    outcome: 'retry_scheduled',
    ...overrides,
  };
}

function createExhaustedAttempt(): AttemptRecord & { readonly outcome: 'exhausted' } {
  return {
    ...createAttempt(),
    id: 'attempt-exhausted',
    statusCode: 503,
    responseSnippet: null,
    error: 'retry limit reached',
    outcome: 'exhausted',
  };
}

async function claimFromSeparateProcess(
  databasePath: string,
  workerId: string,
  limit: number,
): Promise<readonly string[]> {
  const program = `
    const { SqliteDatabaseAdapter } = await import(process.argv[1]);
    const adapter = await SqliteDatabaseAdapter.open(process.argv[2]);
    try {
      const events = await adapter.claimDueEvents({
        workerId: process.argv[3],
        now: process.argv[4],
        limit: Number(process.argv[5]),
      });
      process.stdout.write(JSON.stringify(events.map(({ id }) => id)));
    } finally {
      adapter.close();
    }
  `;
  const child = spawn(
    process.execPath,
    [
      '--import',
      'tsx',
      '--input-type=module',
      '-e',
      program,
      new URL('./sqlite.adapter.ts', import.meta.url).href,
      databasePath,
      workerId,
      timestamp,
      String(limit),
    ],
    { cwd: process.cwd(), stdio: ['ignore', 'pipe', 'pipe'] },
  );
  let stdout = '';
  let stderr = '';
  child.stdout.setEncoding('utf8').on('data', (chunk: string) => {
    stdout += chunk;
  });
  child.stderr.setEncoding('utf8').on('data', (chunk: string) => {
    stderr += chunk;
  });

  return new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('close', (code) => {
      if (code !== 0) {
        reject(new Error(`Claim worker ${workerId} failed (${code}): ${stderr}`));
        return;
      }
      try {
        const claimedIds: unknown = JSON.parse(stdout);
        if (
          !Array.isArray(claimedIds) ||
          !claimedIds.every((eventId: unknown) => typeof eventId === 'string')
        ) {
          throw new TypeError('Claim worker returned invalid event ids.');
        }
        resolve(claimedIds);
      } catch (error) {
        reject(error);
      }
    });
  });
}

async function terminateProcessAfterClaim(
  databasePath: string,
  workerId: string,
  now: string,
  eventId: string,
): Promise<void> {
  const program = `
    const { SqliteDatabaseAdapter } = await import(process.argv[1]);
    const adapter = await SqliteDatabaseAdapter.open(process.argv[2]);
    const events = await adapter.claimDueEvents({
      workerId: process.argv[3],
      now: process.argv[4],
      limit: 1,
    });
    process.exit(events.some(({ id }) => id === process.argv[5]) ? 73 : 74);
  `;
  const child = spawn(
    process.execPath,
    [
      '--import',
      'tsx',
      '--input-type=module',
      '-e',
      program,
      new URL('./sqlite.adapter.ts', import.meta.url).href,
      databasePath,
      workerId,
      now,
      eventId,
    ],
    { cwd: process.cwd(), stdio: 'ignore' },
  );

  await new Promise<void>((resolve, reject) => {
    child.once('error', reject);
    child.once('close', (code) => {
      if (code !== 73) {
        reject(new Error(`Crash worker exited with unexpected code ${String(code)}.`));
        return;
      }
      resolve();
    });
  });
}

describe('SqliteDatabaseAdapter', () => {
  let directory: string;
  let databasePath: string;
  let adapter: SqliteDatabaseAdapter;

  beforeEach(async () => {
    directory = mkdtempSync(join(tmpdir(), 'webhook-sqlite-adapter-'));
    databasePath = join(directory, 'events.db');
    adapter = await SqliteDatabaseAdapter.open(databasePath);
  });

  afterEach(() => {
    adapter.close();
    rmSync(directory, { recursive: true, force: true });
  });

  it('configures WAL, busy timeout, foreign keys, and the migrated schema', async () => {
    const connection = new Database(databasePath);

    expect(connection.pragma('journal_mode', { simple: true })).toBe('wal');
    expect(connection.pragma('busy_timeout', { simple: true })).toBe(5000);
    expect(connection.pragma('foreign_keys', { simple: true })).toBe(1);
    expect(
      connection
        .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?")
        .get('webhook_events'),
    ).toBeDefined();

    connection.close();
  });

  it('rejects SQLite connections that cannot enable WAL mode', async () => {
    await expect(SqliteDatabaseAdapter.open(':memory:')).rejects.toThrow(/WAL/i);
  });

  it('closes the connection when migration setup fails', async () => {
    const invalidDatabasePath = join(directory, 'invalid.db');
    const connection = new Database(invalidDatabasePath);
    connection.exec(`
      CREATE TABLE schema_migrations (version TEXT PRIMARY KEY);
      INSERT INTO schema_migrations (version) VALUES ('001_initial_schema');
    `);
    connection.close();

    await expect(SqliteDatabaseAdapter.open(invalidDatabasePath)).rejects.toThrow();
    const reopenedConnection = new Database(invalidDatabasePath);
    expect(reopenedConnection.open).toBe(true);
    reopenedConnection.close();
  });

  it('upserts events idempotently within a tenant and preserves JSON values', async () => {
    const event = createEvent();
    const first = await adapter.upsertEvent(event);
    const replay = await adapter.upsertEvent(
      createEvent({ id: 'event-duplicate', payload: { message: 'different' } }),
    );
    const sameIdReplay = await adapter.upsertEvent(event);
    const otherTenant = await adapter.upsertEvent(
      createEvent({
        id: 'event-other-tenant',
        clientId: 'client-2',
        payload: [1, 'text', null],
      }),
    );

    expect(first).toEqual({ event, inserted: true });
    expect(replay).toEqual({ event, inserted: false });
    expect(sameIdReplay).toEqual({ event, inserted: false });
    expect(otherTenant).toMatchObject({
      event: { id: 'event-other-tenant', payload: [1, 'text', null] },
      inserted: true,
    });
    await expect(adapter.findEventById('event-1', 'client-1')).resolves.toEqual(event);
  });

  it('surfaces an error when an upserted row disappears before it can be returned', async () => {
    const connection = new Database(databasePath);
    connection.exec(`
      CREATE TRIGGER remove_inserted_event
      AFTER INSERT ON webhook_events
      BEGIN
        DELETE FROM webhook_events WHERE id = NEW.id;
      END;
    `);
    connection.close();

    await expect(adapter.upsertEvent(createEvent())).rejects.toThrow(/matching event row/i);
  });

  it('binds SQL-shaped tenant and idempotency values as data', async () => {
    const event = createEvent({
      id: 'event-injection',
      clientId: "client' OR 1=1 --",
      idempotencyKey: "key'); DELETE FROM webhook_events; --",
    });

    await adapter.upsertEvent(event);

    await expect(
      adapter.findEventByIdempotencyKey(event.clientId, event.idempotencyKey),
    ).resolves.toEqual(event);
    await expect(adapter.findEventById('event-1', 'client-1')).resolves.toBeNull();
    await expect(
      adapter.findEventByIdempotencyKey('unknown-client', event.idempotencyKey),
    ).resolves.toBeNull();
  });

  it('scopes event lookup and attempt history to the owning tenant', async () => {
    await adapter.upsertEvent(
      createEvent({
        status: 'processing',
        attemptCount: 1,
        lockedAt: timestamp,
        lockedBy: 'worker-1',
      }),
    );
    await adapter.recordAttemptAndTransition({
      attempt: createAttempt(),
      workerId: 'worker-1',
      nextStatus: 'delivered',
      nextRetryAt: null,
      updatedAt: timestamp,
    });

    await expect(adapter.findEventById('event-1', 'other-client')).resolves.toBeNull();
    await expect(adapter.listAttempts('event-1', 'other-client')).resolves.toEqual([]);
    await expect(adapter.listAttempts('event-1', 'client-1')).resolves.toHaveLength(1);
  });

  it('lists tenant events in stable cursor pages', async () => {
    await adapter.upsertEvent(createEvent({ id: 'event-b', createdAt: timestamp }));
    await adapter.upsertEvent(
      createEvent({ id: 'event-a', createdAt: timestamp, idempotencyKey: 'a' }),
    );
    await adapter.upsertEvent(
      createEvent({
        id: 'event-other',
        clientId: 'client-2',
        idempotencyKey: 'other',
        createdAt: timestamp,
      }),
    );

    const firstPage = await adapter.listEvents({ clientId: 'client-1', limit: 1 });
    expect(firstPage.items.map(({ id }) => id)).toEqual(['event-a']);
    expect(firstPage.nextCursor).not.toBeNull();
    const cursor = firstPage.nextCursor;
    if (cursor === null) throw new Error('Expected a continuation cursor.');
    const secondPage = await adapter.listEvents({ clientId: 'client-1', limit: 1, cursor });
    expect(secondPage.items.map(({ id }) => id)).toEqual(['event-b']);
    expect(secondPage.nextCursor).toBeNull();
    await expect(
      adapter.listEvents({ clientId: 'client-1', status: 'delivered', limit: 1 }),
    ).resolves.toMatchObject({ items: [], nextCursor: null });
  });

  it('rejects invalid page bounds and malformed cursors', async () => {
    await expect(adapter.listEvents({ clientId: 'client-1', limit: 0 })).rejects.toThrow(/limit/i);
    await expect(adapter.listEvents({ clientId: 'client-1', limit: 1001 })).rejects.toThrow(
      /limit/i,
    );
    await expect(
      adapter.listEvents({ clientId: 'client-1', limit: 1, cursor: 'not-a-cursor' }),
    ).rejects.toThrow(/cursor/i);
    const invalidShapeCursor = Buffer.from(JSON.stringify(['not-a-tuple']), 'utf8').toString(
      'base64url',
    );
    await expect(
      adapter.listEvents({ clientId: 'client-1', limit: 1, cursor: invalidShapeCursor }),
    ).rejects.toThrow(/cursor/i);
    const invalidTimestampCursor = Buffer.from(
      JSON.stringify(['not-an-ISO-timestamp', 'event-1']),
      'utf8',
    ).toString('base64url');
    await expect(
      adapter.listEvents({ clientId: 'client-1', limit: 1, cursor: invalidTimestampCursor }),
    ).rejects.toThrow(/cursor/i);
  });

  it('claims due events once and increments each reserved attempt count', async () => {
    await adapter.upsertEvent(createEvent({ id: 'pending' }));
    await adapter.upsertEvent(
      createEvent({
        id: 'due-retry',
        idempotencyKey: 'retry',
        status: 'retry',
        nextRetryAt: timestamp,
      }),
    );
    await adapter.upsertEvent(
      createEvent({
        id: 'future-retry',
        idempotencyKey: 'future',
        status: 'retry',
        nextRetryAt: '2026-10-20T12:01:00.000Z',
      }),
    );
    await adapter.upsertEvent(
      createEvent({
        id: 'future-pending',
        idempotencyKey: 'future-pending',
        nextRetryAt: '2026-10-20T12:01:00.000Z',
      }),
    );

    const claimed = await adapter.claimDueEvents({
      workerId: 'worker-1',
      now: timestamp,
      limit: 2,
    });
    const duplicateClaim = await adapter.claimDueEvents({
      workerId: 'worker-2',
      now: timestamp,
      limit: 2,
    });

    expect(claimed.map(({ id }) => id)).toEqual(['due-retry', 'pending']);
    expect(claimed).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ status: 'processing', attemptCount: 1, lockedBy: 'worker-1' }),
      ]),
    );
    expect(duplicateClaim).toEqual([]);
  });

  it('orders claims by creation time even when insertion order differs', async () => {
    await adapter.upsertEvent(
      createEvent({
        id: 'newer',
        idempotencyKey: 'newer',
        createdAt: '2026-10-20T12:01:00.000Z',
      }),
    );
    await adapter.upsertEvent(
      createEvent({
        id: 'older',
        idempotencyKey: 'older',
        createdAt: '2026-10-20T11:59:00.000Z',
      }),
    );

    const claimed = await adapter.claimDueEvents({
      workerId: 'worker-1',
      now: timestamp,
      limit: 2,
    });

    expect(claimed.map(({ id }) => id)).toEqual(['older', 'newer']);
  });

  it('orders claims with matching creation times by id', async () => {
    await adapter.upsertEvent(createEvent({ id: 'event-a', idempotencyKey: 'event-a' }));
    await adapter.upsertEvent(createEvent({ id: 'event-z', idempotencyKey: 'event-z' }));

    const claimed = await adapter.claimDueEvents({
      workerId: 'worker-1',
      now: timestamp,
      limit: 2,
    });

    expect(claimed.map(({ id }) => id)).toEqual(['event-a', 'event-z']);
  });

  it('implements claims as a single conditional UPDATE with RETURNING', () => {
    const source = readFileSync(new URL('./sqlite.adapter.ts', import.meta.url), 'utf8');
    const claimMethod = source.slice(
      source.indexOf('public async claimDueEvents'),
      source.indexOf('public async recoverStaleLeases'),
    );

    expect(claimMethod).toMatch(/UPDATE webhook_events[\s\S]*WHERE id IN \([\s\S]*SELECT id/);
    expect(claimMethod).toMatch(/RETURNING \*/);
    expect(claimMethod.match(/\.prepare\(/g)).toHaveLength(1);
    expect(claimMethod).not.toContain('.transaction(');
  });

  it('does not double-claim an event across two SQLite connections', async () => {
    const secondAdapter = await SqliteDatabaseAdapter.open(databasePath);
    await adapter.upsertEvent(createEvent());

    const claims = await Promise.all([
      adapter.claimDueEvents({ workerId: 'worker-1', now: timestamp, limit: 1 }),
      secondAdapter.claimDueEvents({ workerId: 'worker-2', now: timestamp, limit: 1 }),
    ]);

    expect(claims.flat()).toHaveLength(1);
    secondAdapter.close();
  });

  it('does not double-claim 1,000 events across 100 independent worker processes', async () => {
    const eventCount = 1000;
    const workerCount = 100;
    const claimLimit = eventCount / workerCount;
    const workerIds = Array.from({ length: workerCount }, (_, index) => `process-${index}`);
    for (let index = 0; index < eventCount; index += 1) {
      await adapter.upsertEvent(
        createEvent({
          id: `event-${index.toString().padStart(2, '0')}`,
          idempotencyKey: `key-${index}`,
        }),
      );
    }

    const batches = await Promise.all(
      workerIds.map((workerId) => claimFromSeparateProcess(databasePath, workerId, claimLimit)),
    );
    const claimedIds = batches.flat();
    const events = await adapter.listEvents({ clientId: 'client-1', limit: eventCount });

    expect(new Set(claimedIds).size).toBe(eventCount);
    expect(claimedIds).toHaveLength(eventCount);
    for (const [index, workerId] of workerIds.entries()) {
      const claimedByWorker = batches[index];
      expect(claimedByWorker?.length).toBeLessThanOrEqual(claimLimit);
      for (const eventId of claimedByWorker ?? []) {
        expect(events.items).toEqual(
          expect.arrayContaining([
            expect.objectContaining({
              id: eventId,
              status: 'processing',
              attemptCount: 1,
              lockedBy: workerId,
            }),
          ]),
        );
      }
    }
  }, 60_000);

  it('reclaims and resumes a persisted event after its worker process exits abruptly', async () => {
    const event = createEvent();
    await adapter.upsertEvent(event);
    await terminateProcessAfterClaim(databasePath, 'crashed-worker', timestamp, event.id);

    await expect(adapter.findEventById(event.id, event.clientId)).resolves.toMatchObject({
      status: 'processing',
      attemptCount: 1,
      lockedAt: timestamp,
      lockedBy: 'crashed-worker',
    });

    vi.useFakeTimers();
    const recoveryTime = '2026-10-21T00:00:00.000Z';
    vi.setSystemTime(new Date(recoveryTime));
    let resolveRecovery!: () => void;
    const recoveryCompleted = new Promise<void>((resolve) => {
      resolveRecovery = resolve;
    });
    let recoveredEvent: WebhookEvent | null = null;
    const recoverStaleLeases = adapter.recoverStaleLeases.bind(adapter);
    vi.spyOn(adapter, 'recoverStaleLeases').mockImplementation(async (input) => {
      const recoveredCount = await recoverStaleLeases(input);
      if (recoveredCount > 0) {
        recoveredEvent = await adapter.findEventById(event.id, event.clientId);
        resolveRecovery();
      }
      return recoveredCount;
    });

    let resolveClaim!: (claimedEvent: WebhookEvent) => void;
    const claimedAgain = new Promise<WebhookEvent>((resolve) => {
      resolveClaim = resolve;
    });
    const config: EngineConfig = {
      concurrency: { workerCount: 1, batchSize: 1, pollIntervalMs: 10_000 },
      timeoutLimitMs: 10_000,
      retry: { maxAttempts: 5, baseDelayMs: 1_000, maxDelayMs: 60_000 },
    };
    const scheduler = new ClaimScheduler(adapter, config, resolveClaim);
    scheduler.start();

    try {
      await recoveryCompleted;
      await vi.advanceTimersByTimeAsync(10_000);
      const resumedEvent = await claimedAgain;
      await scheduler.stop();
      expect(recoveredEvent).toMatchObject({
        id: event.id,
        status: 'retry',
        attemptCount: 1,
        nextRetryAt: '2026-10-21T00:00:10.000Z',
        lockedAt: null,
        lockedBy: null,
      });
      expect(resumedEvent).toMatchObject({
        id: event.id,
        status: 'processing',
        attemptCount: 2,
      });
      expect(resumedEvent.lockedBy).not.toBe('crashed-worker');
      await expect(adapter.findEventById(event.id, event.clientId)).resolves.toMatchObject({
        id: event.id,
        status: 'processing',
        attemptCount: 2,
      });
    } finally {
      await scheduler.stop();
      vi.useRealTimers();
    }
  }, 15_000);

  it('recovers expired leases and releases only the owning worker lease', async () => {
    await adapter.upsertEvent(
      createEvent({
        status: 'processing',
        attemptCount: 1,
        lockedAt: timestamp,
        lockedBy: 'worker-1',
      }),
    );

    await expect(
      adapter.releaseEventLease({
        eventId: 'event-1',
        workerId: 'worker-2',
        releasedAt: timestamp,
      }),
    ).resolves.toBe(false);
    await expect(
      adapter.recoverStaleLeases({
        now: '2026-10-20T12:02:00.000Z',
        timeoutLimitMs: 10_000,
      }),
    ).resolves.toBe(1);
    await expect(adapter.findEventById('event-1', 'client-1')).resolves.toMatchObject({
      status: 'retry',
      nextRetryAt: '2026-10-20T12:02:10.000Z',
      updatedAt: '2026-10-20T12:02:00.000Z',
      lockedAt: null,
      lockedBy: null,
    });
  });

  it('uses the 90-second minimum and leaves active or cutoff-equal leases unchanged', async () => {
    const now = '2026-10-20T12:00:00.000Z';
    await adapter.upsertEvent(
      createEvent({
        id: 'event-expired',
        idempotencyKey: 'key-expired',
        status: 'processing',
        attemptCount: 1,
        lockedAt: '2026-10-20T11:58:29.999Z',
        lockedBy: 'worker-expired',
      }),
    );
    await adapter.upsertEvent(
      createEvent({
        id: 'event-cutoff',
        idempotencyKey: 'key-cutoff',
        status: 'processing',
        attemptCount: 1,
        lockedAt: '2026-10-20T11:58:30.000Z',
        lockedBy: 'worker-cutoff',
      }),
    );
    await adapter.upsertEvent(
      createEvent({
        id: 'event-active',
        idempotencyKey: 'key-active',
        status: 'processing',
        attemptCount: 1,
        lockedAt: '2026-10-20T11:59:00.000Z',
        lockedBy: 'worker-active',
      }),
    );
    await adapter.upsertEvent(
      createEvent({
        id: 'event-pending',
        idempotencyKey: 'key-pending',
        status: 'pending',
      }),
    );

    await expect(adapter.recoverStaleLeases({ now, timeoutLimitMs: 60_000 })).resolves.toBe(1);

    await expect(adapter.findEventById('event-expired', 'client-1')).resolves.toMatchObject({
      status: 'retry',
      nextRetryAt: '2026-10-20T12:00:10.000Z',
      lockedAt: null,
      lockedBy: null,
    });
    await expect(adapter.findEventById('event-cutoff', 'client-1')).resolves.toMatchObject({
      status: 'processing',
      lockedBy: 'worker-cutoff',
    });
    await expect(adapter.findEventById('event-active', 'client-1')).resolves.toMatchObject({
      status: 'processing',
      lockedBy: 'worker-active',
    });
    await expect(adapter.findEventById('event-pending', 'client-1')).resolves.toMatchObject({
      status: 'pending',
      lockedAt: null,
      lockedBy: null,
    });
  });

  it('adds 30 seconds to request timeouts longer than 60 seconds', async () => {
    const now = '2026-10-20T12:00:00.000Z';
    await adapter.upsertEvent(
      createEvent({
        id: 'event-over-limit',
        idempotencyKey: 'key-over-limit',
        status: 'processing',
        attemptCount: 1,
        lockedAt: '2026-10-20T11:58:29.998Z',
        lockedBy: 'worker-expired',
      }),
    );
    await adapter.upsertEvent(
      createEvent({
        id: 'event-at-limit',
        idempotencyKey: 'key-at-limit',
        status: 'processing',
        attemptCount: 1,
        lockedAt: '2026-10-20T11:58:29.999Z',
        lockedBy: 'worker-active',
      }),
    );

    await expect(adapter.recoverStaleLeases({ now, timeoutLimitMs: 60_001 })).resolves.toBe(1);
    await expect(adapter.findEventById('event-over-limit', 'client-1')).resolves.toMatchObject({
      status: 'retry',
      lockedAt: null,
      lockedBy: null,
    });
    await expect(adapter.findEventById('event-at-limit', 'client-1')).resolves.toMatchObject({
      status: 'processing',
      lockedBy: 'worker-active',
    });
  });

  it('rejects invalid timeout and clock inputs without changing leases', async () => {
    await adapter.upsertEvent(
      createEvent({
        status: 'processing',
        attemptCount: 1,
        lockedAt: '2026-10-20T11:00:00.000Z',
        lockedBy: 'worker-1',
      }),
    );

    await expect(
      adapter.recoverStaleLeases({
        now: '2026-10-20T12:00:00.000Z',
        timeoutLimitMs: 0,
      }),
    ).rejects.toThrow(/timeoutLimitMs/i);
    await expect(
      adapter.recoverStaleLeases({
        now: 'not-a-timestamp',
        timeoutLimitMs: 10_000,
      }),
    ).rejects.toThrow(/now/i);
    await expect(
      adapter.recoverStaleLeases({
        now: '2026-10-20T12:00:00.000Z',
        timeoutLimitMs: Number.MAX_SAFE_INTEGER,
      }),
    ).rejects.toThrow(/threshold/i);
    await expect(adapter.findEventById('event-1', 'client-1')).resolves.toMatchObject({
      status: 'processing',
      lockedBy: 'worker-1',
    });
  });

  it('releases an unstarted lease and reverses the reserved attempt count', async () => {
    await adapter.upsertEvent(
      createEvent({
        status: 'processing',
        attemptCount: 1,
        lockedAt: timestamp,
        lockedBy: 'worker-1',
      }),
    );

    await expect(
      adapter.releaseEventLease({
        eventId: 'event-1',
        workerId: 'worker-1',
        releasedAt: timestamp,
      }),
    ).resolves.toBe(true);
    await expect(adapter.findEventById('event-1', 'client-1')).resolves.toMatchObject({
      status: 'pending',
      attemptCount: 0,
      lockedAt: null,
      lockedBy: null,
    });
  });

  it('records attempts and transitions event state atomically', async () => {
    await adapter.upsertEvent(
      createEvent({
        status: 'processing',
        attemptCount: 1,
        lockedAt: timestamp,
        lockedBy: 'worker-1',
      }),
    );

    await expect(
      adapter.recordAttemptAndTransition({
        attempt: createAttempt(),
        workerId: 'worker-1',
        nextStatus: 'delivered',
        nextRetryAt: null,
        updatedAt: timestamp,
      }),
    ).resolves.toBe(true);
    await expect(adapter.findEventById('event-1', 'client-1')).resolves.toMatchObject({
      status: 'delivered',
      lockedAt: null,
      lockedBy: null,
    });
    await expect(adapter.listAttempts('event-1', 'client-1')).resolves.toEqual([createAttempt()]);
  });

  it('records retry outcomes and schedules the next attempt', async () => {
    await adapter.upsertEvent(
      createEvent({
        status: 'processing',
        attemptCount: 1,
        lockedAt: timestamp,
        lockedBy: 'worker-1',
      }),
    );
    const nextRetryAt = '2026-10-20T12:01:00.000Z';
    const attempt = createRetryAttempt();

    await expect(
      adapter.recordAttemptAndTransition({
        attempt,
        workerId: 'worker-1',
        nextStatus: 'retry',
        nextRetryAt,
        updatedAt: timestamp,
      }),
    ).resolves.toBe(true);
    await expect(adapter.findEventById('event-1', 'client-1')).resolves.toMatchObject({
      status: 'retry',
      nextRetryAt,
      lockedBy: null,
    });
    await expect(adapter.listAttempts('event-1', 'client-1')).resolves.toEqual([attempt]);
  });

  it('records exhausted outcomes as terminal failures', async () => {
    await adapter.upsertEvent(
      createEvent({
        status: 'processing',
        attemptCount: 1,
        lockedAt: timestamp,
        lockedBy: 'worker-1',
      }),
    );
    const attempt = createExhaustedAttempt();

    await expect(
      adapter.recordAttemptAndTransition({
        attempt,
        workerId: 'worker-1',
        nextStatus: 'failed',
        nextRetryAt: null,
        updatedAt: timestamp,
      }),
    ).resolves.toBe(true);
    await expect(adapter.findEventById('event-1', 'client-1')).resolves.toMatchObject({
      status: 'failed',
      nextRetryAt: null,
    });
    await expect(adapter.listAttempts('event-1', 'client-1')).resolves.toEqual([attempt]);
  });

  it('rejects attempts that do not match the claimed attempt ordinal', async () => {
    await adapter.upsertEvent(
      createEvent({
        status: 'processing',
        attemptCount: 1,
        lockedAt: timestamp,
        lockedBy: 'worker-1',
      }),
    );

    await expect(
      adapter.recordAttemptAndTransition({
        attempt: createAttempt({ attemptNumber: 2 }),
        workerId: 'worker-1',
        nextStatus: 'delivered',
        nextRetryAt: null,
        updatedAt: timestamp,
      }),
    ).resolves.toBe(false);
    await expect(adapter.listAttempts('event-1', 'client-1')).resolves.toEqual([]);
  });

  it('rejects an attempt from a stale lease owner without writing it', async () => {
    await adapter.upsertEvent(
      createEvent({
        status: 'processing',
        attemptCount: 1,
        lockedAt: timestamp,
        lockedBy: 'worker-1',
      }),
    );

    await expect(
      adapter.recordAttemptAndTransition({
        attempt: createAttempt(),
        workerId: 'worker-2',
        nextStatus: 'delivered',
        nextRetryAt: null,
        updatedAt: timestamp,
      }),
    ).resolves.toBe(false);
    await expect(adapter.listAttempts('event-1', 'client-1')).resolves.toEqual([]);
  });

  it('rolls back the attempt insert when the event transition fails', async () => {
    await adapter.upsertEvent(
      createEvent({
        status: 'processing',
        attemptCount: 1,
        lockedAt: timestamp,
        lockedBy: 'worker-1',
      }),
    );
    const connection = new Database(databasePath);
    connection.exec(`
      CREATE TRIGGER fail_delivery_transition
      BEFORE UPDATE OF status ON webhook_events
      WHEN NEW.status = 'delivered'
      BEGIN
        SELECT RAISE(ABORT, 'transition rejected');
      END;
    `);
    connection.close();

    await expect(
      adapter.recordAttemptAndTransition({
        attempt: createAttempt(),
        workerId: 'worker-1',
        nextStatus: 'delivered',
        nextRetryAt: null,
        updatedAt: timestamp,
      }),
    ).rejects.toThrow(/transition rejected/);
    await expect(adapter.listAttempts('event-1', 'client-1')).resolves.toEqual([]);
    await expect(adapter.findEventById('event-1', 'client-1')).resolves.toMatchObject({
      status: 'processing',
    });
  });

  it('rolls back when an event transition is ignored by SQLite', async () => {
    await adapter.upsertEvent(
      createEvent({
        status: 'processing',
        attemptCount: 1,
        lockedAt: timestamp,
        lockedBy: 'worker-1',
      }),
    );
    const connection = new Database(databasePath);
    connection.exec(`
      CREATE TRIGGER ignore_delivery_transition
      BEFORE UPDATE OF status ON webhook_events
      WHEN NEW.status = 'delivered'
      BEGIN
        SELECT RAISE(IGNORE);
      END;
    `);
    connection.close();

    await expect(
      adapter.recordAttemptAndTransition({
        attempt: createAttempt(),
        workerId: 'worker-1',
        nextStatus: 'delivered',
        nextRetryAt: null,
        updatedAt: timestamp,
      }),
    ).rejects.toThrow(/lease changed/i);
    await expect(adapter.listAttempts('event-1', 'client-1')).resolves.toEqual([]);
  });

  it('rejects corrupt persisted event values rather than returning invalid domain data', async () => {
    await adapter.upsertEvent(createEvent());
    const connection = new Database(databasePath);
    connection.pragma('ignore_check_constraints = ON');
    connection
      .prepare('UPDATE webhook_events SET payload = ?, status = ? WHERE id = ?')
      .run('{invalid', 'unknown', 'event-1');
    connection.close();

    await expect(adapter.findEventById('event-1', 'client-1')).rejects.toThrow(/event status/i);
  });

  it('rejects malformed persisted JSON and non-object metadata or headers', async () => {
    await adapter.upsertEvent(createEvent({ id: 'bad-payload', idempotencyKey: 'bad-payload' }));
    await adapter.upsertEvent(createEvent({ id: 'bad-metadata', idempotencyKey: 'bad-metadata' }));
    await adapter.upsertEvent(createEvent({ id: 'bad-headers', idempotencyKey: 'bad-headers' }));
    await adapter.upsertEvent(
      createEvent({ id: 'bad-header-json', idempotencyKey: 'bad-header-json' }),
    );
    await adapter.upsertEvent(
      createEvent({ id: 'non-json-number', idempotencyKey: 'non-json-number' }),
    );
    const connection = new Database(databasePath);
    connection.pragma('ignore_check_constraints = ON');
    connection
      .prepare('UPDATE webhook_events SET payload = ? WHERE id = ?')
      .run('{invalid', 'bad-payload');
    connection
      .prepare('UPDATE webhook_events SET metadata = ? WHERE id = ?')
      .run('[]', 'bad-metadata');
    connection
      .prepare('UPDATE webhook_events SET headers = ? WHERE id = ?')
      .run('[]', 'bad-headers');
    connection
      .prepare('UPDATE webhook_events SET headers = ? WHERE id = ?')
      .run('{invalid', 'bad-header-json');
    connection
      .prepare('UPDATE webhook_events SET payload = ? WHERE id = ?')
      .run('1e10000', 'non-json-number');
    connection.close();

    await expect(adapter.findEventById('bad-payload', 'client-1')).rejects.toThrow(/invalid JSON/i);
    await expect(adapter.findEventById('bad-metadata', 'client-1')).rejects.toThrow(/JSON object/i);
    await expect(adapter.findEventById('bad-headers', 'client-1')).rejects.toThrow(
      /string object/i,
    );
    await expect(adapter.findEventById('bad-header-json', 'client-1')).rejects.toThrow(
      /invalid JSON/i,
    );
    await expect(adapter.findEventById('non-json-number', 'client-1')).rejects.toThrow(
      /not JSON-compatible/i,
    );
  });

  it('rejects invalid runtime metadata and header values before persistence', async () => {
    const invalidMetadata = [] as unknown as WebhookEvent['metadata'];
    const invalidHeaders = { 'x-test': 1 } as unknown as WebhookEvent['headers'];

    await expect(adapter.upsertEvent(createEvent({ metadata: invalidMetadata }))).rejects.toThrow(
      /metadata/i,
    );
    await expect(adapter.upsertEvent(createEvent({ headers: invalidHeaders }))).rejects.toThrow(
      /headers/i,
    );
  });

  it('rejects persisted attempt rows with invalid outcome values', async () => {
    await adapter.upsertEvent(
      createEvent({
        status: 'processing',
        attemptCount: 1,
        lockedAt: timestamp,
        lockedBy: 'worker-1',
      }),
    );
    await adapter.recordAttemptAndTransition({
      attempt: createAttempt(),
      workerId: 'worker-1',
      nextStatus: 'delivered',
      nextRetryAt: null,
      updatedAt: timestamp,
    });
    const connection = new Database(databasePath);
    connection.pragma('ignore_check_constraints = ON');
    connection
      .prepare('UPDATE webhook_event_attempts SET outcome = ? WHERE id = ?')
      .run('unknown', 'attempt-1');
    connection.close();

    await expect(adapter.listAttempts('event-1', 'client-1')).rejects.toThrow(/attempt outcome/i);
  });

  it('validates UTC timestamps at persistence boundaries', async () => {
    const invalidTimestamp: Timestamp = 'not-a-date';

    await expect(adapter.upsertEvent(createEvent({ createdAt: invalidTimestamp }))).rejects.toThrow(
      /timestamp/i,
    );
    await expect(
      adapter.upsertEvent(createEvent({ createdAt: '2026-10-20 12:00:00' })),
    ).rejects.toThrow(/timestamp/i);
  });

  it('rejects non-finite values that are not valid JSON', async () => {
    await expect(
      adapter.upsertEvent(createEvent({ payload: { amount: Number.POSITIVE_INFINITY } })),
    ).rejects.toThrow(/JSON/i);
  });

  it('rejects cyclic payload objects without overflowing the stack', async () => {
    const cyclicPayload: { self?: unknown } = {};
    cyclicPayload.self = cyclicPayload;

    await expect(
      adapter.upsertEvent(
        createEvent({
          payload: cyclicPayload as unknown as WebhookEvent['payload'],
        }),
      ),
    ).rejects.toThrow(/JSON/i);
  });

  it('rejects JSON values whose custom serializer returns undefined', async () => {
    const payload = Object.defineProperty({}, 'toJSON', {
      value: () => undefined,
    }) as WebhookEvent['payload'];

    await expect(adapter.upsertEvent(createEvent({ payload }))).rejects.toThrow(/serialized/i);
  });
});
