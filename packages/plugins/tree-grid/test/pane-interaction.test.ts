/**
 * Interaction on the grid pane: F2 / double-click inline editing, the `view/editStart` command,
 * column sort cycling, header keyboard accessibility, the row pointer gestures
 * (`grid/rowPointerDown|Move|Up`), and the two context-menu events.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Task } from "@stargantt/plugin-data-store";
import { boot, flatTasks, probe, treeTasks } from "./_boot";
import type { Booted } from "./_boot";
import type { FakeElement, FakeInput } from "./_harness/index";
import type { ColumnDef } from "../src/types";

let b: Booted | undefined;
afterEach(() => {
  b?.gantt.dispose();
  b?.dom.restore();
  b = undefined;
});

describe("inline edit (F2 / double-click → `task/update`)", () => {
  function openEditor(booted: Booted): FakeInput {
    const cell = booted.visibleRows()[0]?.findAll("sg-grid-cell")[0];
    booted.body.fire("dblclick", { target: cell });
    const editor = booted.editor();
    if (editor === undefined) throw new Error("editor was not opened");
    return editor;
  }

  it("double-click opens an editor seeded with the task name", () => {
    b = boot();
    b.data.load(flatTasks(3));
    b.dom.flushFrames();
    const editor = openEditor(b);
    expect(editor.value).toBe("t0");
    expect(editor.focused).toBe(true);
  });

  it("Enter commits through the `task/update` command", () => {
    b = boot();
    b.data.load(flatTasks(3));
    b.dom.flushFrames();
    const editor = openEditor(b);
    editor.value = "renamed";
    editor.fire("keydown", { key: "Enter" });
    expect(b.data.getTask("t0")?.name).toBe("renamed");
    b.dom.flushFrames();
    expect(b.visibleRows()[0]?.findAll("sg-grid-cell")[0]?.textContent).toBe("renamed");
    expect(b.editor()).toBeUndefined();
  });

  it("blur commits too", () => {
    b = boot();
    b.data.load(flatTasks(1));
    b.dom.flushFrames();
    const editor = openEditor(b);
    editor.value = "blurred";
    editor.fire("blur", {});
    expect(b.data.getTask("t0")?.name).toBe("blurred");
  });

  it("Escape cancels without dispatching", () => {
    b = boot();
    b.data.load(flatTasks(1));
    b.dom.flushFrames();
    const editor = openEditor(b);
    editor.value = "discarded";
    editor.fire("keydown", { key: "Escape" });
    expect(b.data.getTask("t0")?.name).toBe("t0");
    expect(b.editor()).toBeUndefined();
  });

  it("F2 on a row opens the same editor", () => {
    b = boot();
    b.data.load(flatTasks(2));
    b.dom.flushFrames();
    b.pane.fire("keydown", { key: "F2", target: b.visibleRows()[1] });
    expect(b.editor()?.value).toBe("t1");
  });

  it("F2 reaches the row last pointed at, with focus on the pane itself", () => {
    b = boot();
    b.data.load(flatTasks(3));
    b.dom.flushFrames();
    // The pane must be a keyboard target at all, or the F2 binding is unreachable.
    expect(b.pane.getAttribute("tabindex")).toBe("0");

    b.body.fire("click", { target: b.visibleRows()[1] });
    b.pane.fire("keydown", { key: "F2", target: b.pane });
    expect(b.editor()?.value).toBe("t1");
  });

  it("F2 with no row ever pointed at does nothing", () => {
    b = boot();
    b.data.load(flatTasks(3));
    b.dom.flushFrames();
    b.pane.fire("keydown", { key: "F2", target: b.pane });
    expect(b.editor()).toBeUndefined();
  });

  it("an open editor survives an unrelated repaint", () => {
    b = boot();
    b.data.load(flatTasks(3));
    b.dom.flushFrames();
    const editor = openEditor(b);
    editor.value = "typed";

    // A repaint used to clear the cell and detach the focused editor — element removal fires no
    // `blur`, so the typed value vanished silently.
    b.data.load(flatTasks(3));
    b.dom.flushFrames();
    expect(b.editor()).toBe(editor);
    expect(b.editor()?.value).toBe("typed");
  });

  it("commits an editor that a repaint would otherwise have detached", () => {
    b = boot();
    b.data.load(treeTasks(1, 2));
    b.dom.flushFrames();
    const cell = b.visibleRows()[1]?.findAll("sg-grid-cell")[0];
    b.body.fire("dblclick", { target: cell });
    const editor = b.editor();
    if (editor === undefined) throw new Error("editor was not opened");
    editor.value = "renamed";

    // Collapsing takes the edited row out of the view entirely.
    b.gantt.dispatch("view/rowToggle", { id: "p0", expanded: false });
    b.dom.flushFrames();
    expect(b.data.getTask("p0c0")?.name).toBe("renamed");
    expect(b.editor()).toBeUndefined();
  });

  it("double-click on the toggle does not open the editor", () => {
    b = boot();
    b.data.load(treeTasks(1, 1));
    b.dom.flushFrames();
    b.body.fire("dblclick", { target: b.visibleRows()[0]?.find("sg-grid-toggle") });
    expect(b.editor()).toBeUndefined();
  });
});

// The public path into the same inline-edit F2 / double-click start, so a keyboard-accessibility
// plugin's own Enter binding can reach it.
describe("`view/editStart` command", () => {
  it("starts editing the name cell of a visible row", () => {
    b = boot();
    b.data.load(flatTasks(3));
    b.dom.flushFrames();
    b.gantt.dispatch("view/editStart", { id: "t1" });
    const editor = b.editor();
    expect(editor?.value).toBe("t1");
    expect(editor?.focused).toBe(true);
  });

  it("commits through `task/update` like any other edit", () => {
    b = boot();
    b.data.load(flatTasks(2));
    b.dom.flushFrames();
    b.gantt.dispatch("view/editStart", { id: "t0" });
    const editor = b.editor();
    if (editor === undefined) throw new Error("editor was not opened");
    editor.value = "renamed";
    editor.fire("keydown", { key: "Enter" });
    expect(b.data.getTask("t0")?.name).toBe("renamed");
  });

  it("does nothing for an unknown id", () => {
    b = boot();
    b.data.load(flatTasks(2));
    b.dom.flushFrames();
    b.gantt.dispatch("view/editStart", { id: "nope" });
    expect(b.editor()).toBeUndefined();
  });

  it("does nothing for a row hidden inside a collapsed branch", () => {
    b = boot();
    b.data.load(treeTasks(1, 2));
    b.dom.flushFrames();
    b.gantt.dispatch("view/rowToggle", { id: "p0", expanded: false });
    b.dom.flushFrames();
    b.gantt.dispatch("view/editStart", { id: "p0c0" });
    expect(b.editor()).toBeUndefined();
  });

  it("does nothing for a visible row scrolled outside the viewport", () => {
    b = boot();
    b.data.load(flatTasks(1000));
    b.dom.flushFrames();
    // Row 500 exists in the row model but is far below the 300px window, so no cell of it is
    // materialized and the command declines silently.
    b.gantt.dispatch("view/editStart", { id: "t500" });
    expect(b.editor()).toBeUndefined();
  });
});

describe("column sort", () => {
  const nameCompare = (a: Task, b2: Task): number => a.name.localeCompare(b2.name);

  function sortableColumn(id = "name"): ColumnDef {
    return {
      id,
      header: id.toUpperCase(),
      width: 100,
      render: (el, task) => void (el.textContent = task.name),
      getValue: (task) => task.name,
      compare: nameCompare,
    };
  }

  function plainColumn(id: string): ColumnDef {
    return {
      id,
      header: id.toUpperCase(),
      width: 60,
      render: (el, task) => void (el.textContent = task.name),
      getValue: (task) => task.name,
    };
  }

  const treeData: Partial<Task>[] = [
    { id: "b", parentId: null, name: "bRoot", start: 0, end: 1 },
    { id: "a", parentId: null, name: "aRoot", start: 0, end: 1 },
    { id: "b2", parentId: "b", name: "b2", start: 0, end: 1 },
    { id: "b1", parentId: "b", name: "b1", start: 0, end: 1 },
    { id: "a2", parentId: "a", name: "a2", start: 0, end: 1 },
    { id: "a1", parentId: "a", name: "a1", start: 0, end: 1 },
  ];

  function clickHeader(booted: Booted, columnIndex: number): void {
    const cell = booted.header.findAll("sg-grid-cell sg-grid-header-cell")[columnIndex];
    booted.header.fire("click", { target: cell });
  }

  it("first click sorts ascending", () => {
    b = boot([], {}, { columns: [sortableColumn()] });
    b.data.load(treeData);
    b.dom.flushFrames();
    clickHeader(b, 0);
    expect(b.rows.taskIdAt(0)).toBe("a");
  });

  it("preserves the tree structure — children stay under their reordered parent", () => {
    b = boot([], {}, { columns: [sortableColumn()] });
    b.data.load(treeData);
    b.dom.flushFrames();
    clickHeader(b, 0);
    const order = [0, 1, 2, 3, 4, 5].map((r) => b?.rows.taskIdAt(r));
    expect(order).toEqual(["a", "a1", "a2", "b", "b1", "b2"]);
  });

  it("second click reverses to descending", () => {
    b = boot([], {}, { columns: [sortableColumn()] });
    b.data.load(treeData);
    b.dom.flushFrames();
    clickHeader(b, 0);
    clickHeader(b, 0);
    const order = [0, 1, 2, 3, 4, 5].map((r) => b?.rows.taskIdAt(r));
    expect(order).toEqual(["b", "b2", "b1", "a", "a2", "a1"]);
  });

  it("third click turns sorting off and restores store order", () => {
    b = boot([], {}, { columns: [sortableColumn()] });
    b.data.load(treeData);
    b.dom.flushFrames();
    clickHeader(b, 0);
    clickHeader(b, 0);
    clickHeader(b, 0);
    const order = [0, 1, 2, 3, 4, 5].map((r) => b?.rows.taskIdAt(r));
    expect(order).toEqual(["b", "b2", "b1", "a", "a2", "a1"]);
  });

  it("clicking a different column's header replaces the active sort", () => {
    b = boot([], {}, { columns: [sortableColumn("name"), sortableColumn("other")] });
    b.data.load(treeData);
    b.dom.flushFrames();
    clickHeader(b, 0);
    clickHeader(b, 0); // "name" descending
    clickHeader(b, 1); // switches to "other", fresh ascending
    const order = [0, 1, 2, 3, 4, 5].map((r) => b?.rows.taskIdAt(r));
    expect(order).toEqual(["a", "a1", "a2", "b", "b1", "b2"]);
  });

  it("a column without `compare` does not sort", () => {
    b = boot([], {}, { columns: [plainColumn("plain")] });
    b.data.load(treeData);
    b.dom.flushFrames();
    clickHeader(b, 0);
    const order = [0, 1, 2, 3, 4, 5].map((r) => b?.rows.taskIdAt(r));
    expect(order).toEqual(["b", "b2", "b1", "a", "a2", "a1"]);
  });

  it("does not mutate the store or dispatch anything (display order only)", () => {
    b = boot([], {}, { columns: [sortableColumn()] });
    b.data.load(treeData);
    b.dom.flushFrames();
    const dispatched = vi.fn();
    b.data.tasks.subscribe(dispatched);
    clickHeader(b, 0);
    expect(dispatched).not.toHaveBeenCalled();
    expect(b.data.getTask("b")?.name).toBe("bRoot");
  });

  it("announces each reorder through the rows store", () => {
    b = boot([], {}, { columns: [sortableColumn()] });
    b.data.load(treeData);
    b.dom.flushFrames();
    const seen = vi.fn();
    b.rows.rows.subscribe(seen);
    clickHeader(b, 0);
    expect(seen).toHaveBeenCalledTimes(1);
  });
});

// Header cells are keyboard-operable `columnheader`s: Enter/Space cycles sort, Alt+Arrow resizes,
// `aria-sort` reflects the active sort.
describe("header accessibility", () => {
  const sortable: ColumnDef = {
    id: "name",
    header: "Name",
    width: 100,
    render: (el, task) => void (el.textContent = task.name),
    getValue: (task) => task.name,
    compare: (a, b2) => a.name.localeCompare(b2.name),
  };

  function headerCell(booted: Booted, index = 0): FakeElement {
    const cell = booted.header.findAll("sg-grid-cell sg-grid-header-cell")[index];
    if (cell === undefined) throw new Error("header cell not found");
    return cell;
  }

  it("every header cell is `role=columnheader` and a tab stop", () => {
    b = boot();
    const headers = b.header.findAll("sg-grid-cell sg-grid-header-cell");
    expect(headers.length).toBeGreaterThan(0);
    for (const h of headers) {
      expect(h.getAttribute("role")).toBe("columnheader");
      expect(h.getAttribute("tabindex")).toBe("0");
    }
  });

  it("Enter cycles the sort exactly as a click does", () => {
    b = boot([], {}, { columns: [sortable] });
    b.data.load([
      { id: "b", parentId: null, name: "bRoot", start: 0, end: 1 },
      { id: "a", parentId: null, name: "aRoot", start: 0, end: 1 },
    ]);
    b.dom.flushFrames();
    const cell = headerCell(b);
    b.header.fire("keydown", { key: "Enter", target: cell, preventDefault: () => {} });
    expect(b.rows.taskIdAt(0)).toBe("a");
  });

  it("Space cycles the sort too", () => {
    b = boot([], {}, { columns: [sortable] });
    b.data.load([
      { id: "b", parentId: null, name: "bRoot", start: 0, end: 1 },
      { id: "a", parentId: null, name: "aRoot", start: 0, end: 1 },
    ]);
    b.dom.flushFrames();
    const cell = headerCell(b);
    b.header.fire("keydown", { key: " ", target: cell, preventDefault: () => {} });
    expect(b.rows.taskIdAt(0)).toBe("a");
  });

  it("is inert on a column without `compare`", () => {
    b = boot();
    const cell = headerCell(b); // the built-in `name` column carries no `compare`
    b.header.fire("keydown", { key: "Enter", target: cell, preventDefault: () => {} });
    expect(cell.getAttribute("aria-sort")).toBeNull();
  });

  it("`aria-sort` reflects each step of the cycle", () => {
    b = boot([], {}, { columns: [sortable] });
    b.data.load([{ id: "a", parentId: null, name: "a", start: 0, end: 1 }]);
    b.dom.flushFrames();
    const cell = headerCell(b);
    b.header.fire("keydown", { key: "Enter", target: cell, preventDefault: () => {} });
    expect(cell.getAttribute("aria-sort")).toBe("ascending");
    b.header.fire("keydown", { key: "Enter", target: cell, preventDefault: () => {} });
    expect(cell.getAttribute("aria-sort")).toBe("descending");
    b.header.fire("keydown", { key: "Enter", target: cell, preventDefault: () => {} });
    expect(cell.getAttribute("aria-sort")).toBe("none");
  });

  it("Alt+ArrowRight resizes the column, the same clamp the drag handle uses", () => {
    b = boot();
    const cell = headerCell(b);
    // The built-in `name` column declares `width: 220`; the keyboard step (16) is applied to that
    // tracked width, not a DOM measurement.
    b.header.fire("keydown", {
      key: "ArrowRight",
      altKey: true,
      target: cell,
      preventDefault: () => {},
    });
    expect(cell.style["width"]).toBe("236px");
  });

  it("accumulates across successive presses", () => {
    b = boot();
    const cell = headerCell(b);
    b.header.fire("keydown", {
      key: "ArrowRight",
      altKey: true,
      target: cell,
      preventDefault: () => {},
    });
    b.header.fire("keydown", {
      key: "ArrowRight",
      altKey: true,
      target: cell,
      preventDefault: () => {},
    });
    expect(cell.style["width"]).toBe("252px");
  });

  it("Alt+ArrowLeft resizes smaller, clamped at the usable minimum", () => {
    b = boot();
    const cell = headerCell(b);
    for (let i = 0; i < 30; i += 1) {
      b.header.fire("keydown", {
        key: "ArrowLeft",
        altKey: true,
        target: cell,
        preventDefault: () => {},
      });
    }
    expect(cell.style["width"]).toBe("40px");
  });

  it("announces a keyboard resize through the column-widths store, not the rows store", () => {
    b = boot();
    const widths = vi.fn();
    const rows = vi.fn();
    b.grid.columnWidths.subscribe(widths);
    b.rows.rows.subscribe(rows);
    const cell = headerCell(b);
    b.header.fire("keydown", {
      key: "ArrowRight",
      altKey: true,
      target: cell,
      preventDefault: () => {},
    });
    expect(widths).toHaveBeenCalledTimes(1);
    expect(rows).not.toHaveBeenCalled();
  });

  it("nudges a column that declares no width from its measured width", () => {
    const undeclared: ColumnDef = {
      id: "name",
      header: "Name",
      render: (el, task) => void (el.textContent = task.name),
      getValue: (task) => task.name,
    };
    b = boot([], {}, { columns: [undeclared] });
    const cell = headerCell(b);
    // Laid out at its content width, which the header cell measures: the first press nudges that
    // width rather than jumping the column to the resize floor.
    cell.rect = { left: 0, top: 0, width: 150, height: 44 };
    b.header.fire("keydown", {
      key: "ArrowRight",
      altKey: true,
      target: cell,
      preventDefault: () => {},
    });
    expect(cell.style["width"]).toBe("166px");
    b.header.fire("keydown", {
      key: "ArrowRight",
      altKey: true,
      target: cell,
      preventDefault: () => {},
    });
    expect(cell.style["width"]).toBe("182px");
  });

  it("a bare ArrowRight (no Alt) does not resize", () => {
    b = boot();
    const cell = headerCell(b);
    b.header.fire("keydown", { key: "ArrowRight", target: cell, preventDefault: () => {} });
    expect(cell.style["width"]).toBe("220px");
  });
});

// The grid row as a selection surface: `grid/rowPointerDown` is emitted for information only, and
// `stargantt.grid` lets a selection owner reflect its selection back onto the row.
describe("row pointer gestures and context menus", () => {
  it("emits `grid/rowPointerDown` with a flat payload on a row pointerdown", () => {
    b = boot();
    b.data.load(flatTasks(2));
    b.dom.flushFrames();
    const seen: unknown[] = [];
    b.gantt.on("grid/rowPointerDown", (e) => seen.push(e));
    const cell = b.visibleRows()[1]?.findAll("sg-grid-cell")[0];
    b.body.fire("pointerdown", {
      target: cell,
      ctrlKey: true,
      metaKey: false,
      shiftKey: false,
      button: 0,
    });
    expect(seen).toEqual([
      {
        id: "t1",
        row: 1,
        ctrlKey: true,
        metaKey: false,
        shiftKey: false,
        button: 0,
        // The press also carries its pointer identity and position, which a synthetic event leaves
        // out — they read as 0 rather than as NaN.
        pointerId: 0,
        x: 0,
        y: 0,
        clientX: 0,
        clientY: 0,
      },
    ]);
  });

  // The payload carries every button, unfiltered, so a consumer (e.g. an edit-dialog's
  // double-activation guard) can tell a right-press from a left one.
  it("carries `button` off the originating pointer event, unfiltered", () => {
    b = boot();
    b.data.load(flatTasks(2));
    b.dom.flushFrames();
    const seen: unknown[] = [];
    b.gantt.on("grid/rowPointerDown", (e) => seen.push(e));
    const cell = b.visibleRows()[1]?.findAll("sg-grid-cell")[0];
    b.body.fire("pointerdown", {
      target: cell,
      ctrlKey: false,
      metaKey: false,
      shiftKey: false,
      button: 2,
    });
    expect(seen).toEqual([
      {
        id: "t1",
        row: 1,
        ctrlKey: false,
        metaKey: false,
        shiftKey: false,
        button: 2,
        pointerId: 0,
        x: 0,
        y: 0,
        clientX: 0,
        clientY: 0,
      },
    ]);
  });

  // The press is followed through: moves and exactly one end event, both filtered to the captured
  // pointer.
  it("follows a captured row press with moves and one end event", () => {
    b = boot();
    b.data.load(flatTasks(2));
    b.dom.flushFrames();
    const moves: unknown[] = [];
    const ups: unknown[] = [];
    b.gantt.on("grid/rowPointerMove", (e) => moves.push(e));
    b.gantt.on("grid/rowPointerUp", (e) => ups.push(e));
    const cell = b.visibleRows()[1]?.findAll("sg-grid-cell")[0];
    b.body.fire("pointerdown", { target: cell, button: 0, pointerId: 3 });
    b.dom.document.fire("pointermove", { pointerId: 3, clientX: 10, clientY: 40 });
    // A second pointer's move is not this gesture's and is not published.
    b.dom.document.fire("pointermove", { pointerId: 9, clientX: 10, clientY: 40 });
    b.dom.document.fire("pointerup", { pointerId: 3, clientX: 10, clientY: 40 });
    // After the end, the capture is gone: a further move publishes nothing.
    b.dom.document.fire("pointermove", { pointerId: 3, clientX: 10, clientY: 50 });
    expect(moves).toHaveLength(1);
    expect(ups).toHaveLength(1);
    expect((ups[0] as { pointerId: number; cancelled: boolean }).pointerId).toBe(3);
    expect((ups[0] as { cancelled: boolean }).cancelled).toBe(false);
  });

  it("reports a cancelled capture as the same end event", () => {
    b = boot();
    b.data.load(flatTasks(2));
    b.dom.flushFrames();
    const ups: { cancelled: boolean }[] = [];
    b.gantt.on("grid/rowPointerUp", (e) => ups.push(e));
    const cell = b.visibleRows()[1]?.findAll("sg-grid-cell")[0];
    b.body.fire("pointerdown", { target: cell, button: 0, pointerId: 3 });
    b.dom.document.fire("pointercancel", { pointerId: 3 });
    expect(ups).toEqual([{ pointerId: 3, x: 0, y: 0, clientX: 0, clientY: 0, cancelled: true }]);
  });

  it("emits `grid/rowContextMenu` with pane-local coordinates on a row contextmenu, and no background event", () => {
    b = boot();
    b.data.load(flatTasks(2));
    b.dom.flushFrames();
    const rowSeen: unknown[] = [];
    const backgroundSeen: unknown[] = [];
    b.gantt.on("grid/rowContextMenu", (e) => rowSeen.push(e));
    b.gantt.on("grid/backgroundContextMenu", (e) => backgroundSeen.push(e));
    // The pane sits away from the document origin, so the payload must be pane-relative.
    b.pane.rect = { left: 12, top: 30, width: 200, height: 400 };
    const cell = b.visibleRows()[1]?.findAll("sg-grid-cell")[0];
    b.body.fire("contextmenu", { target: cell, clientX: 40, clientY: 55 });
    expect(rowSeen).toEqual([{ id: "t1", row: 1, x: 28, y: 25 }]);
    expect(backgroundSeen).toHaveLength(0);
  });

  it("does not emit a context menu for the expand toggle, and suppresses nothing", () => {
    b = boot();
    b.data.load(treeTasks(1, 1));
    b.dom.flushFrames();
    const rowSeen: unknown[] = [];
    const backgroundSeen: unknown[] = [];
    b.gantt.on("grid/rowContextMenu", (e) => rowSeen.push(e));
    b.gantt.on("grid/backgroundContextMenu", (e) => backgroundSeen.push(e));
    const toggle = b.visibleRows()[0]?.find("sg-grid-toggle");
    let prevented = false;
    b.body.fire("contextmenu", {
      target: toggle,
      clientX: 0,
      clientY: 0,
      preventDefault: () => void (prevented = true),
    });
    expect(rowSeen).toHaveLength(0);
    expect(backgroundSeen).toHaveLength(0);
    expect(prevented).toBe(false);
  });

  // A contextmenu request that lands inside the grid body but resolves no row (the blank area
  // below the last row) is the background surface, not the row one.
  it("emits `grid/backgroundContextMenu` with pane-local coordinates for the body's blank area, and no row event", () => {
    b = boot();
    b.data.load(flatTasks(2));
    b.dom.flushFrames();
    const rowSeen: unknown[] = [];
    const backgroundSeen: unknown[] = [];
    b.gantt.on("grid/rowContextMenu", (e) => rowSeen.push(e));
    b.gantt.on("grid/backgroundContextMenu", (e) => backgroundSeen.push(e));
    b.pane.rect = { left: 12, top: 30, width: 200, height: 400 };
    // The body element itself, below the last row: `locateRow` walks up and finds no
    // `data-row-index` ancestor.
    let prevented = false;
    b.body.fire("contextmenu", {
      target: b.body,
      clientX: 40,
      clientY: 55,
      preventDefault: () => void (prevented = true),
    });
    expect(backgroundSeen).toEqual([{ x: 28, y: 25 }]);
    expect(rowSeen).toHaveLength(0);
    // The grid neither opens a menu nor suppresses the browser's own: publishing the background
    // event must not preventDefault the press.
    expect(prevented).toBe(false);
  });

  it("emits neither context-menu event for a contextmenu on the grid header", () => {
    b = boot();
    b.data.load(flatTasks(2));
    b.dom.flushFrames();
    const rowSeen: unknown[] = [];
    const backgroundSeen: unknown[] = [];
    b.gantt.on("grid/rowContextMenu", (e) => rowSeen.push(e));
    b.gantt.on("grid/backgroundContextMenu", (e) => backgroundSeen.push(e));
    let prevented = false;
    b.header.fire("contextmenu", {
      target: b.header,
      clientX: 20,
      clientY: 10,
      preventDefault: () => void (prevented = true),
    });
    expect(rowSeen).toHaveLength(0);
    expect(backgroundSeen).toHaveLength(0);
    expect(prevented).toBe(false);
  });

  it("does not emit for a pointerdown on the expand toggle", () => {
    b = boot();
    b.data.load(treeTasks(1, 1));
    b.dom.flushFrames();
    const seen: unknown[] = [];
    b.gantt.on("grid/rowPointerDown", (e) => seen.push(e));
    const toggle = b.visibleRows()[0]?.find("sg-grid-toggle");
    b.body.fire("pointerdown", { target: toggle, ctrlKey: false, metaKey: false, shiftKey: false });
    expect(seen).toHaveLength(0);
  });
});
