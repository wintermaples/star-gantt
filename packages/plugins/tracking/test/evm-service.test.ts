/**
 * `internal/evm/wire.ts` — the assembled `EvmService` over a real data store, with hand-built
 * `EvmAreaExtras` stand-ins for the §2.14 fan-in (docs/specs/plugins/tracking.md §1.4 / §2.14 /
 * §2.15).
 *
 * Rather than composing the sibling plugins (cost-tracking, baselines, progress-tracking), this
 * drives the same inputs through `extras` and the claimed `progressTracking` meta bag — the v2
 * fan-in, which reaches no sibling service at all.
 */
import { afterEach, describe, expect, it } from "vitest";
import type { Task } from "@stargantt/plugin-data-store";
import { MS_DAY, bootEvm, task, taskCost } from "./evm-boot";
import type { EvmBoot } from "./evm-boot";
import type { EvmIndices } from "../src/types";

let boot: EvmBoot | undefined;
afterEach(() => {
  boot?.dispose();
  boot = undefined;
});

/** Two tasks: "a" spans days 0–10 at 50% progress, "b" spans days 10–15 unstarted. */
function loadProject(b: EvmBoot): void {
  b.data.load({
    tasks: [task("a", 0, 10 * MS_DAY, { progress: 0.5 }), task("b", 10 * MS_DAY, 15 * MS_DAY)],
  });
}

/** One task spanning days 0–10 at 50% progress, budget 1000, actual cost 800. */
function loadSingle(b: EvmBoot): void {
  b.data.load({ tasks: [task("a", 0, 10 * MS_DAY, { progress: 0.5 })] });
  b.service.setFields("a", { bac: 1000, actualCost: 800 });
}

describe("per-task fields and the §2.14 BAC/AC resolution", () => {
  it("stores fields via task/update, preserving sibling meta keys and clearing empty bags", () => {
    boot = bootEvm({ evm: { statusDate: 5 * MS_DAY } });
    loadProject(boot);
    boot.gantt.dispatch("task/update", { id: "a", after: { meta: { other: 1 } } });
    boot.service.setFields("a", { bac: 1000, actualCost: 300 });
    expect(boot.service.valuesOf("a")).toEqual({ bac: 1000, actualCost: 300 });
    expect(boot.data.getTask("a")?.meta?.["other"]).toBe(1);
    // Removing every field drops the evm key but keeps the sibling.
    boot.service.setFields("a", { bac: undefined, actualCost: undefined });
    expect(boot.service.valuesOf("a")).toEqual({});
    expect(boot.data.getTask("a")?.meta).toEqual({ other: 1 });
    // Clearing on a task with no sibling keys clears meta entirely (the §2.1 `clears` path).
    boot.service.setFields("b", { bac: 5 });
    boot.service.setFields("b", { bac: undefined });
    expect(boot.data.getTask("b")?.meta).toBeUndefined();
  });

  it("removes fields with undefined keys; unknown tasks and unusable values are no-ops", () => {
    boot = bootEvm({ evm: { statusDate: 5 * MS_DAY } });
    loadProject(boot);
    boot.service.setFields("a", { bac: 100, method: "zeroHundred" });
    boot.service.setFields("a", { bac: undefined, actualCost: Number.NaN });
    expect(boot.service.valuesOf("a")).toEqual({ method: "zeroHundred" });
    boot.service.setFields("nope", { bac: 5 });
    expect(boot.service.valuesOf("nope")).toEqual({});
  });

  it("skips the dispatch entirely for a genuine no-op setFields", () => {
    boot = bootEvm({ evm: { statusDate: 5 * MS_DAY } });
    loadProject(boot);
    let changes = 0;
    const sub = boot.data.tasks.subscribe(() => void (changes += 1));
    // "b" has no stored evm meta at all; a patch clearing fields it never had must not touch the
    // store — `clears: ["meta"]` would otherwise still produce a patch.
    boot.service.setFields("b", { bac: undefined, actualCost: undefined });
    expect(changes).toBe(0);
    expect(boot.data.getTask("b")?.meta).toBeUndefined();
    // A real write still dispatches normally.
    boot.service.setFields("b", { bac: 10 });
    expect(changes).toBe(1);
    // Setting the same value again (merges to byte-identical meta) is also a no-op.
    boot.service.setFields("b", { bac: 10 });
    expect(changes).toBe(1);
    // Clearing it back down for real dispatches once more.
    boot.service.setFields("b", { bac: undefined });
    expect(changes).toBe(2);
    sub.dispose();
  });

  it("falls back to the cost area's estimated/actual through `extras.costOf`", () => {
    boot = bootEvm({ evm: { statusDate: 5 * MS_DAY } });
    loadProject(boot);
    boot.costs.set("a", taskCost("a", 700, 250));
    expect(boot.service.bacOf("a")).toBe(700);
    expect(boot.service.metricsOf("a")?.ac).toBe(250);
    // The stored EVM value wins over the fallback.
    boot.service.setFields("a", { bac: 900 });
    expect(boot.service.bacOf("a")).toBe(900);
    expect(boot.service.metricsOf("a")?.ac).toBe(250); // AC still falls through
    expect(boot.service.bacOf("missing")).toBe(0);
  });

  it("resolves BAC/AC to 0 when the cost area knows nothing about the task", () => {
    boot = bootEvm({ evm: { statusDate: 5 * MS_DAY } });
    loadProject(boot);
    expect(boot.service.bacOf("a")).toBe(0);
    expect(boot.service.metricsOf("a")).toMatchObject({ bac: 0, ac: 0, pv: 0, ev: 0 });
    expect(boot.extrasCalls).toContain("costOf:a");
  });

  it("projectBac sums task BACs, with a session override on top", () => {
    boot = bootEvm({ evm: { statusDate: 5 * MS_DAY } });
    loadProject(boot);
    boot.service.setFields("a", { bac: 100 });
    boot.service.setFields("b", { bac: 50 });
    expect(boot.service.projectBac()).toBe(150);

    const seen: (number | undefined)[] = [];
    const sub = boot.service.state.subscribe((next) => seen.push(next.projectBacOverride));
    boot.service.setProjectBac(400);
    expect(boot.service.projectBac()).toBe(400);
    boot.service.setProjectBac(Number.NaN); // unusable — ignored, no state change
    expect(boot.service.projectBac()).toBe(400);
    boot.service.setProjectBac(undefined);
    expect(boot.service.projectBac()).toBe(150);
    expect(seen).toEqual([400, undefined]);
    sub.dispose();
  });

  it("seeds the project-BAC override from config, as the store's INITIAL value", () => {
    boot = bootEvm({ evm: { projectBac: 5000, statusDate: 5 * MS_DAY } });
    loadProject(boot);
    let sets = 0;
    const sub = boot.service.state.subscribe(() => void (sets += 1));
    expect(boot.service.state.get().projectBacOverride).toBe(5000);
    expect(boot.service.projectBac()).toBe(5000);
    expect(sets).toBe(0); // the seed is the initial state, not a later emission
    sub.dispose();
  });
});

describe("metrics at the status date (§2.15)", () => {
  it("computes PV/EV/AC and the derived indices per task and for the project", () => {
    boot = bootEvm({ evm: { statusDate: 5 * MS_DAY } });
    loadProject(boot);
    boot.service.setFields("a", { bac: 1000, actualCost: 800 });
    const m = boot.service.metricsOf("a");
    // PV: halfway through the span; EV: 50% progress; AC as stored.
    expect(m).toMatchObject({ pv: 500, ev: 500, ac: 800, sv: 0, cv: -300 });
    expect(m?.spi).toBe(1);
    expect(m?.cpi).toBeCloseTo(500 / 800);
    expect(m?.eac).toBeCloseTo(1000 / (500 / 800)); // default "cpi" formula
    const project = boot.service.projectMetrics();
    expect(project.bac).toBe(1000);
    expect(project.pv).toBe(500);
    expect(boot.service.metrics()).toHaveLength(2);
    expect(boot.service.metricsOf("nope")).toBeUndefined();
  });

  it("honors accrual methods: config default, per-task override, milestone weighting", () => {
    boot = bootEvm({ evm: { statusDate: 5 * MS_DAY, method: "zeroHundred" } });
    loadProject(boot);
    boot.service.setFields("a", { bac: 100 });
    expect(boot.service.method()).toBe("zeroHundred");
    expect(boot.service.earnedOf("a")).toBe(0); // 50% progress earns nothing under 0/100
    boot.service.setFields("a", { method: "fiftyFifty" });
    expect(boot.service.methodOf("a")).toBe("fiftyFifty");
    expect(boot.service.earnedOf("a")).toBe(0.5);
    boot.service.setFields("a", {
      method: "milestoneWeighted",
      milestones: [
        { weight: 3, complete: true },
        { weight: 1, complete: false },
      ],
    });
    expect(boot.service.earnedOf("a")).toBe(0.75);
    expect(boot.service.metricsOf("a")?.ev).toBe(75);
    expect(boot.service.earnedOf("nope")).toBe(0);
  });

  it("uses the eacMethod from config", () => {
    boot = bootEvm({ evm: { statusDate: 5 * MS_DAY, eacMethod: "remaining" } });
    loadProject(boot);
    boot.service.setFields("a", { bac: 1000, actualCost: 800 });
    expect(boot.service.metricsOf("a")?.eac).toBe(800 + (1000 - 500));
  });

  it("reads physicalPercent straight off the claimed `progressTracking` bag (§2.14)", () => {
    boot = bootEvm({ evm: { statusDate: 5 * MS_DAY } });
    loadProject(boot);
    boot.service.setFields("a", { bac: 100 });
    expect(boot.service.earnedOf("a")).toBe(0.5); // task.progress
    boot.gantt.dispatch("task/update", {
      id: "a",
      after: { meta: { evm: { bac: 100 }, progressTracking: { physicalPercent: 20 } } },
    });
    expect(boot.service.earnedOf("a")).toBe(0.2); // physical percent wins
  });

  it("clamps an out-of-range physicalPercent and ignores an unusable one", () => {
    boot = bootEvm({ evm: { statusDate: 5 * MS_DAY } });
    boot.data.load({ tasks: [task("a", 0, 10 * MS_DAY, { progress: 0.5 })] });
    const setBag = (bag: unknown): void =>
      boot?.gantt.dispatch("task/update", { id: "a", after: { meta: { progressTracking: bag } } });
    setBag({ physicalPercent: 250 });
    expect(boot.service.earnedOf("a")).toBe(1);
    setBag({ physicalPercent: -40 });
    expect(boot.service.earnedOf("a")).toBe(0);
    setBag({ physicalPercent: "80" });
    expect(boot.service.earnedOf("a")).toBe(0.5); // unusable — back to task.progress
    setBag("junk");
    expect(boot.service.earnedOf("a")).toBe(0.5); // a non-object bag reads as {}
  });

  it("takes planned dates from `extras.baselineSnapshotOf` when it answers", () => {
    boot = bootEvm({ evm: { statusDate: 5 * MS_DAY } });
    loadProject(boot);
    boot.service.setFields("a", { bac: 100 });
    boot.baselineSnapshots.set("a", { id: "a", start: 0, end: 10 * MS_DAY });
    // Slip the task: current dates move, the snapshot keeps the plan, so PV stays put.
    boot.gantt.dispatch("task/update", {
      id: "a",
      after: { start: 5 * MS_DAY, end: 15 * MS_DAY },
    });
    expect(boot.service.metricsOf("a")?.pv).toBe(50); // baseline plan: half elapsed
    boot.baselineSnapshots.delete("a");
    expect(boot.service.metricsOf("a")?.pv).toBe(0); // current dates: not started
  });
});

describe("the §2.14 status-date chain", () => {
  it("prefers the evm value, then the progress value, then the current UTC day", () => {
    boot = bootEvm({
      evm: { statusDate: 7 * MS_DAY },
      progress: { statusDate: 3 * MS_DAY },
      now: () => 9 * MS_DAY + 500,
    });
    expect(boot.service.statusDate()).toBe(7 * MS_DAY);
    boot.dispose();

    boot = bootEvm({ evm: {}, progress: { statusDate: 3 * MS_DAY }, now: () => 9 * MS_DAY + 500 });
    expect(boot.service.statusDate()).toBe(3 * MS_DAY);
    boot.dispose();

    boot = bootEvm({ evm: {}, now: () => 9 * MS_DAY + 500 });
    expect(boot.service.statusDate()).toBe(9 * MS_DAY);
  });

  it("tracks the clock live rather than latching at setup", () => {
    let now = 2 * MS_DAY + 10;
    boot = bootEvm({ evm: {}, now: () => now });
    expect(boot.service.statusDate()).toBe(2 * MS_DAY);
    now = 4 * MS_DAY + 10;
    expect(boot.service.statusDate()).toBe(4 * MS_DAY);
  });
});

describe("snapshots and the S-curve (§1.4 / §2.15)", () => {
  it("seeds one snapshot per UTC day (last wins) and drops unusable entries", () => {
    boot = bootEvm({
      evm: {
        statusDate: 5 * MS_DAY,
        snapshots: [
          { t: 2 * MS_DAY + 123, ev: 10, ac: 5 },
          { t: 2 * MS_DAY + 900, ev: 11, ac: 6 }, // same UTC day — this one wins
          { t: Number.NaN, ev: 1, ac: 1 },
          { t: 3 * MS_DAY, ev: -1, ac: 0 },
        ],
      },
    });
    loadProject(boot);
    expect(boot.service.state.get().snapshots).toEqual([{ t: 2 * MS_DAY, ev: 11, ac: 6 }]);
  });

  it("records the current project EV/AC onto the status date's UTC day, replacing same-day", () => {
    boot = bootEvm({
      evm: { statusDate: 5 * MS_DAY, snapshots: [{ t: 2 * MS_DAY + 123, ev: 10, ac: 5 }] },
    });
    loadProject(boot);
    boot.service.setFields("a", { bac: 100, actualCost: 30 });
    const recorded = boot.service.recordSnapshot();
    expect(recorded).toEqual({ t: 5 * MS_DAY, ev: 50, ac: 30 });
    boot.service.setFields("a", { actualCost: 40 });
    boot.service.recordSnapshot();
    expect(boot.service.state.get().snapshots).toEqual([
      { t: 2 * MS_DAY, ev: 10, ac: 5 },
      { t: 5 * MS_DAY, ev: 50, ac: 40 },
    ]);
  });

  it("re-recording an unchanged same-day snapshot sets nothing", () => {
    boot = bootEvm({ evm: { statusDate: 5 * MS_DAY } });
    loadProject(boot);
    boot.service.setFields("a", { bac: 100, actualCost: 30 });
    let sets = 0;
    const sub = boot.service.state.subscribe(() => void (sets += 1));
    boot.service.recordSnapshot();
    boot.service.recordSnapshot(); // identical figures, same UTC day — silent
    expect(sets).toBe(1);
    boot.service.setFields("a", { actualCost: 40 });
    boot.service.recordSnapshot(); // figures changed — one more set
    expect(sets).toBe(2);
    sub.dispose();
  });

  it("recordSnapshot() takes no argument — it always stamps the status date's UTC day", () => {
    boot = bootEvm({ evm: { statusDate: 5 * MS_DAY + 999 } });
    loadProject(boot);
    boot.service.setFields("a", { bac: 100, actualCost: 30 });
    expect((boot.service.recordSnapshot as (arg?: unknown) => unknown).length).toBe(0);
    expect(boot.service.recordSnapshot()).toEqual({ t: 5 * MS_DAY, ev: 50, ac: 30 });
  });

  it("builds the S-curve from planned boundaries, snapshots and the status date", () => {
    boot = bootEvm({ evm: { statusDate: 5 * MS_DAY } });
    loadProject(boot);
    boot.service.setFields("a", { bac: 100, actualCost: 60 });
    boot.service.setFields("b", { bac: 50 });
    const points = boot.service.scurve();
    expect(points.map((p) => p.t)).toEqual([0, 5 * MS_DAY, 10 * MS_DAY, 15 * MS_DAY]);
    expect(points[1]?.pv).toBe(50);
    expect(points[1]?.ev).toBe(50); // current project EV at the status date
    expect(points[1]?.ac).toBe(60);
    expect(points[2]?.ev).toBeUndefined(); // no EV/AC guess past the status date
    expect(points[3]?.pv).toBe(150);
    boot.data.load({ tasks: [] });
    expect(boot.service.scurve()).toEqual([]);
  });
});

describe("presence semantics (§5) and panel gating (§2.16)", () => {
  it("builds the whole service with the `evm` nest omitted, on the §5.4 defaults", () => {
    boot = bootEvm({ progress: { statusDate: 5 * MS_DAY } });
    loadProject(boot);
    boot.service.setFields("a", { bac: 1000, actualCost: 800 });
    expect(boot.service.method()).toBe("percentComplete");
    expect(boot.service.statusDate()).toBe(5 * MS_DAY);
    expect(boot.service.metricsOf("a")?.eac).toBeCloseTo(1000 / 0.625); // "cpi" default
    expect(boot.service.state.get()).toEqual({ projectBacOverride: undefined, snapshots: [] });
  });

  it("opens no panel while the nest is dormant, even with `stargantt.view` composed", () => {
    boot = bootEvm({ services: { "stargantt.view": { invalidate: () => undefined } } });
    loadProject(boot);
    expect(boot.service.openDashboardPanel()).toBe(false);
    expect(boot.service.openCurvePanel()).toBe(false);
    boot.service.closePanels(); // no-op
  });

  it("opens no panel while `stargantt.view` does not resolve", () => {
    boot = bootEvm({ evm: { statusDate: 5 * MS_DAY } });
    loadProject(boot);
    expect(boot.service.openDashboardPanel()).toBe(false);
    expect(boot.service.openCurvePanel()).toBe(false);
    boot.service.closePanels(); // no-op
  });
});

/* --- the function forms of method / eacMethod (§2.15) ---------------------- */

describe("`evm.method` as a host accrual rule", () => {
  it("drives EV from the rule, receiving the task, the status date and the budget", () => {
    const seen: { id: string; at: number; budget: number }[] = [];
    boot = bootEvm({
      evm: {
        statusDate: 5 * MS_DAY,
        method: (t: Readonly<Task>, at: number, budget: number) => {
          seen.push({ id: String(t.id), at, budget });
          return budget * 0.25;
        },
      },
    });
    loadSingle(boot);
    expect(boot.service.metricsOf("a")?.ev).toBe(250);
    expect(boot.service.earnedOf("a")).toBe(0.25);
    expect(seen[0]).toEqual({ id: "a", at: 5 * MS_DAY, budget: 1000 });
    // The rule answers in money; a zero-budget task earns nothing whatever it returns.
    expect(boot.service.method()).toBe("percentComplete"); // a rule is not one of the names
  });

  it("earns nothing for a zero-budget task however much money the rule returns", () => {
    boot = bootEvm({ evm: { statusDate: 5 * MS_DAY, method: () => 999 } });
    boot.data.load({ tasks: [task("a", 0, 10 * MS_DAY, { progress: 0.5 })] });
    expect(boot.service.earnedOf("a")).toBe(0);
    expect(boot.service.metricsOf("a")?.ev).toBe(0);
  });

  it("keeps a task's stored method override ahead of the host rule", () => {
    boot = bootEvm({ evm: { statusDate: 5 * MS_DAY, method: () => 1000 } });
    loadSingle(boot);
    expect(boot.service.metricsOf("a")?.ev).toBe(1000);
    boot.service.setFields("a", { method: "zeroHundred" });
    expect(boot.service.metricsOf("a")?.ev).toBe(0); // 50% progress earns nothing under 0/100
  });

  it("reports a throwing rule once and falls back to percentComplete for good", () => {
    boot = bootEvm({
      evm: {
        statusDate: 5 * MS_DAY,
        method: () => {
          throw new Error("boom");
        },
      },
    });
    loadSingle(boot);
    expect(boot.service.metricsOf("a")?.ev).toBe(500); // percentComplete: 0.5 × 1000
    expect(boot.service.metricsOf("a")?.ev).toBe(500); // latched: still the built-in
    expect(boot.service.method()).toBe("percentComplete");
    expect(boot.wheres()).toEqual(["method"]);
  });

  it("falls back silently for one task on a non-finite result", () => {
    boot = bootEvm({ evm: { statusDate: 5 * MS_DAY, method: () => Number.NaN } });
    loadSingle(boot);
    expect(boot.service.metricsOf("a")?.ev).toBe(500);
    expect(boot.wheres()).toEqual([]);
  });

  it("leaves every enum value computing exactly what it computes today", () => {
    const evOf = (method: "percentComplete" | "zeroHundred" | "fiftyFifty"): number => {
      const b = bootEvm({ evm: { statusDate: 5 * MS_DAY, method } });
      loadSingle(b);
      const ev = b.service.metricsOf("a")?.ev ?? -1;
      b.dispose();
      return ev;
    };
    expect(evOf("percentComplete")).toBe(500);
    expect(evOf("zeroHundred")).toBe(0);
    expect(evOf("fiftyFifty")).toBe(500);
    boot = bootEvm({ evm: { statusDate: 5 * MS_DAY, method: "milestoneWeighted" } });
    loadSingle(boot);
    boot.service.setFields("a", {
      milestones: [
        { weight: 3, complete: true },
        { weight: 1, complete: false },
      ],
    });
    expect(boot.service.metricsOf("a")?.ev).toBe(750);
    expect(boot.service.method()).toBe("milestoneWeighted");
  });
});

describe("`evm.eacMethod` as a host EAC rule", () => {
  it("drives EAC from the rule and keeps ETC = EAC − AC", () => {
    let seen: Readonly<EvmIndices> | undefined;
    // Snapshotted AT CALL TIME: `derive` hands the rule the very object it then writes the override
    // back into, so a reference kept past the call reports the replaced forecast, not the built-in.
    let seenEacAtCall: number | undefined;
    boot = bootEvm({
      evm: {
        statusDate: 5 * MS_DAY,
        eacMethod: (indices: Readonly<EvmIndices>) => {
          seen = { ...indices };
          seenEacAtCall = indices.eac;
          return indices.ac + (indices.bac - indices.ev) * 2;
        },
      },
    });
    loadSingle(boot);
    const m = boot.service.projectMetrics();
    expect(m.eac).toBe(800 + 500 * 2);
    expect(m.etc).toBe(m.eac - m.ac);
    // The rule sees FINISHED indices — `eac`/`etc` pre-filled with the "cpi" result.
    expect(seen).toMatchObject({ bac: 1000, pv: 500, ev: 500, ac: 800 });
    expect(seen?.cpi).toBeCloseTo(0.625);
    expect(seenEacAtCall).toBeCloseTo(1000 / 0.625);
  });

  it("reports a throwing rule once and falls back to the cpi formula for good", () => {
    boot = bootEvm({
      evm: {
        statusDate: 5 * MS_DAY,
        eacMethod: () => {
          throw new Error("boom");
        },
      },
    });
    loadSingle(boot);
    expect(boot.service.projectMetrics().eac).toBeCloseTo(1000 / 0.625);
    expect(boot.service.projectMetrics().eac).toBeCloseTo(1000 / 0.625); // latched
    expect(boot.wheres()).toEqual(["eacMethod"]);
  });

  it("falls back silently on a non-finite result", () => {
    boot = bootEvm({ evm: { statusDate: 5 * MS_DAY, eacMethod: () => Number.POSITIVE_INFINITY } });
    loadSingle(boot);
    expect(boot.service.projectMetrics().eac).toBeCloseTo(1000 / 0.625);
    expect(boot.wheres()).toEqual([]);
  });

  it("leaves every enum value computing exactly what it computes today", () => {
    const eacOf = (eacMethod: "cpi" | "remaining" | "cpiSpi"): number => {
      const b = bootEvm({ evm: { statusDate: 5 * MS_DAY, eacMethod } });
      loadSingle(b);
      const eac = b.service.projectMetrics().eac;
      b.dispose();
      return eac;
    };
    expect(eacOf("cpi")).toBeCloseTo(1000 / 0.625);
    expect(eacOf("remaining")).toBe(800 + 500);
    expect(eacOf("cpiSpi")).toBeCloseTo(800 + 500 / (0.625 * 1));
  });
});
