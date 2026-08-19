/**
 * The engine-expressible review-fix cases.
 *
 * Lazy theme resolution, per-refresh trend colours, the warning column's cell text, the latched
 * message-builder barrier and the panel DOM are booted-chart, `internal/utilization/` surfaces
 * exercised elsewhere and NOT covered here. What the unified engine and its caller policies own
 * is covered below: the single-resource narrowing (§1.2), the query-range fallback (§2.5) and the
 * capacity-rate usability guard (§2.1).
 */
import { describe, expect, it } from "vitest";
import { computeUtilization } from "../src/internal/engine/compute";
import { alignRange, deriveRange } from "../src/internal/engine/range";
import {
  MS_DAY,
  engineResource,
  loadChartDemands,
  loadChartRoster,
  usableRate,
} from "./_engine";
import type { Store } from "./_engine";

const DAY0 = Date.UTC(2024, 0, 1); // Monday
const DAY = MS_DAY;

describe("lazy warning sweep — the single-resource narrowing (§1.2)", () => {
  it("does not sweep every resource for a single-resource utilization query", () => {
    const seen = new Set<string>();
    const hooks = {
      resourceLoad: (input: { resourceId: string | number; allocated: number }): number => {
        seen.add(String(input.resourceId));
        return input.allocated;
      },
    };
    const p1 = engineResource({ id: "p1", name: "Ana" });
    const p2 = engineResource({ id: "p2", name: "Bo" });
    const demands = new Map([
      ["p1", [{ start: DAY0, end: DAY0 + DAY, units: 2 }]],
      ["p2", [{ start: DAY0, end: DAY0 + DAY, units: 0.25 }]],
    ]);
    // The one-row roster of `utilization(id)`: only this resource is accrued, and the hooks are
    // called for this resource's cells only.
    computeUtilization({
      resources: [p1],
      demands,
      start: DAY0,
      end: DAY0 + 5 * DAY,
      bucket: "day",
      edges: "clamped",
      weekStartDay: 1,
      hooks,
    });
    expect(seen).toEqual(new Set(["p1"]));

    // The union roster of the sweeping surfaces still reaches every row.
    computeUtilization({
      resources: [p1, p2],
      demands,
      start: DAY0,
      end: DAY0 + 5 * DAY,
      bucket: "day",
      edges: "clamped",
      weekStartDay: 1,
      hooks,
    });
    expect(seen).toEqual(new Set(["p1", "p2"]));
  });

  it("reports no row at all for a resource the roster does not carry", () => {
    const matrix = computeUtilization({
      resources: [],
      demands: new Map([["nobody", [{ start: DAY0, end: DAY0 + DAY, units: 1 }]]]),
      start: DAY0,
      end: DAY0 + DAY,
      bucket: "day",
      edges: "clamped",
      weekStartDay: 1,
    });
    expect(matrix.rows).toEqual([]);
  });
});

describe("query-range fallback (§2.5)", () => {
  // §2.2 — a query range with a non-finite member is unusable as a pair and falls back to the
  // derived range instead of yielding empty results.
  it("declines a range with a non-finite member so the caller falls back to the derived one", () => {
    expect(alignRange(Number.NaN, DAY0 + 5 * DAY)).toBeNull();
    expect(alignRange(Number.NaN, Number.NaN)).toBeNull();
    const derived = deriveRange([{ start: DAY0, end: DAY0 + 5 * DAY }]);
    expect(derived).toEqual({ start: DAY0, end: DAY0 + 5 * DAY });
    const matrix = computeUtilization({
      resources: [engineResource({ id: "p1", name: "Ana" })],
      demands: new Map(),
      start: derived!.start,
      end: derived!.end,
      bucket: "day",
      edges: "clamped",
      weekStartDay: 1,
    });
    expect(matrix.rows[0]!.cells).toHaveLength(5);
  });
});

describe("capacity-rate usability guard (§2.1)", () => {
  it("treats a non-finite store capacity as full time", () => {
    const store: Store = {
      tasks: [{ id: "t1", start: DAY0, end: DAY0 + DAY }],
      resources: [
        { id: "s1", name: "NanCap", capacity: Number.NaN },
        { id: "s2", name: "InfCap", capacity: Number.POSITIVE_INFINITY },
      ],
      assignments: [
        { taskId: "t1", resourceId: "s1", units: 1 },
        { taskId: "t1", resourceId: "s2", units: 1 },
      ],
    };
    const roster = loadChartRoster(store, undefined);
    expect(roster.map((r) => r.capacityRate)).toEqual([1, 1]);
    const matrix = computeUtilization({
      resources: roster,
      demands: loadChartDemands(store, roster),
      start: DAY0,
      end: DAY0 + DAY,
      bucket: "day",
      edges: "clamped",
      weekStartDay: 1,
    });
    for (const row of matrix.rows) {
      expect(row.cells[0]!.capacity).toBe(DAY);
      expect(row.cells[0]!.ratio).toBe(1);
    }
  });

  it("keeps the guard's whole truth table", () => {
    expect(usableRate(undefined)).toBe(1);
    expect(usableRate(Number.NaN)).toBe(1);
    expect(usableRate(Number.POSITIVE_INFINITY)).toBe(1);
    expect(usableRate(0)).toBe(1);
    expect(usableRate(-2)).toBe(1);
    expect(usableRate(0.5)).toBe(0.5);
    expect(usableRate(3)).toBe(3);
  });
});
