import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { WebhookEvent } from '../../core/types.js';
import type { DatabaseAdapter } from '../../core/ports.js';
import type { ApiKeyAuthenticationResult } from '../../security/auth.js';
import { SqliteDatabaseAdapter } from '../../storage/sqlite.adapter.js';
import { handleIngestion } from './ingestion.handler.js';

const authentication: ApiKeyAuthenticationResult = {
  authenticated: true,
  clientId: 'client-1',
};

const requestBody = {
  idempotency_key: 'request-1',
  payload: { message: 'hello' },
  destination_url: 'https://93.184.216.34/hooks',
};

function createDatabase(
  upsertEvent: (event: WebhookEvent) => ReturnType<DatabaseAdapter['upsertEvent']>,
): Pick<DatabaseAdapter, 'upsertEvent'> {
  return { upsertEvent };
}

describe('handleIngestion', () => {
  it('creates a server-owned event and returns the new-event acceptance result', async () => {
    const upsertEvent = vi.fn(async (event: WebhookEvent) => ({ event, inserted: true }));
    const result = await handleIngestion({
      authentication,
      body: requestBody,
      defaultDestinationUrl: 'https://93.184.216.34/default',
      database: createDatabase(upsertEvent),
    });

    expect(result).toEqual({
      statusCode: 202,
      body: {
        id: expect.any(String),
        idempotency_key: 'request-1',
        idempotent_replay: false,
        status: 'pending',
      },
    });
    expect(upsertEvent).toHaveBeenCalledOnce();
    const event = upsertEvent.mock.calls[0]?.[0];
    expect(event).toMatchObject({
      id: expect.any(String),
      idempotencyKey: 'request-1',
      clientId: 'client-1',
      destinationUrl: 'https://93.184.216.34/hooks',
      payload: { message: 'hello' },
      metadata: {},
      headers: {},
      status: 'pending',
      attemptCount: 0,
      nextRetryAt: null,
      lockedAt: null,
      lockedBy: null,
      createdAt: expect.any(String),
      updatedAt: expect.any(String),
    });
    expect(event?.createdAt).toBe(event?.updatedAt);
    expect(event?.id).not.toBe('request-1');
  });

  it('returns unauthorized before validating the body or writing to storage', async () => {
    const upsertEvent = vi.fn(async (event: WebhookEvent) => ({ event, inserted: true }));
    const result = await handleIngestion({
      authentication: { authenticated: false, statusCode: 401 },
      body: { client_id: 'untrusted', payload: undefined },
      defaultDestinationUrl: 'not a URL',
      database: createDatabase(upsertEvent),
    });

    expect(result).toEqual({
      statusCode: 401,
      body: { error: 'unauthorized' },
    });
    expect(upsertEvent).not.toHaveBeenCalled();
  });

  it('rejects invalid request bodies without writing to storage', async () => {
    const upsertEvent = vi.fn(async (event: WebhookEvent) => ({ event, inserted: true }));
    const result = await handleIngestion({
      authentication,
      body: { ...requestBody, client_id: 'spoofed-client' },
      defaultDestinationUrl: 'https://93.184.216.34/default',
      database: createDatabase(upsertEvent),
    });

    expect(result).toEqual({
      statusCode: 400,
      body: { error: 'invalid_request' },
    });
    expect(upsertEvent).not.toHaveBeenCalled();
  });

  it('rejects unsafe supplied destinations without writing to storage', async () => {
    const upsertEvent = vi.fn(async (event: WebhookEvent) => ({ event, inserted: true }));
    const result = await handleIngestion({
      authentication,
      body: { ...requestBody, destination_url: 'https://127.0.0.1/hooks' },
      defaultDestinationUrl: 'https://93.184.216.34/default',
      database: createDatabase(upsertEvent),
    });

    expect(result).toEqual({
      statusCode: 422,
      body: { error: 'invalid_destination' },
    });
    expect(upsertEvent).not.toHaveBeenCalled();
  });

  it('uses and validates the configured fallback when destination is omitted', async () => {
    const upsertEvent = vi.fn(async (event: WebhookEvent) => ({ event, inserted: true }));
    const result = await handleIngestion({
      authentication,
      body: { idempotency_key: 'fallback-1', payload: null },
      defaultDestinationUrl: 'https://93.184.216.34/configured',
      database: createDatabase(upsertEvent),
    });

    expect(result.statusCode).toBe(202);
    expect(upsertEvent.mock.calls[0]?.[0].destinationUrl).toBe('https://93.184.216.34/configured');
  });

  it('returns a configuration error for an unsafe fallback without writing', async () => {
    const upsertEvent = vi.fn(async (event: WebhookEvent) => ({ event, inserted: true }));
    const result = await handleIngestion({
      authentication,
      body: { idempotency_key: 'fallback-2', payload: null },
      defaultDestinationUrl: 'https://169.254.169.254/latest',
      database: createDatabase(upsertEvent),
    });

    expect(result).toEqual({
      statusCode: 500,
      body: { error: 'invalid_default_destination' },
    });
    expect(upsertEvent).not.toHaveBeenCalled();
  });

  it('returns the stored identity on replay and propagates adapter failures', async () => {
    const acceptedEvent: WebhookEvent = {
      id: 'original-system-id',
      idempotencyKey: 'request-1',
      clientId: 'client-1',
      destinationUrl: 'https://93.184.216.34/original',
      payload: { original: true },
      metadata: {},
      headers: {},
      status: 'delivered',
      attemptCount: 1,
      nextRetryAt: null,
      lockedAt: null,
      lockedBy: null,
      createdAt: '2026-10-21T12:00:00.000Z',
      updatedAt: '2026-10-21T12:00:01.000Z',
    };
    const upsertEvent = vi.fn(async () => ({ event: acceptedEvent, inserted: false }));
    const result = await handleIngestion({
      authentication,
      body: requestBody,
      defaultDestinationUrl: 'https://93.184.216.34/default',
      database: createDatabase(upsertEvent),
    });

    expect(result).toEqual({
      statusCode: 202,
      body: {
        id: 'original-system-id',
        idempotency_key: 'request-1',
        idempotent_replay: true,
        status: 'pending',
      },
    });

    const failure = new Error('database unavailable');
    const failingAdapter = createDatabase(
      vi.fn(async () => {
        throw failure;
      }),
    );
    await expect(
      handleIngestion({
        authentication,
        body: requestBody,
        defaultDestinationUrl: 'https://93.184.216.34/default',
        database: failingAdapter,
      }),
    ).rejects.toBe(failure);
  });
});

describe('handleIngestion with SQLite', () => {
  let directory: string;
  let adapter: SqliteDatabaseAdapter;

  beforeEach(async () => {
    directory = mkdtempSync(join(tmpdir(), 'webhook-ingestion-'));
    adapter = await SqliteDatabaseAdapter.open(join(directory, 'events.db'));
  });

  afterEach(() => {
    adapter.close();
    rmSync(directory, { recursive: true, force: true });
  });

  it('stores one immutable event for 1,000 concurrent duplicate submissions', async () => {
    const secondAdapter = await SqliteDatabaseAdapter.open(join(directory, 'events.db'));
    const resultSets = await Promise.all(
      Array.from({ length: 1000 }, (_, index) =>
        handleIngestion({
          authentication,
          body: {
            idempotency_key: 'concurrent-key',
            payload: { submission: index },
            destination_url: 'https://93.184.216.34/hooks',
          },
          defaultDestinationUrl: 'https://93.184.216.34/default',
          database: index % 2 === 0 ? adapter : secondAdapter,
        }),
      ),
    );
    secondAdapter.close();

    const acceptedResults = resultSets.filter((result) => result.statusCode === 202);
    const ids = new Set(
      acceptedResults.flatMap((result) => (result.statusCode === 202 ? [result.body.id] : [])),
    );
    const replayCount = acceptedResults.filter(
      (result) => result.statusCode === 202 && result.body.idempotent_replay,
    ).length;
    const storedEvent = await adapter.findEventByIdempotencyKey('client-1', 'concurrent-key');

    expect(acceptedResults).toHaveLength(1000);
    expect(ids.size).toBe(1);
    expect(replayCount).toBe(999);
    expect(storedEvent).not.toBeNull();
    expect(storedEvent?.payload).toEqual({ submission: 0 });
  });

  it('keeps idempotency keys isolated by authenticated tenant', async () => {
    const otherTenantResult = await handleIngestion({
      authentication: { authenticated: true, clientId: 'client-2' },
      body: {
        idempotency_key: 'shared-key',
        payload: { tenant: 2 },
        destination_url: 'https://93.184.216.34/hooks',
      },
      defaultDestinationUrl: 'https://93.184.216.34/default',
      database: adapter,
    });
    const originalTenantResult = await handleIngestion({
      authentication,
      body: {
        idempotency_key: 'shared-key',
        payload: { tenant: 1 },
        destination_url: 'https://93.184.216.34/hooks',
      },
      defaultDestinationUrl: 'https://93.184.216.34/default',
      database: adapter,
    });

    expect(otherTenantResult.statusCode).toBe(202);
    expect(originalTenantResult.statusCode).toBe(202);
    await expect(
      adapter.findEventByIdempotencyKey('client-1', 'shared-key'),
    ).resolves.toMatchObject({
      clientId: 'client-1',
      payload: { tenant: 1 },
    });
    await expect(
      adapter.findEventByIdempotencyKey('client-2', 'shared-key'),
    ).resolves.toMatchObject({
      clientId: 'client-2',
      payload: { tenant: 2 },
    });
  });
});
