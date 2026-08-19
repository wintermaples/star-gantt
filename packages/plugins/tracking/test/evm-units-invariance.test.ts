/**
 * The millisecond-unification invariance guarantee for the EVM area (docs/specs/plugins/
 * tracking.md §2.2): no EVM quantity changes unit. Every figure
 * this area publishes is money, a dimensionless index, a fraction or an epoch-ms instant, so there
 * is nothing to re-express — what has to be pinned is that the numbers did not move, neither the
 * area's own arithmetic nor the sibling inputs it falls back to through `EvmAreaExtras`.
 *
 * Every expectation is derived from the formula the spec states, written inline as an oracle —
 * never from whatever the current code happens to produce. `toBe` is deliberate: the guarantee is
 * exact.
 */
import { afterEach, describe, expect, it } from "vitest";
import { MS_DAY, bootEvm, task, taskCost } from "./evm-boot";
import type { EvmBoot } from "./evm-boot";
import { TRACKING_MESSAGE_KEYS } from "../src/internal/messages";

let boot: EvmBoot | undefined;
afterEach(() => {
  boot?.dispose();
  boot = undefined;
});

/**
 * The cost area's labor cost, by the spec's formula — `((end − start) / 86_400_000) ×
 * hoursPerDay × units × rate` (§2.8 keeps the reduced form for bit-exact money output). It is the
 * EVM BAC fallback (§2.14), so it is the seam through which a unit slip in a sibling would reach
 * EVM's money figures.
 */
function oldLaborCost(
  startMs: number,
  endMs: number,
  hoursPerDay: number,
  units: number,
  ratePerHour: number,
): number {
  const days = Math.max(0, (endMs - startMs) / MS_DAY);
  return days * hoursPerDay * units * ratePerHour;
}

/** §2.15: task PV spreads BAC uniformly over the planned span at the status date. */
function oldPv(bac: number, start: number, end: number, at: number): number {
  const span = end - start;
  if (span <= 0) return at >= start ? bac : 0;
  const f = (at - start) / span;
  return bac * (f < 0 ? 0 : f > 1 ? 1 : f);
}

describe("EVM's own arithmetic is untouched (§2.15)", () => {
  it("PV, EV, SV, CV, SPI, CPI, EAC and ETC all match their stated formulas exactly", () => {
    // A whole-day plan with no intra-day working windows anywhere — the condition the guarantee
    // names.
    boot = bootEvm({ evm: { statusDate: 5 * MS_DAY } });
    boot.data.load({ tasks: [task("a", 0, 10 * MS_DAY, { progress: 0.3 })] });
    boot.service.setFields("a", { bac: 1000, actualCost: 400 });

    // Oracles, straight from §2.15 with the default "percentComplete" accrual and "cpi" EAC.
    const bac = 1000;
    const ac = 400;
    const pv = oldPv(bac, 0, 10 * MS_DAY, 5 * MS_DAY); // 500
    const ev = 0.3 * bac; // earned fraction × BAC = 300
    const sv = ev - pv;
    const cv = ev - ac;
    const spi = ev / pv;
    const cpi = ev / ac;
    const eac = bac / cpi;
    const etc = eac - ac;

    expect(pv).toBe(500);
    expect(boot.service.metricsOf("a")).toMatchObject({
      bac,
      pv,
      ev,
      ac,
      sv,
      cv,
      spi,
      cpi,
      eac,
      etc,
    });
    // The project aggregate derives from the sums, not from averaged per-task indices (§2.15).
    expect(boot.service.projectMetrics()).toMatchObject({
      bac,
      pv,
      ev,
      ac,
      sv,
      cv,
      spi,
      cpi,
      eac,
      etc,
    });
  });

  it("the earned fraction stays a fraction and the curve stays stamped in epoch ms", () => {
    boot = bootEvm({ evm: { statusDate: 5 * MS_DAY } });
    boot.data.load({ tasks: [task("a", 0, 10 * MS_DAY, { progress: 0.3 })] });
    boot.service.setFields("a", { bac: 1000 });
    // `earned` is a fraction and the curve's `t` an epoch-ms instant; neither is a duration, so
    // neither changes unit. §2.15 samples at the planned boundaries with no day grid, so the plan's
    // own start and end instants must appear verbatim, and cumulative PV must reach the whole BAC.
    expect(boot.service.earnedOf("a")).toBe(0.3);
    const curve = boot.service.scurve();
    expect(curve.map((p) => p.t)).toContain(0);
    expect(curve.map((p) => p.t)).toContain(10 * MS_DAY);
    expect(curve[curve.length - 1]?.pv).toBe(1000);
  });
});

describe("EVM's sibling inputs are unchanged (§2.14)", () => {
  it("BAC and AC fall back to the cost area's money, re-derived from the old labor oracle", () => {
    boot = bootEvm({ evm: { statusDate: 5 * MS_DAY } });
    boot.data.load({ tasks: [task("a", 0, 10 * MS_DAY, { progress: 0.5 })] });

    // §2.14: with no stored `bac`/`actualCost`, BAC is the cost area's `estimated` and AC its
    // `actual`. The estimate is the pre-unification labor chain plus the fixed cost.
    const bac = oldLaborCost(0, 10 * MS_DAY, 7.4, 1, 100) + 250;
    const ac = 6000;
    boot.costs.set("a", taskCost("a", bac, ac));

    const pv = oldPv(bac, 0, 10 * MS_DAY, 5 * MS_DAY);
    const ev = 0.5 * bac;
    expect(boot.service.metricsOf("a")).toMatchObject({
      bac,
      ac,
      pv,
      ev,
      sv: ev - pv,
      cv: ev - ac,
    });
  });

  it("`physicalPercent` still drives the earned fraction as percent/100", () => {
    boot = bootEvm({ evm: { statusDate: 5 * MS_DAY } });
    boot.data.load({ tasks: [task("a", 0, 10 * MS_DAY, { progress: 0.3 })] });
    boot.service.setFields("a", { bac: 1000 });
    boot.gantt.dispatch("task/update", {
      id: "a",
      after: { meta: { evm: { bac: 1000 }, progressTracking: { physicalPercent: 40 } } },
    });
    // §2.14: `physicalPercent` is unitless and outranks `task.progress`; the unification leaves both
    // alone, so the earned fraction is still 40/100 rather than the task's own 0.3.
    expect(boot.service.earnedOf("a")).toBe(0.4);
    expect(boot.service.metricsOf("a")?.ev).toBe(400);
  });
});

describe("no rename and no duration member in the EVM keys (§2.2 / §6)", () => {
  it("the EVM half of the merged catalog exposes no duration builder of its own", () => {
    // A `duration` member is added only to catalogs that show one; the EVM keys format money
    // and indices, never durations. The merged catalog's single `duration` key belongs to the
    // baselines + progress areas — no `evmDuration` was invented here.
    expect(TRACKING_MESSAGE_KEYS).not.toContain("evmDuration");
    expect(TRACKING_MESSAGE_KEYS.filter((k) => k.toLowerCase().includes("duration"))).toEqual([
      "duration",
      "reportDurationVariance",
    ]);
  });

  it("every published metric member keeps its documented name", () => {
    boot = bootEvm({ evm: { statusDate: 5 * MS_DAY } });
    boot.data.load({ tasks: [task("a", 0, 10 * MS_DAY, { progress: 0.5 })] });
    boot.service.setFields("a", { bac: 1000, actualCost: 400 });
    // A member that silently gained or lost a name would be an accidental break this test forbids.
    expect(Object.keys(boot.service.projectMetrics()).sort()).toEqual(
      ["ac", "bac", "cpi", "cv", "eac", "etc", "ev", "pv", "spi", "sv"].sort(),
    );
    expect(Object.keys(boot.service.metricsOf("a") ?? {}).sort()).toEqual(
      ["ac", "bac", "cpi", "cv", "eac", "earned", "etc", "ev", "id", "pv", "spi", "sv"].sort(),
    );
  });
});
