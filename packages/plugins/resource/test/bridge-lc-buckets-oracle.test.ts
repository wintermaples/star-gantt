/**
 * BRIDGED from the earlier implementation's `load-chart/test/buckets-oracle.test.ts` — the part
 * §2.6 names as its pinned surface: the coarsening ladder (stop at ≤ 200, never narrow, month
 * accepted over-bound) and bucket indexing (docs/specs/plugins/resource.md §2.2).
 *
 * The rest of that file is an equivalence proof of `computeBuckets`, the aggregate BAND's own
 * Σ-units histogram — never matrix behavior (§2.6 item 6) — so it stays with the band consumer
 * rather than moving into the engine. What is bridged here is what the unified engine owns:
 * the grid itself, its indexing, its cap, and the ladder.
 */
import { describe, expect, it } from "vitest";
import {
  bucketsInRange,
  coarsenBucketMode,
  createBucketIndexer,
} from "../src/internal/engine/buckets";
import type { UtilizationBucketUnit } from "../src/internal/engine/buckets";
import { computeUtilization } from "../src/internal/engine/compute";
import { MS_DAY, MS_HOUR, MS_WEEK, engineResource } from "./_engine";

const RANGE_START = Date.UTC(2026, 0, 1);
const MODES: UtilizationBucketUnit[] = ["day", "week", "month"];

describe("`coarsenBucketMode`", () => {
  const FDOW = 1; // Monday, ISO-8601 default.

  it("keeps day mode when the day grid stays within the 200-bucket bound", () => {
    expect(coarsenBucketMode("day", 0, 100 * MS_DAY, FDOW, 200)).toBe("day");
    // Exactly 200 day buckets: still within bound.
    expect(coarsenBucketMode("day", 0, 200 * MS_DAY, FDOW, 200)).toBe("day");
  });

  it("escalates day to week once the day grid exceeds 200 buckets", () => {
    expect(coarsenBucketMode("day", 0, 201 * MS_DAY, FDOW, 200)).toBe("week");
  });

  it("escalates all the way to month when week still exceeds 200 buckets", () => {
    // ~1500 days: ~215 week buckets, still over 200 → month.
    expect(coarsenBucketMode("day", 0, 1500 * MS_DAY, FDOW, 200)).toBe("month");
  });

  it("accepts month even when it still exceeds 200 buckets — nothing coarser exists", () => {
    expect(coarsenBucketMode("day", 0, 20000 * MS_DAY, FDOW, 200)).toBe("month");
  });

  it("never coarsens below the requested mode", () => {
    expect(coarsenBucketMode("month", 0, MS_DAY, FDOW, 200)).toBe("month");
    expect(coarsenBucketMode("week", 0, MS_DAY, FDOW, 200)).toBe("week");
  });
});

describe("bucket index arithmetic (`createBucketIndexer`)", () => {
  it("agrees with a per-bucket overlap test on every boundary case, in every mode", () => {
    for (const unit of MODES) {
      const buckets = bucketsInRange(unit, RANGE_START, RANGE_START + 200 * MS_DAY, 1, "aligned");
      const indexer = createBucketIndexer(unit, buckets);
      const edges = [
        ...buckets.map((b) => b.start),
        ...buckets.map((b) => b.end),
        RANGE_START - 5 * MS_DAY,
        RANGE_START + 500 * MS_DAY,
      ];
      for (const start of edges) {
        for (const span of [1, MS_DAY / 2, MS_DAY, MS_WEEK, 40 * MS_DAY]) {
          const end = start + span;
          const expected = buckets
            .map((b, i) => (start < b.end && end > b.start ? i : -1))
            .filter((i) => i >= 0);
          const lo = Math.max(0, indexer.firstIndex(start));
          const hi = Math.min(buckets.length - 1, indexer.lastIndex(end));
          const actual: number[] = [];
          for (let i = lo; i <= hi; i += 1) actual.push(i);
          expect(actual, `${unit} start=${String(start)} span=${String(span)}`).toEqual(expected);
        }
      }
    }
  });

  it("collapses an interval running off either end onto the bucket list's own extremes", () => {
    const buckets = bucketsInRange("day", RANGE_START, RANGE_START + 10 * MS_DAY, 1, "aligned");
    for (const unit of MODES) {
      const indexer = createBucketIndexer(unit, buckets);
      expect(indexer.firstIndex(-Infinity)).toBe(-Infinity);
      expect(indexer.lastIndex(Infinity)).toBe(Infinity);
    }
  });
});

describe("grid boundary cases randomness will not reliably produce", () => {
  const day = (n: number): number => RANGE_START + n * MS_DAY;

  it("truncates at MAX_BUCKETS where the range outruns the bucket list", () => {
    const buckets = bucketsInRange("day", day(0), day(40_000), 1, "aligned");
    expect(buckets.length).toBe(8192);
    const matrix = computeUtilization({
      resources: [engineResource()],
      demands: new Map([[
        "r1",
        [{ start: day(0), end: day(40_000), units: 1 }],
      ]]),
      start: day(0),
      end: day(40_000),
      bucket: "day",
      edges: "aligned",
      weekStartDay: 1,
    });
    expect(matrix.rows[0]!.cells).toHaveLength(8192);
  });

  it("returns nothing for an empty or inverted range", () => {
    expect(bucketsInRange("day", day(5), day(5), 1, "aligned")).toEqual([]);
    expect(bucketsInRange("day", day(5), day(1), 1, "aligned")).toEqual([]);
    const empty = computeUtilization({
      resources: [engineResource()],
      demands: new Map(),
      start: day(5),
      end: day(1),
      bucket: "day",
      edges: "aligned",
      weekStartDay: 1,
    });
    expect(empty.rows).toEqual([]);
  });

  it("walks month lengths, leap February included", () => {
    const buckets = bucketsInRange(
      "month",
      Date.UTC(2023, 9, 5),
      Date.UTC(2024, 7, 20),
      1,
      "aligned",
    );
    expect(buckets[0]).toEqual({ start: Date.UTC(2023, 9, 1), end: Date.UTC(2023, 10, 1) });
    const feb = buckets.find((b) => b.start === Date.UTC(2024, 1, 1));
    expect(feb).toEqual({ start: Date.UTC(2024, 1, 1), end: Date.UTC(2024, 2, 1) });
    expect(buckets.at(-1)).toEqual({ start: Date.UTC(2024, 7, 1), end: Date.UTC(2024, 8, 1) });
  });

  it("keeps a two-hour range at its requested width when the bound allows it", () => {
    expect(coarsenBucketMode("hour", RANGE_START, RANGE_START + 2 * MS_HOUR, 1, 200)).toBe("hour");
  });
});
