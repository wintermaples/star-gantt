/**
 * `src/internal/edit-session.ts` — the inline-edit state machine: `open` / `commit` / `cancel` /
 * eviction, the editability rule and the `task/update` diff.
 */
import type { Task, TaskId } from "@stargantt/plugin-data-store";
import { describe, expect, it } from "vitest";
import type { ColumnDef, ColumnEditor } from "../src/types";
import { createColumnTrack } from "../src/internal/column-track";
import { createEditSession, isEditable } from "../src/internal/edit-session";
import type { EditDone, EditSession } from "../src/internal/edit-session";
import { task } from "./_data";
import { asElement } from "./_harness/index";
import type { FakeElement, FakeInput } from "./_harness/index";
import { unitColumn } from "./_units";
import { asDoc, unitDoc } from "./_units-dom";

interface Update {
  id: TaskId;
  after: Partial<Task>;
}

interface Harness {
  session: EditSession;
  updates: Update[];
  faults: unknown[];
  restored: HTMLElement[];
  repaints(): number;
  /** The fake cell of column `index` in row 0, the only materialized row. */
  cell(index: number): FakeElement;
  input: FakeInput;
}

/** A session over one task (`a`, named `Alpha`) whose single row is materialized. */
function harness(columns: ColumnDef[]): Harness {
  const doc = unitDoc();
  const cells = columns.map(() => doc.createElement("div"));
  const track = createColumnTrack(() => columns);
  track.refresh();
  const updates: Update[] = [];
  const faults: unknown[] = [];
  const restored: HTMLElement[] = [];
  let repaints = 0;
  const model = {
    taskIdAt: (row: number): TaskId | undefined => (row === 0 ? "a" : undefined),
    task: (id: TaskId): Readonly<Task> | undefined =>
      id === "a" ? { ...task("a", null, "Alpha"), meta: { hot: true } } : undefined,
  };
  const session = createEditSession({
    doc: asDoc(doc),
    track,
    // Only `taskIdAt` / `task` are reached; the rest of `RowModel` is irrelevant to editing.
    model: model as unknown as Parameters<typeof createEditSession>[0]["model"],
    readOnly: false,
    cellsOf: (row) => (row === 0 ? cells.map((c) => asElement(c)) : undefined),
    update: (id, after) => updates.push({ id, after }),
    fault: (error) => faults.push(error),
    restoreFocus: (host) => restored.push(host),
    schedule: () => {
      repaints += 1;
    },
  });
  return {
    session,
    updates,
    faults,
    restored,
    repaints: () => repaints,
    cell: (index) => cells[index] as FakeElement,
    input: session.input as unknown as FakeInput,
  };
}

/** A writable name column: the built-in composition's only editable column. */
function nameColumn(extra: Partial<ColumnDef> = {}): ColumnDef {
  return unitColumn("name", {
    setValue: (t, value) => {
      (t as Task).name = String(value);
    },
    ...extra,
  });
}

describe("isEditable", () => {
  it("requires `setValue`", () => {
    expect(isEditable(unitColumn("start"), false)).toBe(false);
    expect(isEditable(nameColumn(), false)).toBe(true);
  });

  it("honours an explicit `editable: false` and ignores a pointless `editable: true`", () => {
    expect(isEditable(nameColumn({ editable: false }), false)).toBe(false);
    expect(isEditable(unitColumn("start", { editable: true }), false)).toBe(false);
  });

  it("makes every column read-only under `readOnly`", () => {
    expect(isEditable(nameColumn(), true)).toBe(false);
  });
});

describe("createEditSession — opening", () => {
  it("mounts the shared input into the targeted cell, pre-filled from `getValue`", () => {
    const h = harness([nameColumn()]);
    expect(h.session.open(0)).toBe(true);
    const host = h.cell(0).find("sg-grid-editor-host");
    expect(host).toBeDefined();
    expect(host?.find("sg-grid-editor")).toBeDefined();
    expect(h.input.value).toBe("Alpha");
    expect(h.input.focused).toBe(true);
  });

  it("targets the first editable column when no `columnId` is given", () => {
    const h = harness([unitColumn("start"), nameColumn()]);
    expect(h.session.open(0)).toBe(true);
    expect(h.cell(0).find("sg-grid-editor-host")).toBeUndefined();
    expect(h.cell(1).find("sg-grid-editor-host")).toBeDefined();
  });

  it("declines an unknown column, a non-editable column, and a grid with none", () => {
    const h = harness([unitColumn("start"), nameColumn()]);
    expect(h.session.open(0, "nope")).toBe(false);
    expect(h.session.open(0, "start")).toBe(false);
    expect(harness([unitColumn("start")]).session.open(0)).toBe(false);
  });

  it("declines a row that is not materialized, and an unknown row", () => {
    const h = harness([nameColumn()]);
    expect(h.session.open(5)).toBe(false);
  });

  it("declines every column while the grid is read-only", () => {
    const doc = unitDoc();
    const columns = [nameColumn()];
    const track = createColumnTrack(() => columns);
    track.refresh();
    const cell = doc.createElement("div");
    const session = createEditSession({
      doc: asDoc(doc),
      track,
      model: {
        taskIdAt: () => "a",
        task: () => task("a", null, "Alpha"),
      } as unknown as Parameters<typeof createEditSession>[0]["model"],
      readOnly: true,
      cellsOf: () => [asElement(cell)],
      update: () => {},
      fault: () => {},
      restoreFocus: () => {},
      schedule: () => {},
    });
    expect(session.open(0)).toBe(false);
  });

  it("replaces an earlier session's editor rather than stacking two", () => {
    const h = harness([nameColumn(), nameColumn({ id: "name2" })]);
    h.session.open(0, "name");
    h.session.open(0, "name2");
    expect(h.cell(0).find("sg-grid-editor-host")).toBeUndefined();
    expect(h.cell(1).find("sg-grid-editor-host")).toBeDefined();
  });

  it("reports a throwing `getValue` and falls back to an empty editor", () => {
    const boom = new Error("bad accessor");
    const h = harness([
      nameColumn({
        getValue: () => {
          throw boom;
        },
      }),
    ]);
    expect(h.session.open(0)).toBe(true);
    expect(h.faults).toContain(boom);
    expect(h.input.value).toBe("");
  });
});

describe("createEditSession — committing", () => {
  it("dispatches `task/update` with only the fields that changed", () => {
    const h = harness([nameColumn()]);
    h.session.open(0);
    h.session.sharedDone()?.commit("Beta");
    expect(h.updates).toEqual([{ id: "a", after: { name: "Beta" } }]);
    expect(h.repaints()).toBe(1);
  });

  it("dispatches nothing when the commit changes no field (no phantom undo step)", () => {
    const h = harness([nameColumn()]);
    h.session.open(0);
    h.session.sharedDone()?.commit("Alpha");
    expect(h.updates).toEqual([]);
  });

  it("compares object-valued fields by value, not by reference", () => {
    // A `setValue` that rebuilds `meta` always produces a fresh reference; comparing references
    // would dispatch a no-op `task/update`, and with it a phantom undo entry.
    const h = harness([
      nameColumn({
        setValue: (t) => {
          (t as Task).meta = { ...(t as Task).meta };
        },
      }),
    ]);
    h.session.open(0);
    h.session.sharedDone()?.commit("ignored");
    expect(h.updates).toEqual([]);
  });

  it("dispatches every field a `setValue` really changed", () => {
    const h = harness([
      nameColumn({
        setValue: (t, value) => {
          (t as Task).name = String(value);
          (t as Task).meta = { hot: false };
        },
      }),
    ]);
    h.session.open(0);
    h.session.sharedDone()?.commit("Beta");
    expect(h.updates).toEqual([{ id: "a", after: { name: "Beta", meta: { hot: false } } }]);
  });

  it("reports a throwing `setValue` and dispatches nothing", () => {
    const boom = new Error("bad write");
    const h = harness([
      nameColumn({
        setValue: () => {
          throw boom;
        },
      }),
    ]);
    h.session.open(0);
    h.session.sharedDone()?.commit("Beta");
    expect(h.faults).toContain(boom);
    expect(h.updates).toEqual([]);
  });

  it("tears the editor down, restores focus and repaints on commit", () => {
    const h = harness([nameColumn()]);
    h.session.open(0);
    const host = h.cell(0).find("sg-grid-editor-host");
    h.session.sharedDone()?.commit("Beta");
    expect(h.cell(0).find("sg-grid-editor-host")).toBeUndefined();
    expect(h.restored).toEqual([host as unknown as HTMLElement]);
    expect(h.session.sharedDone()).toBeNull();
  });

  it("leaves the task untouched on cancel", () => {
    const h = harness([nameColumn()]);
    h.session.open(0);
    h.session.sharedDone()?.cancel();
    expect(h.updates).toEqual([]);
    expect(h.cell(0).find("sg-grid-editor-host")).toBeUndefined();
    expect(h.repaints()).toBe(1);
  });

  it("ignores a duplicate or late `commit` / `cancel` from the same session", () => {
    const h = harness([nameColumn()]);
    h.session.open(0);
    const done = h.session.sharedDone();
    done?.commit("Beta");
    done?.commit("Gamma");
    done?.cancel();
    expect(h.updates).toEqual([{ id: "a", after: { name: "Beta" } }]);
  });
});

describe("createEditSession — custom editors", () => {
  it("hands the host, the initial value and the done pair to `ColumnDef.editor`", () => {
    const seen: { el?: HTMLElement; initial?: unknown } = {};
    let done: { commit(v: unknown): void; cancel(): void } | undefined;
    const editor: ColumnEditor = (el, initial, d) => {
      seen.el = el;
      seen.initial = initial;
      done = d;
    };
    const h = harness([nameColumn({ editor })]);
    h.session.open(0);
    expect(seen.initial).toBe("Alpha");
    expect(seen.el).toBe(h.cell(0).find("sg-grid-editor-host") as unknown as HTMLElement);
    // The shared input is not the mounted editor, so its own listeners must find nothing to act on.
    expect(h.session.sharedDone()).toBeNull();

    done?.commit("Delta");
    expect(h.updates).toEqual([{ id: "a", after: { name: "Delta" } }]);
  });

  it("reports a constructor that throws, and does not leave a blank cell behind", () => {
    const boom = new Error("bad editor");
    const h = harness([
      nameColumn({
        editor: () => {
          throw boom;
        },
      }),
    ]);
    expect(h.session.open(0)).toBe(true);
    expect(h.faults).toContain(boom);
    expect(h.cell(0).find("sg-grid-editor-host")).toBeUndefined();
    expect(h.repaints()).toBe(1);
  });

  it("lets a superseded editor's late commit through, tearing its successor down silently", () => {
    // A custom editor is opaque: the grid cannot tell it "you are gone", so replacement does not
    // mark the old session finished and a late `done.commit` still reaches `setValue`. The
    // documented cost is that it also disposes whichever session is current by then, without
    // committing or cancelling it. This pins that edge case rather than leaving it to chance.
    const dones: Record<string, EditDone> = {};
    const record =
      (name: string): ColumnEditor =>
      (_el, _initial, done) => {
        dones[name] = done;
      };
    const h = harness([
      nameColumn({ editor: record("A") }),
      nameColumn({ id: "name2", editor: record("B") }),
    ]);
    h.session.open(0, "name");
    h.session.open(0, "name2");
    const hostB = h.cell(1).find("sg-grid-editor-host") as unknown as HTMLElement;
    expect(hostB).toBeDefined();
    expect(h.cell(0).find("sg-grid-editor-host")).toBeUndefined();

    dones["A"]?.commit("Late");

    expect(h.updates).toEqual([{ id: "a", after: { name: "Late" } }]);
    // The successor is gone, and was never told: `commit`/`cancel` both restore focus, so its host
    // never appearing there is the proof neither ran for it.
    expect(h.cell(1).find("sg-grid-editor-host")).toBeUndefined();
    expect(h.restored).not.toContain(hostB);
    expect(h.session.sharedDone()).toBeNull();
  });

  it("ignores a `commit` from a half-constructed editor that threw", () => {
    let done: { commit(v: unknown): void } | undefined;
    const h = harness([
      nameColumn({
        editor: (_el, _initial, d) => {
          done = d;
          throw new Error("bad editor");
        },
      }),
    ]);
    h.session.open(0);
    done?.commit("Zeta");
    expect(h.updates).toEqual([]);
  });
});

describe("createEditSession — repaint passes", () => {
  it("keeps an open session alive while the pass retains its cell", () => {
    const h = harness([nameColumn()]);
    h.session.open(0);
    h.session.beginPaintPass();
    expect(h.session.retains("a", asElement(h.cell(0)))).toBe(true);
    h.session.endPaintPass();
    expect(h.cell(0).find("sg-grid-editor-host")).toBeDefined();
    expect(h.updates).toEqual([]);
  });

  it("declines a cell that is not the open editor's", () => {
    const h = harness([nameColumn(), nameColumn({ id: "name2" })]);
    h.session.open(0, "name");
    h.session.beginPaintPass();
    expect(h.session.retains("a", asElement(h.cell(1)))).toBe(false);
    expect(h.session.retains("b", asElement(h.cell(0)))).toBe(false);
  });

  it("commits the shared editor's typed value when the pass drops its cell", () => {
    const h = harness([nameColumn()]);
    h.session.open(0);
    h.input.value = "Typed";
    h.session.beginPaintPass();
    h.session.endPaintPass();
    expect(h.updates).toEqual([{ id: "a", after: { name: "Typed" } }]);
    expect(h.session.sharedDone()).toBeNull();
  });

  it("cancels a custom editor instead of guessing at a value to commit", () => {
    const h = harness([nameColumn({ editor: () => {} })]);
    h.session.open(0);
    h.session.beginPaintPass();
    h.session.endPaintPass();
    expect(h.updates).toEqual([]);
  });

  it("does nothing at all when no session is open", () => {
    const h = harness([nameColumn()]);
    h.session.beginPaintPass();
    h.session.endPaintPass();
    expect(h.updates).toEqual([]);
    expect(h.repaints()).toBe(0);
  });
});
