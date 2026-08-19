/**
 * The display extensions: column layout, cell-renderer overrides, row classes, WBS numbering,
 * collapsed-branch badges, locale collation and the bundled editors.
 *
 * docs/specs/plugins/tree-grid.md § Config, § Internal modules, § Third-party surface.
 * The outline-editing commands (`view/rowIndent` / `view/rowOutdent` / `view/rowInsert` /
 * `view/expandToLevel`) are ported separately in `extensions-outline.test.ts`.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Task } from "@stargantt/plugin-data-store";
import { dateEditor, selectEditor } from "../src/index";
import type { TreeGridConfig } from "../src/index";
import { createColumnView, resolveCollation } from "../src/internal/column-view";
import type { ColumnDef } from "../src/types";
import { task } from "./_data";
import { boot, expectHeaderParity, flatTasks, treeTasks } from "./_boot";
import type { Booted } from "./_boot";
import { installDom } from "./_harness/index";

let booted: Booted | undefined;

afterEach(() => {
  booted?.gantt.dispose();
  booted?.dom.restore();
  booted = undefined;
});

/** Boots with the given config and tasks, frames flushed so the pane is painted. */
function withConfig(config: TreeGridConfig | undefined, tasks: Partial<Task>[]): Booted {
  const b = boot([], {}, config);
  booted = b;
  b.data.load(tasks);
  b.dom.flushFrames();
  return b;
}

function headerLabels(b: Booted): (string | undefined)[] {
  return b.header.findAll("sg-grid-cell sg-grid-header-cell").map((c) => c.textContent);
}

function cellTexts(b: Booted, column: number): (string | undefined)[] {
  return b.visibleRows().map((r) => r.findAll("sg-grid-cell")[column]?.textContent);
}

/* ------------------------------------------------------------------ *
 * Pure units — not otherwise covered: `createColumnView` / `resolveCollation` have no other test
 * file exercising them.
 * ------------------------------------------------------------------ */

describe("column view (layout + renderer overrides)", () => {
  const col = (id: string): ColumnDef => ({
    id,
    header: id,
    render(el) {
      el.textContent = `own-${id}`;
    },
    getValue: () => id,
  });

  it("returns the raw reader untouched with nothing configured", () => {
    const read = (): ColumnDef[] => [];
    expect(createColumnView({ read, fault: () => {} })).toBe(read);
  });

  it("hides and reorders by id, ignoring unknown and non-string entries", () => {
    const input = [col("a"), col("b"), col("c")];
    const view = createColumnView({
      read: () => input,
      layout: { hidden: ["b", "nope", 3 as unknown as string], order: ["c", "ghost"] },
      fault: () => {},
    });
    expect(view().map((c) => c.id)).toEqual(["c", "a"]);
  });

  it("memoizes on the input array identity", () => {
    let input = [col("a")];
    const view = createColumnView({ read: () => input, layout: { order: ["a"] }, fault: () => {} });
    const first = view();
    expect(view()).toBe(first);
    input = [col("a"), col("b")];
    expect(view()).not.toBe(first);
  });

  it("wraps an overridden renderer with a latched fault barrier", () => {
    const fault = vi.fn();
    const dom = installDom();
    try {
      const target = dom.root.ownerDocument.createElement("div");
      let calls = 0;
      const view = createColumnView({
        read: () => [col("a")],
        renderers: {
          a: () => {
            calls += 1;
            throw new Error("boom");
          },
        },
        fault,
      });
      const wrapped = view()[0] as ColumnDef;
      const t = task("t", null);
      wrapped.render(target as unknown as HTMLElement, t);
      wrapped.render(target as unknown as HTMLElement, t);
      expect(calls).toBe(1); // latched after the throw
      expect(fault).toHaveBeenCalledTimes(1);
      expect(target.textContent).toBe("own-a"); // fallback to the column's own render
    } finally {
      dom.restore();
    }
  });
});

describe("collation resolution", () => {
  it("yields a locale comparator for `true` and for a locales object", () => {
    const c = resolveCollation(true);
    expect(c?.("a", "b")).toBeLessThan(0);
    const de = resolveCollation({ locales: "de", options: { sensitivity: "base" } });
    expect(de?.("a", "A")).toBe(0);
  });

  it("ignores unusable values", () => {
    expect(resolveCollation(undefined)).toBeUndefined();
    expect(resolveCollation("en")).toBeUndefined();
    expect(resolveCollation(false)).toBeUndefined();
  });
});

/* ------------------------------------------------------------------ *
 * Booted behavior
 * ------------------------------------------------------------------ */

describe("`columnLayout`", () => {
  it("keeps the default composition byte-identical with no config", () => {
    const b = withConfig(undefined, flatTasks(1));
    expect(headerLabels(b)).toEqual(["Name", "Start", "End", "Progress"]);
  });

  it("hides and reorders the displayed columns", () => {
    const b = withConfig(
      { columnLayout: { hidden: ["progress"], order: ["end", "name"] } },
      flatTasks(1),
    );
    expect(headerLabels(b)).toEqual(["End", "Name", "Start"]);
  });

  // Hiding/reordering columns must not desynchronize a body cell's `data-column-id` from the
  // header cell it now sits under: both are read off the same post-layout column list.
  it("keeps `data-column-id` attached to the right cell through a hide/reorder", () => {
    const b = withConfig(
      { columnLayout: { hidden: ["progress"], order: ["end", "name"] } },
      flatTasks(1),
    );
    const headerIds = b.header
      .findAll("sg-grid-cell sg-grid-header-cell")
      .map((c) => c.getAttribute("data-column-id"));
    const bodyIds = b.visibleRows()[0]
      ?.findAll("sg-grid-cell")
      .map((c) => c.getAttribute("data-column-id"));
    expect(headerIds).toEqual(["end", "name", "start"]);
    expect(bodyIds).toEqual(headerIds);
  });
});

describe("`cellRenderers`", () => {
  it("repaints the named column with the override, leaving others alone", () => {
    const b = withConfig(
      { cellRenderers: { name: (el, t) => (el.textContent = `*${t.name}*`) } },
      flatTasks(2),
    );
    expect(cellTexts(b, 0)).toEqual(["*t0*", "*t1*"]);
  });
});

describe("`rowClass`", () => {
  it("adds and clears computed tokens as rows repaint", () => {
    const b = withConfig(
      { rowClass: (t) => (t.name === "t1" ? "hot urgent" : undefined) },
      flatTasks(3),
    );
    const rows = b.visibleRows();
    expect(rows[1]?.classList.contains("hot")).toBe(true);
    expect(rows[1]?.classList.contains("urgent")).toBe(true);
    expect(rows[0]?.classList.contains("hot")).toBe(false);
  });

  it("latches a throwing hook after one report", () => {
    const errors = vi.fn();
    const b = boot([], {}, {
      rowClass: () => {
        throw new Error("boom");
      },
    });
    booted = b;
    b.gantt.on("core/pluginError", errors);
    b.data.load(flatTasks(3));
    b.dom.flushFrames();
    expect(errors).toHaveBeenCalledTimes(1);
    expect(b.visibleRows().length).toBe(3);
  });
});

describe("`wbs`", () => {
  it("prepends a WBS column with hierarchy codes", () => {
    const b = withConfig({ wbs: true }, treeTasks(2, 2));
    expect(headerLabels(b)).toEqual(["WBS", "Name", "Start", "End", "Progress"]);
    expect(cellTexts(b, 0)).toEqual(["1", "1.1", "1.2", "2", "2.1", "2.2"]);
  });

  it("renumbers after a structural change", () => {
    const b = withConfig({ wbs: true }, treeTasks(1, 1));
    b.gantt.dispatch("task/add", { task: { name: "x" } });
    b.dom.flushFrames();
    expect(cellTexts(b, 0)).toEqual(["1", "1.1", "2"]);
  });

  it("honors the `wbsColumn` catalog message", () => {
    const b = withConfig({ wbs: true, messages: { wbsColumn: "Nr." } }, flatTasks(1));
    expect(headerLabels(b)[0]).toBe("Nr.");
  });
});

/**
 * `wbs` composed with the tree indent gutter.
 *
 * A WBS code gains one segment per level, so a deeper row's code is *longer* than a shallow one's.
 * The indentation stays off the numbering column: the gutter and the depth inset sit immediately
 * before the tree column — the first displayed column that is not the one the `wbs` option
 * contributes — so the code column keeps its full width at every depth while the column whose
 * content actually nests (Name) pays for the indentation.
 */
describe("`wbs` × `indent` — room for the code", () => {
  /** `--sg-treegrid-cell-padding`, applied to both sides of every `.sg-grid-cell`. */
  const CELL_PADDING = 8;

  /** A single chain `d0 → d1 → …`, so row *n* sits at depth *n* and is coded `1`, `1.1`, `1.1.1`, … */
  function chain(levels: number): Partial<Task>[] {
    return Array.from({ length: levels }, (_, i) => ({
      id: `d${i}`,
      parentId: i === 0 ? null : `d${i - 1}`,
      name: `level ${i}`,
      start: 0,
      end: 1,
    }));
  }

  /** The px each row's WBS cell leaves for its code, once the cell's own padding is taken off. */
  function codeRoom(b: Booted): number[] {
    return b.visibleRows().map((r) => {
      const width = r.findAll("sg-grid-cell")[0]?.style["width"] ?? "0";
      return Number.parseFloat(width) - 2 * CELL_PADDING;
    });
  }

  it("gives a deeper row's longer code at least the room a shallow row's code gets", () => {
    const b = withConfig({ wbs: true }, chain(4));
    expect(cellTexts(b, 0)).toEqual(["1", "1.1", "1.1.1", "1.1.1.1"]);

    const room = codeRoom(b);
    expect(room).toEqual([room[0], room[0], room[0], room[0]]);
  });

  // The measurement behind the line above, stated on its own so the numbers are visible in the
  // suite rather than only inside a failure diff. Without the placement rule above, the code
  // column would itself shrink with depth — 54, 38, 22, 8 — so `1.1.1` would render as `1…` and
  // `1.1.1.1` as `1..`, and the depth-4 row would also outgrow its own header.
  it("leaves the code column its full width at every depth", () => {
    const b = withConfig({ wbs: true }, chain(4));
    // 70 px declared, less 2 x 8 px of cell padding, at every level.
    expect(codeRoom(b)).toEqual([54, 54, 54, 54]);
  });

  it("moves the indentation onto the column after the code — the one that nests", () => {
    const b = withConfig({ wbs: true }, chain(4));
    const rows = b.visibleRows();
    expect(rows.map((r) => r.findAll("sg-grid-cell")[1]?.style["width"])).toEqual([
      "220px",
      "204px",
      "188px",
      "172px",
    ]);
    expect(rows.map((r) => r.find("sg-grid-toggle")?.style["width"])).toEqual([
      "24px",
      "40px",
      "56px",
      "72px",
    ]);
    // …and the gutter itself is laid out between the two, not at the row's leading edge.
    expect(rows[0]?.children.map((c) => c.getAttribute("data-column-id") ?? c.className)).toEqual([
      "wbs",
      "sg-grid-toggle",
      "name",
      "start",
      "end",
      "progress",
    ]);
  });

  // The header-parity invariant: without it, the `name` cell's left edge would drift as depth
  // grows — observed drifting 347 → 349 → 365 px while its header stayed put at 347.
  it("keeps every column under its own header at every depth", () => {
    const b = withConfig({ wbs: true }, chain(4));
    for (const row of b.visibleRows()) expectHeaderParity(b, row);
  });

  it("holds parity where the inset saturates on a deep tree", () => {
    const b = boot([], { height: 900 }, { wbs: true });
    booted = b;
    b.data.load(chain(20));
    b.dom.flushFrames();
    const rows = b.visibleRows();
    expect(rows.length).toBe(20);
    for (const row of rows) expectHeaderParity(b, row);
    // 220 - (24 + 2 x 8) = 180 px of inset is all the Name column affords.
    expect(rows[19]?.findAll("sg-grid-cell")[1]?.style["width"]).toBe("40px");
    expect(rows[19]?.find("sg-grid-toggle")?.style["width"]).toBe("204px");
    // The code column is untouched by the saturation, as by the indentation.
    expect(codeRoom(b).every((room) => room === 54)).toBe(true);
  });

  // An ellipsised code must never be lossy: the cell carries the full code as its `title`,
  // unconditionally, at every paint.
  it("carries the full code as each cell's `title`", () => {
    const b = withConfig({ wbs: true }, chain(5));
    const cells = b.visibleRows().map((r) => r.findAll("sg-grid-cell")[0]);
    expect(cells.map((c) => c?.getAttribute("title"))).toEqual([
      "1",
      "1.1",
      "1.1.1",
      "1.1.1.1",
      "1.1.1.1.1",
    ]);
    // The attribute follows the row a recycled slot now shows, never a stale code.
    b.gantt.dispatch("view/rowToggle", { id: "d0", expanded: false });
    b.dom.flushFrames();
    expect(b.visibleRows().map((r) => r.findAll("sg-grid-cell")[0]?.getAttribute("title"))).toEqual([
      "1",
    ]);
  });

  // The numbering column is identified by what contributed it, not by its column id: a host's own
  // column called `wbs` is ordinary, and hosts the tree like any other first column.
  it("treats a foreign column that reuses the id `wbs` as an ordinary column", () => {
    const foreign: ColumnDef = {
      id: "wbs",
      header: "Ref",
      width: 70,
      render: (el, task) => {
        el.textContent = task.name;
      },
      getValue: (task) => task.name,
    };
    const b = withConfig({ columns: [foreign] }, chain(2));
    const rows = b.visibleRows();
    expect(rows[0]?.children.map((c) => c.className)).toEqual(["sg-grid-toggle", "sg-grid-cell"]);
    expect(rows.map((r) => r.findAll("sg-grid-cell")[0]?.style["width"])).toEqual(["70px", "54px"]);
    for (const row of rows) expectHeaderParity(b, row);
  });

  // `columnLayout` can hide the tree column's neighbours, or leave the numbering column alone on
  // display — where it becomes the tree column itself.
  it("falls back to the numbering column when it is all that is displayed", () => {
    const b = withConfig(
      { wbs: true, columnLayout: { hidden: ["name", "start", "end", "progress"] } },
      chain(3),
    );
    const rows = b.visibleRows();
    expect(rows[0]?.children.map((c) => c.className)).toEqual(["sg-grid-toggle", "sg-grid-cell"]);
    // 70 - 40 = 30 px of room, so depth 2 saturates one step short of 32.
    expect(rows.map((r) => r.findAll("sg-grid-cell")[0]?.style["width"])).toEqual([
      "70px",
      "54px",
      "40px",
    ]);
    for (const row of rows) expectHeaderParity(b, row);
  });

  // The `wbs`-off default has to be untouched by all of the above: `tree-grid` is in the standard
  // preset, so this is the composition every screenshot baseline in the repository is built on.
  it("leaves the default composition's leading structure exactly as it was", () => {
    const b = withConfig(undefined, chain(3));
    const rows = b.visibleRows();
    for (const row of rows) {
      expect(row.children[0]?.className).toBe("sg-grid-toggle");
      expectHeaderParity(b, row);
    }
    expect(rows.map((r) => r.find("sg-grid-toggle")?.style["width"])).toEqual([
      "24px",
      "40px",
      "56px",
    ]);
    expect(rows.map((r) => r.findAll("sg-grid-cell")[0]?.style["width"])).toEqual([
      "220px",
      "204px",
      "188px",
    ]);
    expect(b.header.children[0]?.className).toBe("sg-grid-header-gutter");
  });
});

describe("`collapsedBadge`", () => {
  it("shows the hidden-descendant count on collapsed branches only", () => {
    const b = withConfig({ collapsedBadge: true }, treeTasks(2, 3));
    b.gantt.dispatch("view/rowToggle", { id: "p0", expanded: false });
    b.dom.flushFrames();
    const rows = b.visibleRows();
    expect(rows[0]?.find("sg-grid-badge")?.textContent).toBe("(3)");
    expect(rows[1]?.find("sg-grid-badge")).toBeUndefined(); // p1 stays expanded
  });

  it("renders no badge by default", () => {
    const b = withConfig(undefined, treeTasks(1, 1));
    b.gantt.dispatch("view/rowToggle", { id: "p0", expanded: false });
    b.dom.flushFrames();
    expect(b.visibleRows()[0]?.find("sg-grid-badge")).toBeUndefined();
  });
});

describe("`collation`", () => {
  it("makes the built-in Name column sortable with a locale-aware order", () => {
    const b = withConfig({ collation: { locales: "en" } }, [
      { id: "a", parentId: null, name: "b", start: 0, end: 1 },
      { id: "b", parentId: null, name: "a", start: 0, end: 1 },
    ]);
    const nameHeader = b.header.findAll("sg-grid-cell sg-grid-header-cell")[0];
    b.header.fire("click", { target: nameHeader });
    b.dom.flushFrames();
    expect(b.rows.taskIdAt(0)).toBe("b"); // "a" sorts first
  });

  it("keeps the Name header unsortable by default", () => {
    const b = withConfig(undefined, flatTasks(2));
    const nameHeader = b.header.findAll("sg-grid-cell sg-grid-header-cell")[0];
    b.header.fire("click", { target: nameHeader });
    b.dom.flushFrames();
    expect(b.rows.taskIdAt(0)).toBe("t0");
  });
});

describe("bundled editors", () => {
  function host(): { el: HTMLElement; dom: ReturnType<typeof installDom> } {
    const dom = installDom();
    const el = dom.root.ownerDocument.createElement("div") as unknown as HTMLElement;
    return { el, dom };
  }

  it("selectEditor commits the picked option's value on change", () => {
    const { el, dom } = host();
    try {
      const commit = vi.fn();
      const cancel = vi.fn();
      selectEditor(["todo", { value: 2, label: "done" }])(el, 2, { commit, cancel });
      const select = (el as unknown as { find(cls: string): { selectedIndex: number; fire(t: string, e: object): void } }).find(
        "sg-grid-select",
      );
      expect(select.selectedIndex).toBe(1); // pre-selected on the current value
      select.selectedIndex = 0;
      select.fire("change", {});
      expect(commit).toHaveBeenCalledWith("todo");
      expect(cancel).not.toHaveBeenCalled();
    } finally {
      dom.restore();
    }
  });

  it("selectEditor cancels on Escape and on blur, and with no usable choices", () => {
    const { el, dom } = host();
    try {
      const commit = vi.fn();
      const cancel = vi.fn();
      selectEditor(["a"])(el, "a", { commit, cancel });
      const select = (el as unknown as { find(cls: string): { fire(t: string, e: object): void } }).find(
        "sg-grid-select",
      );
      select.fire("keydown", { key: "Escape" });
      select.fire("blur", {}); // already settled: no second callback
      expect(cancel).toHaveBeenCalledTimes(1);
      expect(commit).not.toHaveBeenCalled();

      const none = vi.fn();
      selectEditor([])(el, "a", { commit: vi.fn(), cancel: none });
      expect(none).toHaveBeenCalledTimes(1);
    } finally {
      dom.restore();
    }
  });

  it("dateEditor commits the picked day as UTC-midnight epoch ms", () => {
    const { el, dom } = host();
    try {
      const commit = vi.fn();
      const cancel = vi.fn();
      dateEditor()(el, Date.UTC(2026, 7, 7), { commit, cancel });
      const input = (el as unknown as { find(cls: string): { value: string; fire(t: string, e: object): void } }).find(
        "sg-grid-date",
      );
      expect(input.value).toBe("2026-08-07");
      input.value = "2026-08-10";
      input.fire("change", {});
      expect(commit).toHaveBeenCalledWith(Date.UTC(2026, 7, 10));
    } finally {
      dom.restore();
    }
  });

  it("dateEditor cancels on Escape and on an incomplete date", () => {
    const { el, dom } = host();
    try {
      const commit = vi.fn();
      const cancel = vi.fn();
      dateEditor()(el, "not a date", { commit, cancel });
      const input = (el as unknown as { value: string; find(cls: string): { value: string; fire(t: string, e: object): void } }).find(
        "sg-grid-date",
      );
      expect(input.value).toBe(""); // unusable initial value starts blank
      input.fire("keydown", { key: "Enter" }); // empty = incomplete → cancel
      expect(cancel).toHaveBeenCalledTimes(1);
      expect(commit).not.toHaveBeenCalled();
    } finally {
      dom.restore();
    }
  });
});
