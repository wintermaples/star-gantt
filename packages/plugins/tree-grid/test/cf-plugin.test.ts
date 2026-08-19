/**
 * The composed conditional-formatting feature: default-off behavior, the `taskbars/style` and
 * `taskbars/overlays` contributions it hands to the bar pass, the legend node it mounts into the
 * chart pane, and the latched error barrier around each contribution.
 *
 * docs/specs/plugins/tree-grid.md § Extension points, § Internal modules.
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

function bootWith(config?: TreeGridConfig): { b: Booted; probe: UpwardProbe } {
  const probe = upwardProbe();
  b = boot([probe.plugin], {}, config);
  return { b, probe };
}

describe("default-off", () => {
  it("contributes no style provider, no overlay and no legend while the nest is omitted", () => {
    const { b, probe } = bootWith();
    expect(probe.hasStyle()).toBe(false);
    expect(probe.overlays()).toHaveLength(0);
    expect(b.chartPane.find("sg-cf-legend")).toBeUndefined();
  });

  it("with the nest present but empty, contributes a provider that declines for every task", () => {
    const { b, probe } = bootWith({ conditionalFormat: {} });
    expect(probe.hasStyle()).toBe(true);
    expect(probe.style(task({ id: "a", meta: { priority: 1 } }))).toBeUndefined();
    expect(probe.style(task({ id: "b", meta: { priority: 2 } }))).toBeUndefined();
    expect(probe.overlays()).toHaveLength(0);
    expect(b.chartPane.find("sg-cf-legend")).toBeUndefined();
  });
});

describe("bar coloring through taskbars/style", () => {
  it("colors matching bars from rules and priority colors", () => {
    const { probe } = bootWith({
      conditionalFormat: {
        rules: [{ when: { field: "priority", op: "eq", value: 1 }, style: { color: "#111111" } }],
        priorityColors: { "2": "#222222" },
        now: () => 0,
      },
    });
    expect(probe.style(task({ id: "a", meta: { priority: 1 } }))).toEqual({ color: "#111111" });
    expect(probe.style(task({ id: "b", meta: { priority: 2 } }))).toEqual({ color: "#222222" });
  });

  it("colors overdue tasks and draws the warning icon", () => {
    const { b, probe } = bootWith({
      conditionalFormat: { overdue: { color: "#warn" }, now: () => 10 * DAY },
    });
    b.data.load([
      { id: "late", parentId: null, name: "L", start: 0, end: 2 * DAY, progress: 0.5 },
      { id: "ok", parentId: null, name: "O", start: 0, end: 20 * DAY, progress: 0.5 },
    ]);
    expect(probe.style(task({ id: "late", end: 2 * DAY, progress: 0.5 }))).toEqual({
      color: "#warn",
    });
    const g = new FakeContext2D();
    probe.paintOverlays(asContext(g), barBox({ id: "late" }));
    const triangles = g.calls("fill").filter((o) => o.fill === "#warn");
    expect(triangles).toHaveLength(1);
  });

  it("recolors the progress portion by status", () => {
    const { b, probe } = bootWith({
      conditionalFormat: { progress: { behind: "#beh" }, now: () => DAY },
    });
    // Half the span elapsed, 10% done → behind.
    b.data.load([{ id: "x", parentId: null, name: "X", start: 0, end: 2 * DAY, progress: 0.1 }]);
    const g = new FakeContext2D();
    probe.paintOverlays(asContext(g), barBox({ id: "x" }));
    const behind = g.calls("fillRect").filter((o) => o.fill === "#beh");
    expect(behind).toHaveLength(1);
  });
});

describe("legend", () => {
  it("mounts one .sg-cf-legend node with one labelled entry per active source", () => {
    const { b } = bootWith({
      messages: { legendOverdue: "Late!" },
      conditionalFormat: {
        legend: true,
        rules: [
          {
            when: { field: "priority", op: "eq", value: 1 },
            style: { color: "#111" },
            legend: "Top",
          },
          { when: { field: "priority", op: "eq", value: 3 }, style: { color: "#333" } }, // no label
        ],
        priorityColors: { "2": "#222" },
        overdue: true,
      },
    });
    const legend = b.chartPane.find("sg-cf-legend");
    expect(legend).toBeDefined();
    // Entries: the labelled rule, the overdue entry, one priority entry.
    expect(legend?.children).toHaveLength(3);
    const texts = legend?.children.map((row) => row.children[1]?.textContent);
    expect(texts).toEqual(["Top", "Late!", "Priority 2"]);
  });

  it("mounts nothing when legend is on but no source is active, and unmounts on dispose", () => {
    const empty = bootWith({ conditionalFormat: { legend: true } });
    expect(empty.b.chartPane.find("sg-cf-legend")).toBeUndefined();
    empty.b.gantt.dispose();
    empty.b.dom.restore();
    b = undefined;

    const { b: withEntry } = bootWith({
      conditionalFormat: { legend: true, priorityColors: { "1": "#111" } },
    });
    expect(withEntry.chartPane.find("sg-cf-legend")).toBeDefined();
    withEntry.gantt.dispose();
    expect(withEntry.chartPane.find("sg-cf-legend")).toBeUndefined();
  });
});

describe("fault containment", () => {
  it("latches a throwing now(): one core/pluginError per feature, then each stays silent", () => {
    const errors: unknown[] = [];
    const { b, probe } = bootWith({
      conditionalFormat: {
        overdue: true,
        now: () => {
          throw new Error("boom");
        },
      },
    });
    b.gantt.on("core/pluginError", (e) => errors.push(e));
    b.data.load([{ id: "a", parentId: null, name: "A", start: 0, end: 2 * DAY }]);
    const g = new FakeContext2D();
    // Each contribution (style provider, overlay renderer) latches independently and reports
    // exactly once — never once per bar per frame.
    probe.style(task({ id: "a" }));
    probe.style(task({ id: "a" }));
    probe.paintOverlays(asContext(g), barBox({ id: "a" }));
    probe.paintOverlays(asContext(g), barBox({ id: "a" }));
    const own = errors.filter(
      (e) => (e as { pluginId?: string }).pluginId === "stargantt.tree-grid",
    );
    const features = own.map((e) => (e as { error: { feature: string } }).error.feature).sort();
    expect(features).toEqual(["overlay", "style"]);
    // The style provider keeps declining once latched, rather than throwing again.
    expect(probe.style(task({ id: "a" }))).toBeUndefined();
  });
});
