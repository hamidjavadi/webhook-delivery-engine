import { vi, describe, it, expect, beforeEach, afterEach } from 'vitest';
import type { WebhookEvent, Timestamp } from '../core/types.js';
import type { DatabaseAdapter } from '../core/ports.js';
import { GracefulShutdown } from './lifecycle.js';

// ---------------------------------------------------------------------------
// Test fixtures
// ---------------------------------------------------------------------------

function makeEvent(id: string): WebhookEvent {
  const now: Timestamp = '2026-10-21T00:00:00.000Z';
  return {
    id,
    idempotencyKey: `key-${id}`,
    clientId: 'client-1',
    destinationUrl: 'https://consumer.example/hooks',
    payload: { action: 'test' },
    metadata: {},
    headers: {},
    status: 'processing',
    attemptCount: 1,
    nextRetryAt: null,
    lockedAt: now,
    lockedBy: 'worker-1',
    createdAt: now,
    updatedAt: now,
  };
}

interface MockScheduler {
  start: ReturnType<typeof vi.fn>;
  stop: ReturnType<typeof vi.fn>;
  isRunning: boolean;
}

function makeMockScheduler(isRunning = false): MockScheduler {
  return {
    start: vi.fn(),
    stop: vi.fn().mockResolvedValue(undefined),
    isRunning,
  };
}

function makeMockAdapter(): Pick<DatabaseAdapter, 'releaseEventLease'> {
  return {
    releaseEventLease: vi.fn().mockResolvedValue(true),
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('GracefulShutdown', () => {
  let originalListeners: { signal: string; listener: (...args: unknown[]) => void }[];

  beforeEach(() => {
    // Capture current SIGINT/SIGTERM listeners so we can restore them
    originalListeners = [
      ...process
        .listeners('SIGINT')
        .map((l) => ({ signal: 'SIGINT', listener: l as (...args: unknown[]) => void })),
      ...process
        .listeners('SIGTERM')
        .map((l) => ({ signal: 'SIGTERM', listener: l as (...args: unknown[]) => void })),
    ];
  });

  afterEach(() => {
    // Remove any listeners added during the test
    process.removeAllListeners('SIGINT');
    process.removeAllListeners('SIGTERM');
    // Restore original listeners
    for (const { signal, listener } of originalListeners) {
      process.on(signal as NodeJS.Signals, listener as NodeJS.SignalsListener);
    }
    vi.clearAllMocks();
  });

  // -------------------------------------------------------------------------
  // Construction and basic shape
  // -------------------------------------------------------------------------

  it('creates a GracefulShutdown instance without throwing', () => {
    expect(() => new GracefulShutdown(makeMockScheduler(), makeMockAdapter())).not.toThrow();
  });

  it('exposes a register() method and a shutdown() method', () => {
    const gs = new GracefulShutdown(makeMockScheduler(), makeMockAdapter());
    expect(typeof gs.register).toBe('function');
    expect(typeof gs.shutdown).toBe('function');
  });

  // -------------------------------------------------------------------------
  // Signal handler registration
  // -------------------------------------------------------------------------

  it('registers a SIGINT listener on process after register()', () => {
    const gs = new GracefulShutdown(makeMockScheduler(), makeMockAdapter());
    const before = process.listenerCount('SIGINT');
    gs.register();
    expect(process.listenerCount('SIGINT')).toBe(before + 1);
  });

  it('registers a SIGTERM listener on process after register()', () => {
    const gs = new GracefulShutdown(makeMockScheduler(), makeMockAdapter());
    const before = process.listenerCount('SIGTERM');
    gs.register();
    expect(process.listenerCount('SIGTERM')).toBe(before + 1);
  });

  it('does not register duplicate listeners when register() is called multiple times', () => {
    const gs = new GracefulShutdown(makeMockScheduler(), makeMockAdapter());
    const before = process.listenerCount('SIGINT');
    gs.register();
    gs.register(); // second call — must be a no-op
    expect(process.listenerCount('SIGINT')).toBe(before + 1);
  });

  // -------------------------------------------------------------------------
  // shutdown() — stops the scheduler
  // -------------------------------------------------------------------------

  it('calls scheduler.stop() when shutdown() is invoked', async () => {
    const scheduler = makeMockScheduler();
    const gs = new GracefulShutdown(scheduler, makeMockAdapter());
    await gs.shutdown();
    expect(scheduler.stop).toHaveBeenCalledTimes(1);
  });

  it('resolves the shutdown() promise after scheduler.stop() completes', async () => {
    let stopResolved = false;
    const scheduler = makeMockScheduler();
    scheduler.stop.mockImplementation(async () => {
      await new Promise<void>((r) => setTimeout(r, 10));
      stopResolved = true;
    });

    const gs = new GracefulShutdown(scheduler, makeMockAdapter());
    await gs.shutdown();
    expect(stopResolved).toBe(true);
  });

  it('shutdown() is idempotent — second call resolves without calling stop() again', async () => {
    const scheduler = makeMockScheduler();
    const gs = new GracefulShutdown(scheduler, makeMockAdapter());
    await gs.shutdown();
    await gs.shutdown();
    expect(scheduler.stop).toHaveBeenCalledTimes(1);
  });

  // -------------------------------------------------------------------------
  // Lease release — unclaims events that haven't started dispatch
  // -------------------------------------------------------------------------

  it('releases leases for events tracked before shutdown() is called', async () => {
    const adapter = makeMockAdapter();
    const scheduler = makeMockScheduler();
    const gs = new GracefulShutdown(scheduler, adapter);

    const event = makeEvent('event-1');
    // Simulate the scheduler handing an event to the worker seam, but
    // dispatch has NOT started yet — lifecycle tracks it
    gs.trackClaimed(event);

    await gs.shutdown();

    expect(adapter.releaseEventLease).toHaveBeenCalledWith(
      expect.objectContaining({ eventId: event.id }),
    );
  });

  it('releases leases for all tracked events on shutdown', async () => {
    const adapter = makeMockAdapter();
    const scheduler = makeMockScheduler();
    const gs = new GracefulShutdown(scheduler, adapter);

    const events = [makeEvent('event-1'), makeEvent('event-2'), makeEvent('event-3')];
    for (const event of events) gs.trackClaimed(event);

    await gs.shutdown();

    expect(adapter.releaseEventLease).toHaveBeenCalledTimes(3);
    for (const event of events) {
      expect(adapter.releaseEventLease).toHaveBeenCalledWith(
        expect.objectContaining({ eventId: event.id }),
      );
    }
  });

  it('does not release a lease after untrackClaimed() removes the event', async () => {
    const adapter = makeMockAdapter();
    const scheduler = makeMockScheduler();
    const gs = new GracefulShutdown(scheduler, adapter);

    const event = makeEvent('event-1');
    gs.trackClaimed(event);
    // Dispatch starts — remove from tracking so shutdown won't release it
    gs.untrackClaimed(event.id);

    await gs.shutdown();

    expect(adapter.releaseEventLease).not.toHaveBeenCalled();
  });

  it('waits for started dispatches while releasing claims that have not started', async () => {
    const adapter = makeMockAdapter();
    const gs = new GracefulShutdown(makeMockScheduler(), adapter);
    const started = makeEvent('started');
    const queued = makeEvent('queued');
    let finishDispatch!: () => void;
    const dispatch = new Promise<void>((resolve) => {
      finishDispatch = resolve;
    });

    gs.trackClaimed(started);
    gs.trackDispatch(started.id, dispatch);
    gs.trackClaimed(queued);
    const stopping = gs.shutdown();
    await Promise.resolve();
    expect(adapter.releaseEventLease).toHaveBeenCalledWith(
      expect.objectContaining({ eventId: queued.id }),
    );
    expect(adapter.releaseEventLease).not.toHaveBeenCalledWith(
      expect.objectContaining({ eventId: started.id }),
    );

    let stopped = false;
    void stopping.then(() => {
      stopped = true;
    });
    await Promise.resolve();
    expect(stopped).toBe(false);
    finishDispatch();
    await stopping;
    expect(stopped).toBe(true);
  });

  it('passes a UTC ISO-8601 releasedAt timestamp to releaseEventLease', async () => {
    const adapter = makeMockAdapter();
    const scheduler = makeMockScheduler();
    const gs = new GracefulShutdown(scheduler, adapter);

    gs.trackClaimed(makeEvent('event-1'));
    await gs.shutdown();

    const call = (adapter.releaseEventLease as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(new Date(call.releasedAt).toISOString()).toBe(call.releasedAt);
  });

  it('passes the event workerId (lockedBy) as workerId to releaseEventLease', async () => {
    const adapter = makeMockAdapter();
    const gs = new GracefulShutdown(makeMockScheduler(), adapter);

    const event = makeEvent('event-1');
    gs.trackClaimed(event);
    await gs.shutdown();

    const call = (adapter.releaseEventLease as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(call.workerId).toBe(event.lockedBy);
  });

  it('does not throw when releaseEventLease rejects for a single event', async () => {
    const adapter = makeMockAdapter();
    (adapter.releaseEventLease as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
      new Error('DB error'),
    );
    const gs = new GracefulShutdown(makeMockScheduler(), adapter);

    gs.trackClaimed(makeEvent('event-1'));
    gs.trackClaimed(makeEvent('event-2')); // second event should still be released

    await expect(gs.shutdown()).resolves.toBeUndefined();
  });

  it('attempts to release all tracked events even if some releaseEventLease calls fail', async () => {
    const adapter = makeMockAdapter();
    (adapter.releaseEventLease as ReturnType<typeof vi.fn>)
      .mockRejectedValueOnce(new Error('DB error'))
      .mockResolvedValueOnce(true);

    const gs = new GracefulShutdown(makeMockScheduler(), adapter);
    gs.trackClaimed(makeEvent('event-1'));
    gs.trackClaimed(makeEvent('event-2'));

    await gs.shutdown();

    expect(adapter.releaseEventLease).toHaveBeenCalledTimes(2);
  });

  it('uses an empty string workerId when event.lockedBy is null', async () => {
    const adapter = makeMockAdapter();
    const gs = new GracefulShutdown(makeMockScheduler(), adapter);

    const event = { ...makeEvent('event-null-locked'), lockedBy: null };
    gs.trackClaimed(event);
    await gs.shutdown();

    const call = (adapter.releaseEventLease as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(call.workerId).toBe('');
  });

  // -------------------------------------------------------------------------
  // Signal → shutdown() wiring
  // -------------------------------------------------------------------------

  it('calls shutdown() when SIGINT is emitted', async () => {
    const scheduler = makeMockScheduler();
    const gs = new GracefulShutdown(scheduler, makeMockAdapter());
    gs.register();

    process.emit('SIGINT');
    // Give the async chain time to settle
    await new Promise<void>((r) => setTimeout(r, 20));

    expect(scheduler.stop).toHaveBeenCalledTimes(1);
  });

  it('calls shutdown() when SIGTERM is emitted', async () => {
    const scheduler = makeMockScheduler();
    const gs = new GracefulShutdown(scheduler, makeMockAdapter());
    gs.register();

    process.emit('SIGTERM');
    await new Promise<void>((r) => setTimeout(r, 20));

    expect(scheduler.stop).toHaveBeenCalledTimes(1);
  });

  it('calls shutdown() only once when both SIGINT and SIGTERM are emitted', async () => {
    const scheduler = makeMockScheduler();
    const gs = new GracefulShutdown(scheduler, makeMockAdapter());
    gs.register();

    process.emit('SIGINT');
    process.emit('SIGTERM');
    await new Promise<void>((r) => setTimeout(r, 20));

    expect(scheduler.stop).toHaveBeenCalledTimes(1);
  });
});
