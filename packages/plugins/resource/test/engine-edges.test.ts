/**
 * The `edges` input and the two range-resolution policies — surfaces the bridged suites elsewhere
 * cannot pin on their own, because each engine call only ever runs one edge policy at a time
 * (docs/specs/plugins/resource.md §2.2 / §2.5 / §2.6 item 7).
 *
 * `"clamped"` clips the first and last bucket to the range (the resource-utilization rule);
 * `"aligned"` keeps every bucket at its full grid width and the bounds fall inside the edge
 * buckets (the load-chart rule). The cases below are the DISCRIMINATING ones: inputs where the
 * two policies must produce different bucket bounds, different cell counts, or different numbers.
 */
import { describe, expect, it } from "vitest";
import { bucketsInRange } from "../src/internal/engine/buckets";
import { computeUtilization } from "../src/internal/engine/compute";
import type { BucketEdges } from "../src/internal/engine/buckets";
import { resolveReportRange, taskExtent } from "../src/internal/engine/range";
import { MONDAY, MS_DAY, MS_HOUR, alwaysWorking, engineResource } from "./_engine";

const WEDNESDAY = MONDAY + 2 * MS_DAY;

function cells(edges: BucketEdges, from: number, to: number, unit: "day" | "week" | "hour") {
  return computeUtilization({
    resources: [engineResource({ id: "r", workingIntervals: alwaysWorking })],
    demands: new Map([["r", [{ start: from - MS_DAY, end: to + MS_DAY, units: 1 }]]]),
    start: from,
    end: to,
    bucket: unit,
    edges,
    weekStartDay: 1,
  }).rows[0]!.cells;
}

describe("bucket bounds under the two edge policies (§2.2)", () => {
  it("clips the first and last week bucket under `clamped`, keeps full widths under `aligned`", () => {
    const from = WEDNESDAY;
    const to = MONDAY + 10 * MS_DAY;
    expect(bucketsInRange("week", from, to, 1, "clamped")).toEqual([
      { start: from, end: MONDAY + 7 * MS_DAY },
      { start: MONDAY + 7 * MS_DAY, end: to },
    ]);
    expect(bucketsInRange("week", from, to, 1, "aligned")).toEqual([
      { start: MONDAY, end: MONDAY + 7 * MS_DAY },
      { start: MONDAY + 7 * MS_DAY, end: MONDAY + 14 * MS_DAY },
    ]);
  });

  it("clips a sub-day grid at both bounds under `clamped`", () => {
    const from = MONDAY + 9 * MS_HOUR + 30 * 60_000;
    const to = MONDAY + 11 * MS_HOUR + 15 * 60_000;
    expect(bucketsInRange("hour", from, to, 1, "clamped")).toEqual([
      { start: from, end: MONDAY + 10 * MS_HOUR },
      { start: MONDAY + 10 * MS_HOUR, end: MONDAY + 11 * MS_HOUR },
      { start: MONDAY + 11 * MS_HOUR, end: to },
    ]);
    expect(bucketsInRange("hour", from, to, 1, "aligned")).toEqual([
      { start: MONDAY + 9 * MS_HOUR, end: MONDAY + 10 * MS_HOUR },
      { start: MONDAY + 10 * MS_HOUR, end: MONDAY + 11 * MS_HOUR },
      { start: MONDAY + 11 * MS_HOUR, end: MONDAY + 12 * MS_HOUR },
    ]);
  });

  it("clips a month grid to the range under `clamped`", () => {
    const from = Date.UTC(2024, 0, 15);
    const to = Date.UTC(2024, 2, 10);
    expect(bucketsInRange("month", from, to, 1, "clamped")).toEqual([
      { start: from, end: Date.UTC(2024, 1, 1) },
      { start: Date.UTC(2024, 1, 1), end: Date.UTC(2024, 2, 1) },
      { start: Date.UTC(2024, 2, 1), end: to },
    ]);
    expect(bucketsInRange("month", from, to, 1, "aligned")[0]).toEqual({
      start: Date.UTC(2024, 0, 1),
      end: Date.UTC(2024, 1, 1),
    });
  });

  it("changes nothing when both bounds already sit on the grid", () => {
    const from = MONDAY;
    const to = MONDAY + 14 * MS_DAY;
    expect(bucketsInRange("week", from, to, 1, "clamped")).toEqual(
      bucketsInRange("week", from, to, 1, "aligned"),
    );
  });
});

describe("accrual under the two edge policies (§2.3 / §2.5)", () => {
  it("bills an edge bucket its clipped span under `clamped`, its full width under `aligned`", () => {
    const from = MONDAY + 12 * MS_HOUR;
    const to = MONDAY + 2 * MS_DAY;
    // An always-working resource fully booked across the whole span.
    const clamped = cells("clamped", from, to, "day");
    const aligned = cells("aligned", from, to, "day");
    expect(clamped).toHaveLength(2);
    expect(clamped[0]).toMatchObject({ start: from, end: MONDAY + MS_DAY });
    // Half a day of working time in the clipped first bucket…
    expect(clamped[0]!.workingMs).toBe(12 * MS_HOUR);
    expect(clamped[0]!.allocated).toBe(12 * MS_HOUR);
    // …against a whole day in the aligned one, which opens at midnight and measures its own full
    // grid width — the accrual window is the BUCKET SPAN, not the requested range.
    expect(aligned[0]).toMatchObject({ start: MONDAY, end: MONDAY + MS_DAY });
    expect(aligned[0]!.workingMs).toBe(MS_DAY);
    expect(aligned[0]!.allocated).toBe(MS_DAY);
  });

  it("keeps a clamped week bucket's capacity a fraction of its own clipped working time", () => {
    const demands = new Map([["r", [{ start: MONDAY, end: MONDAY + 14 * MS_DAY, units: 1 }]]]);
    const common = {
      resources: [engineResource({ id: "r" })],
      demands,
      start: MONDAY + 3 * MS_DAY,
      end: MONDAY + 10 * MS_DAY,
      bucket: "week" as const,
      weekStartDay: 1,
    };
    // Thu+Fri of the first week, then Mon–Wed of the second: only the clipped days count.
    const clamped = computeUtilization({ ...common, edges: "clamped" }).rows[0]!.cells;
    expect(clamped.map((c) => c.capacity)).toEqual([2 * MS_DAY, 3 * MS_DAY]);

    // The aligned grid keeps both weeks at full width, so each measures its own five working days.
    const aligned = computeUtilization({ ...common, edges: "aligned" }).rows[0]!.cells;
    expect(aligned[0]!.start).toBe(MONDAY);
    expect(aligned[0]!.end).toBe(MONDAY + 7 * MS_DAY);
    expect(aligned.map((c) => c.capacity)).toEqual([5 * MS_DAY, 5 * MS_DAY]);
  });
});

describe("the two range-resolution policies (§2.5)", () => {
  it("derives the task extent, skipping unusable spans", () => {
    expect(
      taskExtent([
        { start: MONDAY + MS_DAY, end: MONDAY + 3 * MS_DAY },
        { start: MONDAY, end: MONDAY },
        { start: Number.NaN, end: MONDAY + 9 * MS_DAY },
        { start: MONDAY + 2 * MS_DAY, end: MONDAY + 5 * MS_DAY },
      ]),
    ).toEqual({ start: MONDAY + MS_DAY, end: MONDAY + 5 * MS_DAY });
    expect(taskExtent([])).toBeNull();
  });

  it("replaces each unusable report bound by its derived one (§4 rule)", () => {
    const extent = { start: MONDAY, end: MONDAY + 10 * MS_DAY };
    expect(resolveReportRange(extent, undefined, undefined)).toEqual(extent);
    expect(resolveReportRange(extent, MONDAY + MS_DAY, undefined)).toEqual({
      start: MONDAY + MS_DAY,
      end: MONDAY + 10 * MS_DAY,
    });
    expect(resolveReportRange(extent, Number.NaN, MONDAY + 4 * MS_DAY)).toEqual({
      start: MONDAY,
      end: MONDAY + 4 * MS_DAY,
    });
  });

  it("gives a usable-but-unordered pair the same member-wise treatment", () => {
    const extent = { start: MONDAY, end: MONDAY + 10 * MS_DAY };
    // Both supplied and inverted: both fall back to their derived bounds.
    expect(resolveReportRange(extent, MONDAY + 5 * MS_DAY, MONDAY + MS_DAY)).toEqual(extent);
    // Only the start supplied, and it sits past the derived end: the start falls back.
    expect(resolveReportRange(extent, MONDAY + 20 * MS_DAY, undefined)).toEqual(extent);
  });

  it("has no range when nothing orders and there is no extent", () => {
    expect(resolveReportRange(null, undefined, undefined)).toBeNull();
    expect(resolveReportRange(null, MONDAY + 5 * MS_DAY, MONDAY)).toBeNull();
    expect(resolveReportRange(null, MONDAY, MONDAY + MS_DAY)).toEqual({
      start: MONDAY,
      end: MONDAY + MS_DAY,
    });
  });
});
