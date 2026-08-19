/**
 * The two shared projections of the load chart (docs/specs/plugins/resource.md §3.6): the band's
 * histogram (`projectHistogram`) and one lane's boxes plus stepped reference line (`projectLane`).
 *
 * Both are pure, and both are read by MORE than one renderer — the live strip and the export tile
 * writers share the histogram — so what is pinned here is exactly what keeps screen and export from
 * drifting apart: the reserved value-label gutter, the y-scale fit, the overload segment being the
 * TOP portion of the bar's own box, per-run capacity segments, run merging and pixel snapping.
 */
import { describe, expect, it } from "vitest";
import {
  CAPACITY_LINE_THICKNESS,
  LANE_PAD_TOP,
  VALUE_LABEL_HEIGHT,
  fitsLabel,
  formatTick,
  projectHistogram,
  projectLane,
} from "../src/internal/load-chart/geometry";
import type { BucketResult } from "../src/internal/load-chart/band";
import { measureAt, MS_DAY } from "./load-chart-fixtures";

/** Buckets on a 10-px-per-day grid starting at t = 0. */
function grid(values: readonly (readonly [value: number, capacity: number | null])[]): BucketResult[] {
  return values.map(([value, capacity], i) => ({
    bucket: { start: i * MS_DAY, end: (i + 1) * MS_DAY },
    value,
    capacity,
  }));
}

const xOf = (t: number): number => (t / MS_DAY) * 10;

describe("projectHistogram (§3.6)", () => {
  it("reserves the top label gutter only when `valueLabels` is on", () => {
    const results = grid([[1, 1]]);
    expect(projectHistogram({ results, width: 100, height: 64, xOf, valueLabels: false }).gutter).toBe(0);
    const withLabels = projectHistogram({ results, width: 100, height: 64, xOf, valueLabels: true });
    expect(withLabels.gutter).toBe(VALUE_LABEL_HEIGHT);
    expect(withLabels.plotHeight).toBe(64 - VALUE_LABEL_HEIGHT);
  });

  it("anchors bars to the bottom edge and raises the ceiling to the round step under `nice`", () => {
    const projection = projectHistogram({
      results: grid([[7, null]]),
      width: 100,
      height: 100,
      xOf,
      valueLabels: false,
      nice: true,
    });
    expect(projection.max).toBeGreaterThanOrEqual(7);
    expect(projection.step).not.toBeNull();
    const bar = projection.bars[0];
    expect(bar?.top).toBeCloseTo(100 - (7 / projection.max) * 100, 6);
    expect((bar?.top ?? 0) + (bar?.height ?? 0)).toBeCloseTo(100, 6);
  });

  it("makes the overload segment the TOP portion of the bar's own full-value box", () => {
    const projection = projectHistogram({
      results: grid([[4, 2]]),
      width: 100,
      height: 100,
      xOf,
      valueLabels: false,
    });
    const bar = projection.bars[0];
    expect(bar?.over).toBeDefined();
    expect(bar?.over?.top).toBe(bar?.top);
    // The over segment spans from the bar's top down to the capacity line.
    expect((bar?.over?.height ?? 0) + (bar?.top ?? 0)).toBeCloseTo(projection.yOf(2), 6);
  });

  it("emits one capacity segment per contiguous run of equal capacity, and none where null", () => {
    const projection = projectHistogram({
      results: grid([
        [1, 2],
        [1, 2],
        [1, null],
        [1, 3],
      ]),
      width: 100,
      height: 100,
      xOf,
      valueLabels: false,
    });
    expect(projection.capacity).toHaveLength(2);
    expect(projection.capacity[0]).toMatchObject({ x: 0, width: 20 });
    expect(projection.capacity[1]).toMatchObject({ x: 30, width: 10 });
  });

  it("clamps a capacity segment's box inside the drawn area at either extreme", () => {
    const projection = projectHistogram({
      results: grid([[1, 1]]),
      width: 100,
      height: 20,
      xOf,
      valueLabels: false,
    });
    const segment = projection.capacity[0];
    expect(segment?.top).toBeGreaterThanOrEqual(0);
    expect(segment?.top).toBeLessThanOrEqual(20 - CAPACITY_LINE_THICKNESS);
  });

  it("omits a value label that does not fit its clamped extent, rather than clipping it", () => {
    const wide = projectHistogram({
      results: grid([[1234, null]]),
      width: 100,
      height: 64,
      xOf,
      valueLabels: true,
      measure: measureAt(6),
    });
    // "1234" at 6px/char is 24px; the bucket's extent is 10px.
    expect(wide.bars[0]?.label).toBeUndefined();

    const narrow = projectHistogram({
      results: grid([[1, null]]),
      width: 100,
      height: 64,
      xOf,
      valueLabels: true,
      measure: measureAt(6),
    });
    expect(narrow.bars[0]?.label?.text).toBe("1");
  });

  it("draws nothing at all when there is no positive value anywhere", () => {
    const projection = projectHistogram({
      results: grid([[0, null]]),
      width: 100,
      height: 64,
      xOf,
      valueLabels: false,
    });
    expect(projection.max).toBe(0);
    expect(projection.bars).toEqual([]);
    expect(projection.capacity).toEqual([]);
  });

  it("honours an export's whole-span `scaleMax` so tiles share one y-scale", () => {
    const projection = projectHistogram({
      results: grid([[1, null]]),
      width: 100,
      height: 100,
      xOf,
      valueLabels: false,
      scaleMax: 10,
    });
    expect(projection.max).toBeGreaterThanOrEqual(10);
  });
});

describe("projectLane (§3.6)", () => {
  it("merges adjacent buckets of equal value AND equal capacity into one snapped box", () => {
    const projection = projectLane({
      results: grid([
        [1, 1],
        [1, 1],
        [2, 1],
      ]),
      threshold: 1,
      plotHeight: 20,
      xOf,
    });
    expect(projection.boxes).toHaveLength(2);
    expect(projection.boxes[0]).toMatchObject({ x: 0, width: 20 });
    expect(projection.boxes[1]).toMatchObject({ x: 20, width: 10 });
  });

  it("does not merge buckets that agree on the bar but differ in their own capacity", () => {
    const projection = projectLane({
      results: grid([
        [1, 1],
        [1, 2],
      ]),
      threshold: 1,
      plotHeight: 20,
      xOf,
    });
    expect(projection.boxes).toHaveLength(2);
  });

  it("judges overload per run against the run's OWN capacity", () => {
    const projection = projectLane({
      results: grid([
        [3, 4],
        [2, 1],
      ]),
      threshold: 4,
      plotHeight: 20,
      xOf,
    });
    // The taller run is under its own budget; the shorter one is over its own.
    expect(projection.boxes[0]?.over).toBeUndefined();
    expect(projection.boxes[1]?.over).toBeDefined();
  });

  it("offsets every box by the lane's top padding", () => {
    const projection = projectLane({
      results: grid([[1, 1]]),
      threshold: 1,
      plotHeight: 20,
      xOf,
    });
    expect(projection.boxes[0]?.top).toBe(LANE_PAD_TOP);
  });

  it("steps the reference line per capacity run and skips runs without a capacity", () => {
    const projection = projectLane({
      results: grid([
        [1, 1],
        [1, 1],
        [1, null],
        [1, 2],
      ]),
      threshold: 1,
      plotHeight: 20,
      xOf,
    });
    expect(projection.referenceSegments).toHaveLength(2);
    expect(projection.referenceSegments[0]).toMatchObject({ x: 0, width: 20 });
    expect(projection.referenceSegments[1]).toMatchObject({ x: 30, width: 10 });
  });

  it("fits every lane to a shared ceiling when one is supplied, and to its own peak otherwise", () => {
    const own = projectLane({ results: grid([[1, 1]]), threshold: 1, plotHeight: 20, xOf });
    expect(own.max).toBe(1);
    const shared = projectLane({
      results: grid([[1, 1]]),
      threshold: 1,
      plotHeight: 20,
      xOf,
      scaleMax: 4,
    });
    expect(shared.max).toBe(4);
  });

  it("centres a lane value label inside its run and omits one that does not fit", () => {
    const projection = projectLane({
      results: grid([
        [1, 1],
        [1, 1],
      ]),
      threshold: 1,
      plotHeight: 20,
      xOf,
      valueLabels: { format: () => "100%", measure: measureAt(4), plotWidth: 100 },
    });
    // "100%" at 4px/char is 16px inside a 20px run: it fits and is centred.
    expect(projection.boxes[0]?.label).toMatchObject({ text: "100%", width: 16, x: 2 });

    const tight = projectLane({
      results: grid([[1, 1]]),
      threshold: 1,
      plotHeight: 20,
      xOf,
      valueLabels: { format: () => "100%", measure: measureAt(4), plotWidth: 100 },
    });
    expect(tight.boxes[0]?.label).toBeUndefined();
  });

  it("draws nothing when the plot has no height or the scale has no positive ceiling", () => {
    expect(projectLane({ results: grid([[1, 1]]), threshold: 1, plotHeight: 0, xOf }).boxes).toEqual([]);
    expect(projectLane({ results: [], threshold: 0, plotHeight: 20, xOf }).boxes).toEqual([]);
  });
});

describe("the shared label-fit rule (§3.6)", () => {
  it("compares the CEILED text width against the extent, so a sub-pixel overhang omits", () => {
    expect(fitsLabel("ab", 10, measureAt(4))).toBe(true);
    expect(fitsLabel("ab", 7.5, measureAt(4))).toBe(false);
    expect(fitsLabel("ab", 0, measureAt(4))).toBe(false);
  });

  it("prints integers plain and fractions to at most two trimmed decimals", () => {
    expect(formatTick(3)).toBe("3");
    expect(formatTick(3.5)).toBe("3.5");
    expect(formatTick(3.456)).toBe("3.46");
  });
});
