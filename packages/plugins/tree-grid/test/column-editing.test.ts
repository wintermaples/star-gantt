/**
 * Per-column editing: `ColumnDef.getValue` / `setValue?` / `editable?` / `editor?`, and
 * `view/editStart`'s `columnId?`.
 *
 * docs/specs/plugins/tree-grid.md § Config (`ColumnDef`), § Commands (`view/editStart`)
 */
import type { Task } from "@stargantt/plugin-data-store";
import { afterEach, describe, expect, it } from "vitest";
import { dateEditor } from "../src/index";
import type { ColumnDef } from "../src/types";
import { boot, flatTasks, probe } from "./_boot";
import type { Booted } from "./_boot";
import type { FakeElement } from "./_harness/index";

let booted: Booted | undefined;

afterEach(() => {
  booted?.gantt.dispose();
  booted?.dom.restore();
  booted = undefined;
});

const DATED: Partial<Task>[] = [
  { id: "t0", parentId: null, name: "t0", start: 0, end: 86_400_000, progress: 0.25 },
];

/** A read-only column: `getValue` only, no `setValue`. */
function readOnlyColumn(id: string): ColumnDef {
  return {
    id,
    header: id.toUpperCase(),
    width: 60,
    render: (el, task) => void (el.textContent = task.name),
    getValue: (task) => task.name,
  };
}

/** An editable column backed by `progress`, via the shared plain-text input. */
function progressColumn(id = "progress", editable?: boolean): ColumnDef {
  const def: ColumnDef = {
    id,
    header: id.toUpperCase(),
    width: 60,
    render: (el, task) => void (el.textContent = String(task.progress)),
    getValue: (task) => task.progress,
    setValue: (task, value) => {
      (task as Task).progress = Number(value);
    },
  };
  return editable === undefined ? def : { ...def, editable };
}

/** A custom-editor column: a single button that commits `true`, plus one that cancels. */
function customColumn(id = "flag"): ColumnDef {
  return {
    id,
    header: id.toUpperCase(),
    width: 60,
    render: (el) => void (el.textContent = ""),
    getValue: (task) => task.progress,
    setValue: (task, value) => {
      (task as Task).progress = value === true ? 1 : 0;
    },
    editor: (el, initialValue, done) => {
      const doc = el.ownerDocument;
      const commitBtn = doc.createElement("button");
      commitBtn.className = "test-commit";
      el.appendChild(commitBtn);
      commitBtn.addEventListener("click", () => done.commit(true));

      const cancelBtn = doc.createElement("button");
      cancelBtn.className = "test-cancel";
      el.appendChild(cancelBtn);
      cancelBtn.addEventListener("click", () => done.cancel());

      const seedBtn = doc.createElement("button");
      seedBtn.className = "test-seed";
      seedBtn.setAttribute("data-initial", JSON.stringify(initialValue ?? null));
      el.appendChild(seedBtn);
    },
  };
}

describe("editability", () => {
  it("a column with `getValue` only stays read-only: `view/editStart` is a no-op", () => {
    booted = boot([], {}, { columns: [readOnlyColumn("name")] });
    booted.data.load(DATED);
    booted.dom.flushFrames();
    booted.gantt.dispatch("view/editStart", { id: "t0" });
    expect(booted.editor()).toBeUndefined();
  });

  it("`setValue` present makes a column editable by default", () => {
    booted = boot([], {}, { columns: [progressColumn()] });
    booted.data.load(DATED);
    booted.dom.flushFrames();
    booted.gantt.dispatch("view/editStart", { id: "t0" });
    expect(booted.editor()?.value).toBe("0.25");
  });

  it("`editable: false` keeps a column with `setValue` read-only", () => {
    booted = boot([], {}, { columns: [progressColumn("progress", false)] });
    booted.data.load(DATED);
    booted.dom.flushFrames();
    booted.gantt.dispatch("view/editStart", { id: "t0" });
    expect(booted.editor()).toBeUndefined();
  });

  it("`editable: true` without `setValue` has no effect — still not editable", () => {
    const col: ColumnDef = { ...readOnlyColumn("name"), editable: true };
    booted = boot([], {}, { columns: [col] });
    booted.data.load(DATED);
    booted.dom.flushFrames();
    booted.gantt.dispatch("view/editStart", { id: "t0" });
    expect(booted.editor()).toBeUndefined();
  });
});

describe("`view/editStart` columnId targeting", () => {
  it("omitted columnId targets the first editable column in composed order", () => {
    booted = boot([], {}, { columns: [readOnlyColumn("name"), progressColumn()] });
    booted.data.load(DATED);
    booted.dom.flushFrames();
    booted.gantt.dispatch("view/editStart", { id: "t0" });
    expect(booted.editor()?.value).toBe("0.25");
  });

  it("a named editable column is targeted directly", () => {
    booted = boot([], {}, { columns: [progressColumn("p1"), progressColumn("p2")] });
    booted.data.load(DATED);
    booted.dom.flushFrames();
    booted.gantt.dispatch("view/editStart", { id: "t0", columnId: "p2" });
    const cell = booted.visibleRows()[0]?.findAll("sg-grid-cell")[1];
    expect(cell?.find("sg-grid-editor")).toBeDefined();
  });

  it("a columnId matching no column is a no-op", () => {
    booted = boot([], {}, { columns: [progressColumn()] });
    booted.data.load(DATED);
    booted.dom.flushFrames();
    booted.gantt.dispatch("view/editStart", { id: "t0", columnId: "nope" });
    expect(booted.editor()).toBeUndefined();
  });

  it("a columnId naming a non-editable column is a no-op", () => {
    booted = boot([], {}, { columns: [readOnlyColumn("name")] });
    booted.data.load(DATED);
    booted.dom.flushFrames();
    booted.gantt.dispatch("view/editStart", { id: "t0", columnId: "name" });
    expect(booted.editor()).toBeUndefined();
  });

  it("no editable column existing at all is a no-op", () => {
    booted = boot([], {}, { columns: [readOnlyColumn("name")] });
    booted.data.load(DATED);
    booted.dom.flushFrames();
    booted.gantt.dispatch("view/editStart", { id: "t0" });
    expect(booted.editor()).toBeUndefined();
  });
});

describe("committing a shared-input edit through `setValue`", () => {
  it("hands the committed string to `setValue` and dispatches only the changed field", () => {
    booted = boot([], {}, { columns: [progressColumn()] });
    booted.data.load(DATED);
    booted.dom.flushFrames();
    booted.gantt.dispatch("view/editStart", { id: "t0" });
    const editor = booted.editor();
    if (editor === undefined) throw new Error("editor was not opened");
    editor.value = "0.75";
    editor.fire("keydown", { key: "Enter" });
    expect(booted.data.getTask("t0")?.progress).toBe(0.75);
    // Untouched fields survive the round trip.
    expect(booted.data.getTask("t0")?.name).toBe("t0");
  });

  it("does not dispatch when the diff is empty", () => {
    booted = boot([], {}, { columns: [progressColumn()] });
    booted.data.load(DATED);
    booted.dom.flushFrames();
    const seen: unknown[] = [];
    // The task store is set once per applied transaction, always last in the burst.
    booted.data.tasks.subscribe((next) => seen.push(next));
    booted.gantt.dispatch("view/editStart", { id: "t0" });
    const editor = booted.editor();
    if (editor === undefined) throw new Error("editor was not opened");
    editor.value = "0.25"; // unchanged
    editor.fire("keydown", { key: "Enter" });
    expect(seen).toHaveLength(0);
  });
});

// A `setValue` that rebuilds an object/array-valued field always yields a fresh reference; the
// diff underlying the write's undoability must compare *values*, not references, or a no-op
// commit dispatches a phantom `task/update` (and with it a phantom undo entry).
describe("no-op commits on object/array fields do not dispatch", () => {
  /** An editable column whose `setValue` rebuilds `task.meta` from scratch, mirroring the example. */
  function metaColumn(id = "priority"): ColumnDef {
    return {
      id,
      header: id.toUpperCase(),
      width: 60,
      render: (el, task) => void (el.textContent = String(task.meta?.["priority"] ?? "")),
      getValue: (task) => task.meta?.["priority"],
      setValue: (task, value) => {
        (task as Task).meta = { ...task.meta, priority: Number(value) };
      },
    };
  }

  it("a value-identical rebuilt object does not dispatch `task/update`", () => {
    booted = boot([], {}, { columns: [metaColumn()] });
    booted.data.load([
      { id: "t0", parentId: null, name: "t0", start: 0, end: 1, meta: { priority: 2 } },
    ]);
    booted.dom.flushFrames();
    const seen: unknown[] = [];
    // The task store is set once per applied transaction, always last in the burst.
    booted.data.tasks.subscribe((next) => seen.push(next));
    booted.gantt.dispatch("view/editStart", { id: "t0" });
    const editor = booted.editor();
    if (editor === undefined) throw new Error("editor was not opened");
    editor.value = "2"; // unchanged
    editor.fire("keydown", { key: "Enter" });
    expect(seen).toHaveLength(0);
  });

  it("a value-changed rebuilt object still dispatches exactly one `task/update`", () => {
    booted = boot([], {}, { columns: [metaColumn()] });
    booted.data.load([
      { id: "t0", parentId: null, name: "t0", start: 0, end: 1, meta: { priority: 2 } },
    ]);
    booted.dom.flushFrames();
    const seen: unknown[] = [];
    // The task store is set once per applied transaction, always last in the burst.
    booted.data.tasks.subscribe((next) => seen.push(next));
    booted.gantt.dispatch("view/editStart", { id: "t0" });
    const editor = booted.editor();
    if (editor === undefined) throw new Error("editor was not opened");
    editor.value = "9";
    editor.fire("keydown", { key: "Enter" });
    expect(seen).toHaveLength(1);
    expect(booted.data.getTask("t0")?.meta?.["priority"]).toBe(9);
  });

  /** A column whose `setValue` rebuilds a nested array field. */
  function tagsColumn(): ColumnDef {
    const tagsOf = (task: Readonly<Task>): string[] => (task.meta?.["tags"] as string[] | undefined) ?? [];
    return {
      id: "tags",
      header: "TAGS",
      width: 60,
      render: (el, task) => void (el.textContent = tagsOf(task).join(",")),
      getValue: (task) => tagsOf(task).join(","),
      setValue: (task, value) => {
        const tags = String(value)
          .split(",")
          .filter((t) => t !== "");
        (task as Task).meta = { ...task.meta, tags };
      },
    };
  }

  it("a value-identical rebuilt array does not dispatch", () => {
    booted = boot([], {}, { columns: [tagsColumn()] });
    booted.data.load([
      { id: "t0", parentId: null, name: "t0", start: 0, end: 1, meta: { tags: ["a"] } },
    ]);
    booted.dom.flushFrames();
    const seen: unknown[] = [];
    // The task store is set once per applied transaction, always last in the burst.
    booted.data.tasks.subscribe((next) => seen.push(next));
    booted.gantt.dispatch("view/editStart", { id: "t0" });
    const editor = booted.editor();
    if (editor === undefined) throw new Error("editor was not opened");
    editor.value = "a"; // unchanged
    editor.fire("keydown", { key: "Enter" });
    expect(seen).toHaveLength(0);
  });

  it("a changed array element still dispatches", () => {
    booted = boot([], {}, { columns: [tagsColumn()] });
    booted.data.load([
      { id: "t0", parentId: null, name: "t0", start: 0, end: 1, meta: { tags: ["a"] } },
    ]);
    booted.dom.flushFrames();
    const seen: unknown[] = [];
    // The task store is set once per applied transaction, always last in the burst.
    booted.data.tasks.subscribe((next) => seen.push(next));
    booted.gantt.dispatch("view/editStart", { id: "t0" });
    const editor = booted.editor();
    if (editor === undefined) throw new Error("editor was not opened");
    editor.value = "b";
    editor.fire("keydown", { key: "Enter" });
    expect(seen).toHaveLength(1);
  });
});

describe("custom `editor`", () => {
  it("is mounted with `getValue`'s result as `initialValue`", () => {
    booted = boot([], {}, { columns: [customColumn()] });
    booted.data.load(DATED);
    booted.dom.flushFrames();
    booted.gantt.dispatch("view/editStart", { id: "t0" });
    const seed = booted.pane.find("test-seed") as FakeElement | undefined;
    expect(seed?.getAttribute("data-initial")).toBe("0.25");
  });

  it("commit hands the value to `setValue` inside the ordinary `task/update` path", () => {
    booted = boot([], {}, { columns: [customColumn()] });
    booted.data.load(DATED);
    booted.dom.flushFrames();
    booted.gantt.dispatch("view/editStart", { id: "t0" });
    const commit = booted.pane.find("test-commit") as FakeElement | undefined;
    commit?.fire("click", {});
    expect(booted.data.getTask("t0")?.progress).toBe(1);
    expect(booted.pane.find("test-commit")).toBeUndefined();
  });

  it("cancel leaves the task untouched and tears down the host", () => {
    booted = boot([], {}, { columns: [customColumn()] });
    booted.data.load(DATED);
    booted.dom.flushFrames();
    booted.gantt.dispatch("view/editStart", { id: "t0" });
    const cancel = booted.pane.find("test-cancel") as FakeElement | undefined;
    cancel?.fire("click", {});
    expect(booted.data.getTask("t0")?.progress).toBe(0.25);
    expect(booted.pane.find("test-cancel")).toBeUndefined();
  });

  it("does not use the shared plain-text input", () => {
    booted = boot([], {}, { columns: [customColumn()] });
    booted.data.load(DATED);
    booted.dom.flushFrames();
    booted.gantt.dispatch("view/editStart", { id: "t0" });
    expect(booted.editor()).toBeUndefined();
  });
});

/** A `dateEditor()`-backed column reading/writing `start`. */
function dueDateColumn(id = "due"): ColumnDef {
  return {
    id,
    header: id.toUpperCase(),
    width: 60,
    render: (el, task) => void (el.textContent = String(task.start)),
    getValue: (task) => task.start,
    setValue: (task, value) => {
      (task as Task).start = Number(value);
    },
    editor: dateEditor(),
  };
}

// docs/specs/plugins/tree-grid.md § Events — a press landing inside the mounted inline-editor
// host belongs to the editor, not the row: the grid emits no `grid/rowPointerDown` for it, and its
// own `dblclick` handler starts no new edit session.
describe("a press inside the open editor belongs to the editor, not the row", () => {
  it("a pointerdown inside the open shared editor emits no `grid/rowPointerDown`, and the editor stays open", () => {
    booted = boot([], {}, { columns: [progressColumn()] });
    booted.data.load(DATED);
    booted.dom.flushFrames();
    booted.gantt.dispatch("view/editStart", { id: "t0" });
    const editor = booted.editor();
    if (editor === undefined) throw new Error("editor was not opened");
    const seen: unknown[] = [];
    booted.gantt.on("grid/rowPointerDown", (e) => seen.push(e));
    booted.body.fire("pointerdown", {
      target: editor,
      ctrlKey: false,
      metaKey: false,
      shiftKey: false,
      button: 0,
    });
    expect(seen).toHaveLength(0);
    // Still the same, still-mounted editor — nothing tore it down or replaced it.
    expect(booted.editor()).toBe(editor);
  });

  it("a pointerdown inside an open custom (date) editor is not cancelled, and emits no `grid/rowPointerDown`", () => {
    booted = boot([], {}, { columns: [dueDateColumn()] });
    booted.data.load(DATED);
    booted.dom.flushFrames();
    booted.gantt.dispatch("view/editStart", { id: "t0" });
    const dateInput = booted.pane.find("sg-grid-date");
    if (dateInput === undefined) throw new Error("date editor was not opened");
    const seen: unknown[] = [];
    booted.gantt.on("grid/rowPointerDown", (e) => seen.push(e));
    booted.body.fire("pointerdown", {
      target: dateInput,
      ctrlKey: false,
      metaKey: false,
      shiftKey: false,
      button: 0,
    });
    expect(seen).toHaveLength(0);
    // Still mounted and uncancelled: the calendar-picker press did not blur-and-cancel the edit,
    // and the task is untouched (cancel never ran).
    expect(booted.pane.find("sg-grid-date")).toBe(dateInput);
    expect(booted.data.getTask("t0")?.start).toBe(0);
  });

  it("a double-click inside the open editor does not restart the session, so a typed value survives", () => {
    booted = boot([], {}, { columns: [progressColumn()] });
    booted.data.load(DATED);
    booted.dom.flushFrames();
    booted.gantt.dispatch("view/editStart", { id: "t0" });
    const editor = booted.editor();
    if (editor === undefined) throw new Error("editor was not opened");
    editor.value = "0.99";
    booted.body.fire("dblclick", { target: editor });
    // Restarting the session would call `edit.open` again, which re-reads `getValue` and resets the
    // shared input back to "0.25" — so a preserved "0.99" is proof no fresh session began.
    expect(booted.editor()).toBe(editor);
    expect(booted.editor()?.value).toBe("0.99");
  });

  it("a pointerdown on a plain cell (no editor open) still emits `grid/rowPointerDown`", () => {
    booted = boot([], {}, { columns: [progressColumn()] });
    booted.data.load(DATED);
    booted.dom.flushFrames();
    const seen: unknown[] = [];
    booted.gantt.on("grid/rowPointerDown", (e) => seen.push(e));
    const cell = booted.visibleRows()[0]?.findAll("sg-grid-cell")[0];
    booted.body.fire("pointerdown", {
      target: cell,
      ctrlKey: false,
      metaKey: false,
      shiftKey: false,
      button: 0,
    });
    expect(seen).toHaveLength(1);
  });

  // The right-button (contextmenu) path reproduces the same defect: an unguarded right-press
  // inside the editor opened the row menu, whose focus move would blur (and so cancel) the edit
  // exactly as the unguarded pointerdown/dblclick did.
  it("a contextmenu request inside the open editor emits neither context-menu event, suppresses nothing, and leaves the editor mounted", () => {
    booted = boot([], {}, { columns: [dueDateColumn()] });
    booted.data.load(DATED);
    booted.dom.flushFrames();
    booted.gantt.dispatch("view/editStart", { id: "t0" });
    const dateInput = booted.pane.find("sg-grid-date");
    if (dateInput === undefined) throw new Error("date editor was not opened");
    const rowMenuSeen: unknown[] = [];
    const backgroundMenuSeen: unknown[] = [];
    booted.gantt.on("grid/rowContextMenu", (e) => rowMenuSeen.push(e));
    booted.gantt.on("grid/backgroundContextMenu", (e) => backgroundMenuSeen.push(e));
    let prevented = false;
    booted.body.fire("contextmenu", {
      target: dateInput,
      clientX: 0,
      clientY: 0,
      preventDefault: () => void (prevented = true),
    });
    expect(rowMenuSeen).toHaveLength(0);
    expect(backgroundMenuSeen).toHaveLength(0);
    expect(prevented).toBe(false);
    // Not blurred-and-cancelled: the browser's own input menu (or date picker) is what survives.
    expect(booted.pane.find("sg-grid-date")).toBe(dateInput);
    expect(booted.data.getTask("t0")?.start).toBe(0);
  });
});

describe("custom `editor` throwing during construction", () => {
  /** A custom-editor column whose `editor` callback throws after capturing `done` for later. */
  function throwingEditorColumn(
    captured: { done?: { commit(value: unknown): void; cancel(): void } },
    id = "flag",
  ): ColumnDef {
    return {
      id,
      header: id.toUpperCase(),
      width: 60,
      render: (el, task) => void (el.textContent = String(task.progress)),
      getValue: (task) => task.progress,
      setValue: (task, value) => {
        (task as Task).progress = value === true ? 1 : 0;
      },
      editor: (_el, _initialValue, done) => {
        captured.done = done;
        throw new Error("boom");
      },
    };
  }

  it("reports the fault and schedules a repaint so the cell does not stay blank", () => {
    const captured: { done?: { commit(value: unknown): void; cancel(): void } } = {};
    const errors: { pluginId: string; error: unknown }[] = [];
    booted = boot(
      [
        probe((ctx) => {
          ctx.on("core/pluginError", (e) => void errors.push(e));
        }),
      ],
      {},
      { columns: [throwingEditorColumn(captured)] },
    );
    booted.data.load(DATED);
    booted.dom.flushFrames();
    booted.gantt.dispatch("view/editStart", { id: "t0" });
    expect(errors).toHaveLength(1);
    // A repaint was scheduled by the failed teardown, so the next frame redraws the cell's
    // ordinary content instead of leaving it blank until some unrelated event repaints it.
    booted.dom.flushFrames();
    const cells = booted.visibleRows()[0]?.findAll("sg-grid-cell").map((c) => c.textContent ?? "");
    expect(cells).toContain("0.25");
  });

  it("a late `done.commit` after the failed construction is ignored", () => {
    const captured: { done?: { commit(value: unknown): void; cancel(): void } } = {};
    booted = boot([], {}, { columns: [throwingEditorColumn(captured)] });
    booted.data.load(DATED);
    booted.dom.flushFrames();
    booted.gantt.dispatch("view/editStart", { id: "t0" });
    booted.dom.flushFrames();
    captured.done?.commit(true);
    expect(booted.data.getTask("t0")?.progress).toBe(0.25);
  });
});

describe("double-click targets the clicked column, not always the first editable one", () => {
  it("edits the specific editable column under the pointer", () => {
    booted = boot([], {}, { columns: [readOnlyColumn("name"), progressColumn()] });
    booted.data.load(DATED);
    booted.dom.flushFrames();
    const cell = booted.visibleRows()[0]?.findAll("sg-grid-cell")[1];
    booted.body.fire("dblclick", { target: cell });
    expect(booted.editor()?.value).toBe("0.25");
  });

  it("double-clicking a read-only cell does not fall back to another column", () => {
    booted = boot([], {}, { columns: [readOnlyColumn("name"), progressColumn()] });
    booted.data.load(DATED);
    booted.dom.flushFrames();
    const cell = booted.visibleRows()[0]?.findAll("sg-grid-cell")[0];
    booted.body.fire("dblclick", { target: cell });
    expect(booted.editor()).toBeUndefined();
  });
});
