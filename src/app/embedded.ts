import type { EngineConfig } from '../config/engine.config.js';
import type { EventPage, ListEventsInput } from '../core/ports.js';
import type { AttemptRecord, WebhookEvent } from '../core/types.js';
import { createDeliveryWorker } from '../features/delivery/delivery.worker.js';
import type { IngestionRequest } from '../features/ingestion/ingestion.schema.js';
import { handleIngestion } from '../features/ingestion/ingestion.handler.js';
import { ClaimScheduler } from '../features/scheduler/scheduler.js';
import { createApiKeyAuthenticator } from '../security/auth.js';
import { SqliteDatabaseAdapter } from '../storage/sqlite.adapter.js';
import { GracefulShutdown } from './lifecycle.js';

/** Options required to create an embedded webhook engine. */
export interface CreateWebhookEngineOptions {
  /** Persistent SQLite database filename. */
  readonly databasePath: string;
  /** Tenant identity fixed for this engine instance. */
  readonly clientId: string;
  /** Credential retained only by the in-process authenticator. */
  readonly apiKey: string;
  /** HMAC key used to sign outbound requests. */
  readonly hmacSecret: string;
  /** HTTPS destination used when an ingestion request omits destination_url. */
  readonly defaultDestinationUrl: string;
  /** Required polling, timeout, and retry controls. */
  readonly config: EngineConfig;
  /** Receives scheduler and delivery failures; the event is omitted for poll errors. */
  readonly onError?: (error: unknown, event?: WebhookEvent) => void;
}

/** Tenant-scoped programmatic event query. */
export type EngineListEventsInput = Omit<ListEventsInput, 'clientId'>;

/** Embedded engine lifecycle and programmatic API. */
export interface WebhookEngine {
  /** Applies bundled migrations and starts polling. Safe to call repeatedly. */
  start(): Promise<void>;
  /** Stops polling, drains started dispatches, releases queued claims, and closes SQLite. */
  stop(): Promise<void>;
  /** Validates and enqueues an event for the configured tenant. */
  enqueue(input: IngestionRequest): ReturnType<typeof handleIngestion>;
  /** Returns an event by system id or idempotency key within the configured tenant. */
  getEvent(identifier: string): Promise<WebhookEvent | null>;
  /** Returns a tenant-scoped event page. */
  listEvents(input: EngineListEventsInput): Promise<EventPage>;
  /** Returns attempt history for an event owned by the configured tenant. */
  listAttempts(eventId: string): Promise<readonly AttemptRecord[]>;
}

/**
 * Creates the public embedded composition root. It does not bind a listener or
 * register process signals; the host owns both responsibilities.
 */
export function createWebhookEngine(options: CreateWebhookEngineOptions): WebhookEngine {
  validateOptions(options);
  const authenticate = createApiKeyAuthenticator({
    apiKey: options.apiKey,
    clientId: options.clientId,
  });
  let adapter: SqliteDatabaseAdapter | null = null;
  let scheduler: ClaimScheduler | null = null;
  let lifecycle: GracefulShutdown | null = null;
  let deliveryWorker: ReturnType<typeof createDeliveryWorker> | null = null;
  let startPromise: Promise<void> | null = null;
  let stopPromise: Promise<void> | null = null;
  let acceptingDispatches = false;
  let activeWorkers = 0;
  const queuedClaims: WebhookEvent[] = [];
  let state: 'new' | 'starting' | 'running' | 'stopping' | 'stopped' | 'failed' = 'new';

  const requireRunning = () => {
    if (state !== 'running' || adapter === null) {
      throw new Error('Webhook engine must be started and not stopping before use.');
    }
    return adapter;
  };

  return {
    async start() {
      if (state === 'running') return;
      if (state === 'starting') return startPromise!;
      if (state !== 'new') throw new Error(`Webhook engine cannot start from state ${state}.`);
      state = 'starting';
      startPromise = (async () => {
        try {
          const db = await SqliteDatabaseAdapter.open(options.databasePath);
          adapter = db;
          deliveryWorker = createDeliveryWorker({
            adapter: db,
            hmacSecret: options.hmacSecret,
            timeoutLimitMs: options.config.timeoutLimitMs,
            retry: options.config.retry,
            onError: (error, event) => reportError(error, event),
            onDispatchStarted: (event, work) => {
              lifecycle?.trackDispatch(event.id, work);
              const finish = () => {
                activeWorkers -= 1;
                startQueuedClaims();
              };
              void work.then(finish, finish);
            },
          });
          scheduler = new ClaimScheduler(
            db,
            options.config,
            (event) => {
              lifecycle?.trackClaimed(event);
              if (!acceptingDispatches) return;
              queuedClaims.push(event);
              startQueuedClaims();
            },
            (error) => reportError(error),
          );
          lifecycle = new GracefulShutdown(scheduler, db);
          acceptingDispatches = true;
          scheduler.start();
          state = 'running';
        } catch (error) {
          adapter?.close();
          adapter = null;
          state = 'failed';
          throw error;
        }
      })();
      return startPromise;
    },
    async stop() {
      if (state === 'stopped') return;
      if (state === 'stopping') return stopPromise!;
      if (state === 'new' || state === 'failed') {
        state = 'stopped';
        return;
      }
      if (state === 'starting') await startPromise;
      state = 'stopping';
      acceptingDispatches = false;
      stopPromise = (async () => {
        try {
          await lifecycle?.shutdown();
        } finally {
          adapter?.close();
          adapter = null;
          state = 'stopped';
        }
      })();
      return stopPromise;
    },
    async enqueue(input) {
      const db = requireRunning();
      return handleIngestion({
        authentication: authenticate(options.apiKey),
        body: input,
        defaultDestinationUrl: options.defaultDestinationUrl,
        database: db,
      });
    },
    async getEvent(identifier) {
      const db = requireRunning();
      return (
        (await db.findEventById(identifier, options.clientId)) ??
        db.findEventByIdempotencyKey(options.clientId, identifier)
      );
    },
    async listEvents(input) {
      const db = requireRunning();
      return db.listEvents({ ...input, clientId: options.clientId });
    },
    async listAttempts(eventId) {
      const db = requireRunning();
      const event = await db.findEventById(eventId, options.clientId);
      return event === null ? [] : db.listAttempts(event.id, options.clientId);
    },
  };

  function startQueuedClaims(): void {
    while (
      acceptingDispatches &&
      activeWorkers < options.config.concurrency.workerCount &&
      queuedClaims.length > 0
    ) {
      const event = queuedClaims.shift()!;
      activeWorkers += 1;
      deliveryWorker?.(event);
    }
  }

  function reportError(error: unknown, event?: WebhookEvent): void {
    if (options.onError !== undefined) {
      options.onError(error, event);
      return;
    }
    const eventLabel = event === undefined ? '' : ` for event ${event.id}`;
    process.emitWarning(
      `Webhook engine processing error${eventLabel}: ${error instanceof Error ? error.message : String(error)}`,
      { code: 'WEBHOOK_ENGINE_ERROR' },
    );
  }
}

function validateOptions(options: CreateWebhookEngineOptions): void {
  for (const [name, value] of Object.entries({
    databasePath: options.databasePath,
    clientId: options.clientId,
    apiKey: options.apiKey,
    hmacSecret: options.hmacSecret,
    defaultDestinationUrl: options.defaultDestinationUrl,
  })) {
    if (typeof value !== 'string' || value.trim().length === 0) {
      throw new TypeError(`${name} must be a non-empty string.`);
    }
  }
  const { concurrency, timeoutLimitMs, retry } = options.config;
  const positive = [
    concurrency.workerCount,
    concurrency.batchSize,
    concurrency.pollIntervalMs,
    timeoutLimitMs,
    retry.maxAttempts,
    retry.baseDelayMs,
    retry.maxDelayMs,
  ];
  if (!positive.every((value) => Number.isSafeInteger(value) && value > 0)) {
    throw new RangeError('Engine configuration values must be positive safe integers.');
  }
  if (retry.maxDelayMs < retry.baseDelayMs) {
    throw new RangeError('retry.maxDelayMs must be greater than or equal to retry.baseDelayMs.');
  }
}
