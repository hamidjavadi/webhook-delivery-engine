import { Buffer } from 'node:buffer';
import { randomBytes, randomUUID } from 'node:crypto';
import express, { type Express, type Request, type Response } from 'express';
import type {
  AttemptRecord,
  IngestionRequest,
  WebhookEngine,
  WebhookEvent,
} from 'webhook-delivery-engine';
import {
  getScenarioDestination,
  parseScenarioRequest,
  type DemoScenarioId,
} from './scenarios.js';
import { verifySignature } from './signature.js';

const MAX_BODY_BYTES = 16 * 1024;
const MAX_RUNS = 200;
const RATE_WINDOW_MS = 60_000;
const RATE_LIMIT = 30;
interface RunRecord {
  readonly runId: string;
  readonly scenario: DemoScenarioId;
  readonly createdAt: string;
  readonly idempotencyKey: string;
  eventId: string | null;
  rejection: string | null;
  state: 'ingesting' | 'accepted' | 'rejected';
  readonly payload: IngestionRequest['payload'];
  readonly observedAttempts: SinkObservation[];
}

interface SinkObservation {
  readonly attemptNumber: number;
  readonly receivedAt: string;
  readonly timestamp: string;
  readonly signature: string;
  readonly eventId: string;
  readonly contentBytes: number;
  readonly rawBody: Buffer;
}

export interface DemoAppOptions {
  readonly engine: Pick<WebhookEngine, 'enqueue' | 'getEvent' | 'listAttempts'>;
  readonly publicOrigin: string;
  readonly hmacSecret: string;
  readonly now?: () => number;
  readonly attachFrontend?: (app: Express) => void;
}

export function createDemoApp(options: DemoAppOptions): { readonly app: Express } {
  getScenarioDestination('success', options.publicOrigin);
  const app = express();
  const now = options.now ?? Date.now;
  const runs = new Map<string, RunRecord>();
  const receiverAttempts = new Map<string, number>();
  const requestTimes = new Map<string, number[]>();
  let requestCount = 0;

  const rejectRequest = (response: Response, message = 'Invalid demo request.') =>
    response.status(400).json({ error: message });

  app.disable('x-powered-by');

  app.get('/api/health', (_request, response) => {
    response.status(200).json({ status: 'ready' });
  });

  app.post(
    '/api/mock-sink/:scenario',
    express.raw({ type: 'application/json', limit: MAX_BODY_BYTES }),
    (request, response) => {
      const body = Buffer.isBuffer(request.body) ? request.body : null;
      if (body === null) return rejectRequest(response);

      const timestamp = request.header('x-webhook-timestamp');
      const signature = request.header('x-webhook-signature');
      const eventId = request.header('x-webhook-event-id');
      if (
        timestamp === undefined ||
        signature === undefined ||
        eventId === undefined ||
        !verifySignature(body, timestamp, signature, options.hmacSecret, now())
      ) {
        return response.status(401).json({ error: 'invalid_signature' });
      }

      let parsed: unknown;
      try {
        parsed = JSON.parse(body.toString('utf8')) as unknown;
      } catch {
        return rejectRequest(response);
      }
      if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
        return rejectRequest(response);
      }
      const payload = parsed as Record<string, unknown>;
      const runId = payload.demoRunId;
      const run = typeof runId === 'string' ? runs.get(runId) : undefined;
      const scenario = request.params.scenario;
      if (
        run === undefined ||
        run.scenario !== scenario ||
        (run.eventId !== null && run.eventId !== eventId) ||
        payload.webhookEventId !== eventId
      ) {
        return response.status(401).json({ error: 'unknown_run' });
      }
      run.eventId ??= eventId;

      const attemptNumber = (receiverAttempts.get(run.runId) ?? 0) + 1;
      receiverAttempts.set(run.runId, attemptNumber);
      run.observedAttempts.push({
        attemptNumber,
        receivedAt: new Date(now()).toISOString(),
        timestamp,
        signature,
        eventId,
        contentBytes: body.byteLength,
        rawBody: Buffer.from(body),
      });

      switch (run.scenario) {
        case 'retry-recovery':
          return response
            .status(attemptNumber === 1 ? 503 : 200)
            .json({ outcome: attemptNumber === 1 ? 'retry' : 'delivered' });
        case 'terminal-401':
          return response.status(401).json({ outcome: 'rejected' });
        case 'max-retries':
          return response.status(503).json({ outcome: 'retry' });
        case 'ssrf-rejection':
          return response.status(400).json({ outcome: 'unexpected_receiver_call' });
        case 'success':
        case 'custom':
          return response.status(200).json({ outcome: 'delivered' });
      }
    },
  );

  app.use(express.json({ limit: MAX_BODY_BYTES, strict: true, type: 'application/json' }));

  app.post('/api/scenarios', (request, response) => {
    if (requestCount >= MAX_RUNS) {
      return response.status(503).json({ error: 'demo_capacity_reached' });
    }

    const remote = request.socket.remoteAddress ?? 'unknown';
    if (!allowRequest(remote, requestTimes, now())) {
      return response.status(429).json({ error: 'rate_limited' });
    }

    let parsedRequest;
    try {
      parsedRequest = parseScenarioRequest(request.body);
    } catch {
      return rejectRequest(response);
    }

    const runId = randomBytes(24).toString('base64url');
    const createdAt = new Date(now()).toISOString();
    requestCount += 1;
    const idempotencyKey =
      parsedRequest.scenario === 'custom'
        ? parsedRequest.idempotency_key
        : `demo-${randomUUID()}`;
    const payload =
      parsedRequest.scenario === 'custom'
        ? asDemoPayload(parsedRequest.payload, runId)
        : { type: `demo.${parsedRequest.scenario}`, demoRunId: runId };
    const destinationUrl = getScenarioDestination(parsedRequest.scenario, options.publicOrigin);
    const run: RunRecord = {
      runId,
      scenario: parsedRequest.scenario,
      createdAt,
      idempotencyKey,
      eventId: null,
      rejection: null,
      state: 'ingesting',
      payload,
      observedAttempts: [],
    };
    runs.set(runId, run);

    return void options.engine
      .enqueue({
        idempotency_key: idempotencyKey,
        payload,
        destination_url: destinationUrl,
      })
      .then((result) => {
        if (result.statusCode === 202) {
          if (result.body.idempotent_replay) {
            runs.delete(runId);
            return response.status(409).json({ error: 'idempotency_key_already_used' });
          }
          run.eventId = result.body.id;
          run.state = 'accepted';
          return response.status(202).json({
            runId,
            eventId: result.body.id,
            accepted: true,
            idempotencyKey,
          });
        }

        run.rejection = result.body.error;
        run.state = 'rejected';
        return response.status(result.statusCode).json({
          runId,
          eventId: null,
          accepted: false,
          status: 'rejected',
          reason: result.body.error,
          idempotencyKey,
        });
      })
      .catch(() => response.status(503).json({ error: 'engine_unavailable' }));
  });

  app.get('/api/scenarios/:runId', async (request, response) => {
    const run = runs.get(request.params.runId);
    if (run === undefined) return response.status(404).json({ error: 'not_found' });

    if (run.state === 'rejected') {
      return response.json({
        runId: run.runId,
        scenario: run.scenario,
        createdAt: run.createdAt,
        status: 'rejected',
        reason: run.rejection,
        payload: run.payload,
        attempts: [],
        idempotencyKey: run.idempotencyKey,
        receiverAttempts: toPublicReceiverAttempts(run),
      });
    }

    if (run.eventId === null) {
      return response.status(202).json({
        runId: run.runId,
        scenario: run.scenario,
        createdAt: run.createdAt,
        status: 'ingesting',
        payload: run.payload,
        attempts: [],
        idempotencyKey: run.idempotencyKey,
        receiverAttempts: toPublicReceiverAttempts(run),
      });
    }

    try {
      const event = await options.engine.getEvent(run.eventId);
      if (event === null) return response.status(404).json({ error: 'not_found' });
      const attempts = await options.engine.listAttempts(event.id);
      return response.json(toPublicRun(run, event, attempts));
    } catch {
      return response.status(503).json({ error: 'engine_unavailable' });
    }
  });

  app.post('/api/scenarios/:runId/receiver-attempts/:attemptNumber/verify', (request, response) => {
    const remote = request.socket.remoteAddress ?? 'unknown';
    if (!allowRequest(remote, requestTimes, now())) {
      return response.status(429).json({ error: 'rate_limited' });
    }

    const attemptText = request.params.attemptNumber;
    const attemptNumber = Number(attemptText);
    if (!/^\d+$/u.test(attemptText) || !Number.isSafeInteger(attemptNumber) || attemptNumber < 1) {
      return rejectRequest(response, 'Invalid receiver attempt number.');
    }

    const run = runs.get(request.params.runId);
    if (run === undefined) return response.status(404).json({ error: 'not_found' });
    const observation = run.observedAttempts.find((attempt) => attempt.attemptNumber === attemptNumber);
    if (observation === undefined) return response.status(404).json({ error: 'not_found' });

    const receivedAt = Date.parse(observation.receivedAt);
    const valid =
      Number.isFinite(receivedAt) &&
      verifySignature(
        observation.rawBody,
        observation.timestamp,
        observation.signature,
        options.hmacSecret,
        receivedAt,
      );
    return response.json({ valid });
  });

  options.attachFrontend?.(app);
  app.use((_request, response) => response.status(404).json({ error: 'not_found' }));
  app.use(
    (error: unknown, _request: Request, response: Response, _next: (error?: unknown) => void) => {
      const status =
        typeof error === 'object' && error !== null && 'status' in error && error.status === 413
          ? 413
          : 400;
      response.status(status).json({ error: status === 413 ? 'payload_too_large' : 'invalid_json' });
    },
  );

  return { app };
}

function asDemoPayload(payload: unknown, runId: string): IngestionRequest['payload'] {
  if (payload !== null && typeof payload === 'object' && !Array.isArray(payload)) {
    return { ...(payload as Record<string, IngestionRequest['payload']>), demoRunId: runId };
  }
  return { payload: payload as IngestionRequest['payload'], demoRunId: runId };
}

function allowRequest(remote: string, requestTimes: Map<string, number[]>, now: number): boolean {
  const current = (requestTimes.get(remote) ?? []).filter((time) => now - time < RATE_WINDOW_MS);
  if (current.length >= RATE_LIMIT) return false;
  current.push(now);
  requestTimes.set(remote, current);
  return true;
}

function toPublicRun(
  run: RunRecord,
  event: WebhookEvent,
  attempts: readonly AttemptRecord[],
) {
  return {
    runId: run.runId,
    idempotencyKey: run.idempotencyKey,
    eventId: event.id,
    scenario: run.scenario,
    createdAt: run.createdAt,
    payload: run.payload,
    status: event.status,
    attemptCount: event.attemptCount,
    nextRetryAt: event.nextRetryAt,
    attempts: attempts.map((attempt) => ({
      attemptNumber: attempt.attemptNumber,
      attemptedAt: attempt.attemptedAt,
      statusCode: attempt.statusCode,
      latencyMs: attempt.latencyMs,
      outcome: attempt.outcome,
      error: attempt.error,
    })),
    receiverAttempts: toPublicReceiverAttempts(run),
  };
}

function toPublicReceiverAttempts(run: RunRecord) {
  return run.observedAttempts.map(({ rawBody: _rawBody, ...attempt }) => attempt);
}
