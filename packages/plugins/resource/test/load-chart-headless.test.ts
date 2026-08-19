/**
 * The load-chart area under a headless composition (docs/specs/plugins/resource.md §3.6 / §9).
 *
 * Without `stargantt.view` the whole area is INERT: it still claims its corner and registers its
 * contributions (both of which are timing-agnostic and land on points nobody declares here), but it
 * paints nothing, opens nothing, and never calls `bindLoadChartStrips` — so the thirteen relocated
 * `UtilizationService` members keep their documented inert answers. What is pinned here is that all
 * of that happens WITHOUT a fault: no `core/pluginError`, whatever the nest carries.
 */
import { describe, expect, it, vi } from "vitest";
import { definePlugin } from "@stargantt/core";
import type { Plugin } from "@stargantt/core";
import { createTestHost } from "@stargantt/sdk";
import type { TestHost } from "@stargantt/sdk";
import { dataStore } from "@stargantt/plugin-data-store";
import { resource } from "../src/index";
import type { ResourceConfig } from "../src/config";
import { MONDAY, MS_DAY } from "./load-chart-fixtures";

/**
 * A recorder composed FIRST, so it is subscribed before any other plugin's `setup()` runs and
 * catches a fault raised during setup or `lifecycle/ready` — which a post-boot `host.on` would miss.
 */
function faultRecorder(sink: unknown[]): Plugin<void> {
  return definePlugin<void>({
    meta: { id: "test.fault-recorder" },
    setup: (ctx) => {
      ctx.own(ctx.on("core/pluginError", (e) => sink.push(e)));
    },
  });
}

function boot(config: ResourceConfig): { errors: unknown[]; harness: TestHost } {
  const errors: unknown[] = [];
  const harness = createTestHost({
    plugins: [faultRecorder(errors), dataStore(), resource(config)],
  });
  return { errors, harness };
}

describe("the load-chart area without `stargantt.view` (§9)", () => {
  it("boots with an empty nest and reports nothing", () => {
    const { errors, harness } = boot({ loadChart: {} });
    try {
      expect(() => harness.ctxOf("stargantt.resource")).not.toThrow();
      expect(errors).toEqual([]);
    } finally {
      harness.dispose();
    }
  });

  it("boots with every §6.5 field populated, hooks included, and reports nothing", () => {
    const resourceLoad = vi.fn(() => 1);
    const resourceCapacity = vi.fn(() => 2);
    const load = vi.fn(() => 3);
    const capacity = vi.fn(() => 4);
    const { errors, harness } = boot({
      loadChart: {
        bucket: "auto",
        resources: ["r1", "r2"],
        axisLabels: true,
        valueLabels: true,
        load,
        capacity,
        resourceLoad,
        resourceCapacity,
        heatmap: true,
        lanes: true,
        total: true,
        laneScale: "shared",
        laneValueLabels: true,
        resizable: false,
      },
    });
    try {
      expect(errors).toEqual([]);
      // Nothing paints without a chart surface, so no host function is ever called.
      expect(resourceLoad).not.toHaveBeenCalled();
      expect(load).not.toHaveBeenCalled();
    } finally {
      harness.dispose();
    }
  });

  it("survives data notifications with the nest present and no chart surface", () => {
    const { errors, harness } = boot({ loadChart: { total: true, lanes: true } });
    try {
      const data = harness.host.service("stargantt.data");
      data.load([
        { id: "a", name: "A", start: MONDAY, end: MONDAY + MS_DAY },
        { id: "b", name: "B", start: MONDAY + MS_DAY, end: MONDAY + 2 * MS_DAY },
      ]);
      expect(errors).toEqual([]);
    } finally {
      harness.dispose();
    }
  });

  it("stays entirely dormant with the nest omitted — no claim, no contribution, no fault", () => {
    const { errors, harness } = boot({ pool: {}, utilization: {} });
    try {
      expect(errors).toEqual([]);
    } finally {
      harness.dispose();
    }
  });
});
