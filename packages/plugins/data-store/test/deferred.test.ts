/**
 * docs/specs/plugins/data-store.md — Bulk paths / deferred children (lazy hierarchy construction
 * via `LoadInput.deferredTasks` / `materializeChildren`).
 */
import { Gantt } from "@stargantt/core";
import type { GanttInstance } from "@stargantt/core";
import { afterEach, describe, expect, it } from "vitest";
import { dataStore } from "../src/index";
import type { DataService, Task, TaskId } from "../src/types";
import { addedIds, fakeRoot } from "./_helpers";

let gantt: GanttInstance | undefined;

afterEach(() => {
  gantt?.dispose();
  gantt = undefined;
});

interface Booted {
  data: DataService;
  /** Every `tasks` store snapshot published so far, in order. */
  snapshots: ReadonlyMap<TaskId, Readonly<Task>>[];
}

function boot(): Booted {
  const snapshots: ReadonlyMap<TaskId, Readonly<Task>>[] = [];
  const g = Gantt.create({ element: fakeRoot(), plugins: [dataStore()] });
  gantt = g;
  const data = g.service("stargantt.data");
  data.tasks.subscribe((next) => snapshots.push(next));
  return { data, snapshots };
}

const parent = { id: "p", name: "P", start: 0, end: 10 };
const kids = [
  { id: "c1", name: "C1", start: 0, end: 5 },
  { id: "c2", name: "C2", start: 5, end: 10 },
];

describe("deferredTasks", () => {
  it("parks rows without building them", () => {
    const b = boot();
    b.data.load({ tasks: [parent], deferredTasks: [{ parentId: "p", rows: kids }] });

    expect(b.data.getTask("c1")).toBeUndefined();
    expect(b.data.query().children.get("p")).toBeUndefined();
    expect(b.data.toJSON().tasks.map((t) => t.id)).toEqual(["p"]);
    expect(b.data.hasDeferredChildren("p")).toBe(true);
    expect(b.data.hasDeferredChildren("c1")).toBe(false);
    // The load publishes a `tasks` snapshot carrying only the built task.
    expect(b.snapshots).toHaveLength(1);
    expect([...b.snapshots[0]!.keys()]).toEqual(["p"]);
  });

  it("materializes on demand as direct children, published without a transaction", () => {
    const b = boot();
    b.data.load({ tasks: [parent], deferredTasks: [{ parentId: "p", rows: kids }] });
    b.data.materializeChildren("p");

    expect(b.data.getTask("c1")).toMatchObject({ parentId: "p", name: "C1", start: 0, end: 5 });
    expect(b.data.query().children.get("p")).toEqual(["c1", "c2"]);
    expect(b.data.hasDeferredChildren("p")).toBe(false);
    // Only one further `tasks` publish — materialize touches no other store.
    expect(b.snapshots).toHaveLength(2);
    // The parent is a summary now, so its own row repaints too — it is present in the new
    // snapshot even though it was not itself created.
    expect(addedIds(b.snapshots[1]!, b.snapshots[0]!).sort()).toEqual(["c1", "c2"]);
    expect(b.snapshots[1]!.get("p")).not.toBe(b.snapshots[0]!.get("p"));
    expect(b.data.getTask("p")?.type).toBe("summary");
  });

  it("is idempotent: a second materialize is a no-op", () => {
    const b = boot();
    b.data.load({ tasks: [parent], deferredTasks: [{ parentId: "p", rows: kids }] });
    b.data.materializeChildren("p");
    b.data.materializeChildren("p");
    expect([...b.data.taskIds()]).toEqual(["p", "c1", "c2"]);
    expect(b.snapshots).toHaveLength(2);
  });

  it("forces the bucket's parent over a row's own parentId", () => {
    const b = boot();
    b.data.load<Record<string, unknown>>({
      tasks: [parent],
      deferredTasks: [{ parentId: "p", rows: [{ id: "c1", name: "C1", parentId: "elsewhere" }] }],
    });
    b.data.materializeChildren("p");
    expect(b.data.getTask("c1")?.parentId).toBe("p");
  });

  it("files materialized children after eagerly-loaded siblings", () => {
    const b = boot();
    b.data.load({
      tasks: [parent, { id: "e1", name: "E1", parentId: "p", start: 0, end: 1 }],
      deferredTasks: [{ parentId: "p", rows: kids }],
    });
    b.data.materializeChildren("p");
    expect(b.data.query().children.get("p")).toEqual(["e1", "c1", "c2"]);
  });

  it("chains the fallback key from a row's actual orderKey, not the fallback that minted it", () => {
    // "c1" carries an explicit orderKey far past what the fallback chain would have produced; the
    // next fallback (for "c2") must be computed after *that* actual key, not after the fallback
    // that was offered to "c1" and ignored, or "c2" could sort ahead of "c1" instead of after it.
    const b = boot();
    b.data.load<Record<string, unknown>>({
      tasks: [parent],
      deferredTasks: [
        {
          parentId: "p",
          rows: [
            { id: "c1", name: "C1", start: 0, end: 5, orderKey: "zzzz" },
            { id: "c2", name: "C2", start: 5, end: 10 },
          ],
        },
      ],
    });
    b.data.materializeChildren("p");
    expect(b.data.query().children.get("p")).toEqual(["c1", "c2"]);
    const key1 = b.data.getTask("c1")?.orderKey;
    const key2 = b.data.getTask("c2")?.orderKey;
    expect(key1).toBe("zzzz");
    expect(key1! < key2!).toBe(true);
  });

  it("keeps a nested bucket pending until its parent exists", () => {
    const b = boot();
    b.data.load({
      tasks: [parent],
      deferredTasks: [
        { parentId: "p", rows: [{ id: "c1", name: "C1", start: 0, end: 1 }] },
        { parentId: "c1", rows: [{ id: "g1", name: "G1", start: 0, end: 1 }] },
      ],
    });
    // c1 does not exist yet, so its bucket cannot build.
    b.data.materializeChildren("c1");
    expect(b.data.getTask("g1")).toBeUndefined();
    expect(b.data.hasDeferredChildren("c1")).toBe(true);

    b.data.materializeChildren("p");
    // Materializing p does NOT auto-build c1's bucket — laziness is per level.
    expect(b.data.getTask("g1")).toBeUndefined();
    b.data.materializeChildren("c1");
    expect(b.data.getTask("g1")?.parentId).toBe("c1");
  });

  it("ignores unusable input: unknown parent, bad entries, duplicate ids", () => {
    const b = boot();
    b.data.load({
      tasks: [parent],
      deferredTasks: [
        {
          parentId: "p",
          rows: [
            { id: "p", name: "dup", start: 0, end: 1 },
            { id: "c1", name: "C1", start: 0, end: 1 },
          ],
        },
        { parentId: {} as unknown as TaskId, rows: [{ id: "x", name: "X", start: 0, end: 1 }] },
        { parentId: "nope", rows: [{ id: "y", name: "Y", start: 0, end: 1 }] },
      ],
    });
    b.data.materializeChildren("nope");
    b.data.materializeChildren("p");
    expect([...b.data.taskIds()]).toEqual(["p", "c1"]);
    // The duplicate-id row was skipped; the parent row is untouched.
    expect(b.data.getTask("p")?.name).toBe("P");
  });

  it("drops pending buckets on the next load()", () => {
    const b = boot();
    b.data.load({ tasks: [parent], deferredTasks: [{ parentId: "p", rows: kids }] });
    b.data.load([parent]);
    expect(b.data.hasDeferredChildren("p")).toBe(false);
    b.data.materializeChildren("p");
    expect(b.data.getTask("c1")).toBeUndefined();
  });

  it("reads deferred rows through the load()'s field mapping", () => {
    const b = boot();
    b.data.load(
      { tasks: [{ key: "p", label: "P" }], deferredTasks: [{ parentId: "p", rows: [{ key: "c1", label: "C1" }] }] },
      { task: { id: "key", name: "label" } },
    );
    b.data.materializeChildren("p");
    expect(b.data.getTask("c1")?.name).toBe("C1");
  });
});
