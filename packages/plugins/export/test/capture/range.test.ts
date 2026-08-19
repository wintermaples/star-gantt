import { describe, expect, it } from "vitest";
import { TILE_HEIGHT, TILE_WIDTH, planRange, taskExtent } from "../../src/internal/capture/range";
import type { PlanInput, ScaleLike } from "../../src/internal/capture/range";
import type { Viewport } from "@stargantt/plugin-view";

const scale: ScaleLike = { tToX: (t) => t / 10, xToT: (x) => x * 10 };

function viewport(over: Partial<Viewport> = {}): Viewport {
  return { scrollTop: 0, scrollLeft: 0, width: 800, height: 600, ...over };
}

function input(over: Partial<PlanInput> = {}): PlanInput {
  return { viewport: viewport(), scale, ...over };
}

// docs/specs/plugins/export.md §1.1 "range" / "Row coverage"
describe("range: \"viewport\" (default)", () => {
  it("is one tile covering the visible viewport, on both axes", () => {
    const plan = planRange(
      undefined,
      input({ viewport: viewport({ scrollLeft: 120, scrollTop: 90 }) }),
    );
    expect(plan).toMatchObject({ x: 120, width: 800, y: 90, height: 600, viewportOnly: true });
    expect(plan.columns).toHaveLength(1);
    expect(plan.columns[0]).toMatchObject({ x: 0, width: 800, scrollLeft: 120 });
    expect(plan.rows).toEqual([{ y: 0, height: 600, scrollTop: 90 }]);
  });

  it("agrees with the explicit \"viewport\" form", () => {
    const a = planRange(undefined, input());
    const b = planRange("viewport", input());
    expect(b).toEqual(a);
  });

  it("keeps the visible rows even when the whole content is taller (§1.1)", () => {
    const plan = planRange(
      "viewport",
      input({ viewport: viewport({ scrollTop: 300 }), contentHeight: 10_000 }),
    );
    expect(plan).toMatchObject({ y: 300, height: 600 });
    expect(plan.rows).toEqual([{ y: 0, height: 600, scrollTop: 300 }]);
  });

  it("carries each column's time span when a scale is present, and zeroes it otherwise", () => {
    const withScale = planRange(undefined, input({ viewport: viewport({ scrollLeft: 100 }) }));
    expect(withScale.columns[0]).toMatchObject({ start: 1000, end: 9000 });

    const without = planRange(undefined, input({ scale: undefined }));
    expect(without.columns[0]).toMatchObject({ start: 0, end: 0 });
  });
});

describe("range: \"full\"", () => {
  it("spans the task extent, tiled through virtual viewports", () => {
    const plan = planRange("full", input({ extent: { start: 0, end: 30_000 } }));
    // 30_000 ms / 10 = 3000 px, walked in TILE_WIDTH (1024) columns — the viewport does not cap it
    // any more: every tile is rendered off-screen through `renderTo` (§1.1 "Tiled composition").
    expect(plan).toMatchObject({ x: 0, width: 3000, viewportOnly: false });
    expect(plan.columns.map((c) => c.width)).toEqual([1024, 1024, 952]);
    expect(plan.columns.map((c) => c.x)).toEqual([0, 1024, 2048]);
    expect(plan.columns.map((c) => c.scrollLeft)).toEqual([0, 1024, 2048]);
  });

  it("covers every row when the content height is reachable (§1.1)", () => {
    const plan = planRange(
      "full",
      input({
        viewport: viewport({ scrollTop: 500, height: 600 }),
        extent: { start: 0, end: 10_000 },
        contentHeight: 2500,
        tileHeight: 1000,
      }),
    );
    expect(plan).toMatchObject({ y: 0, height: 2500 });
    expect(plan.rows).toEqual([
      { y: 0, height: 1000, scrollTop: 0 },
      { y: 1000, height: 1000, scrollTop: 1000 },
      { y: 2000, height: 500, scrollTop: 2000 },
    ]);
  });

  it("keeps the visible rows when no content height is reachable", () => {
    const plan = planRange(
      "full",
      input({ viewport: viewport({ scrollTop: 60 }), extent: { start: 0, end: 10_000 } }),
    );
    expect(plan).toMatchObject({ y: 60, height: 600 });
    expect(plan.rows).toHaveLength(1);
  });

  it("tiles never overlap and exactly cover the area on both axes", () => {
    const plan = planRange(
      "full",
      input({ extent: { start: 0, end: 25_500 }, contentHeight: 2_300 }),
    );
    let x = 0;
    for (const column of plan.columns) {
      expect(column.x).toBe(x);
      x += column.width;
    }
    expect(x).toBe(plan.width);

    let y = 0;
    for (const row of plan.rows) {
      expect(row.y).toBe(y);
      expect(row.scrollTop).toBe(plan.y + y);
      y += row.height;
    }
    expect(y).toBe(plan.height);
  });

  it("falls back to the viewport — both axes — when no task is dated", () => {
    const plan = planRange("full", input({ extent: undefined, contentHeight: 9_000 }));
    expect(plan).toMatchObject({ x: 0, width: 800, height: 600, viewportOnly: true });
    expect(plan.rows).toHaveLength(1);
  });

  // §1.1 — the "missing timeline-scale service" degradation is unreachable: the export
  // plugin's real wiring always has a scale (the hard `view` dependency co-provides
  // `stargantt.timeline`), so this branch cannot fire through the facade. `planRange` itself is
  // still a pure function whose `scale` parameter stays optional, so this hostless test exercises
  // the branch directly.
  it("falls back to the viewport when no timeline scale is supplied", () => {
    const plan = planRange(
      "full",
      input({ scale: undefined, extent: { start: 0, end: 9e6 }, contentHeight: 9_000 }),
    );
    expect(plan.width).toBe(800);
    expect(plan.height).toBe(600);
  });
});

describe("range: { start, end }", () => {
  it("exports the explicit epoch-ms range", () => {
    const plan = planRange({ start: 5_000, end: 15_000 }, input({ tileWidth: 800 }));
    expect(plan).toMatchObject({ x: 500, width: 1000, viewportOnly: false });
    expect(plan.columns.map((c) => c.scrollLeft)).toEqual([500, 1300]);
    expect(plan.columns[0]).toMatchObject({ start: 5000, end: 13_000 });
  });

  it("is time-only but still covers every row (§1.1)", () => {
    const plan = planRange({ start: 0, end: 1_000 }, input({ contentHeight: 1_500 }));
    expect(plan).toMatchObject({ y: 0, height: 1500 });
    expect(plan.rows.map((r) => r.height)).toEqual([1024, 476]);
  });

  it("accepts a reversed range and a degenerate one falls back to the viewport", () => {
    expect(planRange({ start: 15_000, end: 5_000 }, input()).width).toBe(1000);
    expect(planRange({ start: 5_000, end: 5_000 }, input()).width).toBe(800);
    expect(planRange({ start: Number.NaN, end: 5_000 }, input()).width).toBe(800);
  });

  // §1.1 — `planRange` stays pure (never throws); it just tags *why* it fell back so the facade's
  // `begin()` can turn "degenerate" into a rejection.
  it("tags a non-finite or sub-pixel explicit range as \"degenerate\", nothing else", () => {
    expect(planRange({ start: Number.NaN, end: 5_000 }, input()).fallbackReason).toBe("degenerate");
    expect(planRange({ start: 5_000, end: 5_000 }, input()).fallbackReason).toBe("degenerate");
    expect(planRange({ start: 5_000, end: 15_000 }, input()).fallbackReason).toBeUndefined();
    expect(planRange({ start: 15_000, end: 5_000 }, input()).fallbackReason).toBeUndefined();
  });

  it("judges the sub-pixel test at the export's resolution, not in CSS px (§1.1)", () => {
    // 6 ms → 0.6 CSS px. At pixelRatio 2 that is 1.2 exported pixels: a legal explicit range.
    const fine = { start: 5_000, end: 5_006 };
    expect(planRange(fine, input()).fallbackReason).toBe("degenerate");
    expect(planRange(fine, input({ pixelRatio: 2 })).fallbackReason).toBeUndefined();
    // 15 ms → 1.5 CSS px but only 0.75 exported px at ratio 0.5: degenerate at that resolution.
    expect(planRange({ start: 5_000, end: 5_015 }, input({ pixelRatio: 0.5 })).fallbackReason).toBe(
      "degenerate",
    );
    // An unusable ratio falls back to 1 (CSS px judgement).
    expect(planRange(fine, input({ pixelRatio: Number.NaN })).fallbackReason).toBe("degenerate");
  });
});

describe("fallbackReason (§1.1)", () => {
  it("is \"requested\" when range is omitted or \"viewport\"", () => {
    expect(planRange(undefined, input()).fallbackReason).toBe("requested");
    expect(planRange("viewport", input()).fallbackReason).toBe("requested");
  });

  it("is \"no-scale\" when no timeline scale is supplied", () => {
    const plan = planRange(
      "full",
      input({ scale: undefined, extent: { start: 0, end: 9e6 } }),
    );
    expect(plan.fallbackReason).toBe("no-scale");
  });

  it("is \"no-extent\" when \"full\" has no dated task to compute an extent from", () => {
    const plan = planRange("full", input({ extent: undefined }));
    expect(plan.fallbackReason).toBe("no-extent");
  });

  it("is undefined (no fallback) for a resolvable explicit range", () => {
    expect(planRange({ start: 5_000, end: 15_000 }, input()).fallbackReason).toBeUndefined();
  });

  // §1.1 — a zero-width extent (milestone-only schedule) is a valid "full" extent, not a
  // "no-extent" fallback; it gets a minimal one-content-px width instead.
  it("is a valid extent (not a fallback) when the task extent is zero-width", () => {
    const plan = planRange("full", input({ extent: { start: 5_000, end: 5_000 } }));
    expect(plan.fallbackReason).toBeUndefined();
    expect(plan.viewportOnly).toBe(false);
    expect(plan.width).toBe(1);
    expect(plan.x).toBe(500); // scale.tToX(5000) = 500
    expect(plan.columns).toEqual([{ x: 0, width: 1, scrollLeft: 500, start: 5000, end: 5010 }]);
  });
});

describe("tiling", () => {
  it("uses the internal tile size, independent of the viewport", () => {
    const plan = planRange("full", {
      viewport: viewport({ width: 4000, height: 4000 }),
      scale,
      extent: { start: 0, end: 30_000 },
      contentHeight: 3000,
    });
    expect(plan.columns[0]?.width).toBe(TILE_WIDTH);
    expect(plan.rows[0]?.height).toBe(TILE_HEIGHT);
  });

  it("honours overridden tile sizes", () => {
    const plan = planRange(
      { start: 0, end: 2_500 },
      input({ tileWidth: 100, tileHeight: 40, contentHeight: 90 }),
    );
    expect(plan.columns.map((c) => c.width)).toEqual([100, 100, 50]);
    expect(plan.rows.map((r) => r.height)).toEqual([40, 40, 10]);
  });
});

describe("taskExtent", () => {
  it("is the earliest start and the latest end", () => {
    expect(
      taskExtent([
        { start: 30, end: 40 },
        { start: 10, end: 20 },
        { start: 25, end: 90 },
      ]),
    ).toEqual({ start: 10, end: 90 });
  });

  it("ignores non-finite dates and reports nothing for an empty or undated store", () => {
    expect(taskExtent([])).toBeUndefined();
    expect(taskExtent([{ start: Number.NaN, end: Number.NaN }])).toBeUndefined();
    expect(taskExtent([{ start: 5, end: Number.NaN }, { start: 1, end: 9 }])).toEqual({
      start: 1,
      end: 9,
    });
  });

  // §1.1 — a milestone-only store (every task's start === end) is a valid zero-width extent, not
  // "no extent".
  it("reports a zero-width extent for a milestone-only store", () => {
    expect(taskExtent([{ start: 5_000, end: 5_000 }])).toEqual({ start: 5_000, end: 5_000 });
    expect(
      taskExtent([
        { start: 5_000, end: 5_000 },
        { start: 3_000, end: 3_000 },
      ]),
    ).toEqual({ start: 3_000, end: 5_000 });
  });
});
