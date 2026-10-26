import { describe, expect, it, vi } from 'vitest';
import { isRunActive, mergeRunUpdate, pollRunOnce, replayRun, type DemoRunView } from './run-state.js';

function run(status: string, nextRetryAt: string | null = null): DemoRunView {
  return {
    runId: 'run-1',
    eventId: 'event-1',
    scenario: 'retry-recovery',
    createdAt: '2026-01-01T00:00:00.000Z',
    status,
    nextRetryAt,
    payload: { type: 'demo.retry-recovery' },
    attempts: [],
    receiverAttempts: [],
  };
}

describe('demo run state helpers', () => {
  it('keeps ingestion and retry states active while stopping at settled terminal states', () => {
    expect(['ingesting', 'pending', 'processing', 'retry'].every((status) => isRunActive(run(status)))).toBe(true);
    expect(['delivered', 'failed', 'rejected'].every((status) => !isRunActive(run(status)))).toBe(true);
    expect(isRunActive(run('delivered', '2026-01-01T00:00:01.000Z'))).toBe(true);
  });

  it('does not let a late nonterminal response replace a terminal run', () => {
    const merged = mergeRunUpdate(run('delivered'), run('retry', '2026-01-01T00:00:01.000Z'));

    expect(merged.status).toBe('delivered');
  });

  it('merges a terminal update while retaining client-only replay inputs', () => {
    const replayRequest = { scenario: 'retry-recovery' } as const;
    const current = { ...run('retry'), scenarioRequest: replayRequest };
    const merged = mergeRunUpdate(current, run('delivered'));

    expect(merged.status).toBe('delivered');
    expect(merged.scenarioRequest).toEqual(replayRequest);
  });

  it('does not start an overlapping poll for a run and clears its in-flight marker afterward', async () => {
    const inFlight = new Set<string>();
    let finishPoll!: () => void;
    const refresh = vi.fn(() => new Promise<void>((resolve) => { finishPoll = resolve; }));

    expect(pollRunOnce('run-1', inFlight, refresh)).toBe(true);
    expect(pollRunOnce('run-1', inFlight, refresh)).toBe(false);
    expect(refresh).toHaveBeenCalledTimes(1);

    finishPoll();
    await Promise.resolve();
    expect(inFlight.has('run-1')).toBe(false);
  });

  it('replays a custom event with its saved payload and a fresh idempotency key', () => {
    const request = {
      scenario: 'custom',
      idempotency_key: 'custom-1',
      payload: { type: 'invoice.created', amount: 42 },
    } as const;
    const start = vi.fn(async () => undefined);

    expect(replayRun({ ...run('failed'), scenario: 'custom', scenarioRequest: request }, start, () => 'replay-2')).toBe(true);
    expect(start).toHaveBeenCalledWith('custom', {
      scenario: 'custom',
      idempotency_key: 'replay-2',
      payload: request.payload,
    });
  });

  it('does not submit a replay when the original request is unavailable', () => {
    const start = vi.fn(async () => undefined);

    expect(replayRun(run('failed'), start)).toBe(false);
    expect(start).not.toHaveBeenCalled();
  });
});
