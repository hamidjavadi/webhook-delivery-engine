import { randomUUID } from 'node:crypto';
import { request as httpRequest } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { afterEach, describe, expect, it } from 'vitest';
import type { WebhookEvent } from '../core/types.js';
import { handleQueryRoute } from '../features/query/query.routes.js';
import { createApiKeyAuthenticator } from '../security/auth.js';
import { SqliteDatabaseAdapter } from '../storage/sqlite.adapter.js';
import { createWebhookHttpServer } from './http.server.js';

describe('webhook HTTP API', () => {
  let directory: string | undefined;
  let database: SqliteDatabaseAdapter | undefined;
  let server: Server | undefined;
  let baseUrl: string | undefined;

  afterEach(async () => {
    if (server?.listening) {
      await new Promise<void>((resolve, reject) =>
        server?.close((error) => (error ? reject(error) : resolve())),
      );
    }
    server = undefined;
    baseUrl = undefined;
    database?.close();
    database = undefined;
    if (directory !== undefined) {
      rmSync(directory, { recursive: true, force: true });
      directory = undefined;
    }
  });

  async function startServer(
    authenticate = createApiKeyAuthenticator({ apiKey: 'test-key', clientId: 'tenant-a' }),
  ): Promise<void> {
    directory = mkdtempSync(join(tmpdir(), 'webhook-http-'));
    database = await SqliteDatabaseAdapter.open(join(directory, 'events.db'));
    server = createWebhookHttpServer({
      database,
      authenticate,
      defaultDestinationUrl: 'https://8.8.8.8/hooks',
    });
    await new Promise<void>((resolve) => server?.listen(0, '127.0.0.1', resolve));
    const address = server.address() as AddressInfo;
    baseUrl = `http://127.0.0.1:${address.port}`;
  }

  function authHeaders(): HeadersInit {
    return { authorization: 'Bearer test-key' };
  }

  function makeEvent(clientId: string, idempotencyKey: string): WebhookEvent {
    const now = new Date().toISOString();
    return {
      id: randomUUID(),
      idempotencyKey,
      clientId,
      destinationUrl: 'https://8.8.8.8/hooks',
      payload: { ok: true },
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

  it('requires authentication, accepts x-api-key, and prefers malformed authorization', async () => {
    await startServer();

    const response = await fetch(`${baseUrl}/webhooks`, { method: 'POST' });
    const apiKeyResponse = await fetch(`${baseUrl}/webhooks`, {
      headers: { 'x-api-key': 'test-key' },
    });

    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ error: 'unauthorized' });
    expect(apiKeyResponse.status).toBe(200);
    const malformedAuthorization = await fetch(`${baseUrl}/webhooks`, {
      headers: { authorization: 'Basic invalid', 'x-api-key': 'test-key' },
    });
    expect(malformedAuthorization.status).toBe(401);
  });

  it('ingests an event and reads it by both system id and idempotency key', async () => {
    await startServer();

    const accepted = await fetch(`${baseUrl}/webhooks`, {
      method: 'POST',
      headers: { ...authHeaders(), 'content-type': 'application/json' },
      body: JSON.stringify({ idempotency_key: 'order-1', payload: { order: 1 } }),
    });
    const acknowledgment = await accepted.json();

    expect(accepted.status).toBe(202);
    expect(acknowledgment).toMatchObject({
      idempotency_key: 'order-1',
      idempotent_replay: false,
      status: 'pending',
    });
    const byId = await fetch(`${baseUrl}/webhooks/${acknowledgment.id}`, {
      headers: authHeaders(),
    });
    const byKey = await fetch(`${baseUrl}/webhooks/order-1`, { headers: authHeaders() });
    expect(byId.status).toBe(200);
    expect(byKey.status).toBe(200);
    expect(await byKey.json()).toMatchObject({ id: acknowledgment.id, client_id: 'tenant-a' });
  });

  it('lists only the authenticated tenant and returns attempts for an owned event', async () => {
    await startServer();
    const owned = makeEvent('tenant-a', 'owned');
    const secondEvent = makeEvent('tenant-a', 'second-owned');
    const laterTimestamp = new Date(Date.now() + 1000).toISOString();
    const secondOwned = {
      ...secondEvent,
      createdAt: laterTimestamp,
      updatedAt: laterTimestamp,
    };
    const foreignEvent = makeEvent('tenant-b', 'foreign');
    const foreignTimestamp = new Date(Date.now() + 2000).toISOString();
    const foreign = {
      ...foreignEvent,
      createdAt: foreignTimestamp,
      updatedAt: foreignTimestamp,
    };
    await database?.upsertEvent(owned);
    await database?.upsertEvent(secondOwned);
    await database?.upsertEvent(foreign);

    const list = await fetch(`${baseUrl}/webhooks?status=pending&limit=1`, {
      headers: authHeaders(),
    });
    const page = await list.json();

    expect(list.status).toBe(200);
    expect(page.items).toHaveLength(1);
    expect(page.items[0].id).toBe(owned.id);
    expect(page.next_cursor).toEqual(expect.any(String));
    const nextPageResponse = await fetch(
      `${baseUrl}/webhooks?status=pending&limit=1&cursor=${encodeURIComponent(page.next_cursor)}`,
      { headers: authHeaders() },
    );
    expect((await nextPageResponse.json()).items[0].id).toBe(secondOwned.id);

    const [claimed] = await database!.claimDueEvents({
      workerId: 'test-worker',
      now: new Date().toISOString(),
      limit: 1,
    });
    expect(claimed).toBeDefined();
    await database!.recordAttemptAndTransition({
      attempt: {
        id: randomUUID(),
        eventId: owned.id,
        attemptNumber: 1,
        attemptedAt: new Date().toISOString(),
        statusCode: 204,
        responseSnippet: null,
        error: null,
        latencyMs: 3,
        outcome: 'success',
      },
      workerId: 'test-worker',
      nextStatus: 'delivered',
      nextRetryAt: null,
      updatedAt: new Date().toISOString(),
    });
    const history = await fetch(`${baseUrl}/webhooks/${owned.id}/attempts`, {
      headers: authHeaders(),
    });
    expect(history.status).toBe(200);
    expect(await history.json()).toMatchObject({
      items: [{ event_id: owned.id, attempt_number: 1, status_code: 204, outcome: 'success' }],
    });
  });

  it('returns the same not-found response for another tenant and an unknown id', async () => {
    await startServer();
    const foreign = makeEvent('tenant-b', 'foreign');
    await database?.upsertEvent(foreign);

    const foreignResponse = await fetch(`${baseUrl}/webhooks/${foreign.id}`, {
      headers: authHeaders(),
    });
    const unknownResponse = await fetch(`${baseUrl}/webhooks/not-present`, {
      headers: authHeaders(),
    });

    expect(foreignResponse.status).toBe(404);
    expect(await foreignResponse.json()).toEqual({ error: 'not_found' });
    expect(unknownResponse.status).toBe(404);
    expect(await unknownResponse.json()).toEqual({ error: 'not_found' });
  });

  it('returns generic errors for unsupported methods, routes, and encoded identifiers', async () => {
    await startServer();

    const unsupported = await fetch(`${baseUrl}/webhooks`, {
      method: 'DELETE',
      headers: authHeaders(),
    });
    const unknownRoute = await fetch(`${baseUrl}/webhooks/a/unknown`, {
      headers: authHeaders(),
    });
    const malformedIdentifier = await fetch(`${baseUrl}/webhooks/%`, {
      headers: authHeaders(),
    });
    const emptyIdentifier = await fetch(`${baseUrl}/webhooks/`, { headers: authHeaders() });
    const tooManySegments = await fetch(`${baseUrl}/webhooks/a/b/c`, {
      headers: authHeaders(),
    });
    const unknownPath = await fetch(`${baseUrl}/elsewhere`, { headers: authHeaders() });

    expect(unsupported.status).toBe(405);
    expect(await unsupported.json()).toEqual({ error: 'method_not_allowed' });
    expect(unknownRoute.status).toBe(404);
    expect(await unknownRoute.json()).toEqual({ error: 'not_found' });
    expect(malformedIdentifier.status).toBe(400);
    expect(await malformedIdentifier.json()).toEqual({ error: 'invalid_request' });
    expect(emptyIdentifier.status).toBe(404);
    expect(tooManySegments.status).toBe(404);
    expect(unknownPath.status).toBe(404);
  });

  it('rejects malformed requests and invalid list filters with generic errors', async () => {
    await startServer();

    const malformed = await fetch(`${baseUrl}/webhooks`, {
      method: 'POST',
      headers: { ...authHeaders(), 'content-type': 'application/json' },
      body: '{',
    });
    const invalidFilter = await fetch(`${baseUrl}/webhooks?status=unknown`, {
      headers: authHeaders(),
    });
    const invalidLimit = await fetch(`${baseUrl}/webhooks?limit=1001`, {
      headers: authHeaders(),
    });
    const duplicateFilter = await fetch(`${baseUrl}/webhooks?status=pending&status=retry`, {
      headers: authHeaders(),
    });
    const invalidCursor = await fetch(`${baseUrl}/webhooks?cursor=not-a-cursor`, {
      headers: authHeaders(),
    });

    expect(malformed.status).toBe(400);
    expect(await malformed.json()).toEqual({ error: 'invalid_request' });
    expect(invalidFilter.status).toBe(400);
    expect(await invalidFilter.json()).toEqual({ error: 'invalid_request' });
    expect(invalidLimit.status).toBe(400);
    expect(await invalidLimit.json()).toEqual({ error: 'invalid_request' });
    expect(duplicateFilter.status).toBe(400);
    expect(await duplicateFilter.json()).toEqual({ error: 'invalid_request' });
    expect(invalidCursor.status).toBe(400);
    expect(await invalidCursor.json()).toEqual({ error: 'invalid_request' });
  });

  it('maps database failures to a generic service unavailable response', async () => {
    await startServer();
    database?.close();
    database = undefined;

    const readFailure = await fetch(`${baseUrl}/webhooks`, { headers: authHeaders() });
    const detailFailure = await fetch(`${baseUrl}/webhooks/unknown`, { headers: authHeaders() });
    const writeFailure = await fetch(`${baseUrl}/webhooks`, {
      method: 'POST',
      headers: { ...authHeaders(), 'content-type': 'application/json' },
      body: JSON.stringify({ idempotency_key: 'order-fail', payload: { order: 1 } }),
    });

    expect(readFailure.status).toBe(503);
    expect(await readFailure.json()).toEqual({ error: 'service_unavailable' });
    expect(detailFailure.status).toBe(503);
    expect(await detailFailure.json()).toEqual({ error: 'service_unavailable' });
    expect(writeFailure.status).toBe(503);
    expect(await writeFailure.json()).toEqual({ error: 'service_unavailable' });
  });

  it('maps unexpected authentication failures to a generic 503 response', async () => {
    await startServer(() => {
      throw new Error('private auth detail');
    });

    const response = await fetch(`${baseUrl}/webhooks`, { headers: authHeaders() });

    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ error: 'service_unavailable' });
  });

  it('closes a response if an unexpected error occurs after headers are sent', async () => {
    await startServer();
    database!.listEvents = async () => ({
      items: [],
      nextCursor: {
        toJSON() {
          throw new Error('private serialization detail');
        },
      } as unknown as string,
    });

    await expect(fetch(`${baseUrl}/webhooks`, { headers: authHeaders() })).rejects.toThrow();
  });

  it('returns unauthorized when a query route receives a failed auth result directly', async () => {
    await startServer();
    const captured: { statusCode: number; body: string } = { statusCode: 0, body: '' };
    const response = {
      writeHead(statusCode: number) {
        captured.statusCode = statusCode;
        return this;
      },
      end(body: string) {
        captured.body = body;
        return this;
      },
    } as unknown as import('node:http').ServerResponse;

    await handleQueryRoute({
      response,
      url: new URL('http://localhost/webhooks'),
      authentication: { authenticated: false, statusCode: 401 },
      database: database!,
    });

    expect(captured.statusCode).toBe(401);
    expect(JSON.parse(captured.body)).toEqual({ error: 'unauthorized' });
  });

  it('rejects an invalid request target before routing the request', async () => {
    await startServer();
    const address = server?.address() as AddressInfo;

    const response = await new Promise<{ statusCode: number; body: string }>((resolve, reject) => {
      const req = httpRequest(
        {
          hostname: '127.0.0.1',
          port: address.port,
          path: 'http://[',
        },
        (res) => {
          let body = '';
          res.setEncoding('utf8');
          res.on('data', (chunk: string) => (body += chunk));
          res.on('end', () => resolve({ statusCode: res.statusCode ?? 0, body }));
        },
      );
      req.on('error', reject);
      req.end();
    });

    expect(response.statusCode).toBe(400);
    expect(JSON.parse(response.body)).toEqual({ error: 'invalid_request' });
  });
});
