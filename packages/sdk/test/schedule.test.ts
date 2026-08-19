/**
 * `createFrameScheduler` (docs/specs/sdk.md, Module: sdk/frame): once-per-frame repaint batching,
 * plus its ~16ms timer fallback for a host without `requestAnimationFrame`.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { createFrameScheduler } from "../src/index";

/** A minimal rAF queue double, installed and torn down by hand — no `raf` id collisions across tests. */
function fakeRaf(): {
  flush(): number;
  cancelled(): number;
  restore(): void;
} {
  const g = globalThis as unknown as Record<string, unknown>;
  const savedRaf = g["requestAnimationFrame"];
  const savedCancel = g["cancelAnimationFrame"];
  const hadRaf = "requestAnimationFrame" in g;
  const hadCancel = "cancelAnimationFrame" in g;

  let nextId = 1;
  const queue = new Map<number, () => void>();
  let cancelled = 0;
  g["requestAnimationFrame"] = (cb: () => void): number => {
    const id = nextId++;
    queue.set(id, cb);
    return id;
  };
  g["cancelAnimationFrame"] = (id: number): void => {
    if (queue.delete(id)) cancelled += 1;
  };

  return {
    flush(): number {
      const batch = [...queue.values()];
      queue.clear();
      for (const cb of batch) cb();
      return batch.length;
    },
    cancelled: () => cancelled,
    restore(): void {
      if (hadRaf) g["requestAnimationFrame"] = savedRaf;
      else delete g["requestAnimationFrame"];
      if (hadCancel) g["cancelAnimationFrame"] = savedCancel;
      else delete g["cancelAnimationFrame"];
    },
  };
}

/** Removes rAF entirely, so the scheduler falls back to its timer path. */
function withoutRaf(): { restore(): void } {
  const g = globalThis as unknown as Record<string, unknown>;
  const savedRaf = g["requestAnimationFrame"];
  const savedCancel = g["cancelAnimationFrame"];
  const hadRaf = "requestAnimationFrame" in g;
  const hadCancel = "cancelAnimationFrame" in g;
  delete g["requestAnimationFrame"];
  delete g["cancelAnimationFrame"];
  return {
    restore(): void {
      if (hadRaf) g["requestAnimationFrame"] = savedRaf;
      if (hadCancel) g["cancelAnimationFrame"] = savedCancel;
    },
  };
}

describe("coalescing", () => {
  it("runs the callback once per frame, however many times schedule() was called", () => {
    const raf = fakeRaf();
    const run = vi.fn();
    const scheduler = createFrameScheduler(run);
    scheduler.schedule();
    scheduler.schedule();
    scheduler.schedule();
    expect(raf.flush()).toBe(1);
    expect(run).toHaveBeenCalledTimes(1);
    raf.restore();
  });

  it("accepts a new request once the pending one has fired", () => {
    const raf = fakeRaf();
    const run = vi.fn();
    const scheduler = createFrameScheduler(run);
    scheduler.schedule();
    raf.flush();
    scheduler.schedule();
    raf.flush();
    expect(run).toHaveBeenCalledTimes(2);
    raf.restore();
  });

  it("schedule() inside the running callback starts a fresh frame, not the one in progress", () => {
    const raf = fakeRaf();
    let calls = 0;
    const scheduler = createFrameScheduler(() => {
      calls += 1;
      if (calls === 1) scheduler.schedule();
    });
    scheduler.schedule();
    raf.flush();
    expect(calls).toBe(1);
    raf.flush();
    expect(calls).toBe(2);
    raf.restore();
  });
});

describe("timer fallback", () => {
  it("uses a ~16ms timer when requestAnimationFrame does not exist", () => {
    vi.useFakeTimers();
    const disabled = withoutRaf();
    const run = vi.fn();
    const scheduler = createFrameScheduler(run);
    scheduler.schedule();
    expect(run).not.toHaveBeenCalled();
    vi.advanceTimersByTime(16);
    expect(run).toHaveBeenCalledTimes(1);
    disabled.restore();
    vi.useRealTimers();
  });

  it("coalesces repeated schedule() calls onto the same timer", () => {
    vi.useFakeTimers();
    const disabled = withoutRaf();
    const run = vi.fn();
    const scheduler = createFrameScheduler(run);
    scheduler.schedule();
    scheduler.schedule();
    scheduler.schedule();
    vi.advanceTimersByTime(16);
    expect(run).toHaveBeenCalledTimes(1);
    disabled.restore();
    vi.useRealTimers();
  });
});

describe("dispose", () => {
  it("cancels a pending rAF-scheduled run", () => {
    const raf = fakeRaf();
    const run = vi.fn();
    const scheduler = createFrameScheduler(run);
    scheduler.schedule();
    scheduler.dispose();
    expect(raf.flush()).toBe(0);
    expect(run).not.toHaveBeenCalled();
    expect(raf.cancelled()).toBe(1);
    raf.restore();
  });

  it("cancels a pending timer-scheduled run", () => {
    vi.useFakeTimers();
    const disabled = withoutRaf();
    const run = vi.fn();
    const scheduler = createFrameScheduler(run);
    scheduler.schedule();
    scheduler.dispose();
    vi.advanceTimersByTime(100);
    expect(run).not.toHaveBeenCalled();
    disabled.restore();
    vi.useRealTimers();
  });

  it("is a no-op with nothing pending", () => {
    const raf = fakeRaf();
    const scheduler = createFrameScheduler(vi.fn());
    expect(() => scheduler.dispose()).not.toThrow();
    raf.restore();
  });

  // Characterization: `dispose()` does not latch the scheduler shut. A `ctx.own()`-shaped
  // disposable is expected to make its owner's *own* further calls into it inert, but this one has
  // no "disposed" flag — `schedule()` after `dispose()` arms a new run exactly as it would have
  // before, rather than being silently swallowed. Documented here so a future change to that
  // behaviour is a deliberate one, not a regression nobody noticed.
  it("still schedules a run after dispose() — schedule() is not disposed-aware", () => {
    const raf = fakeRaf();
    const run = vi.fn();
    const scheduler = createFrameScheduler(run);
    scheduler.dispose();
    scheduler.schedule();
    expect(raf.flush()).toBe(1);
    expect(run).toHaveBeenCalledTimes(1);
    raf.restore();
  });
});
