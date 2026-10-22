import { afterEach, describe, expect, it, vi } from 'vitest';
import type { EngineConfig } from '../../config/engine.config.js';
import type { DatabaseAdapter } from '../../core/ports.js';
import type { Timestamp, WebhookEvent } from '../../core/types.js';
import { createDeliveryWorker, processDeliveryAttempt } from './delivery.worker.js';
import type { DispatchInput, DispatchResult } from './delivery.dispatcher.js';

const ATTEMPTED_AT: Timestamp = '2026-10-21T18:00:00.000Z';
const UPDATED_AT: Timestamp = '2026-10-21T18:00:01.000Z';
const HMAC_SECRET = 'test-hmac-secret';
const CONFIG: Pick<EngineConfig, 'retry' | 'timeoutLimitMs'> = {
  timeoutLimitMs: 5_000,
  retry: { maxAttempts: 5, baseDelayMs: 50, maxDelayMs: 1_000 },
};

function makeEvent(overrides: Partial<WebhookEvent> = {}): WebhookEvent {
  return {
    id: 'event-1',
    idempotencyKey: 'key-1',
    clientId: 'client-1',
    destinationUrl: 'https://consumer.example/hooks',
    payload: { name: 'payment.created' },
    metadata: {},
    headers: {},
    status: 'processing',
    attemptCount: 2,
    nextRetryAt: null,
    lockedAt: ATTEMPTED_AT,
    lockedBy: 'worker-1',
    createdAt: ATTEMPTED_AT,
    updatedAt: ATTEMPTED_AT,
    ...overrides,
  };
}

function makeResult(overrides: Partial<DispatchResult> = {}): DispatchResult {
  return {
    statusCode: 200,
    latencyMs: 24,
    responseSnippet: 'accepted',
    error: null,
    ...overrides,
  };
}

function makeHarness(result = makeResult(), saved = true) {
  const recordAttemptAndTransition = vi.fn<DatabaseAdapter['recordAttemptAndTransition']>();
  recordAttemptAndTransition.mockResolvedValue(saved);
  const dispatch = vi.fn<(input: DispatchInput) => Promise<DispatchResult>>();
  dispatch.mockResolvedValue(result);
  const now = vi.fn<() => Timestamp>();
  now.mockReturnValueOnce(ATTEMPTED_AT).mockReturnValue(UPDATED_AT);
  const createId = vi.fn(() => 'attempt-1');
  const adapter = { recordAttemptAndTransition };
  const options = {
    adapter,
    hmacSecret: HMAC_SECRET,
    ...CONFIG,
    dispatch,
    now,
    createId,
  };

  return { adapter, createId, dispatch, now, options };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('processDeliveryAttempt', () => {
  it('records a successful dispatch and transitions the event to delivered', async () => {
    const harness = makeHarness();

    await expect(processDeliveryAttempt(makeEvent(), harness.options)).resolves.toBe(true);

    expect(harness.dispatch).toHaveBeenCalledWith({
      event: makeEvent(),
      hmacSecret: HMAC_SECRET,
      timeoutLimitMs: CONFIG.timeoutLimitMs,
    });
    expect(harness.adapter.recordAttemptAndTransition).toHaveBeenCalledWith({
      attempt: {
        id: 'attempt-1',
        eventId: 'event-1',
        attemptNumber: 2,
        attemptedAt: ATTEMPTED_AT,
        statusCode: 200,
        responseSnippet: 'accepted',
        error: null,
        latencyMs: 24,
        outcome: 'success',
      },
      workerId: 'worker-1',
      nextStatus: 'delivered',
      nextRetryAt: null,
      updatedAt: UPDATED_AT,
    });
  });

  it('records non-retryable 4xx as exhausted and immediately fails the event', async () => {
    const harness = makeHarness(makeResult({ statusCode: 422, responseSnippet: 'invalid' }));
    const random = vi.spyOn(Math, 'random');

    await expect(processDeliveryAttempt(makeEvent(), harness.options)).resolves.toBe(true);

    expect(harness.adapter.recordAttemptAndTransition).toHaveBeenCalledWith(
      expect.objectContaining({
        attempt: expect.objectContaining({
          statusCode: 422,
          error: 'HTTP 422',
          outcome: 'exhausted',
        }),
        nextStatus: 'failed',
        nextRetryAt: null,
      }),
    );
    expect(random).not.toHaveBeenCalled();
  });

  it('records a retryable 4xx and schedules a full-jitter retry', async () => {
    vi.spyOn(Math, 'random').mockReturnValue(0.5);
    const harness = makeHarness(makeResult({ statusCode: 429 }));

    await processDeliveryAttempt(makeEvent(), harness.options);

    expect(harness.adapter.recordAttemptAndTransition).toHaveBeenCalledWith(
      expect.objectContaining({
        attempt: expect.objectContaining({ outcome: 'retry_scheduled', error: 'HTTP 429' }),
        nextStatus: 'retry',
        nextRetryAt: '2026-10-21T18:00:01.050Z',
      }),
    );
  });

  it('records a timeout as a retryable attempt', async () => {
    vi.spyOn(Math, 'random').mockReturnValue(0);
    const harness = makeHarness(
      makeResult({ statusCode: null, responseSnippet: null, error: 'timeout' }),
    );

    await processDeliveryAttempt(makeEvent(), harness.options);

    expect(harness.adapter.recordAttemptAndTransition).toHaveBeenCalledWith(
      expect.objectContaining({
        attempt: expect.objectContaining({ statusCode: null, error: 'timeout' }),
        nextStatus: 'retry',
        nextRetryAt: UPDATED_AT,
      }),
    );
  });

  it('limits persisted response snippets to 1024 UTF-8 bytes', async () => {
    const harness = makeHarness(makeResult({ responseSnippet: 'é'.repeat(600) }));

    await processDeliveryAttempt(makeEvent(), harness.options);

    const saved = harness.adapter.recordAttemptAndTransition.mock.calls[0]?.[0];
    expect(Buffer.byteLength(saved?.attempt.responseSnippet ?? '', 'utf8')).toBe(1024);
    expect(saved?.attempt.responseSnippet).toHaveLength(512);
  });

  it('marks a retryable failure exhausted at maxAttempts', async () => {
    const harness = makeHarness(makeResult({ statusCode: 503 }));

    await processDeliveryAttempt(makeEvent({ attemptCount: 5 }), harness.options);

    expect(harness.adapter.recordAttemptAndTransition).toHaveBeenCalledWith(
      expect.objectContaining({
        attempt: expect.objectContaining({ outcome: 'exhausted', error: 'HTTP 503' }),
        nextStatus: 'failed',
        nextRetryAt: null,
      }),
    );
  });

  it('does not dispatch when the event has no active worker lease', async () => {
    const harness = makeHarness();

    await expect(
      processDeliveryAttempt(makeEvent({ lockedBy: null }), harness.options),
    ).rejects.toThrow(/active processing lease/i);

    expect(harness.dispatch).not.toHaveBeenCalled();
    expect(harness.adapter.recordAttemptAndTransition).not.toHaveBeenCalled();
  });

  it('does not dispatch when the event is not processing even with a lease owner', async () => {
    const harness = makeHarness();

    await expect(
      processDeliveryAttempt(makeEvent({ status: 'retry' }), harness.options),
    ).rejects.toThrow(/active processing lease/i);

    expect(harness.dispatch).not.toHaveBeenCalled();
  });

  it('rejects an invalid reserved attempt count before dispatch', async () => {
    const harness = makeHarness();

    await expect(
      processDeliveryAttempt(makeEvent({ attemptCount: 0 }), harness.options),
    ).rejects.toThrow(/attemptCount/i);

    expect(harness.dispatch).not.toHaveBeenCalled();
  });

  it('uses the default UUID and UTC clock providers when not supplied', async () => {
    const harness = makeHarness();
    const options = { ...harness.options };
    delete (options as Partial<typeof options>).createId;
    delete (options as Partial<typeof options>).now;

    await processDeliveryAttempt(makeEvent(), options);

    const saved = harness.adapter.recordAttemptAndTransition.mock.calls[0]?.[0];
    expect(saved?.attempt.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(saved?.attempt.attemptedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(saved?.updatedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it('uses the HTTP dispatcher when the dispatch seam is omitted', async () => {
    const harness = makeHarness();
    const fetchMock = vi.fn().mockResolvedValue({
      status: 204,
      text: vi.fn().mockResolvedValue(''),
    });
    vi.stubGlobal('fetch', fetchMock);

    const options = { ...harness.options };
    delete (options as Partial<typeof options>).dispatch;
    await processDeliveryAttempt(makeEvent(), options);

    expect(fetchMock).toHaveBeenCalledOnce();
    expect(harness.adapter.recordAttemptAndTransition).toHaveBeenCalledWith(
      expect.objectContaining({ nextStatus: 'delivered' }),
    );
  });

  it('returns false when the adapter no longer recognizes the worker lease', async () => {
    const harness = makeHarness(makeResult(), false);

    await expect(processDeliveryAttempt(makeEvent(), harness.options)).resolves.toBe(false);
  });

  it('propagates attempt persistence failures', async () => {
    const harness = makeHarness();
    harness.adapter.recordAttemptAndTransition.mockRejectedValue(new Error('database unavailable'));

    await expect(processDeliveryAttempt(makeEvent(), harness.options)).rejects.toThrow(
      'database unavailable',
    );
  });
});

describe('createDeliveryWorker', () => {
  it('reports processing failures through its error callback', async () => {
    const harness = makeHarness();
    const onError = vi.fn();
    const worker = createDeliveryWorker({ ...harness.options, onError });

    worker(makeEvent({ lockedBy: null }));
    await vi.waitFor(() =>
      expect(onError).toHaveBeenCalledWith(expect.any(Error), expect.any(Object)),
    );

    expect(harness.dispatch).not.toHaveBeenCalled();
  });
});
