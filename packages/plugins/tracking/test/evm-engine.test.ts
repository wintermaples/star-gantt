/**
 * `internal/evm/engine.ts` + `internal/evm/values.ts` — the hostless computation core and the
 * per-task storage model (docs/specs/plugins/tracking.md §2.1 / §2.15).
 *
 * Covers the accrual/PV/derive/aggregate and field-storage halves; the S-curve half lives in
 * `evm-scurve.test.ts`. Fully hostless: no `ctx`, no data store, no DOM.
 */
import { describe, expect, it } from "vitest";
import {
  aggregate,
  derive,
  earnedFraction,
  latched,
  pvFraction,
  taskMetrics,
} from "../src/internal/evm/engine";
import type { EvmTaskInput } from "../src/internal/evm/engine";
import {
  evmValuesOf,
  isEarnedValueMethod,
  mergeEvmValues,
  metaEqual,
  usableAmount,
} from "../src/internal/evm/values";
import { buildBagWrite } from "../src/internal/shared/meta-bag";
import type { Task } from "@stargantt/plugin-data-store";

const DAY = 86_400_000;

describe("earnedFraction — the four accrual rules (§2.15)", () => {
  it("percentComplete earns the clamped progress fraction", () => {
    expect(earnedFraction("percentComplete", 0.4, [])).toBe(0.4);
    expect(earnedFraction("percentComplete", -1, [])).toBe(0);
    expect(earnedFraction("percentComplete", 2, [])).toBe(1);
    expect(earnedFraction("percentComplete", Number.NaN, [])).toBe(0);
  });

  it("zeroHundred earns only on completion", () => {
    expect(earnedFraction("zeroHundred", 0.99, [])).toBe(0);
    expect(earnedFraction("zeroHundred", 1, [])).toBe(1);
  });

  it("fiftyFifty earns half once started", () => {
    expect(earnedFraction("fiftyFifty", 0, [])).toBe(0);
    expect(earnedFraction("fiftyFifty", 0.01, [])).toBe(0.5);
    expect(earnedFraction("fiftyFifty", 0.99, [])).toBe(0.5);
    expect(earnedFraction("fiftyFifty", 1, [])).toBe(1);
  });

  it("milestoneWeighted earns the completed weight share, falling back to percentComplete", () => {
    const milestones = [
      { weight: 1, complete: true },
      { weight: 3, complete: false },
    ];
    expect(earnedFraction("milestoneWeighted", 0.9, milestones)).toBe(0.25);
    expect(earnedFraction("milestoneWeighted", 0.9, [])).toBe(0.9);
  });
});

describe("pvFraction and derive (§2.15)", () => {
  it("spreads uniformly, whole for zero spans once reached", () => {
    expect(pvFraction(0, 10 * DAY, 5 * DAY)).toBe(0.5);
    expect(pvFraction(0, 10 * DAY, -DAY)).toBe(0);
    expect(pvFraction(0, 10 * DAY, 20 * DAY)).toBe(1);
    expect(pvFraction(5 * DAY, 5 * DAY, 4 * DAY)).toBe(0);
    expect(pvFraction(5 * DAY, 5 * DAY, 5 * DAY)).toBe(1);
  });

  it("derives SV/CV/SPI/CPI, leaving indices absent on zero denominators", () => {
    const m = derive(1000, 500, 400, 800, "cpi");
    expect(m.sv).toBe(-100);
    expect(m.cv).toBe(-400);
    expect(m.spi).toBeCloseTo(0.8);
    expect(m.cpi).toBeCloseTo(0.5);
    const zero = derive(1000, 0, 0, 0, "cpi");
    expect(zero.spi).toBeUndefined();
    expect(zero.cpi).toBeUndefined();
  });

  it("computes EAC per formula with the documented fallbacks", () => {
    // cpi: BAC / CPI; falls back to BAC when CPI is absent.
    expect(derive(1000, 500, 400, 800, "cpi").eac).toBeCloseTo(1000 / 0.5);
    expect(derive(1000, 0, 0, 0, "cpi").eac).toBe(1000);
    // remaining: AC + (BAC − EV).
    expect(derive(1000, 500, 400, 800, "remaining").eac).toBe(800 + 600);
    // cpiSpi: AC + (BAC − EV) / (CPI × SPI); falls back to remaining on an unusable factor.
    expect(derive(1000, 500, 400, 800, "cpiSpi").eac).toBeCloseTo(800 + 600 / (0.5 * 0.8));
    expect(derive(1000, 0, 0, 800, "cpiSpi").eac).toBe(800 + 1000);
    // ETC is always EAC − AC.
    const m = derive(1000, 500, 400, 800, "remaining");
    expect(m.etc).toBe(m.eac - m.ac);
  });

  it("lets an EAC override replace the forecast, with ETC following it", () => {
    const m = derive(1000, 500, 400, 800, "cpi", (i) => i.ac + (i.bac - i.ev) * 2);
    expect(m.eac).toBe(800 + 600 * 2);
    expect(m.etc).toBe(m.eac - 800);
    // An override that declines leaves the built-in forecast untouched.
    expect(derive(1000, 500, 400, 800, "cpi", () => undefined).eac).toBeCloseTo(1000 / 0.5);
  });

  it("aggregates by summing PV/EV/AC and deriving from the sums", () => {
    const input = (id: string, bac: number, progress: number, ac: number): EvmTaskInput => ({
      id,
      plannedStart: 0,
      plannedEnd: 10 * DAY,
      bac,
      ac,
      progress,
      method: "percentComplete",
      milestones: [],
    });
    const perTask = [
      taskMetrics(input("a", 100, 0.5, 40), 5 * DAY, "cpi"),
      taskMetrics(input("b", 300, 1, 350), 5 * DAY, "cpi"),
    ];
    const project = aggregate(perTask, 400, "cpi");
    expect(project.pv).toBeCloseTo(50 + 150);
    expect(project.ev).toBeCloseTo(50 + 300);
    expect(project.ac).toBe(390);
    expect(project.spi).toBeCloseTo(350 / 200);
  });

  it("an already-resolved earned fraction wins over the method rule", () => {
    const m = taskMetrics(
      {
        id: "a",
        plannedStart: 0,
        plannedEnd: 10 * DAY,
        bac: 1000,
        ac: 0,
        progress: 0.5,
        method: "zeroHundred",
        milestones: [],
        earned: 0.25,
      },
      5 * DAY,
      "cpi",
    );
    expect(m.earned).toBe(0.25);
    expect(m.ev).toBe(250);
  });
});

describe("latched — the §2.15 host-rule barrier", () => {
  it("reports the first throw once, then declines for the rest of the instance's life", () => {
    const seen: unknown[] = [];
    let calls = 0;
    const run = latched<[number]>(
      (error) => seen.push(error),
      () => {
        calls += 1;
        throw new Error("boom");
      },
    );
    expect(run(1)).toBeUndefined();
    expect(run(1)).toBeUndefined();
    expect(run(1)).toBeUndefined();
    expect(calls).toBe(1); // never called again after the latch closed
    expect(seen).toHaveLength(1);
  });

  it("declines a non-finite answer for that call only, silently", () => {
    const seen: unknown[] = [];
    let next = Number.NaN;
    const run = latched<[]>(
      (error) => seen.push(error),
      () => next,
    );
    expect(run()).toBeUndefined();
    next = 7;
    expect(run()).toBe(7); // not latched — the rule still answers
    expect(seen).toEqual([]);
  });

  it("an absent rule always declines and never reports", () => {
    const seen: unknown[] = [];
    const run = latched<[]>((error) => seen.push(error), undefined);
    expect(run()).toBeUndefined();
    expect(seen).toEqual([]);
  });
});

describe("field storage (§2.1)", () => {
  const taskWith = (evm: unknown): Task =>
    ({ id: "t", parentId: null, name: "t", start: 0, end: DAY, meta: { evm } }) as Task;

  it("reads defensively, dropping unusable members and milestones", () => {
    expect(evmValuesOf(undefined)).toEqual({});
    expect(evmValuesOf(taskWith("junk"))).toEqual({});
    const values = evmValuesOf(
      taskWith({
        bac: 100,
        actualCost: -5,
        method: "zeroHundred",
        milestones: [
          { weight: 2, complete: true, label: "half" },
          { weight: 0, complete: true },
          { weight: 1, complete: "no" },
        ],
      }),
    );
    expect(values.bac).toBe(100);
    expect(values.actualCost).toBeUndefined();
    expect(values.method).toBe("zeroHundred");
    expect(values.milestones).toEqual([{ weight: 2, complete: true, label: "half" }]);
  });

  it("merges patches: undefined removes, unusable values are dropped, absent keys untouched", () => {
    const merged = mergeEvmValues(
      { bac: 100, actualCost: 50 },
      { actualCost: undefined, method: "fiftyFifty", bac: Number.NaN },
    );
    expect(merged).toEqual({ method: "fiftyFifty" });
  });

  it("recognizes the four method names and the non-negative-amount shape", () => {
    expect(isEarnedValueMethod("fiftyFifty")).toBe(true);
    expect(isEarnedValueMethod("nope")).toBe(false);
    expect(usableAmount(0)).toBe(true);
    expect(usableAmount(-1)).toBe(false);
    expect(usableAmount(Number.NaN)).toBe(false);
    expect(usableAmount("5")).toBe(false);
  });

  it("the bag write preserves siblings and clears an emptied meta (§2.1's `clears` path)", () => {
    const withSibling = { id: "t", parentId: null, name: "t", start: 0, end: DAY, meta: { other: 1 } } as Task;
    expect(buildBagWrite(withSibling, "evm", { bac: 2 })).toEqual({
      after: { meta: { other: 1, evm: { bac: 2 } } },
    });
    const onlyEvm = taskWith({ bac: 2 });
    expect(buildBagWrite(onlyEvm, "evm", {})).toEqual({ after: {}, clears: ["meta"] });
    const both = { ...withSibling, meta: { other: 1, evm: { bac: 2 } } } as Task;
    expect(buildBagWrite(both, "evm", {})).toEqual({ after: { meta: { other: 1 } } });
  });

  it("metaEqual treats undefined-vs-undefined as equal and detects real differences", () => {
    expect(metaEqual(undefined, undefined)).toBe(true);
    expect(metaEqual({ other: 1 }, { other: 1 })).toBe(true);
    expect(metaEqual(undefined, { other: 1 })).toBe(false);
    expect(metaEqual({ other: 1 }, undefined)).toBe(false);
    expect(metaEqual({ other: 1 }, { other: 2 })).toBe(false);
  });
});
