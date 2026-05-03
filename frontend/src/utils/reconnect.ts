// Pure reconnect scheduler — no React, no DOM, no store.
//
// Owns the attempt counter and backoff timer. The hook or caller decides what
// to do on each attempt (connectSfu etc.) and passes it in via `onAttempt`.
//
// Designed for testability in a node env (vi.useFakeTimers()).

export type ReconnectSchedulerOptions = {
  /** Delay (ms) for attempt 0, 1, 2, … The last entry is the cap. */
  delays: readonly number[];
  /**
   * Called when a scheduled attempt fires. Receives the 0-based attempt index
   * that is about to run. Must return a Promise: resolve = success (counter
   * resets), reject = failure (next schedule is triggered).
   */
  onAttempt: (attempt: number) => Promise<void>;
  /**
   * Called when all delay slots are exhausted without a successful connection.
   * The scheduler stops — no further attempts are made.
   */
  onExhausted: () => void;
  /**
   * Predicate checked right before each attempt fires. If it returns true the
   * attempt is skipped and the scheduler stops (user left voluntarily).
   */
  isLeaving: () => boolean;
};

export type ReconnectScheduler = {
  /** Schedule the next reconnect attempt using the current attempt counter. */
  schedule: () => void;
  /** Cancel any pending timer and reset the counter. */
  reset: () => void;
  /** Read-only view of the current attempt index (0-based). */
  readonly attemptIndex: number;
};

export function createReconnectScheduler(opts: ReconnectSchedulerOptions): ReconnectScheduler {
  let timerId: ReturnType<typeof setTimeout> | null = null;
  let attempt = 0;
  // Whether a schedule() call is already queued (timer pending).
  let pending = false;

  function reset() {
    if (timerId !== null) {
      clearTimeout(timerId);
      timerId = null;
    }
    attempt = 0;
    pending = false;
  }

  function schedule() {
    if (opts.isLeaving()) return;
    if (pending) return; // already queued

    const currentAttempt = attempt;
    if (currentAttempt >= opts.delays.length) {
      opts.onExhausted();
      return;
    }

    const delay = opts.delays[currentAttempt];
    attempt = currentAttempt + 1;
    pending = true;

    timerId = setTimeout(() => {
      timerId = null;
      pending = false;

      if (opts.isLeaving()) return;

      opts.onAttempt(currentAttempt).then(
        () => {
          // Success — reset counter so the next connection starts fresh.
          attempt = 0;
        },
        () => {
          // Failure — schedule next attempt.
          schedule();
        },
      );
    }, delay);
  }

  return {
    schedule,
    reset,
    get attemptIndex() {
      return attempt;
    },
  };
}
