/**
 * §3.3 prefetch — direct unit coverage of the pure velocity estimator and range calculator
 * (deterministic, independent of `Date.now()` timing/flakiness). Internal module, imported by
 * relative path.
 */
import { describe, expect, it } from "vitest";
import { prefetchRange, ScrollPredictor } from "../src/internal/lazy/prefetch";

describe("ScrollPredictor.sample", () => {
  it("returns undefined for the first sample (no velocity yet)", () => {
    const predictor = new ScrollPredictor();
    expect(predictor.sample({ timeMs: 0, scrollTop: 0 })).toBeUndefined();
  });

  it("returns undefined for zero elapsed time or no movement", () => {
    const predictor = new ScrollPredictor();
    predictor.sample({ timeMs: 0, scrollTop: 0 });
    expect(predictor.sample({ timeMs: 0, scrollTop: 50 })).toBeUndefined(); // dt <= 0
    const p2 = new ScrollPredictor();
    p2.sample({ timeMs: 0, scrollTop: 0 });
    expect(p2.sample({ timeMs: 100, scrollTop: 0 })).toBeUndefined(); // dy === 0
  });

  it("extrapolates 200ms ahead at the observed velocity", () => {
    const predictor = new ScrollPredictor();
    predictor.sample({ timeMs: 0, scrollTop: 0 });
    // velocity = 100px / 100ms = 1px/ms; 200ms horizon → +200px from the latest position.
    const predicted = predictor.sample({ timeMs: 100, scrollTop: 100 });
    expect(predicted).toBe(300);
  });

  it("reset() clears the previous sample", () => {
    const predictor = new ScrollPredictor();
    predictor.sample({ timeMs: 0, scrollTop: 0 });
    predictor.reset();
    expect(predictor.sample({ timeMs: 100, scrollTop: 100 })).toBeUndefined();
  });
});

describe("prefetchRange", () => {
  it("returns undefined when prefetchPages < 1", () => {
    expect(prefetchRange(0, 9, 50, 0, 10)).toBeUndefined();
  });

  it("returns undefined when the prediction stays inside the visible range", () => {
    expect(prefetchRange(0, 9, 5, 2, 10)).toBeUndefined();
  });

  it("extends forward, capped at prefetchPages pages, when the prediction is past the visible edge", () => {
    // visible [0,9], predicted row 100, prefetchPages 1, pageSize 10 → cap 10 → to = min(100, 19) = 19
    const range = prefetchRange(0, 9, 100, 1, 10);
    expect(range).toEqual({ offset: 10, limit: 10 });
  });

  it("extends backward, capped, when the prediction is before the visible edge", () => {
    const range = prefetchRange(50, 59, 10, 1, 10);
    expect(range).toEqual({ offset: 40, limit: 10 });
  });

  it("clamps the backward extension at 0", () => {
    const range = prefetchRange(5, 14, -100, 1, 10);
    expect(range).toEqual({ offset: 0, limit: 5 });
  });
});
