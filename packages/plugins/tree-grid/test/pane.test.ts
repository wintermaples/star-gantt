/**
 * The grid pane's DOM skeleton, its row virtualization, the header/body column-width parity
 * invariant, expand/collapse from the pane, the drop-indicator line, the selection/focus display
 * marks, and resource disposal.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Task } from "@stargantt/plugin-data-store";
import { boot, expectHeaderParity, flatTasks, probe, treeTasks } from "./_boot";
import type { Booted } from "./_boot";
import type { FakeElement } from "./_harness/index";
import type { ColumnDef } from "../src/types";

let b: Booted | undefined;
afterEach(() => {
  b?.gantt.dispose();
  b?.dom.restore();
  b = undefined;
  vi.useRealTimers();
});

/** The fake DOM reports 400×300 for every element, and the default row height is 28. */
const VIEWPORT_H = 300;

describe("DOM structure", () => {
  it("builds `.sg-pane.sg-pane--grid` with a header and a body", () => {
    b = boot();
    expect(b.pane.className).toBe("sg-pane sg-pane--grid");
    expect(b.pane.children.map((c) => c.className)).toEqual(["sg-grid-header", "sg-grid-body"]);
    expect(b.pane.style["width"]).toBe("580px");
  });

  it("places the grid pane and its divider ahead of the chart pane", () => {
    const local = boot();
    expect(local.dom.root.children.map((c) => c.className)).toEqual([
      "sg-pane sg-pane--grid",
      "sg-pane-divider",
      "sg-pane sg-pane--chart",
    ]);
    local.gantt.dispose();
    local.dom.restore();
  });

  it("applies the contributed column widths to header cells", () => {
    b = boot();
    const headers = b.header.findAll("sg-grid-cell sg-grid-header-cell");
    expect(headers.map((h) => h.style["width"])).toEqual(["220px", "110px", "110px", "90px"]);
  });
});

describe("row virtualization", () => {
  it("materializes only the rows intersecting the viewport", () => {
    b = boot();
    b.data.load(flatTasks(1000));
    b.dom.flushFrames();
    const rows = b.visibleRows();
    expect(rows.length).toBe(Math.ceil(VIEWPORT_H / 28));
    expect(rows[0]?.getAttribute("data-row-index")).toBe("0");
    expect(rows[0]?.style["transform"]).toBe("translateY(0px)");
    expect(rows[1]?.style["transform"]).toBe("translateY(28px)");
  });

  it("batches repaints onto a single frame", () => {
    b = boot();
    b.data.load(flatTasks(50));
    b.pane.fire("wheel", { deltaY: 10, preventDefault: () => {} });
    b.pane.fire("wheel", { deltaY: 10, preventDefault: () => {} });
    expect(b.dom.flushFrames()).toBe(1);
  });

  it("scrolls virtually — wheel input moves the row window, not a native scroll box", () => {
    b = boot();
    b.data.load(flatTasks(1000));
    b.dom.flushFrames();
    b.pane.fire("wheel", { deltaY: 100, preventDefault: () => {} });
    b.dom.flushFrames();
    const rows = b.visibleRows();
    expect(rows[0]?.getAttribute("data-row-index")).toBe("3");
    expect(rows[0]?.style["transform"]).toBe("translateY(-16px)");
  });

  it("clamps the scroll position to the content height", () => {
    b = boot();
    b.data.load(flatTasks(12)); // 336px of content, 300px of viewport
    b.dom.flushFrames();
    b.pane.fire("wheel", { deltaY: 100_000, preventDefault: () => {} });
    b.dom.flushFrames();
    const rows = b.visibleRows();
    expect(rows[rows.length - 1]?.getAttribute("data-row-index")).toBe("11");
  });

  // The gutter widens with depth and the first cell narrows by the same amount; the toggle gutter
  // is reserved — not removed — on leaf rows so sibling rows agree regardless of whether they have
  // children.
  it("widens the gutter by tree depth and reserves — not removes — the toggle on leaf rows", () => {
    b = boot();
    b.data.load(treeTasks(1, 2));
    b.dom.flushFrames();
    const rows = b.visibleRows();
    expect(rows[0]?.find("sg-grid-toggle")?.style["width"]).toBe("24px");
    expect(rows[1]?.find("sg-grid-toggle")?.style["width"]).toBe("40px");
    expect(rows[0]?.find("sg-grid-toggle")?.style["visibility"]).toBe("");
    expect(rows[1]?.find("sg-grid-toggle")?.style["visibility"]).toBe("hidden");
    // The built-in `name` column declares `width: 220`; depth 1 narrows it by one `indent` (16).
    expect(rows[0]?.findAll("sg-grid-cell")[0]?.style["width"]).toBe("220px");
    expect(rows[1]?.findAll("sg-grid-cell")[0]?.style["width"]).toBe("204px");
  });

  it("falls back to a timer when requestAnimationFrame is absent", () => {
    vi.useFakeTimers();
    b = boot([], { raf: false });
    b.data.load(flatTasks(3));
    expect(b.visibleRows().length).toBe(0);
    vi.advanceTimersByTime(20);
    expect(b.visibleRows().length).toBe(3);
  });
});

// The header carries the same leading gutter the rows reserve for the expand toggle, so the two
// leading edges and the two total content widths match, and every column after the first sits
// under its own header at every depth.
describe("header/body column alignment", () => {
  /**
   * The leading edge of every flex item of a header or row, plus the trailing edge of the last
   * one (i.e. the total content width), computed from the inline widths the grid writes. The fake
   * DOM has no layout engine, so this reproduces what a run of `flex: 0 0 auto` items with
   * explicit widths lays out to.
   */
  function edges(container: FakeElement): number[] {
    const out: number[] = [];
    let x = 0;
    for (const child of container.children) {
      out.push(x);
      const width = Number.parseFloat(child.style["width"] ?? "");
      if (!Number.isFinite(width)) throw new Error(`no explicit width on .${child.className}`);
      x += width;
    }
    out.push(x);
    return out;
  }

  it("gives the header the same leading gutter the rows carry", () => {
    b = boot();
    b.data.load(flatTasks(1));
    b.dom.flushFrames();
    const gutter = b.header.find("sg-grid-header-gutter");
    expect(gutter?.style["width"]).toBe("24px");
    expect(gutter?.getAttribute("aria-hidden")).toBe("true");
    // The gutter leads the header, exactly as the toggle leads a row.
    expect(b.header.children[0]).toBe(gutter);
  });

  it("aligns every header cell with its body column at depth 0", () => {
    b = boot();
    b.data.load(flatTasks(1));
    b.dom.flushFrames();
    const row = b.visibleRows()[0];
    expect(row).toBeDefined();
    expect(edges(row as FakeElement)).toEqual(edges(b.header));
  });

  it("keeps that alignment — and the total row width — at depth 1", () => {
    b = boot();
    b.data.load(treeTasks(1, 1));
    b.dom.flushFrames();
    const rows = b.visibleRows();
    const head = edges(b.header);
    const deep = edges(rows[1] as FakeElement);
    // The first column's box alone moves with the indent (`deep[1]`); the row's leading edge, every
    // column after the first, and the trailing edge — the total row width — are unmoved.
    expect(deep[0]).toBe(head[0]);
    expect(deep.slice(2)).toEqual(head.slice(2));
    expect(edges(rows[0] as FakeElement)).toEqual(head);
  });

  // The first column of this composition declares no `width`, so it is laid out at its content
  // width; the grid measures that off the header cell rather than growing the row by the indent.
  describe("with a first column that declares no width", () => {
    const wide: ColumnDef = {
      id: "name",
      header: "Name",
      render: (el, task) => void (el.textContent = task.name),
      getValue: (task) => task.name,
    };
    const trailing: ColumnDef = {
      id: "start",
      header: "Start",
      width: 110,
      render: (el, task) => void (el.textContent = String(task.start)),
      getValue: (task) => task.start,
    };

    /** Boots the two-column composition and gives the measured first header cell a real box. */
    function bootMeasured(measured: number): Booted {
      const booted = boot([], {}, { columns: [wide, trailing] });
      const cell = booted.header.findAll("sg-grid-cell sg-grid-header-cell")[0];
      if (cell === undefined) throw new Error("header cell not found");
      cell.rect = { left: 0, top: 0, width: measured, height: 44 };
      return booted;
    }

    it("compensates the indent against the measured width, keeping the row width constant", () => {
      b = bootMeasured(150);
      b.data.load(treeTasks(1, 1));
      b.dom.flushFrames();
      const rows = b.visibleRows();
      expect(rows.map((r) => r.findAll("sg-grid-cell")[0]?.style["width"])).toEqual([
        "150px",
        "134px",
      ]);
      expect(rows.map((r) => r.find("sg-grid-toggle")?.style["width"])).toEqual(["24px", "40px"]);
      const total = (row: FakeElement): number | undefined => edges(row).at(-1);
      expect(total(rows[1] as FakeElement)).toBe(total(rows[0] as FakeElement));
    });

    it("still insets the content when the header has no box to measure", () => {
      b = bootMeasured(0);
      b.data.load(treeTasks(1, 1));
      b.dom.flushFrames();
      const rows = b.visibleRows();
      expect(rows.map((r) => r.findAll("sg-grid-cell")[0]?.style["paddingLeft"])).toEqual([
        "8px",
        "24px",
      ]);
    });
  });

  // The header-parity invariant itself, exercised over the three axes most likely to break it:
  // depth, the number of displayed columns, and the resize floor.
  describe("the parity invariant", () => {
    /** A single chain, so row *n* sits at depth *n*. */
    function chain(levels: number): Partial<Task>[] {
      return Array.from({ length: levels }, (_, i) => ({
        id: `d${i}`,
        parentId: i === 0 ? null : `d${i - 1}`,
        name: `level ${i}`,
        start: 0,
        end: 1,
      }));
    }

    it("holds at every depth of a deep chain, saturation included", () => {
      b = boot([], { height: 900 });
      b.data.load(chain(20));
      b.dom.flushFrames();
      const rows = b.visibleRows();
      expect(rows.length).toBe(20);
      for (const row of rows) expectHeaderParity(b, row);
    });

    it.each([1, 2, 4])("holds with %i displayed column(s)", (count) => {
      const ids = ["name", "start", "end", "progress"];
      b = boot([], {}, { columnLayout: { hidden: ids.slice(count) } });
      b.data.load(treeTasks(1, 2));
      b.dom.flushFrames();
      const rows = b.visibleRows();
      expect(rows[0]?.findAll("sg-grid-cell").length).toBe(count);
      for (const row of rows) expectHeaderParity(b, row);
    });

    it("holds once a keyboard resize has driven the tree column to its floor", () => {
      b = boot();
      b.data.load(treeTasks(1, 2));
      b.dom.flushFrames();
      const cell = b.header.findAll("sg-grid-cell sg-grid-header-cell")[0];
      if (cell === undefined) throw new Error("header cell not found");
      for (let i = 0; i < 30; i += 1) {
        b.header.fire("keydown", {
          key: "ArrowLeft",
          altKey: true,
          target: cell,
          preventDefault: () => {},
        });
      }
      expect(cell.style["width"]).toBe("40px");
      const rows = b.visibleRows();
      // At the floor there is no room left to indent, so every row's cell is the full 40 px and
      // every gutter is back to its base width — the row still ends where the header does.
      expect(rows.map((r) => r.findAll("sg-grid-cell")[0]?.style["width"])).toEqual([
        "40px",
        "40px",
        "40px",
      ]);
      expect(rows.map((r) => r.find("sg-grid-toggle")?.style["width"])).toEqual([
        "24px",
        "24px",
        "24px",
      ]);
      for (const row of rows) expectHeaderParity(b, row);
    });

    it("holds through a drag-resize of the tree column at mixed depths", () => {
      b = boot();
      b.data.load(treeTasks(1, 2));
      b.dom.flushFrames();
      const h = b.header
        .findAll("sg-grid-cell sg-grid-header-cell")[0]
        ?.find("sg-grid-header-resize-handle");
      if (h === undefined) throw new Error("resize handle not found");
      b.header.fire("pointerdown", { clientX: 400, target: h });
      b.dom.document.fire("pointermove", { clientX: 340 });
      for (const row of b.visibleRows()) expectHeaderParity(b, row);
      b.dom.document.fire("pointermove", { clientX: 100 });
      for (const row of b.visibleRows()) expectHeaderParity(b, row);
    });
  });
});

// Header-boundary drag handles, the same gesture feel as the pane divider; announced through the
// `columnWidths` store, never through the `rows` store (whose meaning is the visible row set
// alone).
describe("column resize", () => {
  function handle(booted: Booted, columnIndex = 0): FakeElement {
    const cell = booted.header.findAll("sg-grid-cell sg-grid-header-cell")[columnIndex];
    const found = cell?.find("sg-grid-header-resize-handle");
    if (found === undefined) throw new Error("resize handle not found");
    return found;
  }

  it("dragging the boundary resizes the column to its left", () => {
    b = boot();
    const h = handle(b, 0);
    b.header.fire("pointerdown", { clientX: 100, target: h });
    // the fake layout reports 400px for any element, so +50 lands at 450, mirroring the pane
    // divider's own test convention
    b.dom.document.fire("pointermove", { clientX: 150 });
    const cell = b.header.findAll("sg-grid-cell sg-grid-header-cell")[0];
    expect(cell?.style["width"]).toBe("450px");
  });

  it("applies the live width to materialized body cells of the same column too", () => {
    b = boot();
    b.data.load(flatTasks(2));
    b.dom.flushFrames();
    const h = handle(b, 0);
    b.header.fire("pointerdown", { clientX: 100, target: h });
    b.dom.document.fire("pointermove", { clientX: 150 });
    const rowCell = b.visibleRows()[0]?.findAll("sg-grid-cell")[0];
    expect(rowCell?.style["width"]).toBe("450px");
  });

  it("stops tracking the pointer after pointerup", () => {
    b = boot();
    const h = handle(b, 0);
    b.header.fire("pointerdown", { clientX: 100, target: h });
    b.dom.document.fire("pointermove", { clientX: 150 });
    b.dom.document.fire("pointerup", {});
    b.dom.document.fire("pointermove", { clientX: 300 });
    const cell = b.header.findAll("sg-grid-cell sg-grid-header-cell")[0];
    expect(cell?.style["width"]).toBe("450px");
  });

  // The floor is 24 CSS px of content box, i.e. 40 px of border box at the default 8 px
  // `--sg-treegrid-cell-padding`.
  it("clamps at the usable minimum instead of collapsing to zero or negative", () => {
    b = boot();
    const h = handle(b, 0);
    b.header.fire("pointerdown", { clientX: 100, target: h });
    b.dom.document.fire("pointermove", { clientX: -10_000 });
    const cell = b.header.findAll("sg-grid-cell sg-grid-header-cell")[0];
    expect(cell?.style["width"]).toBe("40px");
  });

  it("does not mutate the contributed `ColumnDef.width`", () => {
    const nameColumn: ColumnDef = {
      id: "name",
      header: "Name",
      width: 220,
      render: (el, task) => void (el.textContent = task.name),
      getValue: (task) => task.name,
    };
    b = boot([], {}, { columns: [nameColumn] });
    const h = handle(b, 0);
    b.header.fire("pointerdown", { clientX: 100, target: h });
    b.dom.document.fire("pointermove", { clientX: 150 });
    expect(nameColumn.width).toBe(220);
  });

  it("announces a drag step through the column-widths store, not the rows store", () => {
    b = boot();
    const widths = vi.fn();
    const rows = vi.fn();
    b.grid.columnWidths.subscribe(widths);
    b.rows.rows.subscribe(rows);
    const h = handle(b, 0);
    b.header.fire("pointerdown", { clientX: 100, target: h });
    b.dom.document.fire("pointermove", { clientX: 150 });
    // The publication is coalesced onto the next frame, so it lands when the frame runs.
    b.dom.flushFrames();
    expect(widths).toHaveBeenCalledTimes(1);
    expect(rows).not.toHaveBeenCalled();
  });

  it("publishes a column-widths snapshot at most once per animation frame during a drag", () => {
    b = boot();
    const widths = vi.fn();
    b.grid.columnWidths.subscribe(widths);
    const h = handle(b, 0);
    b.header.fire("pointerdown", { clientX: 100, target: h });
    // Several moves inside one frame — a real drag easily produces this — must collapse into one
    // publication, while every step is still applied to the DOM.
    for (const clientX of [110, 120, 130, 140]) {
      b.dom.document.fire("pointermove", { clientX });
    }
    expect(widths).not.toHaveBeenCalled();
    expect(b.header.findAll("sg-grid-cell sg-grid-header-cell")[0]?.style["width"]).toBe("440px");
    b.dom.flushFrames();
    expect(widths).toHaveBeenCalledTimes(1);

    // The next frame's moves publish again — the throttle coalesces, it does not drop.
    b.dom.document.fire("pointermove", { clientX: 150 });
    b.dom.flushFrames();
    expect(widths).toHaveBeenCalledTimes(2);
  });

  it("a header click landing on the resize handle does not also trigger sort", () => {
    const sortable: ColumnDef = {
      id: "name",
      header: "Name",
      width: 220,
      render: (el, task) => void (el.textContent = task.name),
      getValue: (task) => task.name,
      compare: (a, c) => a.name.localeCompare(c.name),
    };
    b = boot([], {}, { columns: [sortable] });
    b.data.load([
      { id: "b", parentId: null, name: "bRoot", start: 0, end: 1 },
      { id: "a", parentId: null, name: "aRoot", start: 0, end: 1 },
    ]);
    b.dom.flushFrames();
    const before = [0, 1].map((r) => b?.rows.taskIdAt(r));
    const h = handle(b, 0);
    b.header.fire("click", { target: h });
    const after = [0, 1].map((r) => b?.rows.taskIdAt(r));
    expect(after).toEqual(before);
  });
});

describe("expand/collapse from the pane", () => {
  it("clicking the toggle dispatches `view/rowToggle`", () => {
    b = boot();
    b.data.load(treeTasks(1, 2));
    b.dom.flushFrames();
    const toggle = b.visibleRows()[0]?.find("sg-grid-toggle");
    expect(toggle?.textContent).toBe("▾");

    b.body.fire("click", { target: toggle });
    b.dom.flushFrames();
    expect(b.rows.rowCount()).toBe(1);
    expect(b.visibleRows()[0]?.find("sg-grid-toggle")?.textContent).toBe("▸");
  });

  it("clicking a cell does not toggle", () => {
    b = boot();
    b.data.load(treeTasks(1, 2));
    b.dom.flushFrames();
    const cell = b.visibleRows()[0]?.findAll("sg-grid-cell")[0];
    b.body.fire("click", { target: cell });
    expect(b.rows.rowCount()).toBe(3);
  });
});

describe("drop indicator", () => {
  it("draws and hides the drop indicator at the given depth", () => {
    b = boot();
    b.data.load(flatTasks(2));
    b.dom.flushFrames();
    expect(b.body.find("sg-grid-drop-indicator")).toBeUndefined();
    b.gantt.dispatch("view/dropIndicator", { y: 56, depth: 2 });
    const line = b.body.find("sg-grid-drop-indicator");
    expect(line?.style["top"]).toBe("56px");
    expect(line?.style["left"]).toBe("32px");
    b.gantt.dispatch("view/dropIndicator", null);
    expect(line?.style["display"]).toBe("none");
    // An unusable position hides the line rather than erroring.
    b.gantt.dispatch("view/dropIndicator", { y: Number.NaN, depth: 0 });
    expect(line?.style["display"]).toBe("none");
  });
});

// The grid row as a selection surface: `stargantt.grid` lets a selection-owning or focus-owning
// plugin reflect its state back onto `.sg-grid-row--selected` / `.sg-grid-row--focused`.
describe("selection and focus reflection", () => {
  it("`stargantt.grid` marks the reflected rows `sg-grid-row--selected`", () => {
    b = boot();
    b.data.load(flatTasks(3));
    b.dom.flushFrames();
    b.grid.setSelected(new Set(["t1"]));
    b.dom.flushFrames();
    const rows = b.visibleRows();
    expect(rows[0]?.classList.contains("sg-grid-row--selected")).toBe(false);
    expect(rows[1]?.classList.contains("sg-grid-row--selected")).toBe(true);
  });

  it("an empty set clears every selection mark", () => {
    b = boot();
    b.data.load(flatTasks(3));
    b.dom.flushFrames();
    b.grid.setSelected(new Set(["t0", "t1"]));
    b.dom.flushFrames();
    b.grid.setSelected(new Set());
    b.dom.flushFrames();
    expect(b.visibleRows().some((r) => r.classList.contains("sg-grid-row--selected"))).toBe(false);
  });

  it("a selection survives across a repaint (scroll, expand/collapse, sort)", () => {
    b = boot();
    b.data.load(flatTasks(1000));
    b.dom.flushFrames();
    b.grid.setSelected(new Set(["t3"]));
    b.dom.flushFrames();
    b.viewport.set({ ...b.viewport.get(), scrollTop: 100 });
    b.dom.flushFrames();
    b.viewport.set({ ...b.viewport.get(), scrollTop: 0 });
    b.dom.flushFrames();
    const row = b.visibleRows().find((r) => r.getAttribute("data-row-index") === "3");
    expect(row?.classList.contains("sg-grid-row--selected")).toBe(true);
  });

  // The reflection is immediate and repaints nothing, which is what lets a selection owner react
  // on `pointerdown` mid-gesture.
  it("marks the reflected rows before any frame runs", () => {
    b = boot();
    b.data.load(flatTasks(3));
    b.dom.flushFrames();
    b.grid.setSelected(new Set(["t1"]));
    const rows = b.visibleRows();
    expect(rows[0]?.classList.contains("sg-grid-row--selected")).toBe(false);
    expect(rows[1]?.classList.contains("sg-grid-row--selected")).toBe(true);
  });

  /**
   * A contributed cell's interactive child must survive the selection change its own
   * `pointerdown` triggers. A repaint would replace it — between `mousedown` and `mouseup`, so the
   * browser dispatches no `click` on it — hence the frame flush at the end: nothing may be pending
   * either.
   */
  it("leaves a contributed cell's children and their DOM identity untouched", () => {
    const column: ColumnDef = {
      id: "action",
      header: "Action",
      render(el, task) {
        const button = el.ownerDocument.createElement("button");
        button.className = "unit-open";
        button.textContent = `+${String(task.id)}`;
        el.appendChild(button);
      },
      getValue: (task) => task.id,
    };
    b = boot([probe((ctx) => ctx.contribute("grid/columns", column))]);
    b.data.load(flatTasks(3));
    b.dom.flushFrames();
    const cell = b.visibleRows()[1]?.findAll("sg-grid-cell")[4];
    const button = cell?.find("unit-open");
    expect(button).toBeDefined();

    b.grid.setSelected(new Set(["t1"]));
    expect(cell?.find("unit-open")).toBe(button);
    b.dom.flushFrames();
    expect(cell?.find("unit-open")).toBe(button);
    expect(button?.parentNode).toBe(cell);
    expect(b.visibleRows()[1]?.classList.contains("sg-grid-row--selected")).toBe(true);
  });

  it("marks the focused task's row with `.sg-grid-row--focused`", () => {
    b = boot();
    b.data.load(flatTasks(3));
    b.dom.flushFrames();
    b.grid.setFocused("t1");
    b.dom.flushFrames();
    const rows = b.visibleRows();
    expect(rows[0]?.classList.contains("sg-grid-row--focused")).toBe(false);
    expect(rows[1]?.classList.contains("sg-grid-row--focused")).toBe(true);
  });

  it("moves the focus mark when focus moves again", () => {
    b = boot();
    b.data.load(flatTasks(3));
    b.dom.flushFrames();
    b.grid.setFocused("t0");
    b.dom.flushFrames();
    b.grid.setFocused("t2");
    b.dom.flushFrames();
    const rows = b.visibleRows();
    expect(rows[0]?.classList.contains("sg-grid-row--focused")).toBe(false);
    expect(rows[2]?.classList.contains("sg-grid-row--focused")).toBe(true);
  });

  it("clears the focus mark when focus clears (`setFocused(undefined)`)", () => {
    b = boot();
    b.data.load(flatTasks(1));
    b.dom.flushFrames();
    b.grid.setFocused("t0");
    b.dom.flushFrames();
    b.grid.setFocused(undefined);
    b.dom.flushFrames();
    expect(b.visibleRows()[0]?.classList.contains("sg-grid-row--focused")).toBe(false);
  });

  // Like the selection mark, in place and with no repaint of its own; a cell's children keep their
  // identity across the call.
  it("marks the focused row before any frame runs, without re-rendering the cells", () => {
    const column: ColumnDef = {
      id: "action",
      header: "Action",
      render(el, task) {
        const button = el.ownerDocument.createElement("button");
        button.className = "unit-open";
        button.textContent = `+${String(task.id)}`;
        el.appendChild(button);
      },
      getValue: (task) => task.id,
    };
    b = boot([probe((ctx) => ctx.contribute("grid/columns", column))]);
    b.data.load(flatTasks(3));
    b.dom.flushFrames();
    const cell = b.visibleRows()[1]?.findAll("sg-grid-cell")[4];
    const button = cell?.find("unit-open");
    expect(button).toBeDefined();

    b.grid.setFocused("t1");
    expect(b.visibleRows()[1]?.classList.contains("sg-grid-row--focused")).toBe(true);
    b.dom.flushFrames();
    expect(cell?.find("unit-open")).toBe(button);
    expect(button?.parentNode).toBe(cell);
  });
});

describe("disposal", () => {
  it("removes the DOM it owns and every listener it registered", () => {
    b = boot();
    b.data.load(flatTasks(5));
    b.dom.flushFrames();
    // Two document-level `pointermove` listeners of the grid's own: the header-boundary column
    // resize drag, and the row-press tracking.
    expect(b.dom.document.listenerCount("pointermove")).toBe(2);
    expect(b.body.listenerCount("click")).toBe(1);
    expect(b.header.listenerCount("click")).toBe(1);
    expect(b.header.listenerCount("pointerdown")).toBe(1);

    const { dom, body, header } = b;
    b.gantt.dispose();
    expect(body.listenerCount("click")).toBe(0);
    expect(body.listenerCount("dblclick")).toBe(0);
    expect(b.pane.listenerCount("wheel")).toBe(0);
    expect(b.pane.listenerCount("keydown")).toBe(0);
    expect(header.listenerCount("click")).toBe(0);
    expect(header.listenerCount("pointerdown")).toBe(0);
    expect(dom.document.listenerCount("pointermove")).toBe(0);
    expect(dom.document.listenerCount("pointerup")).toBe(0);

    b = { ...b, gantt: { ...b.gantt, dispose: () => {} } };
  });

  it("cancels a pending frame on dispose", () => {
    b = boot();
    b.data.load(flatTasks(5));
    expect(b.dom.pendingFrames()).toBe(1);
    const dom = b.dom;
    b.gantt.dispose();
    expect(dom.pendingFrames()).toBe(0);
    b = { ...b, gantt: { ...b.gantt, dispose: () => {} } };
  });
});
