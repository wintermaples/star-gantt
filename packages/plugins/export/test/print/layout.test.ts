/** Pure pagination math: option resolution, paper geometry, page-grid planning. */
import { describe, expect, it } from "vitest";
import {
  COLUMN_WIDTHS,
  DATE_BAND,
  FOOTER_BAND,
  HEADER_BAND,
  LEGEND_BAND,
  MAX_PAGES,
  PX_PER_MM,
  bandUnit,
  computePlan,
  paperPx,
  resolveOptions,
} from "../../src/internal/print/layout";
import type { ResolvedOptions } from "../../src/internal/print/layout";

const DAY = 86_400_000;

function plan(
  o: ResolvedOptions,
  over: Partial<Parameters<typeof computePlan>[0]> = {},
): ReturnType<typeof computePlan> {
  return computePlan({
    options: o,
    hasHeader: false,
    hasDateBand: true,
    hasLegend: false,
    hasFooter: true,
    contentX0: 0,
    contentX1: 4000,
    contentY0: 0,
    contentY1: 72,
    ...over,
  });
}

describe("resolveOptions", () => {
  it("fills every default when both config and call are empty", () => {
    const o = resolveOptions({});
    expect(o.paper).toBe("a4");
    expect(o.orientation).toBe("landscape");
    expect(o.scale).toBe(1);
    expect(o.marginPx).toBeCloseTo(10 * PX_PER_MM);
    expect(o.pixelRatio).toBe(2);
    expect(o.columns).toEqual(["name"]);
    expect(o.legend).toBe(true);
    expect(o.criticalPathOnly).toBe(false);
  });

  it("ignores unusable values silently (§1, option resolution)", () => {
    const o = resolveOptions({
      paper: "b5" as never,
      orientation: "diagonal" as never,
      scale: Number.NaN,
      marginMm: 99,
      pixelRatio: -1,
      columns: ["name", "bogus" as never, "progress"],
      legend: [{ color: "#000", label: "ok" }, { nope: 1 } as never],
    });
    expect(o.paper).toBe("a4");
    expect(o.orientation).toBe("landscape");
    expect(o.scale).toBe(1);
    expect(o.marginPx).toBeCloseTo(10 * PX_PER_MM);
    expect(o.pixelRatio).toBe(2);
    expect(o.columns).toEqual(["name", "progress"]);
    expect(o.legend).toEqual([{ color: "#000", label: "ok" }]);
  });

  it("clamps an oversized pixelRatio to 4 instead of leaving it unbounded", () => {
    expect(resolveOptions({ pixelRatio: 999 }).pixelRatio).toBe(4);
    expect(resolveOptions({ pixelRatio: 4 }).pixelRatio).toBe(4);
    // Still passes through usable values under the ceiling untouched.
    expect(resolveOptions({ pixelRatio: 3 }).pixelRatio).toBe(3);
  });

  it("falls back to 2 for a non-positive or unusable pixelRatio (§1)", () => {
    expect(resolveOptions({ pixelRatio: 0 }).pixelRatio).toBe(2);
    expect(resolveOptions({ pixelRatio: -3 }).pixelRatio).toBe(2);
    expect(resolveOptions({ pixelRatio: Number.NaN }).pixelRatio).toBe(2);
    expect(resolveOptions({ pixelRatio: Number.POSITIVE_INFINITY }).pixelRatio).toBe(2);
    expect(resolveOptions({ pixelRatio: "4" as never }).pixelRatio).toBe(2);
  });

  it("clamps scale to 10–400 percent instead of dropping it", () => {
    expect(resolveOptions({ scale: 5 }).scale).toBe(0.1);
    expect(resolveOptions({ scale: 1000 }).scale).toBe(4);
    expect(resolveOptions({ scale: 50 }).scale).toBe(0.5);
    // The exact bounds §1 names.
    expect(resolveOptions({ scale: 10 }).scale).toBe(0.1);
    expect(resolveOptions({ scale: 400 }).scale).toBe(4);
    expect(resolveOptions({ scale: 10000 }).scale).toBe(4);
  });

  it("falls back to 100 % only for a non-finite scale", () => {
    expect(resolveOptions({ scale: Number.NaN }).scale).toBe(1);
    expect(resolveOptions({ scale: Number.POSITIVE_INFINITY }).scale).toBe(1);
    expect(resolveOptions({}).scale).toBe(1);
  });

  it("overrides the factory config per key with the call options", () => {
    const o = resolveOptions({ paper: "a3", scale: 50 }, { scale: 200 });
    expect(o.paper).toBe("a3");
    expect(o.scale).toBe(2);
  });
});

describe("paperPx", () => {
  it("swaps the axes for landscape", () => {
    const portrait = paperPx("a4", "portrait");
    const landscape = paperPx("a4", "landscape");
    expect(portrait.width).toBeCloseTo(210 * PX_PER_MM);
    expect(portrait.height).toBeCloseTo(297 * PX_PER_MM);
    expect(landscape.width).toBeCloseTo(portrait.height);
    expect(landscape.height).toBeCloseTo(portrait.width);
  });

  it("uses the paper sizes §1.2 fixes", () => {
    expect(paperPx("a3", "portrait").width).toBeCloseTo(297 * PX_PER_MM);
    expect(paperPx("a3", "portrait").height).toBeCloseTo(420 * PX_PER_MM);
    expect(paperPx("letter", "portrait").width).toBeCloseTo(215.9 * PX_PER_MM);
    expect(paperPx("letter", "portrait").height).toBeCloseTo(279.4 * PX_PER_MM);
  });
});

describe("computePlan", () => {
  it("breaks the time axis into columns of the chart region width over scale", () => {
    const o = resolveOptions({});
    const p = plan(o);
    const chartRegion = p.chartW;
    expect(p.cols).toBe(Math.ceil(4000 / chartRegion));
    expect(p.bands).toBe(1);
    expect(p.slices).toHaveLength(p.cols);
    // Slices tile the span contiguously from the left edge.
    expect(p.slices[0]!.x0).toBe(0);
    expect(p.slices[1]!.x0).toBeCloseTo(p.slices[0]!.w);
  });

  it("halving the scale halves the page count contribution per axis", () => {
    const full = plan(resolveOptions({}));
    const half = plan(resolveOptions({ scale: 50 }));
    expect(half.cols).toBeLessThanOrEqual(Math.ceil(full.cols / 2) + 1);
    expect(half.slices[0]!.w).toBeCloseTo(full.slices[0]!.w * 2);
  });

  it("orders pages time-major within a row band", () => {
    const o = resolveOptions({});
    const p = plan(o, { contentY1: 5000 });
    expect(p.bands).toBeGreaterThan(1);
    const first = p.slices[0]!;
    const second = p.slices[1]!;
    expect(first.band).toBe(0);
    expect(second.band).toBe(p.cols > 1 ? 0 : 1);
    // The last slice belongs to the last band.
    expect(p.slices[p.slices.length - 1]!.band).toBe(p.bands - 1);
  });

  it("emits every page of a band before the next band's first page", () => {
    // Numeric pin of the "time-major within a row band" order: 3 columns × 2 bands must come out
    // (0,0) (1,0) (2,0) (0,1) (1,1) (2,1) — col varying fastest.
    const o = resolveOptions({});
    const geometry = plan(o);
    const wide = plan(o, {
      contentX1: 3 * (geometry.chartW / o.scale),
      contentY1: 2 * (geometry.chartH / o.scale),
    });
    expect([wide.cols, wide.bands]).toEqual([3, 2]);
    expect(wide.slices.map((s) => [s.col, s.band])).toEqual([
      [0, 0],
      [1, 0],
      [2, 0],
      [0, 1],
      [1, 1],
      [2, 1],
    ]);
  });

  it("reserves the table width for the selected columns only", () => {
    const none = plan(resolveOptions({ columns: [] }));
    const wide = plan(resolveOptions({ columns: ["name", "start", "end", "progress"] }));
    expect(none.tableW).toBe(0);
    expect(wide.tableW).toBe(
      COLUMN_WIDTHS.name + COLUMN_WIDTHS.start + COLUMN_WIDTHS.end + COLUMN_WIDTHS.progress,
    );
    expect(wide.chartW).toBeLessThan(none.chartW);
  });

  it("pins the built-in column widths §1.2 fixes", () => {
    expect(COLUMN_WIDTHS).toEqual({ name: 160, start: 76, end: 76, progress: 56 });
    expect(plan(resolveOptions({ columns: ["name"] })).tableW).toBe(160);
    expect(plan(resolveOptions({ columns: ["start", "end"] })).tableW).toBe(152);
    expect(plan(resolveOptions({ columns: ["progress"] })).tableW).toBe(56);
  });

  it("pins the band heights and the geometry they produce", () => {
    expect([HEADER_BAND, DATE_BAND, LEGEND_BAND, FOOTER_BAND]).toEqual([18, 24, 20, 18]);
    const o = resolveOptions({});
    const all = plan(o, { hasHeader: true, hasDateBand: true, hasLegend: true, hasFooter: true });
    expect(all.headerY).toBeCloseTo(all.margin);
    expect(all.headerH).toBe(18);
    expect(all.dateBandY).toBeCloseTo(all.margin + 18);
    expect(all.dateBandH).toBe(24);
    expect(all.chartY).toBeCloseTo(all.margin + 18 + 24);
    expect(all.footerH).toBe(18);
    expect(all.footerY).toBeCloseTo(all.pageHeight - all.margin - 18);
    expect(all.legendH).toBe(20);
    expect(all.legendY).toBeCloseTo(all.footerY - 20);
    expect(all.chartH).toBeCloseTo(all.legendY - all.chartY);

    // Each absent band contributes exactly its own height back to the chart region.
    const bare = plan(o, { hasHeader: false, hasDateBand: false, hasLegend: false, hasFooter: false });
    expect(bare.headerH + bare.dateBandH + bare.legendH + bare.footerH).toBe(0);
    expect(bare.chartH).toBeCloseTo(all.chartH + 18 + 24 + 20 + 18);
  });

  it("slices the content span by chartRegion / scale on both axes", () => {
    const o = resolveOptions({ scale: 200 });
    const p = plan(o, { contentX1: 10_000, contentY1: 10_000 });
    expect(p.slices[0]!.w).toBeCloseTo(p.chartW / 2);
    expect(p.slices[0]!.h).toBeCloseTo(p.chartH / 2);
    expect(p.cols).toBe(Math.ceil(10_000 / (p.chartW / 2)));
    expect(p.bands).toBe(Math.ceil(10_000 / (p.chartH / 2)));
    // Slices start at the range's own edges, not at zero.
    const shifted = plan(o, { contentX0: 500, contentX1: 10_500, contentY0: 40, contentY1: 10_040 });
    expect(shifted.slices[0]!.x0).toBe(500);
    expect(shifted.slices[0]!.y0).toBe(40);
  });
});

describe("bandUnit", () => {
  it("labels by day for short spans and coarser units for longer ones", () => {
    expect(bandUnit(10 * DAY)).toBe("day");
    expect(bandUnit(60 * DAY)).toBe("week");
    expect(bandUnit(400 * DAY)).toBe("month");
    expect(bandUnit(2000 * DAY)).toBe("year");
  });
});

describe("scale clamping of non-positive values (§1, option resolution)", () => {
  it("clamps zero and negative finite scales to the 10 % floor instead of ignoring them", () => {
    expect(resolveOptions({ scale: 0 }).scale).toBe(0.1);
    expect(resolveOptions({ scale: -50 }).scale).toBe(0.1);
  });
});

describe("computePlan page-count ceiling", () => {
  it("rejects a pathological huge range/scale combination instead of laying out unbounded pages", () => {
    // Minimum scale (10%) over an enormous multi-decade span: without a ceiling this would try
    // to compute (and later rasterize) tens of thousands of pages.
    const o = resolveOptions({ scale: 10 });
    expect(() => plan(o, { contentX1: 50_000_000, contentY1: 50_000_000 })).toThrow(/page count/i);
  });

  it("names this plugin in the ceiling error", () => {
    expect(() =>
      plan(resolveOptions({ scale: 10 }), { contentX1: 50_000_000, contentY1: 50_000_000 }),
    ).toThrow(/^stargantt\.export: /);
  });

  it("stays under the ceiling — and produces the exact expected count — for an ordinary export", () => {
    const o = resolveOptions({});
    const p = plan(o);
    expect(p.slices.length).toBeLessThanOrEqual(MAX_PAGES);
    expect(p.slices.length).toBe(p.cols * p.bands);
  });
});
