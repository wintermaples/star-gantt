/**
 * Hostless unit tests for the surface metrics value object and the devicePixelRatio watcher (§3.2-4).
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { createDprWatcher, paintableHeight, sameMetrics } from "../../src/internal/render/sizing";
import type { SurfaceMetrics } from "../../src/internal/render/sizing";
import { installDom } from "../_utils/index";

const metrics = (patch: Partial<SurfaceMetrics> = {}): SurfaceMetrics => ({
  width: 800,
  height: 600,
  dpr: 1,
  insetTop: 40,
  insetBottom: 10,
  ...patch,
});

let dom: ReturnType<typeof installDom> | null = null;

afterEach(() => {
  dom?.restore();
  dom = null;
});

describe("sameMetrics", () => {
  it("compares every member that changes canvas or viewport geometry", () => {
    expect(sameMetrics(metrics(), metrics())).toBe(true);
    for (const patch of [
      { width: 500 },
      { height: 300 },
      { dpr: 2 },
      { insetTop: 0 },
      { insetBottom: 0 },
    ] as Partial<SurfaceMetrics>[]) {
      expect(sameMetrics(metrics(), metrics(patch))).toBe(false);
    }
  });

  it("never matches the un-measured state", () => {
    expect(sameMetrics(null, metrics())).toBe(false);
  });
});

describe("paintableHeight", () => {
  it("excludes both reserved bands", () => {
    expect(paintableHeight(metrics())).toBe(550);
  });

  it("never goes negative, however much is reserved", () => {
    expect(paintableHeight(metrics({ height: 30 }))).toBe(0);
  });
});

describe("createDprWatcher", () => {
  it("subscribes to the ratio it observed and renews the query after a change", () => {
    dom = installDom({ dpr: 1 });
    const onChange = vi.fn(() => dom?.setDpr(2));
    const watcher = createDprWatcher(onChange);

    expect(dom.mediaQueries().map((q) => q.media)).toEqual(["(resolution: 1dppx)"]);
    dom.fireMediaChange();
    expect(onChange).toHaveBeenCalledTimes(1);
    // Renewed against the new ratio, and the stale subscription dropped.
    expect(dom.mediaQueries().map((q) => q.media)).toEqual([
      "(resolution: 1dppx)",
      "(resolution: 2dppx)",
    ]);
    expect(dom.mediaQueries()[0]?.listeners.size).toBe(0);

    watcher.dispose();
    expect(dom.mediaQueries()[1]?.listeners.size).toBe(0);
  });

  it("reports no change after disposal", () => {
    dom = installDom();
    const onChange = vi.fn();
    createDprWatcher(onChange).dispose();
    dom.fireMediaChange();
    expect(onChange).not.toHaveBeenCalled();
  });

  it("uses the legacy addListener pair when the MediaQueryList has no addEventListener", () => {
    dom = installDom({ legacyMediaQuery: true });
    const onChange = vi.fn();
    const watcher = createDprWatcher(onChange);

    dom.fireMediaChange();
    expect(onChange).toHaveBeenCalledTimes(1);
    watcher.dispose();
    expect(dom.mediaQueries()[1]?.listeners.size).toBe(0);
  });

  it("is inert in a host without matchMedia", () => {
    dom = installDom();
    const saved = (globalThis as unknown as Record<string, unknown>)["matchMedia"];
    delete (globalThis as unknown as Record<string, unknown>)["matchMedia"];
    try {
      expect(() => createDprWatcher(() => {}).dispose()).not.toThrow();
    } finally {
      (globalThis as unknown as Record<string, unknown>)["matchMedia"] = saved;
    }
  });
});
