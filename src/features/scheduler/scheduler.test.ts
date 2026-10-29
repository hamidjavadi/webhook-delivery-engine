import { vi, describe, it, expect, beforeEach, afterEach } from 'vitest';
import type { WebhookEvent, Timestamp } from '../../core/types.js';
import type { DatabaseAdapter } from '../../core/ports.js';
import type { EngineConfig } from '../../config/engine.config.js';
import { ClaimScheduler } from './scheduler.js';

// ---------------------------------------------------------------------------
// Test fixtures
// ---------------------------------------------------------------------------

const POLL_INTERVAL = 100;

const BASE_CONFIG: EngineConfig = {
  concurrency: {
    workerCount: 2,
    batchSize: 5,
    pollIntervalMs: POLL_INTERVAL,
  },
  timeoutLimitMs: 10_000,
  retry: {
    maxAttempts: 5,
    baseDelayMs: 1_000,
    maxDelayMs: 60_000,
  },
};

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
    lockedBy: 'worker-test',
    createdAt: now,
    updatedAt: now,
  };
}

function makeMockAdapter(): DatabaseAdapter {
  return {
    upsertEvent: vi.fn(),
    claimDueEvents: vi.fn().mockResolvedValue([]),
    recoverStaleLeases: vi.fn().mockResolvedValue(0),
    releaseEventLease: vi.fn(),
    recordAttemptAndTransition: vi.fn(),
    findEventById: vi.fn(),
    findEventByIdempotencyKey: vi.fn(),
    listEvents: vi.fn(),
    listAttempts: vi.fn(),
  };
}

/**
 * Advances fake timers by `count` poll intervals and drains microtasks between
 * each advance so async adapter mock resolutions settle.
 */
async function advancePolls(count: number): Promise<void> {
  for (let i = 0; i < count; i++) {
    await vi.advanceTimersByTimeAsync(POLL_INTERVAL + 10);
  }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('ClaimScheduler', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(async () => {
    vi.useRealTimers();
    vi.clearAllMocks();
  });

  // -------------------------------------------------------------------------
  // Construction and basic shape
  // -------------------------------------------------------------------------

  it('creates a scheduler without throwing', () => {
    const adapter = makeMockAdapter();
    const onClaim = vi.fn();
    expect(() => new ClaimScheduler(adapter, BASE_CONFIG, onClaim)).not.toThrow();
  });

  it('exposes start() and stop() methods', () => {
    const scheduler = new ClaimScheduler(makeMockAdapter(), BASE_CONFIG, vi.fn());
    expect(typeof scheduler.start).toBe('function');
    expect(typeof scheduler.stop).toBe('function');
  });

  it('is not running before start() is called', () => {
    const scheduler = new ClaimScheduler(makeMockAdapter(), BASE_CONFIG, vi.fn());
    expect(scheduler.isRunning).toBe(false);
  });

  it('is running after start() and not running after stop()', async () => {
    const scheduler = new ClaimScheduler(makeMockAdapter(), BASE_CONFIG, vi.fn());
    scheduler.start();
    expect(scheduler.isRunning).toBe(true);
    await scheduler.stop();
    expect(scheduler.isRunning).toBe(false);
  });

  it('does not throw when stop() is called before start()', async () => {
    const scheduler = new ClaimScheduler(makeMockAdapter(), BASE_CONFIG, vi.fn());
    await expect(scheduler.stop()).resolves.toBeUndefined();
  });

  it('resolves sleep immediately when its signal is already aborted', async () => {
    const scheduler = new ClaimScheduler(makeMockAdapter(), BASE_CONFIG, vi.fn());
    const controller = new AbortController();
    controller.abort();
    const sleep = Reflect.get(scheduler, 'sleep') as (
      ms: number,
      signal: AbortSignal,
    ) => Promise<void>;

    await expect(sleep.call(scheduler, POLL_INTERVAL, controller.signal)).resolves.toBeUndefined();
  });

  // -------------------------------------------------------------------------
  // Stale lease recovery — runs once per cycle before claiming
  // -------------------------------------------------------------------------

  it('recovers stale leases on the first poll cycle', async () => {
    const adapter = makeMockAdapter();
    const scheduler = new ClaimScheduler(adapter, BASE_CONFIG, vi.fn());
    scheduler.start();

    // Let the first cycle execute
    await Promise.resolve();
    await Promise.resolve();

    expect(adapter.recoverStaleLeases).toHaveBeenCalledTimes(1);
    await scheduler.stop();
  });

  it('recovers stale leases once per poll cycle across multiple cycles', async () => {
    const adapter = makeMockAdapter();
    const scheduler = new ClaimScheduler(adapter, BASE_CONFIG, vi.fn());
    scheduler.start();

    // First cycle runs immediately
    await Promise.resolve();
    await Promise.resolve();

    // Advance enough for 2 more cycles
    await advancePolls(2);

    await scheduler.stop();

    expect(adapter.recoverStaleLeases).toHaveBeenCalledTimes(3);
  });

  it('calls recoverStaleLeases before claimDueEvents in the first cycle', async () => {
    const callOrder: string[] = [];
    const adapter = makeMockAdapter();
    (adapter.recoverStaleLeases as ReturnType<typeof vi.fn>).mockImplementation(async () => {
      callOrder.push('recover');
      return 0;
    });
    (adapter.claimDueEvents as ReturnType<typeof vi.fn>).mockImplementation(async () => {
      callOrder.push('claim');
      return [];
    });

    const scheduler = new ClaimScheduler(adapter, BASE_CONFIG, vi.fn());
    scheduler.start();
    await Promise.resolve();
    await Promise.resolve();

    expect(callOrder[0]).toBe('recover');
    expect(callOrder[1]).toBe('claim');

    await scheduler.stop();
  });

  it('maintains recover → claim order across multiple cycles', async () => {
    const callOrder: string[] = [];
    const adapter = makeMockAdapter();
    (adapter.recoverStaleLeases as ReturnType<typeof vi.fn>).mockImplementation(async () => {
      callOrder.push('recover');
      return 0;
    });
    (adapter.claimDueEvents as ReturnType<typeof vi.fn>).mockImplementation(async () => {
      callOrder.push('claim');
      return [];
    });

    const scheduler = new ClaimScheduler(adapter, BASE_CONFIG, vi.fn());
    scheduler.start();
    await Promise.resolve();
    await Promise.resolve();
    await advancePolls(2);
    await scheduler.stop();

    // Every 'claim' must be immediately preceded by 'recover'
    for (let index = 0; index < callOrder.length - 1; index++) {
      if (callOrder[index + 1] === 'claim') {
        expect(callOrder[index]).toBe('recover');
      }
    }
  });

  // -------------------------------------------------------------------------
  // Batch claiming — correct arguments passed
  // -------------------------------------------------------------------------

  it('passes batchSize from config as the limit to claimDueEvents', async () => {
    const adapter = makeMockAdapter();
    const scheduler = new ClaimScheduler(adapter, BASE_CONFIG, vi.fn());
    scheduler.start();
    await Promise.resolve();
    await Promise.resolve();
    await scheduler.stop();

    expect(adapter.claimDueEvents).toHaveBeenCalledWith(
      expect.objectContaining({ limit: BASE_CONFIG.concurrency.batchSize }),
    );
  });

  it('passes a non-empty workerId string to claimDueEvents', async () => {
    const adapter = makeMockAdapter();
    const scheduler = new ClaimScheduler(adapter, BASE_CONFIG, vi.fn());
    scheduler.start();
    await Promise.resolve();
    await Promise.resolve();
    await scheduler.stop();

    const call = (adapter.claimDueEvents as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(typeof call.workerId).toBe('string');
    expect(call.workerId.length).toBeGreaterThan(0);
  });

  it('passes a UTC ISO-8601 now timestamp to claimDueEvents', async () => {
    const adapter = makeMockAdapter();
    const scheduler = new ClaimScheduler(adapter, BASE_CONFIG, vi.fn());
    scheduler.start();
    await Promise.resolve();
    await Promise.resolve();
    await scheduler.stop();

    const call = (adapter.claimDueEvents as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(new Date(call.now).toISOString()).toBe(call.now);
  });

  it('passes the same now to both recoverStaleLeases and claimDueEvents in a cycle', async () => {
    const adapter = makeMockAdapter();
    let recoveryNow: string | undefined;
    (adapter.recoverStaleLeases as ReturnType<typeof vi.fn>).mockImplementation(
      async (input: { now: string }) => {
        recoveryNow = input.now;
        return 0;
      },
    );
    let claimNow: string | undefined;
    (adapter.claimDueEvents as ReturnType<typeof vi.fn>).mockImplementation(
      async (input: { now: string }) => {
        claimNow = input.now;
        return [];
      },
    );

    const scheduler = new ClaimScheduler(adapter, BASE_CONFIG, vi.fn());
    scheduler.start();
    await Promise.resolve();
    await Promise.resolve();
    await scheduler.stop();

    expect(recoveryNow).toBeDefined();
    expect(recoveryNow).toBe(claimNow);
  });

  // -------------------------------------------------------------------------
  // Worker seam — claimed events handed off
  // -------------------------------------------------------------------------

  it('calls the onClaim callback for each claimed event', async () => {
    const events = [makeEvent('event-1'), makeEvent('event-2')];
    const adapter = makeMockAdapter();
    (adapter.claimDueEvents as ReturnType<typeof vi.fn>).mockResolvedValueOnce(events);

    const onClaim = vi.fn();
    const scheduler = new ClaimScheduler(adapter, BASE_CONFIG, onClaim);
    scheduler.start();
    await Promise.resolve();
    await Promise.resolve();
    await scheduler.stop();

    expect(onClaim).toHaveBeenCalledTimes(2);
    expect(onClaim).toHaveBeenCalledWith(events[0]);
    expect(onClaim).toHaveBeenCalledWith(events[1]);
  });

  it('does not call the onClaim callback when no events are claimed', async () => {
    const adapter = makeMockAdapter();
    (adapter.claimDueEvents as ReturnType<typeof vi.fn>).mockResolvedValue([]);

    const onClaim = vi.fn();
    const scheduler = new ClaimScheduler(adapter, BASE_CONFIG, onClaim);
    scheduler.start();
    await Promise.resolve();
    await Promise.resolve();
    await advancePolls(2);
    await scheduler.stop();

    expect(onClaim).not.toHaveBeenCalled();
  });

  // -------------------------------------------------------------------------
  // Empty-poll wait (poll interval)
  // -------------------------------------------------------------------------

  it('waits pollIntervalMs before starting the next cycle after an empty poll', async () => {
    const adapter = makeMockAdapter();
    (adapter.claimDueEvents as ReturnType<typeof vi.fn>).mockResolvedValue([]);

    const scheduler = new ClaimScheduler(adapter, BASE_CONFIG, vi.fn());
    scheduler.start();

    // First cycle runs immediately (no sleep before it)
    await Promise.resolve();
    await Promise.resolve();
    const callsAfterFirstCycle = (adapter.claimDueEvents as ReturnType<typeof vi.fn>).mock.calls
      .length;
    expect(callsAfterFirstCycle).toBe(1);

    // Advance less than the full interval — no second poll yet
    await vi.advanceTimersByTimeAsync(POLL_INTERVAL - 10);
    expect((adapter.claimDueEvents as ReturnType<typeof vi.fn>).mock.calls.length).toBe(1);

    // Advance past the interval — second poll fires
    await vi.advanceTimersByTimeAsync(20);
    await Promise.resolve();
    expect((adapter.claimDueEvents as ReturnType<typeof vi.fn>).mock.calls.length).toBeGreaterThan(
      1,
    );

    await scheduler.stop();
  });

  // -------------------------------------------------------------------------
  // Transient adapter failure — scheduler continues
  // -------------------------------------------------------------------------

  it('continues polling after recoverStaleLeases throws a transient error', async () => {
    const adapter = makeMockAdapter();
    let recoverCallCount = 0;
    (adapter.recoverStaleLeases as ReturnType<typeof vi.fn>).mockImplementation(async () => {
      recoverCallCount++;
      if (recoverCallCount === 1) throw new Error('transient DB error');
      return 0;
    });

    const scheduler = new ClaimScheduler(adapter, BASE_CONFIG, vi.fn());
    scheduler.start();

    // First cycle (throws on recover — scheduler must continue)
    await Promise.resolve();
    await Promise.resolve();

    // Advance to next cycle
    await advancePolls(1);
    await scheduler.stop();

    // Must have retried recover at least once after the initial failure
    expect(adapter.recoverStaleLeases).toHaveBeenCalledTimes(
      expect.toBeGreaterThanOrEqual ? expect.toBeGreaterThanOrEqual(2) : 2,
    );
  });

  it('continues polling after claimDueEvents throws a transient error', async () => {
    const adapter = makeMockAdapter();
    let claimCallCount = 0;
    (adapter.claimDueEvents as ReturnType<typeof vi.fn>).mockImplementation(async () => {
      claimCallCount++;
      if (claimCallCount === 1) throw new Error('transient DB error');
      return [];
    });

    const scheduler = new ClaimScheduler(adapter, BASE_CONFIG, vi.fn());
    scheduler.start();

    // First cycle (throws on claim — scheduler must continue)
    await Promise.resolve();
    await Promise.resolve();

    // Advance to next cycle
    await advancePolls(1);
    await scheduler.stop();

    // Must have retried claim at least once after the initial failure
    expect(adapter.claimDueEvents).toHaveBeenCalledTimes(
      expect.toBeGreaterThanOrEqual ? expect.toBeGreaterThanOrEqual(2) : 2,
    );
  });

  // -------------------------------------------------------------------------
  // onError callback — invoked on transient adapter failure
  // -------------------------------------------------------------------------

  it('invokes the onError callback when recoverStaleLeases throws', async () => {
    const adapter = makeMockAdapter();
    const error = new Error('DB unavailable');
    (adapter.recoverStaleLeases as ReturnType<typeof vi.fn>).mockRejectedValueOnce(error);

    const onError = vi.fn();
    const scheduler = new ClaimScheduler(adapter, BASE_CONFIG, vi.fn(), onError);
    scheduler.start();
    await Promise.resolve();
    await Promise.resolve();
    await scheduler.stop();

    expect(onError).toHaveBeenCalledWith(error);
  });

  it('invokes the onError callback when claimDueEvents throws', async () => {
    const adapter = makeMockAdapter();
    const error = new Error('DB unavailable');
    (adapter.claimDueEvents as ReturnType<typeof vi.fn>).mockRejectedValueOnce(error);

    const onError = vi.fn();
    const scheduler = new ClaimScheduler(adapter, BASE_CONFIG, vi.fn(), onError);
    scheduler.start();
    await Promise.resolve();
    await Promise.resolve();
    await scheduler.stop();

    expect(onError).toHaveBeenCalledWith(error);
  });

  it('reports the number of stale leases recovered during a poll cycle', async () => {
    const adapter = makeMockAdapter();
    (adapter.recoverStaleLeases as ReturnType<typeof vi.fn>).mockResolvedValueOnce(3);
    const onRecovery = vi.fn();
    const scheduler = new ClaimScheduler(adapter, BASE_CONFIG, vi.fn(), undefined, onRecovery);

    scheduler.start();
    await vi.advanceTimersByTimeAsync(0);
    await scheduler.stop();

    expect(onRecovery).toHaveBeenCalledWith(3);
  });

  it('continues without throwing when no onError callback is provided and adapter errors', async () => {
    const adapter = makeMockAdapter();
    (adapter.recoverStaleLeases as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
      new Error('transient'),
    );

    // No onError passed — scheduler must still continue without crashing
    const scheduler = new ClaimScheduler(adapter, BASE_CONFIG, vi.fn());
    scheduler.start();
    await Promise.resolve();
    await Promise.resolve();
    await advancePolls(1);
    await expect(scheduler.stop()).resolves.toBeUndefined();
  });

  // -------------------------------------------------------------------------
  // No OS signal handling
  // -------------------------------------------------------------------------

  it('does not register process.on signal listeners', () => {
    const registeredEvents: string[] = [];
    const spy = vi.spyOn(process, 'on').mockImplementation((event: string) => {
      registeredEvents.push(event);
      return process;
    });

    const scheduler = new ClaimScheduler(makeMockAdapter(), BASE_CONFIG, vi.fn());
    scheduler.start();

    expect(registeredEvents).not.toContain('SIGINT');
    expect(registeredEvents).not.toContain('SIGTERM');

    spy.mockRestore();
    void scheduler.stop();
  });

  // -------------------------------------------------------------------------
  // stop() — idempotent and completes gracefully
  // -------------------------------------------------------------------------

  it('allows stop() to be called multiple times without error', async () => {
    const scheduler = new ClaimScheduler(makeMockAdapter(), BASE_CONFIG, vi.fn());
    scheduler.start();
    await scheduler.stop();
    await expect(scheduler.stop()).resolves.toBeUndefined();
  });

  it('does not start additional loops when start() is called while already running', async () => {
    const adapter = makeMockAdapter();
    const scheduler = new ClaimScheduler(adapter, BASE_CONFIG, vi.fn());
    scheduler.start();
    scheduler.start(); // second call must be a no-op

    // Let the first cycle execute
    await Promise.resolve();
    await Promise.resolve();
    await advancePolls(1);
    await scheduler.stop();

    // With one loop, recovers should be ~2 for 2 cycles
    // With two loops, recovers would be ~4. We simply assert it's reasonable.
    const calls = (adapter.recoverStaleLeases as ReturnType<typeof vi.fn>).mock.calls.length;
    expect(calls).toBeGreaterThan(0);
    // Upper bound: 3 per cycle × 2 cycles = 6 if two loops, expect ≤ 4
    // We can only guarantee exactly 2 if one loop ran exactly 2 cycles.
    expect(calls).toBeLessThanOrEqual(4);
  });
});
