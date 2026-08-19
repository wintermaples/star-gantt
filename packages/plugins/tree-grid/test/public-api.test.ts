/**
 * Registering a key in the declaration-merging surfaces and registering it at runtime are not
 * linked by the compiler, so every key this package declares gets an explicit "is it actually
 * there?" assertion.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import * as api from "../src/index";
import { boot, flatTasks, probe, treeTasks } from "./_boot";
import type { Booted } from "./_boot";

let booted: Booted | undefined;

afterEach(() => {
  booted?.gantt.dispose();
  booted?.dom.restore();
  booted = undefined;
});

describe("published surface", () => {
  it("exports exactly the plugin factory and the bundled editors at runtime (everything else is types)", () => {
    expect(Object.keys(api).sort()).toEqual(["dateEditor", "selectEditor", "treeGrid"]);
  });
});

describe("declared key ↔ runtime registration", () => {
  it("Services: `stargantt.rows` is provided", () => {
    booted = boot();
    const rows = booted.gantt.service("stargantt.rows");
    for (const member of [
      "rowCount",
      "taskIdAt",
      "rowOf",
      "rowHeight",
      "yOf",
      "rowAtY",
      "totalHeight",
      "isExpanded",
    ] as const) {
      expect(typeof rows[member]).toBe("function");
    }
  });

  it("Commands: `view/rowToggle` has a runner", () => {
    booted = boot();
    booted.data.load(treeTasks(1, 1));
    booted.gantt.dispatch("view/rowToggle", { id: "p0", expanded: false });
    expect(booted.rows.rowCount()).toBe(1);
  });

  it("Services: `stargantt.rows` publishes `rows` on every data change", () => {
    booted = boot();
    const seen = vi.fn();
    booted.rows.rows.subscribe(seen);
    booted.data.load(flatTasks(1));
    expect(seen).toHaveBeenCalledTimes(1);
  });

  // docs/specs/plugins/tree-grid.md § Services — the composed column-width map republishes on
  // every resize step, keyboard included.
  it("Services: `stargantt.grid` publishes `columnWidths` on a keyboard column resize", () => {
    booted = boot();
    const seen = vi.fn();
    booted.grid.columnWidths.subscribe(seen);
    const cell = booted.header.findAll("sg-grid-cell sg-grid-header-cell")[0];
    booted.header.fire("keydown", {
      key: "ArrowRight",
      altKey: true,
      target: cell,
      preventDefault: () => {},
    });
    expect(seen).toHaveBeenCalledTimes(1);
  });

  it("ExtensionPoints: `grid/columns` is defined by this plugin", () => {
    booted = boot([
      probe((ctx) =>
        ctx.contribute("grid/columns", {
          id: "x",
          header: "X",
          render: (el) => {
            el.textContent = "x";
          },
          getValue: () => undefined,
        }),
      ),
    ]);
    expect(booted.header.findAll("sg-grid-cell sg-grid-header-cell").length).toBe(5);
  });

  it("ExtensionPoints: `rows/height` is defined by this plugin", () => {
    booted = boot([probe((ctx) => ctx.contribute("rows/height", () => 50))]);
    booted.data.load(flatTasks(2));
    expect(booted.rows.rowHeight(0)).toBe(50);
    expect(booted.rows.totalHeight()).toBe(100);
  });

  it("accepts a contribution made before the point is defined", () => {
    // `test.early` has no dependency edge to tree-grid, so it starts first and contributes to a
    // key nothing has defined yet; the core buffers it until `defineExtensionPoint` runs.
    const early = probe((ctx) => ctx.contribute("rows/height", () => 50), "test.early", []);
    booted = boot([early]);
    booted.data.load(flatTasks(2));
    expect(booted.rows.totalHeight()).toBe(100);
  });
});
