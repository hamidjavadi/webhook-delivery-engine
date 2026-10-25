import { readFileSync } from 'node:fs';
import https from 'node:https';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { WebhookEvent, Timestamp } from '../../core/types.js';
import { dispatchEvent } from './delivery.dispatcher.js';

const { resolveDestinationMock } = vi.hoisted(() => ({
  resolveDestinationMock: vi.fn(),
}));

vi.mock('../../security/ssrf.js', () => ({
  resolveDestinationForDispatch: resolveDestinationMock,
}));

vi.mock('undici', async () => {
  const actual = await vi.importActual<typeof import('undici')>('undici');
  const certificate = readFileSync(
    new URL('../../../tests/fixtures/consumer-test-cert.pem', import.meta.url),
  );

  return {
    ...actual,
    Agent: class TestAgent extends actual.Agent {
      constructor(options: import('undici').Agent.Options) {
        super({
          ...options,
          connect: {
            ...(typeof options.connect === 'object' ? options.connect : {}),
            ca: certificate,
          },
        });
      }
    },
  };
});

const NOW: Timestamp = '2026-10-24T00:00:00.000Z';
const key = Buffer.from(
  readFileSync(
    new URL('../../../tests/fixtures/consumer-test-key.base64', import.meta.url),
    'utf8',
  ),
  'base64',
);
const cert = readFileSync(
  new URL('../../../tests/fixtures/consumer-test-cert.pem', import.meta.url),
);

function makeEvent(destinationUrl: string): WebhookEvent {
  return {
    id: 'tls-event-1',
    idempotencyKey: 'tls-key-1',
    clientId: 'client-1',
    destinationUrl,
    payload: { test: true },
    metadata: {},
    headers: {},
    status: 'processing',
    attemptCount: 1,
    nextRetryAt: null,
    lockedAt: NOW,
    lockedBy: 'worker-1',
    createdAt: NOW,
    updatedAt: NOW,
  };
}

describe('dispatchEvent connection pinning integration', () => {
  let server: https.Server;
  let serverPort: number;
  const requests: string[] = [];
  const serverNames: (string | undefined)[] = [];

  beforeAll(async () => {
    server = https.createServer({ key, cert }, (request, response) => {
      requests.push(request.url ?? '');
      if (request.url === '/redirect') {
        response.writeHead(302, { location: 'https://untrusted.test/target' }).end();
        return;
      }
      response.writeHead(200).end('tls accepted');
    });
    server.on('secureConnection', (socket) => serverNames.push(socket.servername));
    server.on('tlsClientError', () => undefined);

    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    serverPort = (server.address() as AddressInfo).port;
  });

  afterAll(async () => {
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  });

  beforeEach(() => {
    requests.length = 0;
    serverNames.length = 0;
    resolveDestinationMock.mockClear();
    resolveDestinationMock.mockImplementation(async (value: string) => {
      const url = new URL(value);
      return {
        valid: true,
        url: url.toString(),
        hostname: url.hostname,
        addresses: ['127.0.0.1'],
      };
    });
  });

  it('connects to the vetted address while preserving the URL hostname for SNI and Host', async () => {
    const result = await dispatchEvent({
      event: makeEvent(`https://consumer.test:${serverPort}/hooks`),
      hmacSecret: 'test-secret',
      timeoutLimitMs: 2_000,
    });

    expect(result).toMatchObject({ statusCode: 200, responseSnippet: 'tls accepted', error: null });
    expect(serverNames).toEqual(['consumer.test']);
    expect(requests).toEqual(['/hooks']);
    expect(resolveDestinationMock).toHaveBeenCalledOnce();
  });

  it('sends no HTTP request when the certificate hostname does not match the URL hostname', async () => {
    const result = await dispatchEvent({
      event: makeEvent(`https://wrong.test:${serverPort}/hooks`),
      hmacSecret: 'test-secret',
      timeoutLimitMs: 2_000,
    });

    expect(result).toMatchObject({
      statusCode: null,
      responseSnippet: null,
      error: 'network error',
    });
    expect(requests).toEqual([]);
  });

  it('does not send an HTTP request when the pinned connection cannot be established', async () => {
    resolveDestinationMock.mockImplementation(async (value: string) => {
      const url = new URL(value);
      return {
        valid: true,
        url: url.toString(),
        hostname: url.hostname,
        addresses: ['127.0.0.2'],
      };
    });

    const result = await dispatchEvent({
      event: makeEvent(`https://consumer.test:${serverPort}/hooks`),
      hmacSecret: 'test-secret',
      timeoutLimitMs: 2_000,
    });

    expect(result).toMatchObject({
      statusCode: null,
      responseSnippet: null,
      error: 'network error',
    });
    expect(requests).toEqual([]);
  });

  it('does not follow a redirect to another destination', async () => {
    const result = await dispatchEvent({
      event: makeEvent(`https://consumer.test:${serverPort}/redirect`),
      hmacSecret: 'test-secret',
      timeoutLimitMs: 2_000,
    });

    expect(result).toMatchObject({ statusCode: null, error: 'network error' });
    expect(requests).toEqual(['/redirect']);
    expect(resolveDestinationMock).toHaveBeenCalledOnce();
  });
});
