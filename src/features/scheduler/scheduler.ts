import { randomUUID } from 'node:crypto';
import type { WebhookEvent } from '../../core/types.js';
import type { DatabaseAdapter } from '../../core/ports.js';
import type { EngineConfig } from '../../config/engine.config.js';

/**
 * Callback seam invoked once per claimed event.
 *
 * The scheduler hands each claimed `WebhookEvent` to this function. Delivery,
 * HMAC signing, attempt recording, and state transitions are the
 * responsibility of the worker registered here (WBS 5.x). The scheduler does
 * not await the callback's promise; in-flight work is the worker's concern.
 */
export type OnClaimCallback = (event: WebhookEvent) => void;

/**
 * Optional callback invoked when a poll cycle catches a transient adapter
 * error.
 *
 * The scheduler always continues regardless of whether this callback is
 * supplied. Callers may use this seam to log errors via the structured logger
 * (WBS 6.3) without introducing a direct logger dependency inside the
 * scheduler.
 */
export type OnPollErrorCallback = (error: unknown) => void;

/**
 * Polling loop that coordinates stale-lease recovery and due-event claiming.
 *
 * Each cycle:
 * 1. Calls `DatabaseAdapter.recoverStaleLeases` with the current UTC time and
 *    the configured `timeoutLimitMs` to return expired processing leases to
 *    the retry queue.
 * 2. Calls `DatabaseAdapter.claimDueEvents` with a stable worker id, the
 *    current UTC time, and the configured `batchSize` to atomically acquire
 *    up to `batchSize` due events.
 * 3. Passes each claimed event to the `onClaim` callback (the worker seam).
 * 4. Sleeps for `pollIntervalMs` before the next cycle when the batch is
 *    empty; starts the next cycle immediately when work was found.
 *
 * Transient errors thrown by either adapter operation are caught and logged
 * (as a console.error) so the loop continues rather than crashing. The
 * scheduler does not register OS signal listeners (SIGINT/SIGTERM) — that
 * responsibility belongs to the graceful-shutdown module (WBS 4.2).
 */
export class ClaimScheduler {
  /** Stable id stamped on every lease this scheduler instance claims. */
  private readonly workerId: string;

  /** Whether the scheduler's poll loop is currently active. */
  private running: boolean = false;

  /** Promise that resolves when the active loop iteration completes. */
  private loopPromise: Promise<void> | null = null;

  /** AbortController used to signal the sleeping poll interval to wake early. */
  private abortController: AbortController | null = null;

  /**
   * Creates a scheduler bound to the given adapter, config, and worker seam.
   *
   * @param adapter - The persistence adapter implementing atomic claiming and
   * stale-lease recovery operations.
   * @param config - Immutable engine configuration; `concurrency.batchSize`
   * and `concurrency.pollIntervalMs` govern this scheduler.
   * @param onClaim - Worker seam called once per claimed event. The scheduler
   * does not await this callback.
   * @param onError - Optional callback invoked when a poll cycle catches a
   * transient adapter error. The scheduler always continues regardless of
   * whether this is supplied.
   */
  constructor(
    private readonly adapter: Pick<DatabaseAdapter, 'recoverStaleLeases' | 'claimDueEvents'>,
    private readonly config: EngineConfig,
    private readonly onClaim: OnClaimCallback,
    private readonly onError?: OnPollErrorCallback,
  ) {
    this.workerId = randomUUID();
  }

  /**
   * Whether the poll loop is currently active.
   *
   * Returns `true` from the moment `start()` is called until `stop()` fully
   * resolves.
   */
  get isRunning(): boolean {
    return this.running;
  }

  /**
   * Starts the poll loop.
   *
   * Has no effect when the scheduler is already running — only one loop runs
   * at a time.
   */
  start(): void {
    if (this.running) return;
    this.running = true;
    this.abortController = new AbortController();
    this.loopPromise = this.runLoop(this.abortController.signal);
  }

  /**
   * Signals the poll loop to stop and waits for the current cycle to finish.
   *
   * Safe to call multiple times; resolves immediately when the loop is not
   * running.
   */
  async stop(): Promise<void> {
    if (!this.running) return;
    this.running = false;
    this.abortController?.abort();
    await this.loopPromise;
    this.loopPromise = null;
    this.abortController = null;
  }

  /**
   * The main poll loop. Runs until `signal.aborted`.
   *
   * Errors thrown by adapter operations are caught and reported via
   * `console.error`; the loop continues to the next cycle in all cases.
   *
   * @param signal - Abort signal set by `stop()` to terminate the loop.
   */
  private async runLoop(signal: AbortSignal): Promise<void> {
    while (!signal.aborted) {
      let claimedCount = 0;

      try {
        const now = new Date().toISOString();

        await this.adapter.recoverStaleLeases({
          now,
          timeoutLimitMs: this.config.timeoutLimitMs,
        });

        const claimed = await this.adapter.claimDueEvents({
          workerId: this.workerId,
          now,
          limit: this.config.concurrency.batchSize,
        });

        claimedCount = claimed.length;
        for (const event of claimed) {
          this.onClaim(event);
        }
      } catch (error: unknown) {
        // Transient adapter failure — invoke optional error handler and
        // continue to the next cycle regardless.
        this.onError?.(error);
      }

      // Sleep between cycles when no work was found; skip sleep when the
      // batch was non-empty to process available work without delay.
      if (claimedCount === 0 && !signal.aborted) {
        await this.sleep(this.config.concurrency.pollIntervalMs, signal);
      }
    }
  }

  /**
   * Sleeps for `ms` milliseconds or until the abort signal fires.
   *
   * @param ms - Duration to wait.
   * @param signal - Abort signal that cancels the sleep early.
   */
  private sleep(ms: number, signal: AbortSignal): Promise<void> {
    return new Promise<void>((resolve) => {
      if (signal.aborted) {
        resolve();
        return;
      }
      const timer = setTimeout(resolve, ms);
      signal.addEventListener('abort', () => {
        clearTimeout(timer);
        resolve();
      });
    });
  }
}
