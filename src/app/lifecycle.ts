import type { WebhookEvent } from '../core/types.js';
import type { DatabaseAdapter } from '../core/ports.js';

/**
 * Minimal scheduler interface required by the graceful shutdown coordinator.
 *
 * This keeps the lifecycle module decoupled from the concrete `ClaimScheduler`
 * implementation while still being able to stop the poll loop.
 */
export interface StoppableScheduler {
  /** Stops the poll loop and resolves when the current cycle completes. */
  stop(): Promise<void>;
}

/**
 * Coordinates a clean process exit on SIGINT or SIGTERM.
 *
 * Responsibilities (WBS 4.2):
 * 1. Register one-time SIGINT and SIGTERM handlers via `register()`.
 * 2. On signal (or direct `shutdown()` call): stop the scheduler so no new
 *    events are claimed.
 * 3. Call `DatabaseAdapter.releaseEventLease` for every event that was claimed
 *    but whose dispatch has not yet started, returning those leases to the
 *    `pending` state so they are picked up on the next startup.
 * 4. Remain idempotent — duplicate signals or `shutdown()` calls run the
 *    shutdown sequence exactly once.
 *
 * The lifecycle module does NOT implement the poll loop itself (WBS 4.1), does
 * NOT dispatch events, and does NOT know about HMAC signing or HTTP transport.
 *
 * ### Lease tracking contract
 *
 * When the scheduler claims an event and hands it to the worker seam, callers
 * should immediately call `trackClaimed(event)`. When network dispatch starts,
 * call `trackDispatch(event.id, work)` to move the event from releasable claims
 * to work that shutdown must drain. `untrackClaimed` remains available for
 * callers that only need claim release tracking.
 */
export class GracefulShutdown {
  /**
   * Events that have been claimed by the scheduler but have not yet started
   * network dispatch. Keyed by event id for O(1) lookup and removal.
   */
  private readonly pendingClaims = new Map<string, WebhookEvent>();

  /** Dispatches that crossed the network-start boundary and must be drained. */
  private readonly activeDispatches = new Set<Promise<void>>();

  /** Whether the shutdown sequence has been started (guards idempotency). */
  private shuttingDown = false;

  /** Shared completion promise so concurrent stop calls await the same drain. */
  private shutdownPromise: Promise<void> | null = null;

  /** Whether `register()` has been called (guards duplicate listener registration). */
  private registered = false;

  /**
   * Creates a lifecycle coordinator for the given scheduler and adapter.
   *
   * @param scheduler - The running poll loop to stop on shutdown.
   * @param adapter - Adapter used to release unclaimed-dispatch leases.
   */
  constructor(
    private readonly scheduler: StoppableScheduler,
    private readonly adapter: Pick<DatabaseAdapter, 'releaseEventLease'>,
  ) {}

  /**
   * Registers one-time SIGINT and SIGTERM listeners on `process`.
   *
   * Safe to call multiple times — only one pair of listeners is ever added.
   * Each signal triggers `shutdown()` which is itself idempotent.
   */
  register(): void {
    if (this.registered) return;
    this.registered = true;

    const handle = () => {
      void this.shutdown();
    };

    process.on('SIGINT', handle);
    process.on('SIGTERM', handle);
  }

  /**
   * Marks an event as claimed-but-not-dispatched.
   *
   * Call this immediately after the scheduler hands an event to the worker
   * seam so that a concurrent or subsequent `shutdown()` can release its
   * lease.
   *
   * @param event - The claimed event to track.
   */
  trackClaimed(event: WebhookEvent): void {
    this.pendingClaims.set(event.id, event);
  }

  /**
   * Removes an event from the pending-claim tracking set.
   *
   * Call this when the worker begins actual network dispatch for an event.
   * After removal, `shutdown()` will not attempt to release that lease —
   * the stale-lease recovery mechanism will handle it if the process aborts
   * mid-dispatch.
   *
   * @param eventId - Id of the event whose dispatch has started.
   */
  untrackClaimed(eventId: string): void {
    this.pendingClaims.delete(eventId);
  }

  /**
   * Marks dispatch as started and tracks its completion for shutdown.
   * The lease is no longer eligible for release once network dispatch begins.
   */
  trackDispatch(eventId: string, dispatch: Promise<unknown>): void {
    this.pendingClaims.delete(eventId);
    const tracked = dispatch.then(
      () => undefined,
      () => undefined,
    );
    this.activeDispatches.add(tracked);
    void tracked.then(() => this.activeDispatches.delete(tracked));
  }

  /**
   * Executes the graceful shutdown sequence exactly once.
   *
   * 1. Stops the scheduler (no new claims after this point).
   * 2. Releases the leases of all still-tracked (not-yet-dispatched) events
   *    by calling `releaseEventLease` for each. Failures for individual events
   *    are swallowed so that the remaining releases still run; those events
   *    will be recovered by the stale-lease mechanism on next startup.
   *
   * Safe to call multiple times — subsequent calls resolve immediately.
   *
   * @returns A promise that resolves when the shutdown sequence completes.
   */
  async shutdown(): Promise<void> {
    if (this.shuttingDown) return this.shutdownPromise!;
    this.shuttingDown = true;
    this.shutdownPromise = this.drainAndRelease();
    return this.shutdownPromise;
  }

  private async drainAndRelease(): Promise<void> {
    await this.scheduler.stop();
    const releasedAt = new Date().toISOString();
    const releasePromises = Array.from(this.pendingClaims.values()).map((event) =>
      this.adapter
        .releaseEventLease({
          eventId: event.id,
          workerId: event.lockedBy ?? '',
          releasedAt,
        })
        .catch(() => {
          // Failed releases remain recoverable through stale-lease recovery.
        }),
    );
    await Promise.allSettled(releasePromises);
    this.pendingClaims.clear();
    await Promise.all(Array.from(this.activeDispatches));
  }
}
