/**
 * The utilization matrix's working-time accrual (§4 "Cells") and the one-entry per-frame memo,
 * expressed through the unified `computeUtilization` (docs/specs/plugins/resource.md §2, §2.6).
 *
 * Notable framing: the original `(view, mode, fromT, toT, firstDayOfWeek, allowlist, cache,
 * hooks, scratch)` argument list becomes one `BucketInput` — the view-derived parts arriving
 * pre-projected through the load-chart caller policy of `_engine.ts` — and the suite passes
 * `edges: "aligned"`, the load-chart side's policy (§2.5). Every expected number is pinned exactly.
 */
import { describe, expect, it } from "vitest";
import { computeUtilization } from "../src/internal/engine/compute";
import { createMatrixMemo } from "../src/internal/engine/memo";
import type { UtilizationMatrix } from "../src/internal/engine/compute";
import {
  MONDAY,
  MS_DAY,
  MS_HOUR,
  SHIFT,
  calendarListing,
  loadChartDemands,
  loadChartRoster,
} from "./_engine";
import type { Store } from "./_engine";

const SHIFT_LISTING = calendarListing(SHIFT);

function build(store: Store, days: number, shift = false) {
  const roster = loadChartRoster(store, undefined, shift ? SHIFT_LISTING : undefined);
  return computeUtilization({
    resources: roster,
    demands: loadChartDemands(store, roster),
    start: MONDAY,
    end: MONDAY + days * MS_DAY,
    bucket: "day",
    edges: "aligned",
    weekStartDay: 1,
  });
}

const ada = (capacity = 1) => ({ id: "r", name: "Ada", capacity });

describe("interval intersection (§2.3 Cells)", () => {
  it("bills only the overlap when a span starts and ends inside working windows", () => {
    // Tue 10:00 → Thu 14:00 on a 09:00–17:00 shift: Tue 10–17 (7 h), Wed 9–17 (8 h), Thu 9–14
    // (5 h). Each day is its own bucket, so each figure lands in its own cell.
    const matrix = build(
      {
        tasks: [
          {
            id: "t",
            start: MONDAY + MS_DAY + 10 * MS_HOUR,
            end: MONDAY + 3 * MS_DAY + 14 * MS_HOUR,
          },
        ],
        resources: [ada()],
        assignments: [{ taskId: "t", resourceId: "r", units: 1 }],
      },
      5,
      true,
    );
    expect(matrix.rows[0]!.cells.map((c) => c.allocated)).toEqual([
      0,
      7 * MS_HOUR,
      8 * MS_HOUR,
      5 * MS_HOUR,
      0,
    ]);
    // Capacity is the whole window every working day, whatever the task does.
    expect(matrix.rows[0]!.cells.map((c) => c.capacity)).toEqual(new Array(5).fill(8 * MS_HOUR));
  });

  it("bills nothing for a span that falls entirely in non-working time", () => {
    // Monday 00:00–06:00, wholly before the 09:00 window opens.
    const matrix = build(
      {
        tasks: [{ id: "t", start: MONDAY, end: MONDAY + 6 * MS_HOUR }],
        resources: [ada()],
        assignments: [{ taskId: "t", resourceId: "r", units: 1 }],
      },
      1,
      true,
    );
    expect(matrix.rows[0]!.cells[0]!.allocated).toBe(0);
    expect(matrix.rows[0]!.cells[0]!.capacity).toBe(8 * MS_HOUR);
    expect(matrix.rows[0]!.cells[0]!.ratio).toBe(0);
  });

  it("sums several assignments overlapping the same interval", () => {
    // Two tasks over the same Monday window at units 1 and 0.5: 8 h + 4 h of the day's 8 h.
    const matrix = build(
      {
        tasks: [
          { id: "a", start: MONDAY, end: MONDAY + MS_DAY },
          { id: "b", start: MONDAY, end: MONDAY + MS_DAY },
        ],
        resources: [ada()],
        assignments: [
          { taskId: "a", resourceId: "r", units: 1 },
          { taskId: "b", resourceId: "r", units: 0.5 },
        ],
      },
      1,
      true,
    );
    expect(matrix.rows[0]!.cells[0]!.allocated).toBe(12 * MS_HOUR);
    expect(matrix.rows[0]!.cells[0]!.ratio).toBe(1.5);
  });

  it("scales capacity by the resource's dimensionless rate, never by the bucket width", () => {
    // A half-time resource over one full default-calendar working day: `0.5 × MS_DAY`.
    const matrix = build(
      {
        tasks: [{ id: "t", start: MONDAY, end: MONDAY + MS_DAY }],
        resources: [ada(0.5)],
        assignments: [{ taskId: "t", resourceId: "r", units: 1 }],
      },
      1,
    );
    expect(matrix.rows[0]!.cells[0]!.capacity).toBe(MS_DAY / 2);
    expect(matrix.rows[0]!.cells[0]!.allocated).toBe(MS_DAY);
    expect(matrix.rows[0]!.cells[0]!.ratio).toBe(2);
  });

  it("excludes milestones and non-positive spans", () => {
    const matrix = build(
      {
        tasks: [{ id: "m", start: MONDAY, end: MONDAY }],
        resources: [ada()],
        assignments: [{ taskId: "m", resourceId: "r", units: 3 }],
      },
      1,
    );
    expect(matrix.rows[0]!.cells[0]!.allocated).toBe(0);
  });
});

describe("the per-frame matrix memo (§2.5)", () => {
  const key = ["day", 0, MS_DAY, 1] as const;
  const empty: UtilizationMatrix<unknown> = { bucket: "day", rows: [] };

  it("builds once for a repeated key and serves the same matrix", () => {
    let builds = 0;
    const memo = createMatrixMemo(() => {
      builds += 1;
      return empty;
    });
    const first = memo.get(...key);
    expect(memo.get(...key)).toBe(first);
    expect(builds).toBe(1);
  });

  it("misses on every different key — bucket width, either bound, or the week start", () => {
    let builds = 0;
    const memo = createMatrixMemo(() => {
      builds += 1;
      return empty;
    });
    memo.get("day", 0, MS_DAY, 1);
    memo.get("week", 0, MS_DAY, 1);
    memo.get("day", 0, 2 * MS_DAY, 1);
    memo.get("day", 0, MS_DAY, 0);
    expect(builds).toBe(4);
  });

  it("rebuilds after an invalidation, so nothing outlives its frame", () => {
    let builds = 0;
    const memo = createMatrixMemo(() => {
      builds += 1;
      return empty;
    });
    memo.get(...key);
    memo.invalidate();
    memo.get(...key);
    expect(builds).toBe(2);
  });
});

describe("roster dedupe (allowlist, caller policy — §2.3)", () => {
  it("yields one matrix row for a resource listed twice in the allowlist", () => {
    const store: Store = {
      tasks: [{ id: "t", start: MONDAY, end: MONDAY + MS_DAY }],
      resources: [ada()],
      assignments: [{ taskId: "t", resourceId: "r", units: 1 }],
    };
    const roster = loadChartRoster(store, ["r", "r"]);
    const matrix = computeUtilization({
      resources: roster,
      demands: loadChartDemands(store, roster),
      start: MONDAY,
      end: MONDAY + MS_DAY,
      bucket: "day",
      edges: "aligned",
      weekStartDay: 1,
    });
    expect(matrix.rows).toHaveLength(1);
    expect(matrix.rows[0]!.resource.id).toBe("r");
  });

  it("emits one row per roster entry, in roster order", () => {
    const store: Store = {
      tasks: [{ id: "t", start: MONDAY, end: MONDAY + MS_DAY }],
      resources: [
        { id: "a", name: "A" },
        { id: "b", name: "B" },
      ],
      assignments: [{ taskId: "t", resourceId: "a", units: 1 }],
    };
    const roster = loadChartRoster(store, ["b", "a"]);
    const matrix = computeUtilization({
      resources: roster,
      demands: loadChartDemands(store, roster),
      start: MONDAY,
      end: MONDAY + MS_DAY,
      bucket: "day",
      edges: "aligned",
      weekStartDay: 1,
    });
    expect(matrix.rows.map((r) => r.resource.id)).toEqual(["b", "a"]);
    expect(matrix.rows[0]!.cells[0]!.allocated).toBe(0);
    expect(matrix.rows[1]!.cells[0]!.allocated).toBe(MS_DAY);
  });

  it("yields no rows for an empty roster — there is no task-count fallback in the matrix", () => {
    const matrix = computeUtilization({
      resources: [],
      demands: new Map(),
      start: MONDAY,
      end: MONDAY + MS_DAY,
      bucket: "day",
      edges: "aligned",
      weekStartDay: 1,
    });
    expect(matrix.rows).toEqual([]);
  });
});
