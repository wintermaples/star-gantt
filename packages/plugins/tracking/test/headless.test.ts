/**
 * The root `index.ts`'s OWN coverage (review M1 — it had none): a real `@stargantt/core` host
 * booted with `dataStore() + tracking()` alone, no DOM, no view/task-bars/tree-grid composed —
 * exactly the headless composition §8 promises stays valid. Distinct from the four area-level
 * `*-wire.test.ts` / `*-boot.ts` harnesses (`test/baselines-wire.test.ts`, `test/evm-boot.ts`,
 * `test/cost-helpers.ts`, `test/progress-wire.test.ts`), which deliberately call `wire*(deps)`
 * directly to isolate one area; this file is the one place that boots the REAL root wiring — the
 * five `claimKey` calls, the three `claimOrder` calls, the four `ctx.provide`s, and — the fan-in
 * `index.ts` itself is responsible for (§2.14) — EVM's `costOf`/`baselineSnapshotOf` extras bound
 * to the cost and baselines services' own live methods.
 */
import { createTestHost, expectDepsConsistency } from "@stargantt/sdk";
import { definePlugin } from "@stargantt/core";
import type { AnyPlugin } from "@stargantt/core";
import { dataStore } from "@stargantt/plugin-data-store";
import type { DataService } from "@stargantt/plugin-data-store";
import { describe, expect, it } from "vitest";
import { tracking } from "../src/index";
import type { BaselinesService, CostService, EvmService, ProgressService } from "../src/types";

const DAY = 86_400_000;

describe("headless composition (no DOM, no view)", () => {
  it("provides all four services over dataStore() + tracking() alone", () => {
    const harness = createTestHost({ plugins: [dataStore(), tracking()] });
    try {
      expect(() => harness.host.service("stargantt.baselines")).not.toThrow();
      expect(() => harness.host.service("stargantt.progress")).not.toThrow();
      expect(() => harness.host.service("stargantt.cost")).not.toThrow();
      expect(() => harness.host.service("stargantt.evm")).not.toThrow();
    } finally {
      harness.dispose();
    }
  });

  it("claims the three renderer/layers orders at 50 / 62 / 65, owned by this plugin", () => {
    const harness = createTestHost({ plugins: [dataStore(), tracking()] });
    try {
      const byId = new Map(harness.host.orders("renderer/layers").map((o) => [o.key, o]));
      expect(byId.get("stargantt.tracking:baselines")).toMatchObject({
        order: 50,
        pluginId: "stargantt.tracking",
      });
      expect(byId.get("stargantt.tracking:actuals")).toMatchObject({
        order: 62,
        pluginId: "stargantt.tracking",
      });
      expect(byId.get("stargantt.tracking:progress-line")).toMatchObject({
        order: 65,
        pluginId: "stargantt.tracking",
      });
    } finally {
      harness.dispose();
    }
  });

  it("claims all five task.meta keys — a duplicate claim from another plugin is reported and dropped", () => {
    const faults: { pluginId: string; error: unknown }[] = [];
    const KEYS = ["actualStart", "actualEnd", "progressTracking", "costTracking", "evm"];
    // Ordered strictly after tracking (`dependsOn`), so tracking's own five claims have already
    // landed by the time this plugin's setup() re-attempts them.
    const duplicateClaimant: AnyPlugin = definePlugin({
      meta: {
        id: "test.duplicate-claimant",
        dependsOn: ["stargantt.data-store", "stargantt.tracking"],
      },
      setup(ctx) {
        // Registered before the claim attempts, in the same setup() pass: `emit` is synchronous,
        // so this listener sees every fault this plugin's own re-claims raise.
        ctx.on("core/pluginError", (e) => faults.push(e as { pluginId: string; error: unknown }));
        for (const key of KEYS) ctx.claimKey("task.meta", key);
      },
    });
    const harness = createTestHost({ plugins: [dataStore(), tracking(), duplicateClaimant] });
    try {
      expect(faults).toHaveLength(KEYS.length);
      expect(faults.every((f) => f.pluginId === "test.duplicate-claimant")).toBe(true);
    } finally {
      harness.dispose();
    }
  });

  it("wires EVM's BAC/planned-date fallbacks to LIVE calls into cost and baselines (§2.14 fan-in)", () => {
    // A fixed status date between the baseline span's end and the moved span's start is what makes
    // this test discriminating: PV comes out different depending on which dates EVM actually reads.
    const harness = createTestHost({ plugins: [dataStore(), tracking({ evm: { statusDate: 5 * DAY } })] });
    try {
      const data = harness.host.service("stargantt.data") as DataService;
      data.load({ tasks: [{ id: "t1", parentId: null, name: "T1", start: 0, end: DAY }] });

      const cost = harness.host.service("stargantt.cost") as CostService;
      const baselines = harness.host.service("stargantt.baselines") as BaselinesService;
      const evm = harness.host.service("stargantt.evm") as EvmService;

      // BAC fallback (§2.14: "else the internal cost module's costOf(id).estimated"): with nothing
      // stored under meta.evm.bac, evm.bacOf must track cost.costOf's estimated figure exactly —
      // only possible if EVM's BAC resolution is a genuine live call into the cost service, not a
      // stub answering a constant.
      expect(evm.bacOf("t1")).toBe(0);
      cost.setCostFields("t1", { fixedCost: 500 });
      expect(cost.costOf("t1")?.estimated).toBe(500);
      expect(evm.bacOf("t1")).toBe(500);

      // Planned-dates fallback (§2.14: "the task's snapshot in the ACTIVE baseline when one is
      // active ... else current start/end"): capture [0, DAY) as a baseline, then move the task
      // well past the configured status date (5*DAY). If EVM read the CURRENT (moved) dates, the
      // task would not have started yet at the status date and PV would be 0; if it correctly reads
      // the BASELINE's [0, DAY) span instead, the task is fully past the status date and PV = BAC.
      baselines.save("b1");
      expect(baselines.snapshotOf("t1")).toMatchObject({ start: 0, end: DAY });
      harness.host.dispatch("task/update", {
        id: "t1",
        after: { start: 10 * DAY, end: 11 * DAY },
      });
      // The baseline snapshot itself must stay untouched by the live move (immutable once captured).
      expect(baselines.snapshotOf("t1")).toMatchObject({ start: 0, end: DAY });

      const metrics = evm.metricsOf("t1");
      expect(metrics?.bac).toBe(500);
      expect(metrics?.pv).toBe(500); // fully past the status date under the BASELINE's span
    } finally {
      harness.dispose();
    }
  });
});

describe("declared dependencies", () => {
  it("match the plugin's non-optional ctx.use() calls exactly", () => {
    expectDepsConsistency(tracking(), { "stargantt.data": "stargantt.data-store" });
  });
});
