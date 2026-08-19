/**
 * `src/internal/frame-throttle.ts` — the per-frame coalescer every grid repaint and every
 * pointer-driven announcement goes through.
 */
import type { Disposable } from "@stargantt/core";
import { afterEach, describe, expect, it, vi } from "vitest";
import { frameThrottle } from "../src/internal/frame-throttle";

type MutableGlobal = Record<string, unknown>;

interface RafHarness {
  /** Runs every queued frame callback, returning how many ran. */
  flush(): number;
  /** Runs every callback ever queued, cancelled or not — the "no `cancelAnimationFrame`" case. */
  flushIgnoringCancellation(): number;
  restore(): void;
}

/** Installs a `requestAnimationFrame` double; `cancelable: false` drops `cancelAnimationFrame`. */
function installRaf(options: { cancelable?: boolean } = {}): RafHarness {
  const g = globalThis as unknown as MutableGlobal;
  const saved = {
    requestAnimationFrame: g["requestAnimationFrame"],
    cancelAnimationFrame: g["cancelAnimationFrame"],
  };
  const queue = new Map<number, () => void>();
  const everQueued: (() => void)[] = [];
  let nextId = 1;
  g["requestAnimationFrame"] = (cb: () => void): number => {
    const id = nextId++;
    queue.set(id, cb);
    everQueued.push(cb);
    return id;
  };
  if (options.cancelable === false) delete g["cancelAnimationFrame"];
  else {
    g["cancelAnimationFrame"] = (id: number): void => {
      queue.delete(id);
    };
  }
  return {
    flush(): number {
      const batch = [...queue.values()];
      queue.clear();
      for (const cb of batch) cb();
      return batch.length;
    },
    flushIgnoringCancellation(): number {
      const batch = [...everQueued];
      everQueued.length = 0;
      queue.clear();
      for (const cb of batch) cb();
      return batch.length;
    },
    restore(): void {
      for (const [key, value] of Object.entries(saved)) {
        if (value === undefined) delete g[key];
        else g[key] = value;
      }
    },
  };
}

/** The narrow `own()` surface the throttle needs, plus the ledger a leak test inspects. */
function owner(): { own(d: Disposable): void; ledger: Disposable[] } {
  const ledger: Disposable[] = [];
  return {
    own(d: Disposable): void {
      ledger.push(d);
    },
    ledger,
  };
}

let raf: RafHarness | undefined;

afterEach(() => {
  raf?.restore();
  raf = undefined;
  vi.useRealTimers();
});

describe("frameThrottle", () => {
  it("runs the callback once per frame however often it is scheduled", () => {
    raf = installRaf();
    const host = owner();
    let runs = 0;
    const throttle = frameThrottle(host, () => {
      runs += 1;
    });

    throttle.schedule();
    throttle.schedule();
    throttle.schedule();
    expect(runs).toBe(0);
    expect(raf.flush()).toBe(1);
    expect(runs).toBe(1);
  });

  it("re-arms after firing, so the next burst gets its own frame", () => {
    raf = installRaf();
    const host = owner();
    let runs = 0;
    const throttle = frameThrottle(host, () => {
      runs += 1;
    });

    throttle.schedule();
    raf.flush();
    throttle.schedule();
    raf.flush();
    expect(runs).toBe(2);
  });

  it("drops a queued frame on cancel()", () => {
    raf = installRaf();
    const host = owner();
    let runs = 0;
    const throttle = frameThrottle(host, () => {
      runs += 1;
    });

    throttle.schedule();
    throttle.cancel();
    expect(raf.flush()).toBe(0);
    expect(runs).toBe(0);
  });

  it("cannot run a cancelled arm even where `cancelAnimationFrame` is missing", () => {
    raf = installRaf({ cancelable: false });
    const host = owner();
    let runs = 0;
    const throttle = frameThrottle(host, () => {
      runs += 1;
    });

    throttle.schedule();
    throttle.cancel();
    // The environment hands the callback back regardless; the cancelled-arm guard must swallow it.
    expect(raf.flushIgnoringCancellation()).toBe(1);
    expect(runs).toBe(0);
  });

  it("registers exactly one disposable, whatever the schedule traffic (no monotonic leak)", () => {
    raf = installRaf();
    const host = owner();
    const throttle = frameThrottle(host, () => {});
    for (let i = 0; i < 50; i += 1) {
      throttle.schedule();
      raf.flush();
    }
    expect(host.ledger.length).toBe(1);
  });

  it("cancels the pending frame when the owner disposes it", () => {
    raf = installRaf();
    const host = owner();
    let runs = 0;
    const throttle = frameThrottle(host, () => {
      runs += 1;
    });

    throttle.schedule();
    for (const d of host.ledger) d.dispose();
    expect(raf.flush()).toBe(0);
    expect(runs).toBe(0);
  });

  it("falls back to a 16 ms timer where `requestAnimationFrame` is unavailable", () => {
    vi.useFakeTimers();
    const g = globalThis as unknown as MutableGlobal;
    const savedRaf = g["requestAnimationFrame"];
    delete g["requestAnimationFrame"];
    try {
      const host = owner();
      let runs = 0;
      const throttle = frameThrottle(host, () => {
        runs += 1;
      });

      throttle.schedule();
      throttle.schedule();
      vi.advanceTimersByTime(15);
      expect(runs).toBe(0);
      vi.advanceTimersByTime(1);
      expect(runs).toBe(1);

      // The timer arm cancels too.
      throttle.schedule();
      throttle.cancel();
      vi.advanceTimersByTime(100);
      expect(runs).toBe(1);
    } finally {
      if (savedRaf === undefined) delete g["requestAnimationFrame"];
      else g["requestAnimationFrame"] = savedRaf;
    }
  });
});
