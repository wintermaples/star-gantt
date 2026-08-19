/** Hostless unit tests for progressive detail and the scroll predictor (contract §6.3 / §6.5). */
import { describe, expect, it } from "vitest";
import { createProgressiveDetail } from "../../src/internal/render/progressive";
import { createScrollPredictor } from "../../src/internal/render/prefetch";
import type { Viewport } from "../../src/internal/render/index";

/** A hand-cranked timer: `fire()` runs the armed callback, as a fake clock would. */
function fakeTimer(): {
  set(fn: () => void, ms: number): unknown;
  clear(handle: unknown): void;
  fire(): void;
  armed(): boolean;
  lastDelay(): number | undefined;
} {
  let current: (() => void) | null = null;
  let delay: number | undefined;
  let id = 0;
  return {
    set(fn, ms) {
      current = fn;
      delay = ms;
      return ++id;
    },
    clear() {
      current = null;
    },
    fire() {
      const fn = current;
      current = null;
      fn?.();
    },
    armed: () => current !== null,
    lastDelay: () => delay,
  };
}

describe("createProgressiveDetail", () => {
  it("is coarse after a scroll and fine again after the quiet period fires one refine", () => {
    const timer = fakeTimer();
    let refines = 0;
    const p = createProgressiveDetail({
      enabled: true,
      onRefine: () => {
        refines += 1;
      },
      setTimer: timer.set,
      clearTimer: timer.clear,
    });
    expect(p.detail()).toBe("fine");
    p.noteScroll();
    expect(p.detail()).toBe("coarse");
    timer.fire();
    expect(p.detail()).toBe("fine");
    expect(refines).toBe(1);
  });

  it("re-arms one timer per scroll burst instead of stacking timers", () => {
    const timer = fakeTimer();
    let refines = 0;
    const p = createProgressiveDetail({
      enabled: true,
      onRefine: () => {
        refines += 1;
      },
      setTimer: timer.set,
      clearTimer: timer.clear,
    });
    p.noteScroll();
    p.noteScroll();
    p.noteScroll();
    timer.fire();
    expect(refines).toBe(1); // earlier arms were cleared, not left to fire
    expect(timer.armed()).toBe(false);
  });

  it("uses the default 150ms quiet period and honors an override", () => {
    const timer = fakeTimer();
    createProgressiveDetail({
      enabled: true,
      onRefine: () => {},
      setTimer: timer.set,
      clearTimer: timer.clear,
    }).noteScroll();
    expect(timer.lastDelay()).toBe(150);
  });

  it("disabled, it reports no detail and never arms a timer", () => {
    const timer = fakeTimer();
    const p = createProgressiveDetail({
      enabled: false,
      onRefine: () => {},
      setTimer: timer.set,
      clearTimer: timer.clear,
    });
    p.noteScroll();
    expect(p.detail()).toBeUndefined();
    expect(timer.armed()).toBe(false);
  });

  it("dispose clears an armed timer", () => {
    const timer = fakeTimer();
    const p = createProgressiveDetail({
      enabled: true,
      onRefine: () => {},
      setTimer: timer.set,
      clearTimer: timer.clear,
    });
    p.noteScroll();
    p.dispose();
    expect(timer.armed()).toBe(false);
  });
});

describe("createScrollPredictor", () => {
  const vp: Viewport = { scrollTop: 0, scrollLeft: 0, width: 800, height: 600 };

  it("extrapolates the scroll velocity leadMs ahead", () => {
    let t = 0;
    const p = createScrollPredictor({ enabled: true, leadMs: 100, now: () => t });
    p.sample(0, 0);
    t = 100;
    p.sample(50, 20); // 0.5 px/ms right, 0.2 px/ms down
    const predicted = p.predict(vp);
    expect(predicted).toEqual({ scrollLeft: 100, scrollTop: 40, width: 800, height: 600 });
  });

  it("clamps predictions to non-negative offsets", () => {
    let t = 0;
    const p = createScrollPredictor({ enabled: true, leadMs: 1000, now: () => t });
    p.sample(100, 0);
    t = 100;
    p.sample(50, 0); // moving left fast
    expect(p.predict(vp)?.scrollLeft).toBe(0);
  });

  it("predicts nothing before two samples, when stale, when still, or when disabled", () => {
    let t = 0;
    const p = createScrollPredictor({ enabled: true, staleMs: 250, now: () => t });
    expect(p.predict(vp)).toBeUndefined();
    p.sample(0, 0);
    expect(p.predict(vp)).toBeUndefined(); // one sample
    t = 50;
    p.sample(0, 0);
    expect(p.predict(vp)).toBeUndefined(); // not moving
    t = 100;
    p.sample(10, 0);
    t = 500;
    expect(p.predict(vp)).toBeUndefined(); // stale

    const off = createScrollPredictor({ enabled: false });
    off.sample(0, 0);
    off.sample(10, 10);
    expect(off.predict(vp)).toBeUndefined();
  });
});
