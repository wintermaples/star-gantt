/**
 * The millisecond unification's numerical-invariance guarantee (docs/specs/plugins/tracking.md §2.2
 * / §2.8): for a plan whose calendars declare no intra-day working windows, every money figure this
 * area publishes is numerically UNCHANGED from the prior day-denominated formula.
 *
 * Every expectation below is derived from the OLD, day-denominated formula written inline as an
 * oracle — never from whatever the current code happens to produce. `toBe` is deliberate: the
 * guarantee is exact, not "close enough", so an ulp of drift is a failure.
 */
import { afterEach, describe, expect, it } from "vitest";
import { DAY, bootCost, task } from "./cost-helpers";
import type { CostBoot } from "./cost-helpers";

let boot: CostBoot | undefined;
afterEach(() => {
  boot?.dispose();
  boot = undefined;
});

/** One assignment as the oracle sees it: allocation plus the rate that resolved for it. */
interface OracleAssignment {
  units: number;
  standard: number;
  overtime?: number;
}

/**
 * Labor cost exactly as it stood before the millisecond unification:
 *
 *     days  = max(0, (end − start) / 86_400_000)
 *     hours = days × hoursPerDay
 *     cost  = Σ hours × min(units, 1) × standard
 *           + Σ hours × max(units − 1, 0) × (overtime ?? standard)
 *
 * This keeps the definition of labor effort as elapsed span — the plugin consults no working calendar — and
 * the ms re-expression `effortMs = elapsedMs × hoursPerDay × 3_600_000 / 86_400_000`, costed at
 * `effortMs / 3_600_000`, is an algebraic identity over it. The two must therefore agree EXACTLY.
 */
function oldLaborCost(
  startMs: number,
  endMs: number,
  hoursPerDay: number,
  assignments: readonly OracleAssignment[],
): number {
  const days = Math.max(0, (endMs - startMs) / DAY);
  if (days === 0) return 0;
  const hours = days * hoursPerDay;
  let total = 0;
  for (const a of assignments) {
    total += hours * Math.min(a.units, 1) * a.standard;
    total += hours * Math.max(a.units - 1, 0) * (a.overtime ?? a.standard);
  }
  return total;
}

describe("labor cost is numerically unchanged by the millisecond unification", () => {
  it("matches the old days × hoursPerDay chain at the default 8 h density", () => {
    boot = bootCost({ cost: { rates: [{ resourceId: "r1", standard: 10 }] } });
    boot.data.load({
      tasks: [task("a", 0, 10 * DAY)],
      resources: [{ id: "r1", name: "Dev" }],
      assignments: [{ taskId: "a", resourceId: "r1", units: 1 }],
    });
    // Old oracle: 10 days × 8 h × 1 unit × 10/h.
    const expected = oldLaborCost(0, 10 * DAY, 8, [{ units: 1, standard: 10 }]);
    expect(expected).toBe(800);
    expect(boot.service.costOf("a")?.labor).toBe(expected);
  });

  it("matches it at a density whose millisecond round-trip would lose an ulp", () => {
    // 7 days at a 7.4 h density is one of the cases where evaluating the ms form literally —
    // multiplying up by 3_600_000 and dividing straight back down — lands on 51.80000000000001 h
    // instead of the old chain's 51.800000000000004 h, moving the money. The guarantee is exact, so
    // the REDUCED form must be the one evaluated.
    boot = bootCost({ cost: { hoursPerDay: 7.4, rates: [{ resourceId: "r1", standard: 100 }] } });
    boot.data.load({
      tasks: [task("a", 0, 7 * DAY)],
      resources: [{ id: "r1", name: "Dev" }],
      assignments: [{ taskId: "a", resourceId: "r1", units: 1 }],
    });
    const expected = oldLaborCost(0, 7 * DAY, 7.4, [{ units: 1, standard: 100 }]);
    expect(boot.service.costOf("a")?.labor).toBe(expected);
  });

  it("matches it for the overtime split above full-time allocation", () => {
    boot = bootCost({
      cost: { hoursPerDay: 7.4, rates: [{ resourceId: "r2", standard: 20, overtime: 30 }] },
    });
    boot.data.load({
      tasks: [task("b", 10 * DAY, 15 * DAY)],
      resources: [{ id: "r2", name: "Rig" }],
      assignments: [{ taskId: "b", resourceId: "r2", units: 1.5 }],
    });
    // Old oracle: 5 days × 7.4 h, costed 1 unit at 20/h plus 0.5 unit at the 30/h overtime rate.
    const expected = oldLaborCost(10 * DAY, 15 * DAY, 7.4, [
      { units: 1.5, standard: 20, overtime: 30 },
    ]);
    expect(boot.service.costOf("b")?.labor).toBe(expected);
  });

  it("still contributes 0 for a zero-length span", () => {
    boot = bootCost({ cost: { rates: [{ resourceId: "r1", standard: 10 }] } });
    boot.data.load({
      tasks: [task("m", 3 * DAY, 3 * DAY, { type: "milestone" })],
      resources: [{ id: "r1", name: "Dev" }],
      assignments: [{ taskId: "m", resourceId: "r1", units: 1 }],
    });
    expect(oldLaborCost(3 * DAY, 3 * DAY, 8, [{ units: 1, standard: 10 }])).toBe(0);
    expect(boot.service.costOf("m")?.labor).toBe(0);
  });
});

describe("the composed money surface is unchanged", () => {
  it("estimated, actual, variance and the breakdown all re-derive from the old oracle", () => {
    boot = bootCost({ cost: { hoursPerDay: 7.4, rates: [{ resourceId: "r1", standard: 100 }] } });
    boot.data.load({
      tasks: [task("a", 0, 7 * DAY)],
      resources: [{ id: "r1", name: "Dev" }],
      assignments: [{ taskId: "a", resourceId: "r1", units: 1 }],
    });
    boot.service.setCostFields("a", { fixedCost: 250, materialCost: 90, actualCost: 6000 });

    const labor = oldLaborCost(0, 7 * DAY, 7.4, [{ units: 1, standard: 100 }]);
    // §2.9's composition: estimated = labor + fixed + variable + material; the comparison row's
    // variance = actual − estimated.
    const estimated = labor + 250 + 0 + 90;
    expect(boot.service.costOf("a")).toMatchObject({
      labor,
      fixed: 250,
      variable: 0,
      material: 90,
      estimated,
      actual: 6000,
    });
    expect(boot.service.breakdown()).toEqual({ labor, fixed: 250, variable: 0, material: 90 });
    expect(boot.service.comparison()[0]).toMatchObject({
      estimated,
      actual: 6000,
      variance: 6000 - estimated,
    });
  });

  it("the threshold alert trips on the same figures as before", () => {
    boot = bootCost({
      cost: { hoursPerDay: 7.4, alertThreshold: 1, rates: [{ resourceId: "r1", standard: 100 }] },
    });
    boot.data.load({
      tasks: [task("a", 0, 7 * DAY)],
      resources: [{ id: "r1", name: "Dev" }],
      assignments: [{ taskId: "a", resourceId: "r1", units: 1 }],
    });
    const estimated = oldLaborCost(0, 7 * DAY, 7.4, [{ units: 1, standard: 100 }]);
    // §2.10: a task alerts when its actual exceeds threshold × estimate. One cent over the old
    // estimate must still trip, and the reported limit must still be the old estimate itself.
    boot.service.setCostFields("a", { actualCost: estimated + 0.01 });
    expect(boot.service.alerts()).toEqual([
      { kind: "task", subject: "a", value: estimated + 0.01, limit: estimated },
    ]);
  });
});

describe("effort stays elapsed-span based, not working-time based (named deferral)", () => {
  it("two equal elapsed spans cost the same whether or not they cover a weekend", () => {
    // Epoch day 0 is a Thursday, so days 1–5 cover Sat and Sun while days 5–9 are Tue–Fri. Both
    // spans are 4 elapsed days. Consulting the working-time engine instead of the hoursPerDay
    // density would make these differ — this switch is deliberately deferred because it would move
    // existing plans' money.
    boot = bootCost({ cost: { rates: [{ resourceId: "r1", standard: 10 }] } });
    boot.data.load({
      tasks: [task("weekend", 1 * DAY, 5 * DAY), task("midweek", 5 * DAY, 9 * DAY)],
      resources: [{ id: "r1", name: "Dev" }],
      assignments: [
        { taskId: "weekend", resourceId: "r1", units: 1 },
        { taskId: "midweek", resourceId: "r1", units: 1 },
      ],
    });
    const expected = oldLaborCost(0, 4 * DAY, 8, [{ units: 1, standard: 10 }]);
    expect(boot.service.costOf("weekend")?.labor).toBe(expected);
    expect(boot.service.costOf("midweek")?.labor).toBe(expected);
  });
});
