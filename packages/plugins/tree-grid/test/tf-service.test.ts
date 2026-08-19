import { afterEach, describe, expect, it, vi } from "vitest";
import type { Task, TaskId } from "@stargantt/plugin-data-store";
import { boot } from "./_boot";
import type { Booted } from "./_boot";
import { upwardProbe, barBox } from "./_upward";
import type { UpwardProbe } from "./_upward";
import { FakeContext2D } from "./_harness/index";
import type { FakeElement, FakeInput } from "./_harness/index";
import { fieldsOfTask } from "../src/internal/task-fields/fields";

const MS_DAY = 86_400_000;
const NOW = Date.UTC(1970, 0, 15, 12);

/** A task, optionally carrying field values and extra overrides (custom dates, and so on). */
function task(id: TaskId, fields?: Record<string, unknown>, extra?: Partial<Task>): Task {
  const t: Task = { id, parentId: null, name: String(id), start: 0, end: MS_DAY, ...extra };
  if (fields !== undefined) t.meta = { taskFields: fields };
  return t;
}

let booted: Booted[] = [];
function useBoot(...args: Parameters<typeof boot>): Booted {
  const b = boot(...args);
  booted.push(b);
  return b;
}
afterEach(() => {
  for (const b of booted) {
    b.gantt.dispose();
    b.dom.restore();
  }
  booted = [];
});

/** The text of one row's cell for `columnId`, addressed by task id via the row model. */
function cellText(b: Booted, id: TaskId, columnId: string): string {
  const rowIndex = b.rows.rowOf(id);
  if (rowIndex === undefined) throw new Error(`no visible row for ${String(id)}`);
  const row = b.visibleRows()[rowIndex];
  if (row === undefined) throw new Error(`missing row element at index ${rowIndex}`);
  const cell = row.querySelector(`[data-column-id="${columnId}"]`);
  if (cell === null) throw new Error(`missing column ${columnId}`);
  return cell.textContent;
}

/** The side panel's mounted controls, indexed exactly as its own row order. */
function panelControls(host: FakeElement) {
  const row = (index: number): FakeElement => {
    const r =
      index < 4
        ? host.children[index + 1]
        : index < 6
          ? host.children[5]?.children[index - 4]
          : host.children[6];
    if (r === undefined) throw new Error(`missing row ${index}`);
    return r;
  };
  const control = (index: number): FakeInput => {
    const c = row(index)?.children[1];
    if (c === undefined) throw new Error(`missing control ${index}`);
    return c as FakeInput;
  };
  return { row, control };
}

/** Mounts the field section the composed plugin contributes to the side panel. */
function mountFieldsPanel(b: Booted, probe: UpwardProbe) {
  const contribution = probe.panels()[0];
  if (contribution === undefined) throw new Error("no side-panel field contribution");
  const host = b.dom.document.createElement("div");
  const handle = contribution.mount(host as unknown as HTMLElement);
  if (handle === undefined || handle === null) throw new Error("expected a handle");
  return { handle, ...panelControls(host) };
}

// Control order inside the section: status, priority, tags, deadline, actualStart, actualEnd,
// notes.
const STATUS = 0;
const PRIORITY = 1;

describe("committing through the side panel", () => {
  it("writes through one task/update transaction per edit, and the field values read back off the store", () => {
    const probe = upwardProbe();
    const b = useBoot([probe.plugin], {}, { taskFields: {} });
    b.data.load([task("a")]);
    const panel = mountFieldsPanel(b, probe);
    panel.handle.update([b.data.getTask("a")!]);

    let transactions = 0;
    b.gantt.on("data/willApplyTransaction", () => void (transactions += 1));
    panel.control(STATUS).value = "in-progress";
    panel.control(STATUS).fire("change");
    expect(transactions).toBe(1);
    expect(fieldsOfTask(b.data.getTask("a"))).toEqual({ status: "in-progress" });

    // Sibling meta keys survive a commit, and clearing the last field removes the bag entirely.
    b.data.load([task("b", undefined, { meta: { color: "red" } })]);
    panel.handle.update([b.data.getTask("b")!]);
    panel.control(PRIORITY).value = "high";
    panel.control(PRIORITY).fire("change");
    expect(b.data.getTask("b")?.meta).toEqual({ color: "red", taskFields: { priority: "high" } });

    panel.control(PRIORITY).value = ""; // the none option — clears
    panel.control(PRIORITY).fire("change");
    expect(b.data.getTask("b")?.meta).toEqual({ color: "red" });
  });

  it("committing for an unknown task is a no-op", () => {
    const probe = upwardProbe();
    const b = useBoot([probe.plugin], {}, { taskFields: {} });
    b.data.load([task("a")]);
    const panel = mountFieldsPanel(b, probe);
    panel.handle.update([task("nope")]);
    expect(() => {
      panel.control(STATUS).value = "done";
      panel.control(STATUS).fire("change");
    }).not.toThrow();
    expect(b.data.getTask("nope")).toBeUndefined();
    expect(fieldsOfTask(b.data.getTask("a"))).toEqual({});
  });
});

describe("the id column", () => {
  it("numbers tasks in store order, a customId wins, and removal renumbers the rest", () => {
    const b = useBoot(
      [],
      {},
      { taskFields: { columns: ["id"], idNumbering: { prefix: "T-", start: 10, minDigits: 3 } } },
    );
    b.data.load([task("a"), task("b"), task("c", { customId: "EXT-9" })]);
    b.dom.flushFrames();
    expect(cellText(b, "a", "taskfields-id")).toBe("T-010");
    expect(cellText(b, "b", "taskfields-id")).toBe("T-011");
    expect(cellText(b, "c", "taskfields-id")).toBe("EXT-9");
    expect(b.rows.rowOf("zzz")).toBeUndefined();

    b.gantt.dispatch("task/remove", { ids: ["a"] });
    b.dom.flushFrames();
    expect(cellText(b, "b", "taskfields-id")).toBe("T-010");
  });
});

describe("the deadline warning overlay", () => {
  it("pairs a past deadline with a non-done status", () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    const probe = upwardProbe();
    const b = useBoot([probe.plugin], {}, { taskFields: {} });
    b.data.load([
      task("late", { deadline: NOW - 1 }),
      task("done", { deadline: NOW - 1, status: "done" }),
      task("future", { deadline: NOW + MS_DAY }),
    ]);

    const drawn = (id: string): FakeContext2D => {
      const g = new FakeContext2D();
      probe.paintOverlays(g as unknown as CanvasRenderingContext2D, barBox({ id }));
      return g;
    };
    expect(drawn("late").ops.some((op) => op.op === "fill" && op.fill === "#d32f2f")).toBe(true);
    expect(drawn("done").ops.some((op) => op.op === "fill" && op.fill === "#d32f2f")).toBe(false);
    expect(drawn("future").ops.some((op) => op.op === "fill" && op.fill === "#d32f2f")).toBe(false);
    vi.useRealTimers();
  });
});

describe("the assignees column", () => {
  it("reflects assignment/set and assignment/remove, resource by resource", () => {
    const b = useBoot([], {}, { taskFields: { columns: ["assignees"] } });
    b.data.load([task("a")]);
    b.gantt.dispatch("resource/add", { resource: { id: "r1", name: "Ann" } });
    b.gantt.dispatch("resource/add", { resource: { id: "r2", name: "Bob" } });
    b.gantt.dispatch("assignment/set", { taskId: "a", resourceId: "r1", units: 1 });
    b.gantt.dispatch("assignment/set", { taskId: "a", resourceId: "r2", units: 1 });
    b.gantt.dispatch("view/rowsInvalidate", undefined);
    b.dom.flushFrames();
    expect(cellText(b, "a", "taskfields-assignees")).toBe("Ann, Bob");

    b.gantt.dispatch("assignment/remove", { taskId: "a", resourceId: "r1" });
    b.gantt.dispatch("view/rowsInvalidate", undefined);
    b.dom.flushFrames();
    expect(cellText(b, "a", "taskfields-assignees")).toBe("Bob");

    b.gantt.dispatch("assignment/remove", { taskId: "a", resourceId: "r2" });
    b.gantt.dispatch("view/rowsInvalidate", undefined);
    b.dom.flushFrames();
    expect(cellText(b, "a", "taskfields-assignees")).toBe("");
  });

  it("a full replace, dispatched as the public commands, lands as the new set", () => {
    const b = useBoot([], {}, { taskFields: { columns: ["assignees"] } });
    b.data.load([task("a")]);
    for (const [id, name] of [
      ["r1", "Ann"],
      ["r2", "Bob"],
      ["r3", "Cid"],
      ["r4", "Dee"],
      ["r5", "Eve"],
      ["r6", "Fay"],
    ] as const) {
      b.gantt.dispatch("resource/add", { resource: { id, name } });
    }
    b.gantt.dispatch("assignment/set", { taskId: "a", resourceId: "r1", units: 1 });
    b.gantt.dispatch("assignment/set", { taskId: "a", resourceId: "r2", units: 1 });
    b.gantt.dispatch("assignment/set", { taskId: "a", resourceId: "r3", units: 1 });
    b.gantt.dispatch("assignment/remove", { taskId: "a", resourceId: "r1" });
    b.gantt.dispatch("assignment/remove", { taskId: "a", resourceId: "r2" });
    b.gantt.dispatch("assignment/remove", { taskId: "a", resourceId: "r3" });
    b.gantt.dispatch("assignment/set", { taskId: "a", resourceId: "r4", units: 1 });
    b.gantt.dispatch("assignment/set", { taskId: "a", resourceId: "r5", units: 1 });
    b.gantt.dispatch("assignment/set", { taskId: "a", resourceId: "r6", units: 1 });
    b.gantt.dispatch("view/rowsInvalidate", undefined);
    b.dom.flushFrames();
    expect(cellText(b, "a", "taskfields-assignees")).toBe("Dee, Eve, Fay");
  });

  it("assignment/set to an unknown resource is a no-op; a known one still lands", () => {
    const b = useBoot([], {}, { taskFields: { columns: ["assignees"] } });
    b.data.load([task("a")]);
    b.gantt.dispatch("resource/add", { resource: { id: "r1", name: "Ann" } });
    b.gantt.dispatch("assignment/set", { taskId: "a", resourceId: "ghost", units: 1 });
    b.gantt.dispatch("assignment/set", { taskId: "a", resourceId: "r1", units: 1 });
    b.gantt.dispatch("view/rowsInvalidate", undefined);
    b.dom.flushFrames();
    expect(cellText(b, "a", "taskfields-assignees")).toBe("Ann");
  });
});

describe("the duration column", () => {
  it("reads in the configured unit and a commit moves end only", () => {
    const b = useBoot([], {}, { taskFields: { columns: ["duration"], durationUnit: "hours" } });
    b.data.load([task("a", undefined, { start: 0, end: 2 * MS_DAY })]);
    b.dom.flushFrames();
    expect(cellText(b, "a", "taskfields-duration")).toBe("48 h");

    b.gantt.dispatch("view/editStart", { id: "a", columnId: "taskfields-duration" });
    const editor = b.editor();
    if (editor === undefined) throw new Error("editor was not opened");
    editor.value = "12";
    editor.fire("keydown", { key: "Enter" });
    expect(b.data.getTask("a")).toMatchObject({ start: 0, end: 12 * 3_600_000 });

    // A negative commit is ignored — `end` stays put.
    b.gantt.dispatch("view/editStart", { id: "a", columnId: "taskfields-duration" });
    const editor2 = b.editor();
    if (editor2 === undefined) throw new Error("editor was not opened");
    editor2.value = "-5";
    editor2.fire("keydown", { key: "Enter" });
    expect(b.data.getTask("a")?.end).toBe(12 * 3_600_000);
  });
});

describe("completion auto-record", () => {
  it("stamps actualEnd when a status commit flips to done, inside the same transaction", () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    const probe = upwardProbe();
    const b = useBoot([probe.plugin], {}, { taskFields: {} });
    b.data.load([task("a")]);
    const panel = mountFieldsPanel(b, probe);
    panel.handle.update([b.data.getTask("a")!]);
    panel.control(STATUS).value = "done";
    panel.control(STATUS).fire("change");
    expect(fieldsOfTask(b.data.getTask("a"))).toEqual({ status: "done", actualEnd: NOW });
    vi.useRealTimers();
  });

  it("does not overwrite an existing actualEnd, and can be disabled entirely", () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);

    const keptProbe = upwardProbe();
    const kept = useBoot([keptProbe.plugin], {}, { taskFields: {} });
    kept.data.load([task("a", { actualEnd: 7 })]);
    const keptPanel = mountFieldsPanel(kept, keptProbe);
    keptPanel.handle.update([kept.data.getTask("a")!]);
    keptPanel.control(STATUS).value = "done";
    keptPanel.control(STATUS).fire("change");
    expect(fieldsOfTask(kept.data.getTask("a"))).toEqual({ status: "done", actualEnd: 7 });

    const offProbe = upwardProbe();
    const off = useBoot([offProbe.plugin], {}, { taskFields: { autoRecordCompletion: false } });
    off.data.load([task("a")]);
    const offPanel = mountFieldsPanel(off, offProbe);
    offPanel.handle.update([off.data.getTask("a")!]);
    offPanel.control(STATUS).value = "done";
    offPanel.control(STATUS).fire("change");
    expect(fieldsOfTask(off.data.getTask("a"))).toEqual({ status: "done" });

    vi.useRealTimers();
  });
});
