/**
 * Theme-token colors reached through the composed conditional-formatting feature: a token painted
 * onto a bar, the same bar following a theme change, the latched `core/pluginError` for a color
 * that cannot be resolved, and the graceful degradation when nothing resolves it.
 *
 * docs/specs/plugins/tree-grid.md § Config, § Internal modules.
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
  tokens: Record<string, string> = {},
): { b: Booted; probe: UpwardProbe } {
  const probe = upwardProbe();
  b = boot([probe.plugin], {}, { conditionalFormat });
  if (Object.keys(tokens).length > 0) b.themeTokens.set(tokens);
  return { b, probe };
}

function ownErrors(seen: unknown[]): { feature: string; message: string }[] {
  return seen
    .filter((e) => (e as { pluginId?: string }).pluginId === "stargantt.tree-grid")
    .map((e) => {
      const error = (e as { error: { feature: string; cause: unknown } }).error;
      return {
        feature: error.feature,
        message: error.cause instanceof Error ? error.cause.message : String(error.cause),
      };
    });
}

describe("theme-token colors", () => {
  it("paints the token's value, not the reference, for both spellings", () => {
    const { probe } = bootWith(
      {
        rules: [
          { when: { field: "id", op: "eq", value: "a" }, style: { color: "var(--sg-danger)" } },
          { when: { field: "id", op: "eq", value: "b" }, style: { color: "--sg-warning" } },
        ],
        now: () => 0,
      },
      { "--sg-danger": "#ff0000", "--sg-warning": "#ffaa00" },
    );
    // The raw reference must never be what a bar is painted with.
    expect(probe.style(task({ id: "a" }))).toEqual({ color: "#ff0000" });
    expect(probe.style(task({ id: "b" }))).toEqual({ color: "#ffaa00" });
  });

  it("resolves the bar in the new value once the theme changes", () => {
    const { b, probe } = bootWith(
      {
        rules: [{ when: { field: "id", op: "exists" }, style: { color: "var(--sg-danger)" } }],
        now: () => 0,
      },
      { "--sg-danger": "#ff0000" },
    );
    const t = task({ id: "a" });
    expect(probe.style(t)).toEqual({ color: "#ff0000" });

    b.themeTokens.set({ "--sg-danger": "#00ff00" });
    expect(probe.style(t)).toEqual({ color: "#00ff00" });
  });

  it("resolves the overlay's colors too — progress fill and warning icon", () => {
    const { b, probe } = bootWith(
      { progress: { behind: "var(--sg-behind)" }, overdue: { color: "--sg-late" }, now: () => DAY },
      { "--sg-behind": "#0000ff", "--sg-late": "#ff00ff" },
    );
    b.data.load([
      { id: "x", parentId: null, name: "X", start: 0, end: 2 * DAY, progress: 0.1 },
      { id: "late", parentId: null, name: "L", start: 0, end: DAY / 2, progress: 0.5 },
    ]);
    const behind = new FakeContext2D();
    probe.paintOverlays(asContext(behind), barBox({ id: "x" }));
    expect(behind.calls("fillRect").map((o) => o.fill)).toContain("#0000ff");

    const overdue = new FakeContext2D();
    probe.paintOverlays(asContext(overdue), barBox({ id: "late" }));
    expect(overdue.calls("fill").map((o) => o.fill)).toContain("#ff00ff");
  });

  it("paints an on-track bar in the theme's own bar fill, and follows it when it changes", () => {
    const { b, probe } = bootWith({ progress: {}, now: () => DAY }, { "--sg-bar-fill": "#0d9488" });
    // Two days long, one day in, half done — on schedule, so the on-track color is used.
    b.data.load([{ id: "x", parentId: null, name: "X", start: 0, end: 2 * DAY, progress: 0.5 }]);

    const before = new FakeContext2D();
    probe.paintOverlays(asContext(before), barBox({ id: "x" }));
    expect(before.calls("fillRect").map((o) => o.fill)).toContain("#0d9488");

    b.themeTokens.set({ "--sg-bar-fill": "#123456" });
    const after = new FakeContext2D();
    probe.paintOverlays(asContext(after), barBox({ id: "x" }));
    expect(after.calls("fillRect").map((o) => o.fill)).toContain("#123456");
  });

  it("falls back to a literal on-track fill when no theme resolves the token", () => {
    const { b, probe } = bootWith({ progress: {}, now: () => DAY });
    b.data.load([{ id: "x", parentId: null, name: "X", start: 0, end: 2 * DAY, progress: 0.5 }]);
    const g = new FakeContext2D();
    probe.paintOverlays(asContext(g), barBox({ id: "x" }));
    // The var() fallback keeps the overlay paintable rather than dropping it.
    expect(g.calls("fillRect").map((o) => o.fill)).toContain("#0f766e");
  });

  it("draws no overlay at all in a color that cannot be resolved", () => {
    const { b, probe } = bootWith({
      progress: { behind: "var(--sg-nope)" },
      overdue: { color: "--sg-also-nope" },
      now: () => DAY,
    });
    b.data.load([
      { id: "x", parentId: null, name: "X", start: 0, end: 2 * DAY, progress: 0.1 },
      { id: "late", parentId: null, name: "L", start: 0, end: DAY / 2, progress: 0.5 },
    ]);
    const g = new FakeContext2D();
    probe.paintOverlays(asContext(g), barBox({ id: "x" }));
    probe.paintOverlays(asContext(g), barBox({ id: "late" }));
    const fills = g.calls("fillRect").map((o) => o.fill);
    expect(fills).not.toContain("var(--sg-nope)");
    expect(fills).not.toContain("");
    // The warning triangle is a path fill; none is drawn when its color is unusable.
    expect(g.calls("fill")).toHaveLength(0);
  });

  it("uses the var() fallback when the token is unset", () => {
    const { probe } = bootWith({
      rules: [{ when: { field: "id", op: "exists" }, style: { color: "var(--sg-nope, #123456)" } }],
      now: () => 0,
    });
    expect(probe.style(task({ id: "a" }))).toEqual({ color: "#123456" });
    expect(probe.style(task({ id: "b" }))).toEqual({ color: "#123456" });
  });
});

describe("unresolvable colors", () => {
  it("reports once per distinct string, however many bars and lookups ask for it", () => {
    const seen: unknown[] = [];
    const { b, probe } = bootWith({
      rules: [{ when: { field: "id", op: "exists" }, style: { color: "var(--sg-nope)" } }],
      now: () => 0,
    });
    b.gantt.on("core/pluginError", (e) => seen.push(e));
    // Two distinct tasks ask for the same unresolvable color, more than once each.
    probe.style(task({ id: "a" }));
    probe.style(task({ id: "b" }));
    probe.style(task({ id: "a" }));

    const errors = ownErrors(seen);
    expect(errors).toHaveLength(1);
    expect(errors[0]?.feature).toBe("color");
    // The offending string is named, so the host can find the rule that carries it.
    expect(errors[0]?.message).toContain("var(--sg-nope)");
  });

  it("applies no color, declining in favor of whatever paints the bar next", () => {
    const { probe } = bootWith({
      rules: [{ when: { field: "id", op: "eq", value: "a" }, style: { color: "--sg-nope" } }],
      now: () => 0,
    });
    // Nothing paintable comes out of the rule: the provider declines rather than painting an
    // unresolved reference.
    expect(probe.style(task({ id: "a", meta: { color: "#abcdef" } }))).toBeUndefined();
  });

  it("paints nothing wrong and does not throw while the token is unset", () => {
    const seen: unknown[] = [];
    const { b, probe } = bootWith({
      rules: [{ when: { field: "id", op: "exists" }, style: { color: "var(--sg-danger)" } }],
      now: () => 0,
    });
    b.gantt.on("core/pluginError", (e) => seen.push(e));
    expect(() => probe.style(task({ id: "a" }))).not.toThrow();
    expect(() => probe.style(task({ id: "b" }))).not.toThrow();
    expect(probe.style(task({ id: "a" }))).toBeUndefined();
    expect(ownErrors(seen)).toHaveLength(1);
  });

  // The plugin that hosted this feature previously kept its theme dependency optional, since it
  // was a freestanding plugin that could be composed without one. This feature is internal to the
  // grid plugin and reaches the theme through the same required service the grid itself depends
  // on, so there is no optional-dependency path left to assert on.
});

describe("legend swatches", () => {
  it("spells a token reference so CSS resolves it, and never writes a bare token", () => {
    const { b } = bootWith(
      {
        legend: true,
        rules: [
          {
            when: { field: "id", op: "exists" },
            style: { color: "--sg-danger" },
            legend: "Danger",
          },
        ],
      },
      { "--sg-danger": "#ff0000" },
    );
    const swatch = b.chartPane.find("sg-cf-legend")?.children[0]?.children[0];
    expect(swatch?.style.cssText).toContain("background:var(--sg-danger)");
  });
});
