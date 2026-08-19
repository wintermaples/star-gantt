/**
 * `internal/cost/curve.ts` — the cumulative cost curve and the CPI-scaled S-curve forecast
 * (docs/specs/plugins/tracking.md §2.11).
 *
 * Uses a naive O(T²) per-sample oracle, plus explicit coverage of the review-fixed boundary rule: `costForecast`
 * returns the SAME point set as `costCurve` — nothing appended — and the status-date point ITSELF
 * carries a forecast.
 */
import { describe, expect, it } from "vitest";
import { costCurvePoints, costForecastPoints } from "../src/internal/cost/curve";
import type { CurveTask } from "../src/internal/cost/curve";
import { DAY } from "./cost-helpers";

const FIXTURE: CurveTask[] = [
  { start: 0, end: 10 * DAY, estimated: 1000, actual: 400 },
  { start: 10 * DAY, end: 20 * DAY, estimated: 500, actual: 0 },
];

describe("cost curve (§2.11)", () => {
  it("accumulates planned uniformly and actual up to the status date", () => {
    const points = costCurvePoints(FIXTURE, 5 * DAY);
    const at = (t: number): (typeof points)[number] | undefined => points.find((p) => p.t === t);
    expect(at(0)).toEqual({ t: 0, planned: 0, actual: 0 });
    // Status date at day 5: half the first task's planned; its whole actual spread over [0, 5d).
    expect(at(5 * DAY)).toEqual({ t: 5 * DAY, planned: 500, actual: 400 });
    expect(at(20 * DAY)).toEqual({ t: 20 * DAY, planned: 1500, actual: 400 });
    expect(points.map((p) => p.t)).toEqual([0, 5 * DAY, 10 * DAY, 20 * DAY]);
  });

  it("is empty without tasks, and carries no `forecast` on any point", () => {
    expect(costCurvePoints([], 0)).toEqual([]);
    expect(costForecastPoints([], 0)).toEqual([]);
    for (const p of costCurvePoints(FIXTURE, 5 * DAY)) expect(p.forecast).toBeUndefined();
  });

  it("a zero-span task is a step at its date", () => {
    const points = costCurvePoints([{ start: 3 * DAY, end: 3 * DAY, estimated: 200, actual: 0 }], 0);
    expect(points.find((p) => p.t === 3 * DAY)?.planned).toBe(200);
  });
});

describe("cost forecast (§2.11, the review-fixed boundary)", () => {
  it("forecasts by scaling remaining planned with the cost performance factor", () => {
    const points = costForecastPoints(FIXTURE, 5 * DAY);
    // f = actualToDate / plannedToDate = 400 / 500 = 0.8
    const last = points[points.length - 1];
    expect(last?.forecast).toBeCloseTo(400 + 0.8 * (1500 - 500));
    // …and it lands on f × totalPlanned.
    expect(last?.forecast).toBeCloseTo(0.8 * 1500);
  });

  it("returns the SAME point set as costCurve — nothing appended", () => {
    const curve = costCurvePoints(FIXTURE, 5 * DAY);
    const forecast = costForecastPoints(FIXTURE, 5 * DAY);
    expect(forecast).toHaveLength(curve.length);
    expect(forecast.map((p) => p.t)).toEqual(curve.map((p) => p.t));
    forecast.forEach((p, i) => {
      expect(p.planned).toBe(curve[i]!.planned);
      expect(p.actual).toBe(curve[i]!.actual);
    });
  });

  it("points strictly BEFORE the status date carry no forecast; the status-date point DOES", () => {
    const points = costForecastPoints(FIXTURE, 5 * DAY);
    expect(points.find((p) => p.t === 0)?.forecast).toBeUndefined();
    // The pinned boundary: `p.t < statusDate` is the ONLY unchanged case,
    // so the status-date point itself is a forecast point and reads actualToDate exactly.
    expect(points.find((p) => p.t === 5 * DAY)?.forecast).toBeCloseTo(400);
    for (const p of points) {
      expect(p.forecast === undefined).toBe(p.t < 5 * DAY);
    }
  });

  it("uses f = 1 when planned-to-date is 0", () => {
    // Status date before anything is planned: nothing is earned yet, so the extrapolation is the
    // plan itself.
    const points = costForecastPoints(
      [{ start: 10 * DAY, end: 20 * DAY, estimated: 500, actual: 0 }],
      0,
    );
    expect(points.find((p) => p.t === 0)?.forecast).toBe(0);
    expect(points[points.length - 1]?.forecast).toBeCloseTo(500);
  });

  it("every point is a forecast point when the status date precedes them all", () => {
    const points = costForecastPoints(FIXTURE, -DAY);
    expect(points.every((p) => p.forecast !== undefined)).toBe(true);
  });
});

describe("conformance vs the naive O(T²) per-sample reference", () => {
  // The pre-sweep implementation: scan every task at every sample time. Kept here, independent of
  // `internal/cost/curve.ts`, as an oracle for the sorted-boundary slope sweep.
  function naivePlannedAt(tasks: readonly CurveTask[], t: number): number {
    let total = 0;
    for (const task of tasks) {
      if (task.estimated === 0) continue;
      const span = task.end - task.start;
      if (span <= 0) {
        if (t >= task.start) total += task.estimated;
      } else {
        const f = (t - task.start) / span;
        total += task.estimated * (f <= 0 ? 0 : f >= 1 ? 1 : f);
      }
    }
    return total;
  }

  function naiveActualAt(tasks: readonly CurveTask[], t: number, statusDate: number): number {
    const at = Math.min(t, statusDate);
    let total = 0;
    for (const task of tasks) {
      if (task.actual === 0) continue;
      const start = Math.min(task.start, statusDate);
      const end = Math.min(task.end, statusDate);
      const span = end - start;
      if (span <= 0) {
        if (at >= start) total += task.actual;
      } else {
        const f = (at - start) / span;
        total += task.actual * (f <= 0 ? 0 : f >= 1 ? 1 : f);
      }
    }
    return total;
  }

  function naiveSampleTimes(tasks: readonly CurveTask[], statusDate: number): number[] {
    const set = new Set<number>();
    for (const task of tasks) {
      set.add(task.start);
      set.add(task.end);
    }
    if (set.size > 0) set.add(statusDate);
    return [...set].sort((a, b) => a - b);
  }

  function naiveCostCurvePoints(
    tasks: readonly CurveTask[],
    statusDate: number,
  ): { t: number; planned: number; actual: number }[] {
    return naiveSampleTimes(tasks, statusDate).map((t) => ({
      t,
      planned: naivePlannedAt(tasks, t),
      actual: naiveActualAt(tasks, t, statusDate),
    }));
  }

  const cases: { name: string; tasks: CurveTask[]; statusDate: number }[] = [
    { name: "the fixture project", tasks: FIXTURE, statusDate: 5 * DAY },
    {
      name: "zero-span (milestone) tasks",
      tasks: [
        { start: 3 * DAY, end: 3 * DAY, estimated: 200, actual: 200 },
        { start: 8 * DAY, end: 8 * DAY, estimated: 300, actual: 0 },
      ],
      statusDate: 5 * DAY,
    },
    {
      name: "overlapping tasks straddling the status date",
      tasks: [
        { start: 0, end: 20 * DAY, estimated: 2000, actual: 900 },
        { start: 5 * DAY, end: 15 * DAY, estimated: 800, actual: 800 },
        { start: -5 * DAY, end: 5 * DAY, estimated: 100, actual: 0 },
      ],
      statusDate: 10 * DAY,
    },
    {
      name: "status date before every task starts",
      tasks: [{ start: 10 * DAY, end: 20 * DAY, estimated: 500, actual: 0 }],
      statusDate: 0,
    },
    {
      name: "status date after every task ends",
      tasks: [{ start: 0, end: 10 * DAY, estimated: 500, actual: 300 }],
      statusDate: 20 * DAY,
    },
  ];

  for (const c of cases) {
    it(`matches the naive scan for ${c.name}`, () => {
      const fast = costCurvePoints(c.tasks, c.statusDate);
      const naive = naiveCostCurvePoints(c.tasks, c.statusDate);
      // Floating-point summation order differs between an incremental sweep and a per-sample full
      // scan, so compare numerically close rather than byte-exact.
      expect(fast.map((p) => p.t)).toEqual(naive.map((p) => p.t));
      fast.forEach((p, i) => {
        expect(p.planned).toBeCloseTo(naive[i]!.planned, 6);
        expect(p.actual).toBeCloseTo(naive[i]!.actual, 6);
      });
    });
  }
});
