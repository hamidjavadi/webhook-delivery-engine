import { randomBytes } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import ngrok, { type Listener } from '@ngrok/ngrok';
import express, { type Express, type RequestHandler } from 'express';
import { createWebhookEngine } from 'webhook-delivery-engine';
import type { ViteDevServer } from 'vite';
import { createDemoApp } from './app.js';

const moduleDirectory = dirname(fileURLToPath(import.meta.url));

export async function main(): Promise<void> {
  let tunnel: Listener | undefined;
  let engine: ReturnType<typeof createWebhookEngine> | undefined;
  let engineStarted = false;
  let vite: ViteDevServer | undefined;
  let server: Server | undefined;

  try {
    const port = parsePort(process.env.PORT ?? '3000');
    if (process.env.DEMO_USE_NGROK === 'true') {
      if (process.env.NGROK_AUTHTOKEN === undefined || process.env.NGROK_AUTHTOKEN.length === 0) {
        throw new Error(
          'Set NGROK_AUTHTOKEN in examples/demo/.env before running pnpm dev:tunnel.',
        );
      }
      tunnel = await ngrok.forward({ addr: `localhost:${port}`, authtoken_from_env: true });
      process.stdout.write(`ngrok tunnel: ${tunnel.url()}\n`);
    }

    const publicOrigin =
      tunnel?.url() ?? process.env.DEMO_PUBLIC_ORIGIN ?? process.env.RENDER_EXTERNAL_URL;
    if (publicOrigin === undefined || publicOrigin.length === 0) {
      throw new Error('Set DEMO_PUBLIC_ORIGIN to the public HTTPS origin of this demo service.');
    }

    const databasePath =
      process.env.DEMO_SQLITE_PATH ?? '/tmp/webhook-delivery-engine-demo/demo.sqlite';
    mkdirSync(dirname(databasePath), { recursive: true });
    const hmacSecret = process.env.DEMO_HMAC_SECRET ?? randomBytes(32).toString('hex');
    engine = createWebhookEngine({
      databasePath,
      clientId: 'public-hosted-demo',
      hmacSecret,
      defaultDestinationUrl: new URL('/api/mock-sink/success', publicOrigin).toString(),
      logLevel: 'warn',
      config: {
        concurrency: { workerCount: 2, batchSize: 10, pollIntervalMs: 100 },
        timeoutLimitMs: 5_000,
        retry: { maxAttempts: 3, baseDelayMs: 500, maxDelayMs: 1_000 },
      },
    });

    await engine.start();
    engineStarted = true;
    const attachFrontend = await createFrontend(moduleDirectory, publicOrigin);
    vite = attachFrontend.vite;
    const { app } = createDemoApp({
      engine,
      publicOrigin,
      hmacSecret,
      attachFrontend: attachFrontend.attach,
    });
    server = createServer(app);
    await new Promise<void>((resolveListen, rejectListen) => {
      server?.once('error', rejectListen);
      server?.listen(port, '0.0.0.0', resolveListen);
    });

    let stopping: Promise<void> | undefined;
    const shutdown = () => {
      stopping ??= (async () => {
        await new Promise<void>((resolveClose, rejectClose) => {
          server?.close((error) => (error === undefined ? resolveClose() : rejectClose(error)));
        });
        await engine?.stop();
        await vite?.close();
        await tunnel?.close();
      })();
      return stopping;
    };
    const onSigterm = () => void shutdown().catch(() => (process.exitCode = 1));
    const onSigint = () => void shutdown().catch(() => (process.exitCode = 1));
    process.once('SIGTERM', onSigterm);
    process.once('SIGINT', onSigint);
  } catch (error) {
    if (server?.listening) {
      await new Promise<void>((resolveClose) => server?.close(() => resolveClose()));
    }
    if (engineStarted) await engine?.stop();
    await vite?.close();
    await tunnel?.close();
    throw error;
  }
}

export async function createFrontend(
  directory: string,
  publicOrigin: string,
): Promise<{
  readonly attach: (app: Express) => void;
  readonly vite?: ViteDevServer;
}> {
  if (process.env.NODE_ENV === 'production') {
    const publicDirectory = join(directory, 'public');
    const indexFile = join(publicDirectory, 'index.html');
    return {
      attach(app) {
        app.use(express.static(publicDirectory, { index: 'index.html', fallthrough: true }));
        app.get('/{*path}', (request, response, next) => {
          if (!request.accepts('html')) return next();
          return response.sendFile(indexFile);
        });
      },
    };
  }

  const vite = await import('vite').then(({ createServer }) =>
    createServer({
      configFile: resolve(directory, '../vite.config.ts'),
      server: {
        middlewareMode: true,
        allowedHosts: [new URL(publicOrigin).hostname],
      },
      appType: 'custom',
    }),
  );
  const indexPath = resolve(directory, '../index.html');
  return {
    vite,
    attach(app) {
      app.use(vite.middlewares as RequestHandler);
      app.get('/{*path}', async (request, response, next) => {
        if (!request.accepts('html')) return next();
        try {
          const { readFile } = await import('node:fs/promises');
          const source = await readFile(indexPath, 'utf8');
          const html = await vite.transformIndexHtml(request.originalUrl, source);
          return response.status(200).type('html').send(html);
        } catch (error) {
          return next(error);
        }
      });
    },
  };
}

export function parsePort(value: string): number {
  const port = Number(value);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new RangeError('PORT must be a valid TCP port number.');
  }
  return port;
}

const isDirectExecution =
  process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isDirectExecution) {
  void main().catch((error: unknown) => {
    const message = error instanceof Error ? error.message : 'Unknown startup error.';
    process.stderr.write(`Hosted demo failed to start: ${message}\n`);
    process.exitCode = 1;
  });
}
