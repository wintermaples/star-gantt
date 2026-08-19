/**
 * The plugin boundary reached only through the public core API: the row-model service, the two
 * extension points, and the commands that mutate the row set.
 *
 * docs/specs/plugins/tree-grid.md § Services / § Extension points / § Commands
 *
 * The `grid/columns` composition itself, the published stores' shapes and the `dependsOn` /
 * `ctx.use()` consistency check live in `plugin.test.ts`; this file does not repeat them.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ColumnDef, RowHeightContribution } from "../src/types";
import { boot, flatTasks, probe, treeTasks } from "./_boot";
import type { Booted } from "./_boot";

let booted: Booted | undefined;

afterEach(() => {
  booted?.gantt.dispose();
  booted?.dom.restore();
  booted = undefined;
});

describe("plugin identity", () => {
  it("provides `stargantt.rows` to application code", () => {
    booted = boot();
    expect(typeof booted.rows.rowCount).toBe("function");
    expect(booted.rows.rowCount()).toBe(0);
  });

  it("declares `stargantt.data-store` and `stargantt.view` as its dependencies", async () => {
    const { treeGrid } = await import("../src/index");
    expect(treeGrid().meta.id).toBe("stargantt.tree-grid");
    expect(treeGrid().meta.dependsOn).toEqual(["stargantt.data-store", "stargantt.view"]);
  });
});

describe("row model service", () => {
  it("reflects loaded data", () => {
    booted = boot();
    booted.data.load(treeTasks(2, 2));
    expect(booted.rows.rowCount()).toBe(6);
    expect(booted.rows.taskIdAt(0)).toBe("p0");
    expect(booted.rows.taskIdAt(1)).toBe("p0c0");
    expect(booted.rows.rowOf("p1")).toBe(3);
    expect(booted.rows.isExpanded("p0")).toBe(true);
  });

  it("exposes fixed-height geometry with no `rows/height` contribution", () => {
    booted = boot();
    booted.data.load(flatTasks(10));
    const h = booted.rows.rowHeight(0);
    expect(booted.rows.totalHeight()).toBe(10 * h);
    expect(booted.rows.yOf(4)).toBe(4 * h);
    expect(booted.rows.rowAtY(4 * h)).toBe(4);
  });
});

describe("`view/rowToggle` command", () => {
  it("collapses and re-expands, publishing the row set each time", () => {
    booted = boot();
    booted.data.load(treeTasks(1, 3));
    const seen: unknown[] = [];
    // docs/specs/plugins/tree-grid.md § Services — a row-set change publishes its own store, and
    // it does not leak into the column-width one: the two meanings stay separate in both
    // directions.
    const widths: unknown[] = [];
    booted.rows.rows.subscribe((next) => seen.push(next));
    booted.grid.columnWidths.subscribe((next) => widths.push(next));

    booted.gantt.dispatch("view/rowToggle", { id: "p0", expanded: false });
    expect(booted.rows.rowCount()).toBe(1);
    expect(booted.rows.isExpanded("p0")).toBe(false);
    expect(seen).toHaveLength(1);

    booted.gantt.dispatch("view/rowToggle", { id: "p0" });
    expect(booted.rows.rowCount()).toBe(4);
    expect(seen).toHaveLength(2);
    expect(widths).toHaveLength(0);
  });

  it("stays silent when the requested state is already in effect", () => {
    booted = boot();
    booted.data.load(treeTasks(1, 1));
    const seen: unknown[] = [];
    booted.rows.rows.subscribe((next) => seen.push(next));
    booted.gantt.dispatch("view/rowToggle", { id: "p0", expanded: true });
    expect(seen).toHaveLength(0);
  });

  it("gives `rows` subscribers the already-updated model", () => {
    booted = boot();
    booted.data.load(treeTasks(1, 2));
    let observed = -1;
    const rows = booted.rows;
    booted.rows.rows.subscribe(() => {
      observed = rows.rowCount();
    });
    booted.gantt.dispatch("view/rowToggle", { id: "p0", expanded: false });
    expect(observed).toBe(1);
  });
});

// docs/specs/plugins/tree-grid.md § Commands — row-model invalidation.
describe("`view/rowsInvalidate` command", () => {
  it("re-resolves row heights and republishes once, leaving expand state alone", () => {
    let hidden = false;
    booted = boot([
      probe((ctx) => {
        ctx.contribute("rows/height", (task) => (hidden && task.id === "p0c0" ? 0 : undefined));
      }),
    ]);
    booted.data.load(treeTasks(1, 2));
    expect(booted.rows.rowHeight(1)).toBeGreaterThan(0);

    const seen: unknown[] = [];
    booted.rows.rows.subscribe((next) => seen.push(next));
    hidden = true;
    booted.gantt.dispatch("view/rowsInvalidate", undefined);
    expect(seen).toHaveLength(1);
    expect(booted.rows.rowHeight(1)).toBe(0);
    // The row is still there — hiding is geometric — and no branch changed its expand state.
    expect(booted.rows.rowCount()).toBe(3);
    expect(booted.rows.isExpanded("p0")).toBe(true);
  });
});

describe("a data command republishes the row set", () => {
  it("re-flattens after a data command", () => {
    booted = boot();
    booted.data.load(flatTasks(2));
    const seen: unknown[] = [];
    booted.rows.rows.subscribe((next) => seen.push(next));
    booted.gantt.dispatch("task/add", { task: { name: "extra" } });
    expect(seen).toHaveLength(1);
    expect(booted.rows.rowCount()).toBe(3);
  });
});

describe("`grid/columns` (collect)", () => {
  it("collects third-party columns after the defaults", () => {
    const extra: ColumnDef = {
      id: "note",
      header: "Note",
      render(el, task) {
        el.textContent = `#${String(task.id)}`;
      },
      getValue: (task) => task.id,
    };
    booted = boot([probe((ctx) => ctx.contribute("grid/columns", extra))]);
    booted.data.load(flatTasks(1));
    booted.dom.flushFrames();
    const headers = booted.header.findAll("sg-grid-cell sg-grid-header-cell");
    expect(headers.map((h) => h.textContent)).toEqual(["Name", "Start", "End", "Progress", "Note"]);
    const cells = booted.visibleRows()[0]?.findAll("sg-grid-cell") ?? [];
    expect(cells[4]?.textContent).toBe("#t0");
  });

  it("renders the default cell contents", () => {
    booted = boot();
    booted.data.load([
      { id: "a", parentId: null, name: "Alpha", start: 0, end: 86400000, progress: 0.5 },
    ]);
    booted.dom.flushFrames();
    const cells = booted.visibleRows()[0]?.findAll("sg-grid-cell") ?? [];
    expect(cells.map((c) => c.textContent)).toEqual(["Alpha", "1970-01-01", "1970-01-02", "50%"]);
  });
});

describe("`rows/height` (reduce)", () => {
  it("lets a contribution override the default height", () => {
    const tall: RowHeightContribution = (task, d) => (task.id === "t1" ? 64 : d);
    booted = boot([probe((ctx) => ctx.contribute("rows/height", tall))]);
    booted.data.load(flatTasks(3));

    const base = booted.rows.rowHeight(0);
    expect(booted.rows.rowHeight(1)).toBe(64);
    expect(booted.rows.totalHeight()).toBe(base * 2 + 64);
    expect(booted.rows.yOf(2)).toBe(base + 64);
    expect(booted.rows.rowAtY(base)).toBe(1);
    expect(booted.rows.rowAtY(base + 63)).toBe(1);
    expect(booted.rows.rowAtY(base + 64)).toBe(2);
  });

  it("passes the height resolved so far as the next contribution's default", () => {
    const seen: number[] = [];
    booted = boot([
      probe((ctx) => ctx.contribute("rows/height", () => 40), "test.a"),
      probe(
        (ctx) =>
          ctx.contribute("rows/height", (_t, d) => {
            seen.push(d);
            return d + 2;
          }),
        "test.b",
      ),
    ]);
    booted.data.load(flatTasks(1));
    expect(booted.rows.rowHeight(0)).toBe(42);
    expect(seen).toEqual([40]);
  });

  it("`undefined` declines the override", () => {
    booted = boot([probe((ctx) => ctx.contribute("rows/height", () => undefined))]);
    booted.data.load(flatTasks(2));
    const h = booted.rows.rowHeight(0);
    expect(booted.rows.totalHeight()).toBe(2 * h);
  });

  it("a throwing contribution is reported as a plugin error and does not break geometry", () => {
    const errors: { pluginId: string; error: unknown }[] = [];
    booted = boot([
      probe((ctx) =>
        ctx.contribute("rows/height", () => {
          throw new Error("boom");
        }),
      ),
    ]);
    booted.gantt.on("core/pluginError", (e) => errors.push(e));
    booted.data.load(flatTasks(2));
    const h = booted.rows.rowHeight(0);
    expect(booted.rows.totalHeight()).toBe(2 * h);
    expect(errors.length).toBeGreaterThan(0);
    expect(errors[0]?.pluginId).toBe("stargantt.tree-grid");
    // The owner is the only attributable id, so the payload names the point the contribution came
    // through instead of claiming tree-grid itself threw.
    expect(errors[0]?.error).toMatchObject({ point: "rows/height" });
    expect((errors[0]?.error as { cause: Error }).cause.message).toBe("boom");
  });

  it("reports a persistently throwing contribution once, not once per row", () => {
    const errors: unknown[] = [];
    booted = boot([
      probe((ctx) =>
        ctx.contribute("rows/height", () => {
          throw new Error("boom");
        }),
      ),
    ]);
    booted.gantt.on("core/pluginError", (e) => errors.push(e));
    booted.data.load(flatTasks(500));
    expect(booted.rows.rowCount()).toBe(500);
    // Unlatched, this would be 500 synchronous emits for one bad contribution.
    expect(errors.length).toBe(1);
  });

  it("reports a throwing column `render` against the `grid/columns` point", () => {
    const errors: { pluginId: string; error: unknown }[] = [];
    const bad: ColumnDef = {
      id: "bad",
      header: "Bad",
      getValue: () => undefined,
      render() {
        throw new Error("column boom");
      },
    };
    booted = boot([probe((ctx) => ctx.contribute("grid/columns", bad))]);
    booted.gantt.on("core/pluginError", (e) => errors.push(e));
    booted.data.load(flatTasks(1));
    booted.dom.flushFrames();
    expect(errors.length).toBeGreaterThan(0);
    expect(errors[0]?.pluginId).toBe("stargantt.tree-grid");
    expect(errors[0]?.error).toMatchObject({ point: "grid/columns" });
  });
});
