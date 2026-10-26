import { createServer, type Server } from 'node:http';
import { createHmac } from 'node:crypto';
import type { WebhookEngine, WebhookEvent } from 'webhook-delivery-engine';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createDemoApp } from './app.js';

const servers: Server[] = [];

afterEach(async () => {
  await Promise.all(
    servers
      .splice(0)
      .map((server) => new Promise<void>((resolve) => server.close(() => resolve()))),
  );
});

async function serve(engine: WebhookEngine) {
  const { app } = createDemoApp({
    engine,
    publicOrigin: 'https://demo.example',
    hmacSecret: 'test-only-demo-secret',
  });
  const server = createServer(app);
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('Test server did not bind.');
  return `http://127.0.0.1:${address.port}`;
}

function makeEngine(overrides: Partial<WebhookEngine> = {}): WebhookEngine {
  return {
    start: vi.fn(async () => undefined),
    stop: vi.fn(async () => undefined),
    enqueue: vi.fn(async () => ({
      statusCode: 202 as const,
      body: {
        id: 'event-demo-1',
        idempotency_key: 'demo-key',
        idempotent_replay: false,
        status: 'pending' as const,
      },
    })),
    getEvent: vi.fn(async () => null),
    listEvents: vi.fn(async () => ({ items: [], nextCursor: null })),
    listAttempts: vi.fn(async () => []),
    ...overrides,
  };
}

function makePendingEvent(): WebhookEvent {
  return {
    id: 'event-demo-1',
    idempotencyKey: 'demo-key',
    clientId: 'public-demo',
    destinationUrl: 'https://demo.example/api/mock-sink/success',
    payload: { type: 'demo.success' },
    metadata: {},
    headers: {},
    status: 'pending',
    attemptCount: 0,
    nextRetryAt: null,
    lockedAt: null,
    lockedBy: null,
    createdAt: new Date(0).toISOString(),
    updatedAt: new Date(0).toISOString(),
  };
}

describe('demo HTTP API', () => {
  it('rejects arbitrary destination fields before calling the engine', async () => {
    const engine = makeEngine();
    const origin = await serve(engine);
    const response = await fetch(`${origin}/api/scenarios`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        scenario: 'custom',
        idempotency_key: 'key-1',
        payload: { type: 'invoice.created' },
        destination_url: 'https://attacker.example/collect',
      }),
    });

    expect(response.status).toBe(400);
    expect(engine.enqueue).not.toHaveBeenCalled();
  });

  it('returns an opaque run id and restricts reads to registered runs', async () => {
    const event = makePendingEvent();
    const engine = makeEngine({ getEvent: vi.fn(async () => event) });
    const origin = await serve(engine);
    const created = await fetch(`${origin}/api/scenarios`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ scenario: 'success' }),
    });
    const run = (await created.json()) as { runId: string; eventId: string };
    expect(created.status).toBe(202);
    expect(run.eventId).toBe('event-demo-1');
    expect(run.runId.length).toBeGreaterThanOrEqual(32);

    const found = await fetch(`${origin}/api/scenarios/${run.runId}`);
    const absent = await fetch(`${origin}/api/scenarios/${'a'.repeat(48)}`);
    expect(found.status).toBe(200);
    expect(absent.status).toBe(404);
  });

  it('rejects mock receiver calls without valid engine HMAC headers', async () => {
    const origin = await serve(makeEngine());
    const response = await fetch(`${origin}/api/mock-sink/success`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ demoRunId: 'unknown' }),
    });

    expect(response.status).toBe(401);
  });

  it('records signed receiver headers for the matching demo run', async () => {
    const origin = await serve(makeEngine({ getEvent: vi.fn(async () => makePendingEvent()) }));
    const created = await fetch(`${origin}/api/scenarios`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ scenario: 'success' }),
    });
    const run = (await created.json()) as { runId: string; eventId: string };
    const body = JSON.stringify({
      demoRunId: run.runId,
      type: 'demo.success',
      webhookEventId: run.eventId,
    });
    const timestamp = String(Math.floor(Date.now() / 1000));
    const signature = createHmac('sha256', 'test-only-demo-secret')
      .update(`${timestamp}.${body}`)
      .digest('hex');
    const received = await fetch(`${origin}/api/mock-sink/success`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-webhook-event-id': run.eventId,
        'x-webhook-timestamp': timestamp,
        'x-webhook-signature': `sha256=${signature}`,
      },
      body,
    });
    expect(received.status).toBe(200);

    const status = await fetch(`${origin}/api/scenarios/${run.runId}`);
    const result = (await status.json()) as {
      receiverAttempts: Array<{ signature: string; timestamp: string }>;
    };
    expect(result.receiverAttempts).toMatchObject([
      { signature: `sha256=${signature}`, timestamp },
    ]);
  });
});
