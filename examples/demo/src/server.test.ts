import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import express from 'express';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createFrontend, main, parsePort } from './server.js';

const mocks = vi.hoisted(() => {
  const engine = {
    start: vi.fn(async () => undefined),
    stop: vi.fn(async () => undefined),
    enqueue: vi.fn(async () => ({
      statusCode: 202 as const,
      body: {
        id: 'event-1',
        idempotency_key: 'key-1',
        idempotent_replay: false,
        status: 'pending' as const,
      },
    })),
    getEvent: vi.fn(async () => null),
    listEvents: vi.fn(async () => ({ items: [], nextCursor: null })),
    listAttempts: vi.fn(async () => []),
  };
  return { engine, createEngine: vi.fn(() => engine) };
});

vi.mock('webhook-delivery-engine', () => ({ createWebhookEngine: mocks.createEngine }));

const envKeys = [
  'PORT',
  'NODE_ENV',
  'DEMO_USE_NGROK',
  'NGROK_AUTHTOKEN',
  'DEMO_PUBLIC_ORIGIN',
  'RENDER_EXTERNAL_URL',
  'DEMO_SQLITE_PATH',
  'DEMO_HMAC_SECRET',
] as const;
const originalEnv = new Map(envKeys.map((key) => [key, process.env[key]]));
const servers: Server[] = [];
let tempDirectory: string | undefined;
let shutdownHandler: (() => void) | undefined;

afterEach(async () => {
  shutdownHandler?.();
  shutdownHandler = undefined;
  await new Promise((resolveClose) => setTimeout(resolveClose, 10));
  await Promise.all(
    servers
      .splice(0)
      .map((server) => new Promise<void>((resolveClose) => server.close(() => resolveClose()))),
  );
  if (tempDirectory !== undefined) await rm(tempDirectory, { recursive: true, force: true });
  tempDirectory = undefined;
  for (const key of envKeys) {
    const value = originalEnv.get(key);
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  vi.clearAllMocks();
});

describe('demo server entrypoint', () => {
  it('accepts valid ports and rejects values outside the TCP range', () => {
    expect(parsePort('3000')).toBe(3000);
    expect(() => parsePort('0')).toThrow('PORT must be a valid TCP port number.');
    expect(() => parsePort('65536')).toThrow('PORT must be a valid TCP port number.');
    expect(() => parsePort('not-a-port')).toThrow('PORT must be a valid TCP port number.');
  });

  it('serves production assets and the SPA fallback from the configured directory', async () => {
    process.env.NODE_ENV = 'production';
    tempDirectory = await mkdtemp(join(tmpdir(), 'demo-frontend-'));
    const publicDirectory = join(tempDirectory, 'public');
    await mkdir(publicDirectory);
    await writeFile(join(publicDirectory, 'index.html'), '<main>demo fixture</main>');
    const frontend = await createFrontend(tempDirectory, 'https://demo.example');
    const app = express();
    frontend.attach(app);
    app.use((_request, response) => response.sendStatus(404));
    const server = createServer(app);
    servers.push(server);
    await new Promise<void>((resolveListen) => server.listen(0, '127.0.0.1', resolveListen));
    const port = (server.address() as AddressInfo).port;

    const index = await fetch(`http://127.0.0.1:${port}/`);
    const fallback = await fetch(`http://127.0.0.1:${port}/scenario/run-1`);
    const nonHtml = await fetch(`http://127.0.0.1:${port}/not-found`, {
      headers: { accept: 'application/json' },
    });

    expect(await index.text()).toContain('demo fixture');
    expect(await fallback.text()).toContain('demo fixture');
    expect(nonHtml.status).toBe(404);
  });

  it('rejects startup when public origin is missing before creating the engine', async () => {
    delete process.env.DEMO_PUBLIC_ORIGIN;
    delete process.env.RENDER_EXTERNAL_URL;
    delete process.env.DEMO_USE_NGROK;

    await expect(main()).rejects.toThrow(
      'Set DEMO_PUBLIC_ORIGIN to the public HTTPS origin of this demo service.',
    );
    expect(mocks.createEngine).not.toHaveBeenCalled();
  });

  it.each([undefined, ''])(
    'requires an ngrok token when tunnel mode is enabled (%s)',
    async (token) => {
      process.env.DEMO_USE_NGROK = 'true';
      process.env.DEMO_PUBLIC_ORIGIN = 'https://demo.example';
      if (token === undefined) delete process.env.NGROK_AUTHTOKEN;
      else process.env.NGROK_AUTHTOKEN = token;

      await expect(main()).rejects.toThrow(
        'Set NGROK_AUTHTOKEN in examples/demo/.env before running pnpm dev:tunnel.',
      );
      expect(mocks.createEngine).not.toHaveBeenCalled();
    },
  );

  it('starts the hosted app and drains the engine on SIGTERM', async () => {
    process.env.NODE_ENV = 'production';
    process.env.PORT = '0';
    const tempDirectoryForDb = await mkdtemp(join(tmpdir(), 'demo-server-'));
    tempDirectory = tempDirectoryForDb;
    process.env.DEMO_SQLITE_PATH = join(tempDirectoryForDb, 'demo.sqlite');
    delete process.env.DEMO_PUBLIC_ORIGIN;
    process.env.RENDER_EXTERNAL_URL = 'https://demo.example';
    process.env.DEMO_HMAC_SECRET = 'test-only-demo-secret';
    const portProbe = createServer();
    await new Promise<void>((resolveListen) => portProbe.listen(0, '127.0.0.1', resolveListen));
    const port = (portProbe.address() as AddressInfo).port;
    await new Promise<void>((resolveClose) => portProbe.close(() => resolveClose()));
    process.env.PORT = String(port);
    const priorSigtermHandlers = new Set(process.listeners('SIGTERM'));

    await main();
    shutdownHandler = process
      .listeners('SIGTERM')
      .find((listener) => !priorSigtermHandlers.has(listener)) as (() => void) | undefined;
    expect(shutdownHandler).toBeDefined();
    const health = await fetch(`http://127.0.0.1:${port}/api/health`);
    expect(await health.json()).toEqual({ status: 'ready' });

    shutdownHandler?.();
    await vi.waitFor(() => expect(mocks.engine.stop).toHaveBeenCalledOnce());
    expect(mocks.engine.start).toHaveBeenCalledOnce();
    expect(mocks.createEngine).toHaveBeenCalledWith(
      expect.objectContaining({
        databasePath: join(tempDirectoryForDb, 'demo.sqlite'),
        clientId: 'public-hosted-demo',
      }),
    );
  });
});
