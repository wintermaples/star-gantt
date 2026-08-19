/**
 * Hostless unit tests for the ordered-strip inset model: the pure reducer, the rect
 * assignment and the placement tracker. No `Gantt.create()`, no DOM.
 */
import { describe, expect, it } from "vitest";
import {
  NO_INSETS,
  asInsetLayout,
  assignInsetRects,
  createPlacementTracker,
  reduceInsets,
  sanePositive,
} from "../../src/internal/render/insets";
import type { InsetContribution, InsetRect } from "../../src/internal/render/index";

const strip = (side: "top" | "bottom", order: number, size: number): InsetContribution => ({
  side,
  order,
  size,
});

describe("reduceInsets", () => {
  it("reserves the sum of a side's strips", () => {
    const layout = reduceInsets([
      strip("top", 0, 44),
      strip("top", 1, 20),
      strip("bottom", 0, 10),
      strip("bottom", 1, 30),
    ]);
    expect(layout.top).toBe(64);
    expect(layout.bottom).toBe(40);
  });

  it("stacks each side by ascending order, top strips before bottom ones", () => {
    const outer = strip("top", 1, 30);
    const inner = strip("top", 10, 20);
    const foot = strip("bottom", 0, 15);
    const layout = reduceInsets([inner, foot, outer]);
    expect(layout.strips.map((s) => s.contribution)).toEqual([outer, inner, foot]);
  });

  it("breaks an order tie by contribution order", () => {
    const a = strip("top", 0, 10);
    const b = strip("top", 0, 10);
    expect(reduceInsets([a, b]).strips.map((s) => s.contribution)).toEqual([a, b]);
    expect(reduceInsets([b, a]).strips.map((s) => s.contribution)).toEqual([b, a]);
  });

  it("treats a negative, non-finite or missing size as reserving nothing", () => {
    const layout = reduceInsets([
      strip("top", 0, -5),
      strip("top", 1, Number.NaN),
      strip("bottom", 0, Number.POSITIVE_INFINITY),
      { side: "bottom", order: 1 } as unknown as InsetContribution,
    ]);
    expect(layout).toMatchObject({ top: 0, bottom: 0 });
    expect(layout.strips).toHaveLength(4);
  });

  it("drops values that do not name one of the two sides", () => {
    const bad = [null, 42, { size: 50 }, { side: "left", size: 50, order: 0 }];
    const layout = reduceInsets([...(bad as unknown as InsetContribution[]), strip("top", 0, 30)]);
    expect(layout.top).toBe(30);
    expect(layout.strips).toHaveLength(1);
  });

  it("treats a non-finite order as 0 rather than sorting it to an end", () => {
    const nan = { side: "top", order: Number.NaN, size: 10 } as InsetContribution;
    const late = strip("top", 5, 10);
    expect(reduceInsets([late, nan]).strips.map((s) => s.contribution)).toEqual([nan, late]);
  });

  it("is pure: the same input twice produces equal, independent results", () => {
    const inputs = [strip("top", 0, 10), strip("bottom", 0, 20)];
    const first = reduceInsets(inputs);
    const second = reduceInsets(inputs);
    expect(second).toEqual(first);
    expect(second).not.toBe(first);
  });

  it("reserves nothing for an empty contribution list", () => {
    expect(reduceInsets([])).toEqual({ top: 0, bottom: 0, strips: [] });
  });
});

describe("asInsetLayout", () => {
  it("hands back the reducer's own value unchanged, allocating nothing", () => {
    const layout = reduceInsets([strip("top", 0, 12)]);
    expect(asInsetLayout(layout)).toBe(layout);
  });

  it("falls back to no insets for a missing reduction", () => {
    expect(asInsetLayout(undefined)).toBe(NO_INSETS);
  });

  it("sanitizes bands and supplies an empty strip list for a foreign reduced value", () => {
    expect(asInsetLayout({ top: -10, bottom: Number.NaN })).toEqual({
      top: 0,
      bottom: 0,
      strips: [],
    });
  });
});

describe("assignInsetRects", () => {
  it("stacks top strips down from the top edge and bottom strips up from the bottom edge", () => {
    const layout = reduceInsets([
      strip("top", 1, 30),
      strip("top", 10, 20),
      strip("bottom", 1, 15),
      strip("bottom", 5, 25),
    ]);
    expect(assignInsetRects(layout.strips, 640, 480).map((p) => p.rect)).toEqual([
      { x: 0, y: 0, width: 640, height: 30 },
      { x: 0, y: 30, width: 640, height: 20 },
      { x: 0, y: 465, width: 640, height: 15 },
      { x: 0, y: 440, width: 640, height: 25 },
    ]);
  });

  it("spans the full body width and keeps the contribution identity", () => {
    const one = strip("top", 0, 8);
    const [placement] = assignInsetRects(reduceInsets([one]).strips, 500, 300);
    expect(placement?.contribution).toBe(one);
    expect(placement?.rect.width).toBe(500);
  });
});

describe("createPlacementTracker", () => {
  const rect = (y: number): InsetRect => ({ x: 0, y, width: 100, height: 10 });

  it("reports a strip the first time and not again while it has not moved", () => {
    const tracker = createPlacementTracker();
    const contribution = strip("top", 0, 10);
    expect(tracker.moved([{ contribution, rect: rect(0) }])).toHaveLength(1);
    expect(tracker.moved([{ contribution, rect: rect(0) }])).toHaveLength(0);
  });

  it("reports it again once any member of its rect changes", () => {
    const tracker = createPlacementTracker();
    const contribution = strip("bottom", 0, 20);
    tracker.moved([{ contribution, rect: rect(460) }]);
    const moved = tracker.moved([{ contribution, rect: rect(280) }]);
    expect(moved.map((p) => p.rect.y)).toEqual([280]);
  });

  it("forgets a contribution that left the stack, so a re-registered one is placed again", () => {
    const tracker = createPlacementTracker();
    const contribution = strip("top", 0, 10);
    expect(tracker.moved([{ contribution, rect: rect(0) }])).toHaveLength(1);
    // The contribution is gone (its plugin was disposed, or a re-define dropped it).
    expect(tracker.moved([])).toHaveLength(0);
    // Registered again and assigned the very same rectangle: it has never been told about it.
    expect(tracker.moved([{ contribution, rect: rect(0) }])).toHaveLength(1);
  });

  it("keeps each contribution's history separate, so a new strip does not re-place the others", () => {
    const tracker = createPlacementTracker();
    const first = strip("top", 0, 10);
    const second = strip("top", 1, 10);
    tracker.moved([{ contribution: first, rect: rect(0) }]);
    const moved = tracker.moved([
      { contribution: first, rect: rect(0) },
      { contribution: second, rect: rect(10) },
    ]);
    expect(moved.map((p) => p.contribution)).toEqual([second]);
  });
});

describe("sanePositive", () => {
  it("keeps finite positives and zeroes everything else", () => {
    expect(sanePositive(12.5)).toBe(12.5);
    for (const bad of [0, -1, Number.NaN, Number.POSITIVE_INFINITY, undefined]) {
      expect(sanePositive(bad)).toBe(0);
    }
  });
});
