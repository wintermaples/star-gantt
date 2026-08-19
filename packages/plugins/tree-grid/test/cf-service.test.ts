/**
 * Configuration-time rule application.
 *
 * There is no runtime service that replaces the conditional-formatting rules once a chart is
 * composed: the rule list, the priority-color map and the legend they describe are all fixed for
 * the life of the instance from the `conditionalFormat` config nest. This file exercises that
 * path — what a configured rule set and priority-color map actually produce on a task's bar, how
 * the legend reflects exactly what was configured, what still resolves live even though the rules
 * themselves do not (a theme token), and what the feature deliberately never touches (the task
 * store, undo history).
 *
 * docs/specs/plugins/tree-grid.md § Config, § Extension points.
 */
import { afterEach, describe, expect, it } from "vitest";
import type { Task } from "@stargantt/plugin-data-store";
import type { TreeGridConfig } from "../src/index";
import { boot } from "./_boot";
import type { Booted } from "./_boot";
import { asContext, FakeContext2D } from "./_harness/index";
import { barBox, upwardProbe } from "./_upward";
import type { UpwardProbe } from "./_upward";

const DAY = 86_400_000;

function task(partial: Partial<Task>): Task {
  return { id: "t1", parentId: null, name: "T", start: 0, end: 2 * DAY, ...partial } as Task;
}

let b: Booted | undefined;
afterEach(() => {
  b?.gantt.dispose();
  b?.dom.restore();
  b = undefined;
});

function bootWith(
  conditionalFormat: NonNullable<TreeGridConfig["conditionalFormat"]>,
): { b: Booted; probe: UpwardProbe } {
  const probe = upwardProbe();
  b = boot([probe.plugin], {}, { conditionalFormat });
  return { b, probe };
}

describe("rule application from config", () => {
  it("colors bars from rules supplied in the config nest", () => {
    const { probe } = bootWith({
      rules: [{ when: { field: "priority", op: "eq", value: 1 }, style: { color: "#111111" } }],
    });
    expect(probe.style(task({ id: "a", meta: { priority: 1 } }))).toEqual({ color: "#111111" });
    // A task the rule does not match stays uncolored.
    expect(probe.style(task({ id: "b", meta: { priority: 2 } }))).toBeUndefined();
  });

  // Wholesale runtime replacement of the rule list, reporting what ends up in effect, has no
  // counterpart here: rules are configuration-time only, and there is nothing left to replace
  // once the chart is composed.

  it("drops unusable rule entries from the config instead of throwing", () => {
    const { probe } = bootWith({
      rules: [
        null as never,
        { when: { field: "priority", op: "exists" }, style: { color: 7 as never } },
        { when: { field: "priority", op: "exists" }, style: { color: "#333333" } },
      ],
    });
    expect(probe.style(task({ meta: { priority: 1 } }))).toEqual({ color: "#333333" });
  });

  it("colors matching bars from a configured priority-color map", () => {
    const { probe } = bootWith({ priorityColors: { "1": "#aa0000" } });
    expect(probe.style(task({ meta: { priority: 1 } }))).toEqual({ color: "#aa0000" });
  });

  it("keeps rules and priority colors independent: a non-matching rule leaves the priority preset in force", () => {
    const { probe } = bootWith({
      rules: [{ when: { field: "priority", op: "eq", value: 9 }, style: { color: "#f0f" } }],
      priorityColors: { "1": "#aa0000" },
    });
    expect(probe.style(task({ meta: { priority: 1 } }))).toEqual({ color: "#aa0000" });
  });
});

describe("live theme resolution of a configured color", () => {
  it("resolves a theme token supplied after composition, exactly as one present at boot would", () => {
    const { b, probe } = bootWith({
      rules: [{ when: { field: "priority", op: "exists" }, style: { color: "var(--sg-danger)" } }],
    });
    const t = task({ meta: { priority: 1 } });
    // No token published yet: the reference cannot resolve, so the rule declines.
    expect(probe.style(t)).toBeUndefined();
    // Supplied later, entirely outside the config: the very next lookup sees it.
    b.themeTokens.set({ "--sg-danger": "#ff0000" });
    expect(probe.style(t)).toEqual({ color: "#ff0000" });
  });
});

describe("the legend describes exactly the configured rules", () => {
  it("shows one entry per labelled rule, in the configured order", () => {
    const { b } = bootWith({
      legend: true,
      rules: [
        { when: { field: "priority", op: "eq", value: 1 }, style: { color: "#111" }, legend: "One" },
      ],
    });
    const labels = b.chartPane
      .find("sg-cf-legend")
      ?.children.map((row) => row.children[1]?.textContent);
    expect(labels).toEqual(["One"]);
  });

  it("mounts nothing when the configured rules carry no legend label", () => {
    const { b } = bootWith({
      legend: true,
      rules: [{ when: { field: "priority", op: "eq", value: 1 }, style: { color: "#111" } }],
    });
    expect(b.chartPane.find("sg-cf-legend")).toBeUndefined();
  });
});

describe("display state only", () => {
  it("writes nothing to the task store and leaves no trace on the task", () => {
    const { b, probe } = bootWith({
      rules: [{ when: { field: "priority", op: "exists" }, style: { color: "#111111" } }],
      priorityColors: { "1": "#222222" },
    });
    b.data.load([{ id: "a", parentId: null, name: "A", start: 0, end: 2 * DAY, meta: { priority: 1 } }]);
    const before = b.data.toJSON();

    probe.style(task({ id: "a", meta: { priority: 1 } }));
    const g = new FakeContext2D();
    probe.paintOverlays(asContext(g), barBox({ id: "a" }));

    expect(b.data.toJSON()).toEqual(before);
    expect(b.data.getTask("a")?.meta?.["color"]).toBeUndefined();
  });
});
