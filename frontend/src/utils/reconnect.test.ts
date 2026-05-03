// Characterization tests for createReconnectScheduler.
//
// These tests pin CURRENT behaviour. If a bug is found while writing them it
// is surfaced but NOT fixed here — that is a separate concern.
//
// Uses vi.useFakeTimers() — no DOM, no React, pure node env.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createReconnectScheduler } from "./reconnect";

const DELAYS = [1000, 2000, 4000, 8000, 15000, 30000, 30000] as const;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeOpts(overrides: {
  onAttempt?: (attempt: number) => Promise<void>;
  onExhausted?: () => void;
  isLeaving?: () => boolean;
}) {
  return {
    delays: DELAYS,
    onAttempt: overrides.onAttempt ?? (() => Promise.resolve()),
    onExhausted: overrides.onExhausted ?? vi.fn(),
    isLeaving: overrides.isLeaving ?? (() => false),
  };
}

// ---------------------------------------------------------------------------
// Setup / teardown
// ---------------------------------------------------------------------------

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

// ---------------------------------------------------------------------------
// Exponential backoff progression
// ---------------------------------------------------------------------------

describe("backoff progression", () => {
  it("fires first attempt after 1000 ms", async () => {
    const fired: number[] = [];
    const sched = createReconnectScheduler(
      makeOpts({
        onAttempt: async (i) => {
          fired.push(i);
          throw new Error("fail");
        },
      }),
    );

    sched.schedule();
    expect(fired).toHaveLength(0); // nothing yet

    await vi.advanceTimersByTimeAsync(999);
    expect(fired).toHaveLength(0);

    await vi.advanceTimersByTimeAsync(1); // now at 1000 ms total
    expect(fired).toEqual([0]);
  });

  it("fires second attempt after cumulative 3000 ms (1000 + 2000)", async () => {
    const fired: number[] = [];
    const sched = createReconnectScheduler(
      makeOpts({
        onAttempt: async (i) => {
          fired.push(i);
          throw new Error("fail");
        },
      }),
    );

    sched.schedule();
    await vi.advanceTimersByTimeAsync(1000); // attempt 0 fires, fails, schedules next
    await vi.advanceTimersByTimeAsync(1999); // still before 2000 ms for attempt 1
    expect(fired).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1); // now +2000 ms after first attempt → attempt 1
    expect(fired).toEqual([0, 1]);
  });

  it("fires all 7 attempts at the correct cumulative delays", async () => {
    const fired: number[] = [];
    const sched = createReconnectScheduler(
      makeOpts({
        onAttempt: async (i) => {
          fired.push(i);
          throw new Error("fail");
        },
        onExhausted: vi.fn(),
      }),
    );

    sched.schedule();

    const cumulativeMs = [1000, 3000, 7000, 15000, 30000, 60000, 90000];
    for (let i = 0; i < cumulativeMs.length; i++) {
      const nextMs = i === 0 ? cumulativeMs[0] : cumulativeMs[i] - cumulativeMs[i - 1];
      await vi.advanceTimersByTimeAsync(nextMs);
      expect(fired).toHaveLength(i + 1);
      expect(fired[i]).toBe(i);
    }
  });
});

// ---------------------------------------------------------------------------
// Cap behaviour — after the last delay slot, onExhausted is called
// ---------------------------------------------------------------------------

describe("cap / exhaustion behaviour", () => {
  it("calls onExhausted after all delay slots are consumed", async () => {
    const exhausted = vi.fn();
    const sched = createReconnectScheduler(
      makeOpts({
        onAttempt: async () => {
          throw new Error("fail");
        },
        onExhausted: exhausted,
      }),
    );

    sched.schedule();

    // Advance through all 7 attempts
    await vi.advanceTimersByTimeAsync(1000); // attempt 0
    await vi.advanceTimersByTimeAsync(2000); // attempt 1
    await vi.advanceTimersByTimeAsync(4000); // attempt 2
    await vi.advanceTimersByTimeAsync(8000); // attempt 3
    await vi.advanceTimersByTimeAsync(15000); // attempt 4
    await vi.advanceTimersByTimeAsync(30000); // attempt 5
    await vi.advanceTimersByTimeAsync(30000); // attempt 6

    expect(exhausted).toHaveBeenCalledTimes(1);
  });

  it("makes no further attempts after exhaustion", async () => {
    const fired: number[] = [];
    const sched = createReconnectScheduler(
      makeOpts({
        onAttempt: async (i) => {
          fired.push(i);
          throw new Error("fail");
        },
        onExhausted: vi.fn(),
      }),
    );

    sched.schedule();

    // Burn through all delays
    await vi.advanceTimersByTimeAsync(1000 + 2000 + 4000 + 8000 + 15000 + 30000 + 30000);

    const countAfterExhaustion = fired.length;
    // Extra time passes — no new attempts
    await vi.advanceTimersByTimeAsync(60000);
    expect(fired).toHaveLength(countAfterExhaustion);
  });
});

// ---------------------------------------------------------------------------
// isLeaving — early exit cancels the pending attempt
// ---------------------------------------------------------------------------

describe("isLeaving guard", () => {
  it("does not fire an attempt if isLeaving is true before schedule() is called", async () => {
    const fired: number[] = [];
    const sched = createReconnectScheduler(
      makeOpts({
        onAttempt: async (i) => {
          fired.push(i);
        },
        isLeaving: () => true,
      }),
    );

    sched.schedule();
    await vi.advanceTimersByTimeAsync(5000);
    expect(fired).toHaveLength(0);
  });

  it("skips the attempt when isLeaving becomes true mid-backoff", async () => {
    const fired: number[] = [];
    let leaving = false;
    const sched = createReconnectScheduler(
      makeOpts({
        onAttempt: async (i) => {
          fired.push(i);
          throw new Error("fail");
        },
        isLeaving: () => leaving,
      }),
    );

    sched.schedule();
    // Let the first attempt fire and fail
    await vi.advanceTimersByTimeAsync(1000);
    expect(fired).toHaveLength(1);

    // User leaves during the 2000 ms window before attempt 1
    leaving = true;

    await vi.advanceTimersByTimeAsync(2000); // timer fires but isLeaving check gates it
    expect(fired).toHaveLength(1); // no new attempt
  });

  it("does not schedule if isLeaving is already true at schedule() call", async () => {
    const fired: number[] = [];
    let leaving = false;
    const sched = createReconnectScheduler(
      makeOpts({
        onAttempt: async (i) => {
          fired.push(i);
          throw new Error("fail");
        },
        isLeaving: () => leaving,
      }),
    );

    // schedule, then user leaves before the timer fires
    sched.schedule();
    leaving = true;
    await vi.advanceTimersByTimeAsync(5000);
    expect(fired).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Reset on success
// ---------------------------------------------------------------------------

describe("reset on success", () => {
  it("resets the attempt counter to 0 after a successful onAttempt", async () => {
    let callCount = 0;
    const sched = createReconnectScheduler(
      makeOpts({
        onAttempt: async () => {
          callCount++;
          if (callCount === 1) throw new Error("first attempt fails");
          // second attempt succeeds — no throw
        },
      }),
    );

    sched.schedule();

    // First attempt fires and fails
    await vi.advanceTimersByTimeAsync(1000);
    expect(callCount).toBe(1);
    expect(sched.attemptIndex).toBe(2); // was incremented before timer, then auto-schedules again → 2

    // Second attempt fires (after 2000 ms delay) and succeeds
    await vi.advanceTimersByTimeAsync(2000);
    expect(callCount).toBe(2);
    expect(sched.attemptIndex).toBe(0); // reset to 0 after success
  });

  it("after a reset(), a fresh schedule() starts from delay[0] again", async () => {
    const fired: number[] = [];
    const sched = createReconnectScheduler(
      makeOpts({
        onAttempt: async (i) => {
          fired.push(i);
          throw new Error("fail");
        },
      }),
    );

    // Burn two attempts
    sched.schedule();
    await vi.advanceTimersByTimeAsync(1000); // attempt 0
    await vi.advanceTimersByTimeAsync(2000); // attempt 1
    expect(fired).toEqual([0, 1]);

    // Reset and start fresh
    sched.reset();
    expect(sched.attemptIndex).toBe(0);
    sched.schedule();

    await vi.advanceTimersByTimeAsync(999);
    expect(fired).toHaveLength(2); // nothing yet

    await vi.advanceTimersByTimeAsync(1); // 1000 ms → fires with index 0 again
    expect(fired).toEqual([0, 1, 0]);
  });
});

// ---------------------------------------------------------------------------
// Idempotency — duplicate schedule() calls do not double-queue
// ---------------------------------------------------------------------------

describe("idempotency", () => {
  it("calling schedule() twice before the timer fires does not double-queue", async () => {
    const fired: number[] = [];
    const sched = createReconnectScheduler(
      makeOpts({
        onAttempt: async (i) => {
          fired.push(i);
        },
      }),
    );

    sched.schedule();
    sched.schedule(); // second call ignored while timer is pending
    await vi.advanceTimersByTimeAsync(1000);
    expect(fired).toHaveLength(1);
  });
});
