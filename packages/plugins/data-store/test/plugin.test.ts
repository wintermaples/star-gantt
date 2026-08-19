import { Gantt } from "@stargantt/core";
import type { GanttInstance, PluginContext } from "@stargantt/core";
import { afterEach, describe, expect, it, vi } from "vitest";
import { dataStore } from "../src/index";
import type { DataService, Task, TaskId, Transaction } from "../src/types";
import { createGantt, dataOf, fakeRoot } from "./_helpers";

let gantt: GanttInstance | undefined;

afterEach(() => {
  gantt?.dispose();
  gantt = undefined;
});

function start(): { gantt: GanttInstance; data: DataService } {
  const g = createGantt();
  gantt = g;
  return { gantt: g, data: dataOf(g) };
}

describe("factory shape", () => {
  it("is a factory, not a plain plugin const", () => {
    expect(typeof dataStore).toBe("function");
    expect(typeof dataStore().setup).toBe("function");
  });

  it("accepts an omitted and an empty config alike, producing independent instances", () => {
    const a = dataStore();
    const b = dataStore({});
    expect(a).not.toBe(b);
    expect(a.meta.id).toBe(b.meta.id);
  });

  it("gives each instance its own store, so two charts do not share data", () => {
    const one = Gantt.create({ element: fakeRoot(), plugins: [dataStore()] });
    const two = Gantt.create({ element: fakeRoot(), plugins: [dataStore()] });
    try {
      one.service("stargantt.data").load([{ id: "T1", name: "only in one" }]);
      expect([...two.service("stargantt.data").taskIds()]).toEqual([]);
    } finally {
      one.dispose();
      two.dispose();
    }
  });
});

describe("plugin identity", () => {
  it("declares the spec plugin id and no dependencies", () => {
    expect(dataStore().meta.id).toBe("stargantt.data-store");
    expect(dataStore().meta.dependsOn).toEqual([]);
  });

  it("provides `stargantt.data` and `stargantt.fields`", () => {
    const g = start().gantt;
    const data = g.service("stargantt.data");
    const fields = g.service("stargantt.fields");
    expect(typeof data.getTask).toBe("function");
    expect(typeof data.query).toBe("function");
    expect(typeof fields.definitions).toBe("function");
  });

  it("registers exactly the keys its declaration merging declares", () => {
    const provide: string[] = [];
    const registerCommand: string[] = [];
    const claimKey: [string, string][] = [];
    const define = vi.fn();
    const contribute = vi.fn();
    const on = vi.fn();
    const own = vi.fn();

    const ctx = {
      provide: (k: string) => provide.push(k),
      use: () => {
        throw new Error("data-store must not use any service");
      },
      useOptional: () => undefined,
      defineExtensionPoint: define,
      contribute,
      on,
      emit: () => undefined,
      registerCommand: (k: string) => registerCommand.push(k),
      dispatch: () => undefined,
      claimOrder: () => undefined,
      claimKey: (bag: string, key: string) => claimKey.push([bag, key]),
      claimSlot: () => ({ granted: true }),
      own,
      root: {} as HTMLElement,
      locale: "en",
    } as unknown as PluginContext;

    dataStore().setup(ctx, undefined);

    expect(provide.slice().sort()).toEqual(["stargantt.data", "stargantt.fields"]);
    expect(registerCommand.slice().sort()).toEqual([
      "assignment/remove",
      "assignment/set",
      "history/apply",
      "link/add",
      "link/remove",
      "link/update",
      "resource/add",
      "resource/remove",
      "resource/update",
      "task/add",
      "task/move",
      "task/remove",
      "task/setProgress",
      "task/update",
    ]);
    // The plugin defines and consumes no extension point.
    expect(define).not.toHaveBeenCalled();
    expect(contribute).not.toHaveBeenCalled();
    // One `ctx.on` — the `data/willApplyTransaction` handler that stitches `fields.setValues`'
    // per-task patches onto one transaction.
    expect(on).toHaveBeenCalledTimes(1);
    expect(on.mock.calls[0]?.[0]).toBe("data/willApplyTransaction");
    // The one reserved `task.meta` key `fields` owns.
    expect(claimKey).toEqual([["task.meta", "customFields"]]);
    expect(own).toHaveBeenCalledTimes(1);
  });
});

describe("DataService", () => {
  it("loads already-normalized tasks without a mapping", () => {
    const { data } = start();
    data.load([
      { id: "a", parentId: null, name: "A", start: 0, end: 10 },
      { id: "b", parentId: "a", name: "B", start: 2, end: 5 },
    ]);
    expect(data.getTask("a")?.name).toBe("A");
    expect([...data.taskIds()]).toEqual(["a", "b"]);
    expect(data.query().children.get("a")).toEqual(["b"]);
  });

  it("applies a field mapping of names and functions", () => {
    const { data } = start();
    data.load(
      [{ code: 1, parent: null, name: "A", beginDate: 100, dueDate: 200, pct: 40 }],
      {
        task: {
          id: "code",
          parentId: "parent",
          start: "beginDate",
          end: "dueDate",
          progress: (raw: { pct: number }) => raw.pct / 100,
        },
      },
    );
    const task = data.getTask(1) as Task;
    expect(task.start).toBe(100);
    expect(task.end).toBe(200);
    expect(task.progress).toBeCloseTo(0.4);
  });

  it("reads an item as a link when both endpoints map", () => {
    const { data } = start();
    data.load(
      [
        { code: "a", name: "A", beginDate: 0, dueDate: 1 },
        { code: "b", name: "B", beginDate: 0, dueDate: 1 },
        { from: "a", to: "b", kind: "SS" },
      ],
      {
        task: { id: "code", start: "beginDate", end: "dueDate" },
        link: { sourceId: "from", targetId: "to", type: (raw: { kind?: string }) => raw.kind },
      },
    );
    expect([...data.taskIds()]).toEqual(["a", "b"]);
    const links = [...data.links.get().values()];
    expect(links).toHaveLength(1);
    expect(links[0]?.sourceId).toBe("a");
    expect(links[0]?.type).toBe("SS");
    expect(data.query().linksByTask.get("b")?.in).toHaveLength(1);
  });

  it("gives every loaded task an orderKey and keeps raw order per parent", () => {
    const { data } = start();
    data.load([
      { id: "c", name: "C", start: 0, end: 1 },
      { id: "a", name: "A", start: 0, end: 1 },
      { id: "b", name: "B", start: 0, end: 1 },
    ]);
    expect(data.query().children.get(null)).toEqual(["c", "a", "b"]);
    for (const id of data.taskIds()) expect(typeof data.getTask(id)?.orderKey).toBe("string");
  });

  it("coerces a Date at the load boundary to epoch ms", () => {
    const { data } = start();
    const d = new Date(86400000);
    data.load([{ id: "a", name: "A", start: d, end: d }]);
    expect(data.getTask("a")?.start).toBe(86400000);
  });

  it("defaults a missing link type to FS", () => {
    const { data } = start();
    data.load([{ sourceId: "a", targetId: "b" }]);
    expect([...data.links.get().values()][0]?.type).toBe("FS");
  });

  it("replaces the previous contents", () => {
    const { data } = start();
    data.load([{ id: "a", name: "A", start: 0, end: 1 }]);
    data.load([{ id: "b", name: "B", start: 0, end: 1 }]);
    expect([...data.taskIds()]).toEqual(["b"]);
  });

  it("publishes the tasks store once per load, keyed by the real loaded tasks", () => {
    const { data } = start();
    const seen: TaskId[][] = [];
    data.tasks.subscribe((next) => seen.push([...next.keys()]));
    data.load([
      { id: "a", name: "A", start: 0, end: 1 },
      // The link's target names no real task — the tasks store only ever carries real entities.
      { sourceId: "a", targetId: "z" },
    ]);
    expect(seen).toHaveLength(1);
    expect(seen[0]).toEqual(["a"]);
  });

  it("publishes the tasks store again on reload, reflecting only the survivors", () => {
    const { data } = start();
    data.load([{ id: "a", name: "A", start: 0, end: 1 }]);
    const seen: TaskId[][] = [];
    data.tasks.subscribe((next) => seen.push([...next.keys()]));
    data.load([{ id: "b", name: "B", start: 0, end: 1 }]);
    expect(seen).toEqual([["b"]]);
  });

  it("drops a raw link whose endpoints do not resolve to an id", () => {
    const { data } = start();
    data.load([
      { id: "a", name: "A", start: 0, end: 1 },
      { sourceId: {}, targetId: {} },
    ]);
    expect([...data.links.get().values()]).toEqual([]);
    expect(data.query().linksByTask.size).toBe(0);
  });

  it("clamps a loaded progress to the documented 0..1", () => {
    const { data } = start();
    data.load([{ id: "a", name: "A", start: 0, end: 1, progress: 42 }]);
    expect(data.getTask("a")?.progress).toBe(1);
  });

  it("toJSON returns tasks, links and calendars", () => {
    const { data } = start();
    data.load([
      { id: "a", name: "A", start: 0, end: 1 },
      { id: "b", name: "B", start: 0, end: 1 },
      { sourceId: "a", targetId: "b" },
    ]);
    const json = data.toJSON();
    expect(json.tasks.map((t) => t.id)).toEqual(["a", "b"]);
    expect(json.links).toHaveLength(1);
    expect(json.calendars).toEqual([]);
  });

  it("query() exposes the indexes", () => {
    const { data } = start();
    data.load([{ id: "a", name: "A", start: 0, end: 1 }]);
    const view = data.query();
    expect(view.byId.size).toBe(1);
    expect(view.children.get(null)).toEqual(["a"]);
    expect(view.calendars.size).toBe(0);
  });
});

describe("commands — apply flow", () => {
  function seed(data: DataService): void {
    data.load([
      { id: "a", name: "A", start: 0, end: 10 },
      { id: "b", name: "B", start: 20, end: 30 },
    ]);
  }

  it("task/move updates the task and publishes the tasks store exactly once", () => {
    const { gantt: g, data } = start();
    seed(data);
    let calls = 0;
    data.tasks.subscribe(() => void calls++);
    g.dispatch("task/move", { id: "a", start: 5, end: 15 });
    expect(data.getTask("a")).toMatchObject({ start: 5, end: 15 });
    expect(calls).toBe(1);
  });

  it("task/setProgress updates progress", () => {
    const { gantt: g, data } = start();
    seed(data);
    g.dispatch("task/setProgress", { id: "a", progress: 0.5 });
    expect(data.getTask("a")?.progress).toBe(0.5);
  });

  it("task/add inserts a task at the requested sibling index", () => {
    const { gantt: g, data } = start();
    seed(data);
    g.dispatch("task/add", { task: { id: "x", name: "X" }, index: 1 });
    expect(data.query().children.get(null)).toEqual(["a", "x", "b"]);
    expect(data.getTask("x")?.name).toBe("X");
  });

  it("history/apply applies an ordered patch list as one transaction, unbuilt", () => {
    const { gantt: g, data } = start();
    seed(data);
    let bursts = 0;
    data.tasks.subscribe(() => void bursts++);
    let seenOrigin: string | undefined;
    let seenPatchCount: number | undefined;
    g.on("data/willApplyTransaction", (e) => {
      seenOrigin = e.transaction.origin;
      seenPatchCount = e.transaction.patches.length;
    });

    g.dispatch("history/apply", {
      patches: [
        { op: "task/update", id: "a", before: { start: 0 }, after: { start: 5 } },
        { op: "task/remove", task: data.getTask("b") as Task },
      ],
    });

    expect(bursts).toBe(1);
    expect(data.getTask("a")?.start).toBe(5);
    expect(data.getTask("b")).toBeUndefined();
    expect(seenOrigin).toBe("history");
    expect(seenPatchCount).toBe(2);
  });

  it('history/apply defaults its origin to "history", not "user"', () => {
    const { gantt: g, data } = start();
    seed(data);
    let seenOrigin: string | undefined;
    g.on("data/willApplyTransaction", (e) => {
      seenOrigin = e.transaction.origin;
    });
    g.dispatch("history/apply", {
      patches: [{ op: "task/update", id: "a", before: { start: 0 }, after: { start: 5 } }],
    });
    expect(seenOrigin).toBe("history");
  });

  it("task/remove deletes the subtree and its links", () => {
    const { gantt: g, data } = start();
    data.load([
      { id: "a", name: "A", start: 0, end: 1 },
      { id: "a1", parentId: "a", name: "A1", start: 0, end: 1 },
      { id: "b", name: "B", start: 0, end: 1 },
      { sourceId: "a1", targetId: "b" },
    ]);
    g.dispatch("task/remove", { ids: ["a"] });
    expect([...data.taskIds()]).toEqual(["b"]);
    expect([...data.links.get().values()]).toEqual([]);
    expect(data.query().linksByTask.get("b")?.in ?? []).toEqual([]);
  });

  it("task/update writes the given fields", () => {
    const { gantt: g, data } = start();
    seed(data);
    g.dispatch("task/update", { id: "a", after: { name: "renamed" } });
    expect(data.getTask("a")?.name).toBe("renamed");
  });

  it("link/add creates a link and indexes it", () => {
    const { gantt: g, data } = start();
    seed(data);
    g.dispatch("link/add", { sourceId: "a", targetId: "b", type: "FS", lag: 1000 });
    const links = [...data.links.get().values()];
    expect(links).toHaveLength(1);
    expect(links[0]).toMatchObject({ sourceId: "a", targetId: "b", type: "FS", lag: 1000 });
    expect(data.query().linksByTask.get("a")?.out).toHaveLength(1);
  });

  it("load() normalizes a link's `lag: 0` to an absent field, like the command builders", () => {
    const { data } = start();
    data.load([
      { id: "a", name: "A", start: 0, end: 1 },
      { id: "b", name: "B", start: 0, end: 1 },
      { sourceId: "a", targetId: "b", lag: 0 },
    ]);
    const links = [...data.links.get().values()];
    expect(links).toHaveLength(1);
    expect("lag" in links[0]!).toBe(false);
  });

  it("load() drops a link's non-finite lag, like the command builders", () => {
    const { data } = start();
    data.load([
      { id: "a", name: "A", start: 0, end: 1 },
      { id: "b", name: "B", start: 0, end: 1 },
      { sourceId: "a", targetId: "b", lag: Number.NaN },
    ]);
    const links = [...data.links.get().values()];
    expect(links).toHaveLength(1);
    expect("lag" in links[0]!).toBe(false);
  });

  it("load() keeps only the first link of a repeated pair", () => {
    const { data } = start();
    data.load([
      { id: "a", name: "A", start: 0, end: 1 },
      { id: "b", name: "B", start: 0, end: 1 },
      { id: "l1", sourceId: "a", targetId: "b", type: "FS" },
      { id: "l2", sourceId: "a", targetId: "b", type: "FS" },
      { id: "l3", sourceId: "a", targetId: "b", type: "SS" },
      { id: "l4", sourceId: "b", targetId: "a", type: "FS" },
    ]);
    const links = [...data.links.get().values()];
    expect(links.map((l) => l.id)).toEqual(["l1", "l4"]);
    expect(data.query().linksByTask.get("a")?.out).toHaveLength(1);
  });

  // A raw row whose id collides with one already loaded must not crash the load mid-way
  // (`Store#addTask` throwing after `store.clear()` would otherwise leave the store half-loaded,
  // with rows past the duplicate simply missing).
  it("load() skips a task row whose id duplicates one already loaded", () => {
    const { data } = start();
    data.load([
      { id: "a", name: "first A", start: 0, end: 1 },
      { id: "a", name: "second A", start: 0, end: 1 },
      { id: "b", name: "B", start: 0, end: 1 },
    ]);
    expect([...data.taskIds()]).toEqual(["a", "b"]);
    expect(data.getTask("a")?.name).toBe("first A");
  });

  it("load() skips a resource row whose id duplicates one already loaded", () => {
    const { data } = start();
    data.load({
      tasks: [{ id: "a", name: "A", start: 0, end: 1 }],
      resources: [
        { id: "r1", name: "first R1" },
        { id: "r1", name: "second R1" },
        { id: "r2", name: "R2" },
      ],
    });
    const resources = [...data.resources.get().values()];
    expect(resources.map((r) => r.id)).toEqual(["r1", "r2"]);
    expect(resources[0]?.name).toBe("first R1");
  });

  it("publishes no store at all when nothing can change", () => {
    const { gantt: g, data } = start();
    seed(data);
    const will = vi.fn();
    const tasksChanged = vi.fn();
    g.on("data/willApplyTransaction", will);
    data.tasks.subscribe(tasksChanged);
    g.dispatch("task/move", { id: "missing", start: 0, end: 1 });
    g.dispatch("task/update", { id: "a", after: {} });
    g.dispatch("task/remove", { ids: [] });
    expect(will).not.toHaveBeenCalled();
    expect(tasksChanged).not.toHaveBeenCalled();
  });
});

describe("data/willApplyTransaction", () => {
  it("fires before the patches are applied and carries the transaction", () => {
    const { gantt: g, data } = start();
    data.load([{ id: "a", name: "A", start: 0, end: 10 }]);

    let seen: Transaction | undefined;
    let startDuringWill: number | undefined;
    g.on("data/willApplyTransaction", (e) => {
      seen = e.transaction;
      startDuringWill = data.getTask("a")?.start;
    });
    g.dispatch("task/move", { id: "a", start: 7, end: 17 });

    expect(startDuringWill).toBe(0);
    expect(seen?.origin).toBe("user");
    expect(typeof seen?.id).toBe("string");
    expect(seen?.label).toBe("Move task");
    expect(seen?.patches).toHaveLength(1);
    expect(data.getTask("a")?.start).toBe(7);
  });

  it("leaves coalesceKey unset when the payload does not carry one", () => {
    const { gantt: g, data } = start();
    data.load([{ id: "a", name: "A", start: 0, end: 10 }]);
    const keys: (string | undefined)[] = [];
    g.on("data/willApplyTransaction", (e) => keys.push(e.transaction.coalesceKey));
    g.dispatch("task/move", { id: "a", start: 1, end: 2 });
    g.dispatch("task/move", { id: "a", start: 3, end: 4 });
    expect(keys).toEqual([undefined, undefined]);
  });

  it("stamps task/move's coalesceKey verbatim onto the transaction", () => {
    const { gantt: g, data } = start();
    data.load([{ id: "a", name: "A", start: 0, end: 10 }]);
    let seen: string | undefined;
    g.on("data/willApplyTransaction", (e) => {
      seen = e.transaction.coalesceKey;
    });
    g.dispatch("task/move", { id: "a", start: 1, end: 2, coalesceKey: "drag-1" });
    expect(seen).toBe("drag-1");
  });

  it("stamps task/setProgress's coalesceKey verbatim onto the transaction", () => {
    const { gantt: g, data } = start();
    data.load([{ id: "a", name: "A", start: 0, end: 10 }]);
    let seen: string | undefined;
    g.on("data/willApplyTransaction", (e) => {
      seen = e.transaction.coalesceKey;
    });
    g.dispatch("task/setProgress", { id: "a", progress: 0.5, coalesceKey: "drag-2" });
    expect(seen).toBe("drag-2");
  });

  it("is cancelable — preventDefault() aborts the whole transaction", () => {
    const { gantt: g, data } = start();
    data.load([{ id: "a", name: "A", start: 0, end: 10 }]);
    const tasksChanged = vi.fn();
    data.tasks.subscribe(tasksChanged);
    g.on("data/willApplyTransaction", (e) => e.preventDefault());
    g.dispatch("task/move", { id: "a", start: 7, end: 17 });
    expect(data.getTask("a")?.start).toBe(0);
    expect(tasksChanged).not.toHaveBeenCalled();
  });

  it("lets a handler append follow-on patches to the same transaction", () => {
    const { gantt: g, data } = start();
    data.load([
      { id: "a", name: "A", start: 0, end: 10 },
      { id: "b", name: "B", start: 20, end: 30 },
    ]);
    let bursts = 0;
    data.tasks.subscribe(() => void bursts++);
    g.on("data/willApplyTransaction", (e) => {
      e.transaction.patches.push({
        op: "task/update",
        id: "b",
        before: { start: 20, end: 30 },
        after: { start: 25, end: 35 },
      });
    });
    g.dispatch("task/move", { id: "a", start: 5, end: 15 });

    expect(data.getTask("a")?.start).toBe(5);
    expect(data.getTask("b")?.start).toBe(25);
    expect(bursts).toBe(1);
  });

  it("applies nothing when a handler empties the patch list", () => {
    const { gantt: g, data } = start();
    data.load([{ id: "a", name: "A", start: 0, end: 10 }]);
    const tasksChanged = vi.fn();
    data.tasks.subscribe(tasksChanged);
    g.on("data/willApplyTransaction", (e) => {
      e.transaction.patches.length = 0;
    });
    g.dispatch("task/move", { id: "a", start: 7, end: 17 });
    expect(data.getTask("a")?.start).toBe(0);
    expect(tasksChanged).not.toHaveBeenCalled();
  });
});

// docs/specs/plugins/data-store.md "Apply flow" / "Events" — the authoritative post-apply settle
// signal: the will-hook + burst pairing undo-redo could use instead is unsound under
// cancellation, a throwing apply, and nested dispatch from a will-handler.
describe("data/didApplyTransaction", () => {
  it("fires once, after the tasks burst, carrying the final patch list", () => {
    const { gantt: g, data } = start();
    data.load([
      { id: "a", name: "A", start: 0, end: 10 },
      { id: "b", name: "B", start: 20, end: 30 },
    ]);
    const order: string[] = [];
    data.tasks.subscribe(() => order.push("burst"));
    g.on("data/willApplyTransaction", (e) => {
      // Follow-on patch appended in the will phase — the settled event must reflect it.
      e.transaction.patches.push({
        op: "task/update",
        id: "b",
        before: { start: 20, end: 30 },
        after: { start: 25, end: 35 },
      });
    });
    let seen: Transaction | undefined;
    g.on("data/didApplyTransaction", (e) => {
      order.push("did");
      seen = e.transaction;
    });

    g.dispatch("task/move", { id: "a", start: 5, end: 15 });

    expect(order).toEqual(["burst", "did"]);
    expect(seen?.patches).toHaveLength(2);
    expect(seen?.label).toBe("Move task");
  });

  it("never fires for a transaction cancelled in the will phase", () => {
    const { gantt: g, data } = start();
    data.load([{ id: "a", name: "A", start: 0, end: 10 }]);
    const did = vi.fn();
    g.on("data/didApplyTransaction", did);
    g.on("data/willApplyTransaction", (e) => e.preventDefault());

    g.dispatch("task/move", { id: "a", start: 5, end: 15 });

    expect(did).not.toHaveBeenCalled();
  });

  it("never fires when a will-handler empties the patch list", () => {
    const { gantt: g, data } = start();
    data.load([{ id: "a", name: "A", start: 0, end: 10 }]);
    const did = vi.fn();
    g.on("data/didApplyTransaction", did);
    g.on("data/willApplyTransaction", (e) => {
      e.transaction.patches.length = 0;
    });

    g.dispatch("task/move", { id: "a", start: 5, end: 15 });

    expect(did).not.toHaveBeenCalled();
  });

  it("never fires for a command that builds an empty patch list (no transaction at all)", () => {
    const { gantt: g } = start();
    const did = vi.fn();
    g.on("data/didApplyTransaction", did);

    g.dispatch("task/move", { id: "missing", start: 0, end: 1 });

    expect(did).not.toHaveBeenCalled();
  });

  it("never fires for a bulk load", () => {
    const { data } = start();
    const did = vi.fn();
    gantt?.on("data/didApplyTransaction", did);

    data.load([{ id: "a", name: "A", start: 0, end: 10 }]);

    expect(did).not.toHaveBeenCalled();
  });

  it("never fires when the atomic apply throws", () => {
    const { gantt: g, data } = start();
    data.load([{ id: "a", name: "A", start: 0, end: 10 }]);
    const did = vi.fn();
    g.on("data/didApplyTransaction", did);
    const errors: { pluginId: string }[] = [];
    g.on("core/pluginError", (e) => errors.push({ pluginId: e.pluginId }));

    // A raw `task/add` patch appended in the will phase bypasses `buildTaskAdd`'s duplicate-id
    // guard and reaches `Store#addTask` directly, which throws for an id already in the store —
    // a genuine throwing apply, as opposed to the uniform no-op a duplicate `task/add` *command*
    // produces (see "failure handling" below).
    g.on("data/willApplyTransaction", (e) => {
      e.transaction.patches.push({ op: "task/add", task: { id: "a", parentId: null, name: "dup", start: 0, end: 1 } });
    });

    g.dispatch("task/move", { id: "a", start: 5, end: 15 });

    expect(did).not.toHaveBeenCalled();
    expect(errors).toHaveLength(1);
    // The move itself never committed either — the whole transaction, including the leading
    // task/update patch, is atomic and the throw aborts it before any store publish.
    expect(data.getTask("a")?.start).toBe(0);
  });

  it("fires exactly once per applied transaction, in dispatch order", () => {
    const { gantt: g, data } = start();
    data.load([{ id: "a", name: "A", start: 0, end: 10 }]);
    const labels: string[] = [];
    g.on("data/didApplyTransaction", (e) => labels.push(e.transaction.label));

    g.dispatch("task/move", { id: "a", start: 5, end: 15 });
    g.dispatch("task/setProgress", { id: "a", progress: 0.5 });

    expect(labels).toEqual(["Move task", "Set progress"]);
    expect(data.getTask("a")?.progress).toBe(0.5);
  });

  // A nested dispatch made from inside a will-handler is its own, independent, fully-synchronous
  // apply (build → will-event → apply → burst → did-event) that runs to completion — settling —
  // entirely before the *outer* transaction's own will-event handler returns, and therefore
  // entirely before the outer transaction's own apply/burst/did-event.
  it("settles a nested dispatch from a will-handler before the outer transaction", () => {
    const { gantt: g, data } = start();
    data.load([
      { id: "a", name: "A", start: 0, end: 10 },
      { id: "b", name: "B", start: 20, end: 30 },
    ]);
    const settled: string[] = [];
    g.on("data/didApplyTransaction", (e) => settled.push(e.transaction.label));
    let nested = false;
    g.on("data/willApplyTransaction", (e) => {
      if (nested || e.transaction.label !== "Move task") return;
      nested = true;
      g.dispatch("task/setProgress", { id: "b", progress: 0.9 });
    });

    g.dispatch("task/move", { id: "a", start: 5, end: 15 });

    expect(settled).toEqual(["Set progress", "Move task"]);
    expect(data.getTask("a")?.start).toBe(5);
    expect(data.getTask("b")?.progress).toBe(0.9);
  });
});

describe("failure handling", () => {
  // A `task/add` naming an id already in the store is a silent no-op, uniform with `link/add` /
  // `resource/add`, so it no longer reaches `Store#addTask` and throws.
  it("silently no-ops a task/add whose id is already taken, rather than throwing", () => {
    const { gantt: g, data } = start();
    data.load([{ id: "a", name: "A", start: 0, end: 10 }]);

    const errors: { pluginId: string }[] = [];
    g.on("core/pluginError", (e) => errors.push({ pluginId: e.pluginId }));
    const tasksChanged = vi.fn();
    data.tasks.subscribe(tasksChanged);

    g.dispatch("task/add", { task: { id: "a", name: "duplicate" } });

    expect(errors).toEqual([]);
    expect(data.getTask("a")?.name).toBe("A");
    expect([...data.taskIds()]).toEqual(["a"]);
    expect(tasksChanged).not.toHaveBeenCalled();
  });
});

describe("resource ownership", () => {
  it("releases the store when the gantt is disposed", () => {
    const g = createGantt();
    const data = dataOf(g);
    data.load([{ id: "a", name: "A", start: 0, end: 1 }]);
    const view = data.query();
    expect(view.byId.size).toBe(1);
    g.dispose();
    expect(view.byId.size).toBe(0);
    expect(view.children.size).toBe(0);
  });
});

describe("link/remove and the identity a link is re-created under", () => {
  function seedPair(data: DataService): void {
    data.load([
      { id: "a", name: "A", start: 0, end: 10 },
      { id: "b", name: "B", start: 20, end: 30 },
    ]);
  }

  it("deletes the named link and clears it out of both endpoints' buckets", () => {
    const { gantt: g, data } = start();
    seedPair(data);
    g.dispatch("link/add", { sourceId: "a", targetId: "b", type: "FS" });
    const id = [...data.links.get().values()][0]?.id as string;

    g.dispatch("link/remove", { ids: [id] });

    expect([...data.links.get().values()]).toEqual([]);
    expect(data.query().linksByTask.get("a")?.out ?? []).toEqual([]);
    expect(data.query().linksByTask.get("b")?.in ?? []).toEqual([]);
  });

  it("produces no transaction for ids that name no link", () => {
    const { gantt: g, data } = start();
    seedPair(data);
    const will = vi.fn();
    g.on("data/willApplyTransaction", will);
    g.dispatch("link/remove", { ids: ["nope"] });
    expect(will).not.toHaveBeenCalled();
  });

  it("removes each link once however often its id is repeated", () => {
    const { gantt: g, data } = start();
    seedPair(data);
    g.dispatch("link/add", { sourceId: "a", targetId: "b", type: "FS" });
    const id = [...data.links.get().values()][0]?.id as string;

    let patchCount = 0;
    g.on("data/willApplyTransaction", (e) => (patchCount = e.transaction.patches.length));
    g.dispatch("link/remove", { ids: [id, id, id] });

    expect(patchCount).toBe(1);
    expect([...data.links.get().values()]).toEqual([]);
  });

  it("re-creates a removed link under its original id, type and lag", () => {
    const { gantt: g, data } = start();
    seedPair(data);
    g.dispatch("link/add", { sourceId: "a", targetId: "b", type: "SS", lag: 500 });
    const original = [...data.links.get().values()][0] as { id: string };

    g.dispatch("link/remove", { ids: [original.id] });
    g.dispatch("link/add", {
      id: original.id,
      sourceId: "a",
      targetId: "b",
      type: "SS",
      lag: 500,
    });

    expect([...data.links.get().values()]).toEqual([original]);
  });

  it("creates nothing when the requested id is already in use", () => {
    const { gantt: g, data } = start();
    seedPair(data);
    g.dispatch("link/add", { sourceId: "a", targetId: "b", type: "FS" });
    const id = [...data.links.get().values()][0]?.id as string;

    g.dispatch("link/add", { id, sourceId: "b", targetId: "a", type: "SS" });

    expect([...data.links.get().values()]).toHaveLength(1);
    expect([...data.links.get().values()][0]).toMatchObject({
      sourceId: "a",
      targetId: "b",
      type: "FS",
    });
  });
});

describe("transaction provenance and apply confirmation", () => {
  function seedOne(data: DataService): void {
    data.load([{ id: "a", name: "A", start: 0, end: 10 }]);
  }

  it("stamps a command's origin onto the transaction it produces", () => {
    const { gantt: g, data } = start();
    seedOne(data);
    const origins: string[] = [];
    g.on("data/willApplyTransaction", (e) => origins.push(e.transaction.origin));

    g.dispatch("task/update", { id: "a", after: { name: "X" }, origin: "history" });
    g.dispatch("task/update", { id: "a", after: { name: "Y" } });

    expect(origins).toEqual(["history", "user"]);
  });

  // The store carries no `transaction` on its publications — a consumer that needs the identity
  // pairs the will-event (fires first) with the same-stack `tasks` publish that follows it
  // (docs/specs/plugins/data-store.md — Apply flow). Burst ordering itself is covered in
  // `stores.test.ts`; this pins only that the pairing is possible.
  it("lets a consumer pair the will-event transaction with the following tasks publish", () => {
    const { gantt: g, data } = start();
    seedOne(data);
    let remembered: Transaction | undefined;
    let committed: Transaction | undefined;
    g.on("data/willApplyTransaction", (e) => {
      remembered = e.transaction;
    });
    data.tasks.subscribe(() => {
      committed = remembered;
    });

    g.dispatch("task/move", { id: "a", start: 5, end: 15 });

    expect(committed).toBeDefined();
    expect(committed?.label).toBe("Move task");
    expect(committed?.patches).toHaveLength(1);
  });

  it("fires no will-event for a bulk load, which is not a transaction", () => {
    const { data } = start();
    const will = vi.fn();
    gantt?.on("data/willApplyTransaction", will);
    seedOne(data);
    expect(will).not.toHaveBeenCalled();
  });

  it("never reaches the tasks publish when the transaction is cancelled", () => {
    const { gantt: g, data } = start();
    seedOne(data);
    const tasksChanged = vi.fn();
    g.on("data/willApplyTransaction", (e) => e.preventDefault());
    data.tasks.subscribe(tasksChanged);
    g.dispatch("task/move", { id: "a", start: 5, end: 15 });
    expect(tasksChanged).not.toHaveBeenCalled();
  });
});

// The whole edit is one transaction, so an undo UI keyed on transactions takes it back in a
// single step.
describe("link/update — one transaction per link edit", () => {
  function bootLinked(): { gantt: GanttInstance; data: DataService; applied: Transaction[] } {
    const { gantt: g, data } = start();
    data.load({
      tasks: [
        { id: "a", name: "A", start: 0, end: 10 },
        { id: "b", name: "B", start: 0, end: 10 },
      ],
      links: [{ id: "l1", sourceId: "a", targetId: "b", type: "FS" }],
    });
    const applied: Transaction[] = [];
    g.on("data/willApplyTransaction", (e) => applied.push(e.transaction));
    return { gantt: g, data, applied };
  }

  it("retypes and re-lags in a single transaction, keeping the link's identity", () => {
    const { gantt: g, data, applied } = bootLinked();
    g.dispatch("link/update", { id: "l1", type: "SS", lag: 86400000 });

    expect(applied).toHaveLength(1);
    expect(applied[0]?.patches).toHaveLength(1);
    expect(applied[0]?.label).toBe("Update link");
    const link = [...data.links.get().values()][0];
    expect(link).toEqual({
      id: "l1",
      sourceId: "a",
      targetId: "b",
      type: "SS",
      lag: 86400000,
    });
  });

  it("publishes the links store once and stamps the provenance", () => {
    const { gantt: g, data, applied } = bootLinked();
    let linksCalls = 0;
    data.links.subscribe(() => void linksCalls++);
    g.dispatch("link/update", { id: "l1", type: "FF", origin: "api" });
    expect(linksCalls).toBe(1);
    expect(applied[0]?.origin).toBe("api");
  });

  it("produces no transaction at all when the payload changes nothing", () => {
    const { gantt: g, applied } = bootLinked();
    g.dispatch("link/update", { id: "l1", type: "FS" });
    g.dispatch("link/update", { id: "unknown", type: "SS" });
    expect(applied).toEqual([]);
  });
});
