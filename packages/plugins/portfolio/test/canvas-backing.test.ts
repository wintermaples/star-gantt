// Hostless unit tests for the panel's DPR-exact canvas backing (docs/specs/plugins/portfolio.md
// §3.6): `syncChartBacking`'s CSS-size × dpr sizing and no-op-when-unchanged guard, and
// `watchDpr`/`watchResize`'s re-arming and disposal. Built on minimal fake `Document`/`view`
// doubles (the same "fake context" idiom `tracking`'s canvas-paint suites use) rather than a real
// canvas backend, which vitest's environments do not provide.
import { describe, expect, it, vi } from "vitest";
import { currentDpr, syncChartBacking, watchDpr, watchResize } from "../src/internal/dashboard/canvas-backing";

function fakeCanvasAndContext(): {
  canvas: HTMLCanvasElement;
  g: CanvasRenderingContext2D;
  setTransformCalls: unknown[][];
  scaleCalls: unknown[][];
} {
  const setTransformCalls: unknown[][] = [];
  const scaleCalls: unknown[][] = [];
  const canvas = { width: 0, height: 0 } as unknown as HTMLCanvasElement;
  const g = {
    setTransform: (...args: unknown[]) => setTransformCalls.push(args),
    scale: (...args: unknown[]) => scaleCalls.push(args),
  } as unknown as CanvasRenderingContext2D;
  return { canvas, g, setTransformCalls, scaleCalls };
}

describe("currentDpr", () => {
  it("reads the view's devicePixelRatio, defaulting to 1 when unusable or absent", () => {
    expect(currentDpr({ defaultView: { devicePixelRatio: 3 } } as unknown as Document)).toBe(3);
    expect(currentDpr({ defaultView: { devicePixelRatio: 0 } } as unknown as Document)).toBe(1);
    expect(currentDpr({ defaultView: { devicePixelRatio: Number.NaN } } as unknown as Document)).toBe(1);
    expect(currentDpr({ defaultView: {} } as unknown as Document)).toBe(1);
  });
});

describe("syncChartBacking", () => {
  it("sizes the backing store to CSS size × dpr and resets the transform before scaling", () => {
    const { canvas, g, setTransformCalls, scaleCalls } = fakeCanvasAndContext();
    const resized = syncChartBacking(canvas, g, 100, 50, 2);
    expect(resized).toBe(true);
    expect(canvas.width).toBe(200);
    expect(canvas.height).toBe(100);
    expect(setTransformCalls).toEqual([[1, 0, 0, 1, 0, 0]]);
    expect(scaleCalls).toEqual([[2, 2]]);
  });

  it("is a no-op — no resize, no transform reset, no scale — when the target backing already matches", () => {
    const { canvas, g, setTransformCalls, scaleCalls } = fakeCanvasAndContext();
    syncChartBacking(canvas, g, 100, 50, 2);
    setTransformCalls.length = 0;
    scaleCalls.length = 0;
    const resized = syncChartBacking(canvas, g, 100, 50, 2);
    expect(resized).toBe(false);
    expect(canvas.width).toBe(200);
    expect(canvas.height).toBe(100);
    expect(setTransformCalls).toEqual([]);
    expect(scaleCalls).toEqual([]);
  });

  it("resizes again once the CSS size or dpr actually changes", () => {
    const { canvas, g } = fakeCanvasAndContext();
    syncChartBacking(canvas, g, 100, 50, 1);
    expect(canvas.width).toBe(100);
    const resized = syncChartBacking(canvas, g, 100, 50, 2);
    expect(resized).toBe(true);
    expect(canvas.width).toBe(200);
    expect(canvas.height).toBe(100);
  });

  it("rounds and floors the backing to at least 1px on either axis", () => {
    const { canvas, g } = fakeCanvasAndContext();
    syncChartBacking(canvas, g, 0.2, 0.2, 1);
    expect(canvas.width).toBe(1);
    expect(canvas.height).toBe(1);
  });
});

/** A controllable fake `matchMedia` view: tracks the live subscription and lets a test fire it. */
function fakeDprView(initialDpr: number) {
  let dpr = initialDpr;
  let current: { query: string; fn: () => void } | null = null;
  let removedCount = 0;
  const matchMedia = vi.fn((query: string) => {
    return {
      addEventListener: (_type: string, fn: () => void) => {
        current = { query, fn };
      },
      removeEventListener: (_type: string, fn: () => void) => {
        if (current?.fn === fn) current = null;
        removedCount += 1;
      },
    } as unknown as MediaQueryList;
  });
  return {
    view: {
      matchMedia,
      get devicePixelRatio() {
        return dpr;
      },
    },
    setDpr: (next: number) => {
      dpr = next;
    },
    fireChange: () => current?.fn(),
    currentQuery: () => current?.query,
    removedCount: () => removedCount,
    matchMedia,
  };
}

describe("watchDpr", () => {
  it("re-arms a fresh subscription pinned to the new ratio after every change, and reports it", () => {
    const fake = fakeDprView(1);
    const doc = { defaultView: fake.view } as unknown as Document;
    const changes: number[] = [];
    const watcher = watchDpr(doc, () => changes.push(currentDpr(doc)));
    expect(fake.matchMedia).toHaveBeenCalledTimes(1);
    expect(fake.currentQuery()).toContain("1dppx");

    fake.setDpr(2);
    fake.fireChange();
    expect(changes).toEqual([2]);
    // A fresh subscription was armed at the new ratio, not the stale one.
    expect(fake.matchMedia).toHaveBeenCalledTimes(2);
    expect(fake.currentQuery()).toContain("2dppx");

    fake.setDpr(3);
    fake.fireChange();
    expect(changes).toEqual([2, 3]);
    expect(fake.matchMedia).toHaveBeenCalledTimes(3);

    watcher.dispose();
  });

  it("disposes the live subscription so no later change reports", () => {
    const fake = fakeDprView(1);
    const doc = { defaultView: fake.view } as unknown as Document;
    const changes: number[] = [];
    const watcher = watchDpr(doc, () => changes.push(1));
    watcher.dispose();
    expect(fake.removedCount()).toBe(1);
    fake.fireChange(); // the removed handler is gone; nothing fires
    expect(changes).toEqual([]);
  });

  it("never reports when the view has no matchMedia (arm() no-ops)", () => {
    const doc = { defaultView: {} } as unknown as Document;
    expect(() => watchDpr(doc, () => undefined).dispose()).not.toThrow();
  });
});

/** A controllable fake `ResizeObserver` view. */
function fakeResizeView() {
  const instances: { cb: () => void; observed: unknown[]; disconnected: boolean }[] = [];
  class FakeResizeObserver {
    private readonly _cb: () => void;
    observed: unknown[] = [];
    disconnected = false;
    constructor(cb: () => void) {
      this._cb = cb;
      instances.push(this);
    }
    observe(target: unknown): void {
      this.observed.push(target);
    }
    disconnect(): void {
      this.disconnected = true;
    }
    fire(): void {
      this._cb();
    }
  }
  return { view: { ResizeObserver: FakeResizeObserver }, instances: instances as unknown as FakeResizeObserver[] };
}

describe("watchResize", () => {
  it("observes the target and reports every border-box change; disposes via disconnect", () => {
    const { view, instances } = fakeResizeView();
    const doc = { defaultView: view } as unknown as Document;
    const target = {} as Element;
    let calls = 0;
    const watcher = watchResize(doc, target, () => {
      calls += 1;
    });
    expect(instances).toHaveLength(1);
    expect(instances[0]?.observed).toEqual([target]);
    (instances[0] as unknown as { fire(): void }).fire();
    expect(calls).toBe(1);
    watcher.dispose();
    expect(instances[0]?.disconnected).toBe(true);
  });

  it("never reports when the view has no ResizeObserver", () => {
    const doc = { defaultView: {} } as unknown as Document;
    expect(() => watchResize(doc, {} as Element, () => undefined).dispose()).not.toThrow();
  });
});
