/**
 * The outline-editing commands: `view/expandToLevel`, `view/rowIndent` / `view/rowOutdent`, and
 * `view/rowInsert`.
 *
 * docs/specs/plugins/tree-grid.md § Commands.
 *
 * `view/rowInsert`'s duration rule asks the composed timeline for one grid cell. In this harness
 * the timeline is a hard dependency the boot helper's view stand-in always provides — its
 * `gridCellAt(t)` answers `{ start: t, end: t + 86_400_000 }` (one day) and its `xToT(x)` is the
 * identity — so there is no "no time axis" state to compose here; the pure fallback branches
 * (an axis that answers no cell at all) are covered directly against `noRefInsertDates` in
 * `outline.test.ts`.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Task } from "@stargantt/plugin-data-store";
import { boot, flatTasks, treeTasks } from "./_boot";
import type { Booted } from "./_boot";

/** One day in milliseconds — also the stand-in axis's fixed grid-cell length. */
const MS_DAY = 86_400_000;

let booted: Booted | undefined;

afterEach(() => {
  booted?.gantt.dispose();
  booted?.dom.restore();
  booted = undefined;
});

/** Boots with the given tasks, frames flushed so the pane is painted. */
function withConfig(tasks: Partial<Task>[]): Booted {
  const b = boot();
  booted = b;
  b.data.load(tasks);
  b.dom.flushFrames();
  return b;
}

describe("`view/expandToLevel`", () => {
  it("collapses everything below the named depth and expands above it", () => {
    const b = withConfig(treeTasks(2, 2));
    b.gantt.dispatch("view/expandToLevel", { level: 0 });
    expect(b.rows.rowCount()).toBe(2);
    b.gantt.dispatch("view/expandToLevel", { level: 1 });
    expect(b.rows.rowCount()).toBe(6);
  });

  it("ignores an unusable level", () => {
    const b = withConfig(treeTasks(1, 1));
    const seen = vi.fn();
    b.rows.rows.subscribe(seen);
    b.gantt.dispatch("view/expandToLevel", { level: Number.NaN });
    b.gantt.dispatch("view/expandToLevel", { level: -1 });
    expect(seen).not.toHaveBeenCalled();
    expect(b.rows.rowCount()).toBe(2);
  });
});

describe("`view/rowIndent` / `view/rowOutdent`", () => {
  it("indents under the previous sibling through an ordinary update", () => {
    const b = withConfig(flatTasks(2));
    b.gantt.dispatch("view/rowIndent", { id: "t1" });
    expect(b.data.getTask("t1")?.parentId).toBe("t0");
    expect(b.rows.rowOf("t1")).toBe(1);
  });

  it("outdents onto the grandparent", () => {
    const b = withConfig(treeTasks(1, 1));
    b.gantt.dispatch("view/rowOutdent", { id: "p0c0" });
    expect(b.data.getTask("p0c0")?.parentId).toBeNull();
  });

  it("no-ops on impossible moves", () => {
    const b = withConfig(flatTasks(2));
    b.gantt.dispatch("view/rowIndent", { id: "t0" }); // first sibling
    b.gantt.dispatch("view/rowOutdent", { id: "t0" }); // already a root
    expect(b.data.getTask("t0")?.parentId).toBeNull();
  });

  it("binds Tab / Shift+Tab on the pane only when `outlineEditing` is on", () => {
    const b = boot([], {}, { outlineEditing: true });
    booted = b;
    b.data.load(flatTasks(2));
    b.dom.flushFrames();
    const row1 = b.visibleRows()[1];
    b.pane.fire("keydown", { key: "Tab", shiftKey: false, target: row1, preventDefault: vi.fn() });
    expect(b.data.getTask("t1")?.parentId).toBe("t0");
    b.pane.fire("keydown", { key: "Tab", shiftKey: true, target: b.visibleRows()[1], preventDefault: vi.fn() });
    expect(b.data.getTask("t1")?.parentId).toBeNull();
  });

  // Tab is captured on the pane and rows only, never inside an open inline editor.
  it("leaves Tab alone inside an open inline editor", () => {
    const b = boot([], {}, { outlineEditing: true });
    booted = b;
    b.data.load(flatTasks(2));
    b.dom.flushFrames();
    b.gantt.dispatch("view/editStart", { id: "t1" });
    b.dom.flushFrames();
    const editor = b.visibleRows()[1]?.find("sg-grid-editor");
    expect(editor).toBeDefined();
    const preventDefault = vi.fn();
    b.pane.fire("keydown", { key: "Tab", shiftKey: false, target: editor, preventDefault });
    expect(preventDefault).not.toHaveBeenCalled();
    expect(b.data.getTask("t1")?.parentId).toBeNull();
  });

  // The keyboard exit: Escape parks the focus on the pane container and hands Tab back to the
  // browser for that one step, so the Tab-capturing pane is never a keyboard trap (WCAG 2.1.2).
  it("Escape leaves the pane and releases Tab until the focus re-enters a row", () => {
    const b = boot([], {}, { outlineEditing: true });
    booted = b;
    b.data.load(flatTasks(2));
    b.dom.flushFrames();
    const row1 = b.visibleRows()[1];
    b.pane.fire("keydown", { key: "Escape", target: row1, preventDefault: vi.fn() });
    expect(b.dom.document.activeElement).toBe(b.pane);

    // Tab now moves the browser focus instead of indenting: nothing is claimed, nothing is edited.
    const preventDefault = vi.fn();
    b.pane.fire("keydown", { key: "Tab", shiftKey: false, target: b.pane, preventDefault });
    expect(preventDefault).not.toHaveBeenCalled();
    expect(b.data.getTask("t1")?.parentId).toBeNull();

    // Focus landing on a row again re-arms the outline binding.
    b.pane.fire("focusin", { target: b.visibleRows()[1] });
    b.pane.fire("keydown", {
      key: "Tab",
      shiftKey: false,
      target: b.visibleRows()[1],
      preventDefault: vi.fn(),
    });
    expect(b.data.getTask("t1")?.parentId).toBe("t0");
  });

  it("leaves an open editor's Escape alone", () => {
    const b = boot([], {}, { outlineEditing: true });
    booted = b;
    b.data.load(flatTasks(2));
    b.dom.flushFrames();
    b.gantt.dispatch("view/editStart", { id: "t1" });
    b.dom.flushFrames();
    const editor = b.visibleRows()[1]?.find("sg-grid-editor");
    expect(editor).toBeDefined();
    b.pane.fire("keydown", { key: "Escape", target: editor, preventDefault: vi.fn() });
    // The pane did not steal the focus: cancelling the edit is the editor's own Escape.
    expect(b.dom.document.activeElement).not.toBe(b.pane);
  });

  it("leaves Tab alone by default", () => {
    const b = withConfig(flatTasks(2));
    b.pane.fire("keydown", {
      key: "Tab",
      shiftKey: false,
      target: b.visibleRows()[1],
      preventDefault: vi.fn(),
    });
    expect(b.data.getTask("t1")?.parentId).toBeNull();
  });
});

describe("`view/rowInsert`", () => {
  it("inserts below the reference row, starting where it starts", () => {
    const b = withConfig(flatTasks(2));
    b.gantt.dispatch("view/rowInsert", { id: "t0", position: "below", name: "inserted" });
    expect(b.rows.rowCount()).toBe(3);
    expect(b.rows.taskIdAt(1)).not.toBe("t1");
    const inserted = b.data.getTask(b.rows.taskIdAt(1) as string);
    expect(inserted?.name).toBe("inserted");
    expect(inserted?.start).toBe(b.data.getTask("t0")?.start);
  });

  it("inserts above and as child, defaulting the name from the catalog", () => {
    const b = withConfig(treeTasks(1, 1));
    b.gantt.dispatch("view/rowInsert", { id: "p0c0", position: "above" });
    expect(b.data.getTask(b.rows.taskIdAt(1) as string)?.name).toBe("New task");
    b.gantt.dispatch("view/rowInsert", { id: "p0", position: "child" });
    expect(b.rows.rowCount()).toBe(4);
  });

  // An omitted or unusable position means "under this task", not "after it".
  it("defaults to a child of the reference task", () => {
    const b = withConfig(flatTasks(2));
    b.gantt.dispatch("view/rowInsert", { id: "t0" });
    const inserted = b.data.getTask(b.rows.taskIdAt(1) as string);
    expect(inserted?.parentId).toBe("t0");
    b.gantt.dispatch("view/rowInsert", { id: "t1", position: "beside" as never });
    expect(b.data.getTask(b.rows.taskIdAt(3) as string)?.parentId).toBe("t1");
  });

  // A "child" insert under a task with no children promotes it to a summary, whose dates roll up
  // from its children: the new child inherits the reference's own span rather than one grid cell,
  // or the insert would silently redate a month-long task down to a single day.
  it("gives a new child of a childless task that task's own span (the promotion case)", () => {
    const b = withConfig(flatTasks(1));
    b.gantt.dispatch("view/rowInsert", { id: "t0" });
    const inserted = b.data.getTask(b.rows.taskIdAt(1) as string);
    expect(inserted?.start).toBe(0);
    expect(inserted?.end).toBe(MS_DAY); // `flatTasks`' own one-day span, copied over
  });

  it("gives a new child of an already-summary task one grid cell of the stand-in axis", () => {
    const b = withConfig([
      { id: "t0", parentId: null, name: "t0", start: 0, end: MS_DAY, type: "summary" },
      { id: "k", parentId: "t0", name: "k", start: 0, end: MS_DAY },
    ]);
    // `t0` already has a child, so the promotion rule does not apply: `view/rowInsert` asks the
    // stand-in axis for one grid cell instead, which is one day long.
    b.gantt.dispatch("view/rowInsert", { id: "t0" });
    const inserted = b.data.getTask(b.rows.taskIdAt(2) as string);
    expect(inserted?.start).toBe(0);
    expect(inserted?.end).toBe(MS_DAY);
  });

  it("gives a child inserted under a leaf that leaf's whole span", () => {
    const b = withConfig([{ id: "t0", parentId: null, name: "t0", start: 0, end: 30 * MS_DAY }]);
    b.gantt.dispatch("view/rowInsert", { id: "t0" });
    const inserted = b.data.getTask(b.rows.taskIdAt(1) as string);
    expect(inserted?.start).toBe(0);
    expect(inserted?.end).toBe(30 * MS_DAY);
  });

  // A child added under a collapsed row would be created out of sight, so the insert expands its
  // parent.
  it("expands a collapsed parent so the inserted row is visible", () => {
    const b = withConfig(treeTasks(1, 1));
    b.gantt.dispatch("view/rowToggle", { id: "p0", expanded: false });
    expect(b.rows.rowCount()).toBe(1);
    b.gantt.dispatch("view/rowInsert", { id: "p0" });
    // Both the pre-existing child and the new one are on screen again.
    expect(b.rows.isExpanded("p0")).toBe(true);
    expect(b.rows.rowCount()).toBe(3);
  });

  it("appends at the root level with no reference, and ignores an unknown one", () => {
    const b = withConfig(flatTasks(1));
    b.gantt.dispatch("view/rowInsert", {});
    expect(b.rows.rowCount()).toBe(2);
    b.gantt.dispatch("view/rowInsert", { id: "missing" });
    expect(b.rows.rowCount()).toBe(2);
  });

  // A no-`id` insert used to carry no dates at all, which the store defaulted to the epoch (a
  // zero-length task); it is dated instead, the same way a no-reference insert always has been.
  describe("no-reference dating", () => {
    it("dates a no-id insert like a `below` insert on the current last root task", () => {
      const b = withConfig([
        { id: "t0", parentId: null, name: "t0", start: 0, end: MS_DAY },
        { id: "t1", parentId: null, name: "t1", start: 2 * MS_DAY, end: 3 * MS_DAY },
      ]);
      b.gantt.dispatch("view/rowInsert", {});
      expect(b.rows.rowCount()).toBe(3);
      const inserted = b.data.getTask(b.rows.taskIdAt(2) as string);
      expect(inserted?.parentId).toBeNull();
      // The stand-in axis's grid cell is exactly one day long, so this lands at the same offsets
      // the one-day fallback would.
      expect(inserted?.start).toBe(2 * MS_DAY);
      expect(inserted?.end).toBe(3 * MS_DAY);
    });

    it("fills the stand-in axis's grid cell at now for a no-id insert on an empty store", () => {
      const b = withConfig([]);
      const before = Date.now();
      b.gantt.dispatch("view/rowInsert", {});
      const after = Date.now();
      expect(b.rows.rowCount()).toBe(1);
      const inserted = b.data.getTask(b.rows.taskIdAt(0) as string);
      // The stand-in's `gridCellAt(t)` answers `{ start: t, end: t + MS_DAY }`, so the inserted
      // start is exactly the sampled instant — bracketed rather than pinned, since the command
      // reads `Date.now()` itself.
      expect(inserted?.start).toBeGreaterThanOrEqual(before);
      expect(inserted?.start).toBeLessThanOrEqual(after);
      expect(inserted?.end).toBe((inserted?.start ?? 0) + MS_DAY);
    });

    // A host-configured future axis origin, and the day-floor fallback of an axis that answers no
    // cell at all, are both pure properties of `noRefInsertDates` and are exercised directly
    // against it in `outline.test.ts` — the stand-in axis here always answers a cell, and its
    // origin is always the epoch, so neither state is reachable through this harness.
  });
});
