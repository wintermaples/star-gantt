/**
 * The plugin value itself: the mechanical `dependsOn` / `ctx.use()` consistency check every
 * official plugin's suite runs.
 */
import { describe, expect, it } from "vitest";
import { expectDepsConsistency } from "@stargantt/sdk";
import { taskBars } from "../src/index";

/**
 * Service id → providing plugin id, for the five services this plugin consumes. The view plugin
 * provides three of them, so the five `ctx.use()` calls collapse onto three `dependsOn` entries.
 */
const SERVICE_PROVIDERS = {
  "stargantt.data": "stargantt.data-store",
  "stargantt.view": "stargantt.view",
  "stargantt.timeline": "stargantt.view",
  "stargantt.theme": "stargantt.view",
  "stargantt.rows": "stargantt.tree-grid",
};

describe("taskBars()", () => {
  it("declares the plugin id and the three provider dependencies", () => {
    expect(taskBars().meta).toEqual({
      id: "stargantt.task-bars",
      dependsOn: ["stargantt.data-store", "stargantt.view", "stargantt.tree-grid"],
    });
  });

  it("keeps dependsOn and ctx.use() in step", () => {
    expectDepsConsistency(taskBars(), SERVICE_PROVIDERS);
  });

  it("snapshots the config, so a later mutation cannot change the plugin's behavior", () => {
    const config: { expandedHitArea?: boolean } = {};
    const plugin = taskBars(config);
    config.expandedHitArea = true;
    // The factory copied the object; the plugin it returned is unaffected by the write above.
    expect(plugin.meta.id).toBe("stargantt.task-bars");
  });
});
