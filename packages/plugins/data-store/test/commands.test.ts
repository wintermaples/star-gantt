import { describe, expect, it } from "vitest";
import {
  buildLinkAdd,
  buildLinkUpdate,
  buildTaskAdd,
  buildTaskMove,
  buildTaskRemove,
  buildTaskSetProgress,
  buildTaskUpdate,
} from "../src/commands";
import { IdGen } from "../src/ids";
import { changedTaskIds, invertPatches } from "../src/patch";
import type { Link, Patch, Task } from "../src/types";
import { makeLink, makeTask, newStore, snapshot } from "./_helpers";

const ids = (): IdGen => new IdGen();

describe("task/move", () => {
  it("builds one reversible update patch", () => {
    const store = newStore([makeTask("a", { start: 0, end: 10 })]);
    const patches = buildTaskMove(store, { id: "a", start: 5, end: 15 });
    expect(patches).toEqual([
      {
        op: "task/update",
        id: "a",
        before: { start: 0, end: 10 },
        after: { start: 5, end: 15 },
      },
    ]);
  });

  it("builds nothing for an unknown task", () => {
    expect(buildTaskMove(newStore(), { id: "nope", start: 1, end: 2 })).toEqual([]);
  });
});

describe("task/setProgress", () => {
  it("captures the previous progress", () => {
    const store = newStore([makeTask("a", { progress: 0.2 })]);
    expect(buildTaskSetProgress(store, { id: "a", progress: 0.8 })).toEqual([
      { op: "task/update", id: "a", before: { progress: 0.2 }, after: { progress: 0.8 } },
    ]);
  });

  it("clamps the progress to the documented 0..1", () => {
    const store = newStore([makeTask("a")]);
    expect(buildTaskSetProgress(store, { id: "a", progress: 1.5 })[0]).toMatchObject({
      after: { progress: 1 },
    });
    expect(buildTaskSetProgress(store, { id: "a", progress: -0.5 })[0]).toMatchObject({
      after: { progress: 0 },
    });
  });

  it("omits `before.progress` when the task had none, so undo removes the field", () => {
    const store = newStore([makeTask("a")]);
    const patches = buildTaskSetProgress(store, { id: "a", progress: 0.8 });
    expect(patches[0]).toEqual({
      op: "task/update",
      id: "a",
      before: {},
      after: { progress: 0.8 },
    });
    store.applyPatch(patches[0] as Patch);
    expect(store.byId.get("a")?.progress).toBe(0.8);
    for (const p of invertPatches(patches)) store.applyPatch(p);
    expect("progress" in store.byId.get("a")!).toBe(false);
  });
});

describe("task/add", () => {
  it("generates an id, defaults the parent and appends by orderKey", () => {
    const store = newStore();
    const patches = buildTaskAdd(store, { task: { name: "first" } }, ids());
    const patch = patches[0] as Extract<Patch, { op: "task/add" }>;
    expect(patch.op).toBe("task/add");
    expect(patch.task.parentId).toBe(null);
    expect(patch.task.name).toBe("first");
    expect(patch.task.start).toBe(0);
    expect(patch.task.end).toBe(0);
    expect(typeof patch.task.id).toBe("string");
    expect(typeof patch.task.orderKey).toBe("string");
  });

  it("honours an explicit id, parent and dates", () => {
    const store = newStore([makeTask("p")]);
    const patches = buildTaskAdd(
      store,
      { task: { id: 7, name: "child", parentId: "p", start: 100, end: 200 } },
      ids(),
    );
    const patch = patches[0] as Extract<Patch, { op: "task/add" }>;
    expect(patch.task.id).toBe(7);
    expect(patch.task.parentId).toBe("p");
    expect(patch.task.start).toBe(100);
    expect(patch.task.end).toBe(200);
  });

  it("places the task at `index` among its siblings", () => {
    const store = newStore();
    const gen = ids();
    for (const name of ["a", "b", "c"]) {
      store.applyPatch(buildTaskAdd(store, { task: { name } }, gen)[0] as Patch);
    }
    const patch = buildTaskAdd(store, { task: { name: "x" }, index: 1 }, gen)[0] as Patch;
    store.applyPatch(patch);
    expect(store.children.get(null)!.map((id) => store.byId.get(id)!.name)).toEqual([
      "a",
      "x",
      "b",
      "c",
    ]);
  });

  it("clamps an out-of-range index", () => {
    const store = newStore();
    const gen = ids();
    store.applyPatch(buildTaskAdd(store, { task: { name: "a" } }, gen)[0] as Patch);
    store.applyPatch(buildTaskAdd(store, { task: { name: "b" }, index: 99 }, gen)[0] as Patch);
    store.applyPatch(buildTaskAdd(store, { task: { name: "c" }, index: -5 }, gen)[0] as Patch);
    expect(store.children.get(null)!.map((id) => store.byId.get(id)!.name)).toEqual([
      "c",
      "a",
      "b",
    ]);
  });

  it("never reuses an existing id", () => {
    const store = newStore([makeTask("t1")]);
    const patch = buildTaskAdd(store, { task: { name: "x" } }, ids())[0] as Extract<
      Patch,
      { op: "task/add" }
    >;
    expect(patch.task.id).not.toBe("t1");
  });
});

describe("task/remove", () => {
  it("removes the whole subtree", () => {
    const store = newStore([
      makeTask("a", { orderKey: "a" }),
      makeTask("a1", { parentId: "a", orderKey: "a" }),
      makeTask("a11", { parentId: "a1", orderKey: "a" }),
      makeTask("b", { orderKey: "b" }),
    ]);
    const patches = buildTaskRemove(store, { ids: ["a"] });
    const removed = patches.map((p) => (p.op === "task/remove" ? p.task.id : p.op));
    expect(removed.sort()).toEqual(["a", "a1", "a11"]);
  });

  it("removes every link touching a removed task", () => {
    const store = newStore(
      [makeTask("a"), makeTask("b", { orderKey: "z" })],
      [makeLink("l1", "a", "b"), makeLink("l2", "b", "a")],
    );
    const patches = buildTaskRemove(store, { ids: ["a"] });
    const links = patches.flatMap((p) => (p.op === "link/remove" ? [p.link.id] : []));
    expect(links.sort()).toEqual(["l1", "l2"]);
  });

  it("restores the subtree and its links on inverse application", () => {
    const store = newStore(
      [
        makeTask("a", { orderKey: "a" }),
        makeTask("a1", { parentId: "a", orderKey: "a" }),
        makeTask("b", { orderKey: "b" }),
      ],
      [makeLink("l1", "a1", "b")],
    );
    const before = snapshot(store);
    const patches = buildTaskRemove(store, { ids: ["a"] });
    for (const p of patches) store.applyPatch(p);
    expect(store.byId.size).toBe(1);
    for (const p of invertPatches(patches)) store.applyPatch(p);
    expect(snapshot(store)).toBe(before);
  });

  it("ignores unknown and duplicated ids", () => {
    const store = newStore([makeTask("a")]);
    expect(buildTaskRemove(store, { ids: ["nope"] })).toEqual([]);
    expect(buildTaskRemove(store, { ids: ["a", "a"] })).toHaveLength(1);
  });
});

describe("task/update — inline edit", () => {
  it("captures the current values as `before`", () => {
    const store = newStore([makeTask("a", { name: "old", start: 1 })]);
    expect(buildTaskUpdate(store, { id: "a", after: { name: "new" } })).toEqual([
      { op: "task/update", id: "a", before: { name: "old" }, after: { name: "new" } },
    ]);
  });

  it("omits absent fields from `before`", () => {
    const store = newStore([makeTask("a")]);
    const patch = buildTaskUpdate(store, { id: "a", after: { type: "milestone" } })[0] as Extract<
      Patch,
      { op: "task/update" }
    >;
    expect(patch.before).toEqual({});
  });

  it("ignores an attempt to change the id", () => {
    const store = newStore([makeTask("a")]);
    expect(buildTaskUpdate(store, { id: "a", after: { id: "b" } })).toEqual([]);
  });

  it("builds nothing for an empty patch or an unknown task", () => {
    const store = newStore([makeTask("a")]);
    expect(buildTaskUpdate(store, { id: "a", after: {} })).toEqual([]);
    expect(buildTaskUpdate(store, { id: "zz", after: { name: "x" } })).toEqual([]);
  });

  describe("`clears`", () => {
    it("forwards `clears`, capturing the cleared key's current value into `before`", () => {
      const store = newStore([makeTask("a", { progress: 0.5 })]);
      expect(buildTaskUpdate(store, { id: "a", after: {}, clears: ["progress"] })).toEqual([
        { op: "task/update", id: "a", before: { progress: 0.5 }, after: {}, clears: ["progress"] },
      ]);
    });

    it("builds a patch from `clears` alone, with an empty `after`", () => {
      const store = newStore([makeTask("a", { calendarId: "cal-1" })]);
      const patches = buildTaskUpdate(store, { id: "a", after: {}, clears: ["calendarId"] });
      expect(patches).toHaveLength(1);
      expect(patches[0]).toMatchObject({ after: {}, clears: ["calendarId"] });
    });

    it("never clears `id`, even when named explicitly", () => {
      const store = newStore([makeTask("a")]);
      expect(buildTaskUpdate(store, { id: "a", after: {}, clears: ["id"] })).toEqual([]);
    });

    it("prefers the `after` assignment when a key is named in both `after` and `clears`", () => {
      const store = newStore([makeTask("a", { progress: 0.5 })]);
      const patch = buildTaskUpdate(store, {
        id: "a",
        after: { progress: 0.9 },
        clears: ["progress"],
      })[0] as Extract<Patch, { op: "task/update" }>;
      expect(patch.after).toEqual({ progress: 0.9 });
      expect(patch.clears).toBeUndefined();
    });

    it("is a no-op for a key the task never had", () => {
      const store = newStore([makeTask("a")]);
      expect(buildTaskUpdate(store, { id: "a", after: {}, clears: ["progress"] })).toEqual([
        { op: "task/update", id: "a", before: {}, after: {}, clears: ["progress"] },
      ]);
    });
  });

  // A key present in the payload with an explicit `undefined` value is not a "set to undefined"
  // request — `clears` is this API's spelling for deletion — so it must not be copied into
  // `after` (which would write a literal `undefined` into the task through `mergeUpdate`).
  it("ignores a payload key whose value is explicitly `undefined`", () => {
    const store = newStore([makeTask("a", { progress: 0.5 })]);
    const patches = buildTaskUpdate(store, {
      id: "a",
      after: { progress: undefined, type: "milestone" } as unknown as Partial<Task>,
    });
    expect(patches).toEqual([
      { op: "task/update", id: "a", before: {}, after: { type: "milestone" } },
    ]);
  });
});

describe("link/add", () => {
  it("generates a link id and defaults no lag", () => {
    const store = newStore([makeTask("a"), makeTask("b", { orderKey: "z" })]);
    const patch = buildLinkAdd(
      store,
      { sourceId: "a", targetId: "b", type: "SS" },
      ids(),
    )[0] as Extract<Patch, { op: "link/add" }>;
    expect(patch.link.sourceId).toBe("a");
    expect(patch.link.targetId).toBe("b");
    expect(patch.link.type).toBe("SS");
    expect("lag" in patch.link).toBe(false);
  });

  it("builds nothing when either endpoint is unknown", () => {
    const store = newStore([makeTask("a")]);
    expect(buildLinkAdd(store, { sourceId: "a", targetId: "zz", type: "FS" }, ids())).toEqual([]);
    expect(buildLinkAdd(store, { sourceId: "zz", targetId: "a", type: "FS" }, ids())).toEqual([]);
  });

  it("carries the lag when given", () => {
    const store = newStore([makeTask("a"), makeTask("b", { orderKey: "z" })]);
    const patch = buildLinkAdd(
      store,
      { sourceId: "a", targetId: "b", type: "FS", lag: -3600000 },
      ids(),
    )[0] as Extract<Patch, { op: "link/add" }>;
    expect(patch.link.lag).toBe(-3600000);
  });

  it("normalizes `lag: 0` to an absent field, so a stored link never carries a zero lag", () => {
    const store = newStore([makeTask("a"), makeTask("b", { orderKey: "z" })]);
    const patch = buildLinkAdd(
      store,
      { sourceId: "a", targetId: "b", type: "FS", lag: 0 },
      ids(),
    )[0] as Extract<Patch, { op: "link/add" }>;
    expect("lag" in patch.link).toBe(false);
  });

  it("drops a non-finite lag, the same unusable-argument treatment as `link/update`", () => {
    const store = newStore([makeTask("a"), makeTask("b", { orderKey: "z" })]);
    for (const lag of [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]) {
      const patch = buildLinkAdd(
        store,
        { sourceId: "a", targetId: "b", type: "FS", lag },
        ids(),
      )[0] as Extract<Patch, { op: "link/add" }>;
      expect("lag" in patch.link).toBe(false);
    }
  });

  it("never reuses an existing link id", () => {
    const store = newStore(
      [makeTask("a"), makeTask("b", { orderKey: "z" }), makeTask("c", { orderKey: "zz" })],
      [makeLink("l1", "a", "b")],
    );
    const patch = buildLinkAdd(
      store,
      { sourceId: "a", targetId: "c", type: "FS" },
      ids(),
    )[0] as Extract<Patch, { op: "link/add" }>;
    expect(patch.link.id).not.toBe("l1");
  });

  describe("duplicate links", () => {
    const linked = (over: Partial<Link> = {}) =>
      newStore(
        [makeTask("a"), makeTask("b", { orderKey: "z" })],
        [{ ...makeLink("l1", "a", "b"), ...over }],
      );

    it("builds nothing when the pair is already linked", () => {
      expect(buildLinkAdd(linked(), { sourceId: "a", targetId: "b", type: "FS" }, ids())).toEqual(
        [],
      );
    });

    it("builds nothing even when the requested type or lag differs", () => {
      expect(buildLinkAdd(linked(), { sourceId: "a", targetId: "b", type: "SS" }, ids())).toEqual(
        [],
      );
      expect(
        buildLinkAdd(linked(), { sourceId: "a", targetId: "b", type: "FS", lag: 3600000 }, ids()),
      ).toEqual([]);
    });

    it("builds nothing for an explicit id either, so no restore path can duplicate a pair", () => {
      expect(
        buildLinkAdd(linked(), { sourceId: "a", targetId: "b", type: "FS", id: "l9" }, ids()),
      ).toEqual([]);
    });

    it("still builds the opposite direction, which is the cycle check's business", () => {
      const patch = buildLinkAdd(
        linked(),
        { sourceId: "b", targetId: "a", type: "FS" },
        ids(),
      )[0] as Extract<Patch, { op: "link/add" }>;
      expect(patch.link.sourceId).toBe("b");
      expect(patch.link.targetId).toBe("a");
    });
  });
});

// One patch, therefore one transaction and one undo step, for an edit that used to need a
// `link/remove` + `link/add` pair.
describe("link/update", () => {
  const linked = (over: Partial<Link> = {}) =>
    newStore(
      [makeTask("a"), makeTask("b", { orderKey: "z" })],
      [{ ...makeLink("l1", "a", "b"), ...over }],
    );

  it("builds exactly one reversible patch for a retype", () => {
    const store = linked();
    const patches = buildLinkUpdate(store, { id: "l1", type: "SS" });
    expect(patches).toEqual([
      {
        op: "link/update",
        before: { id: "l1", sourceId: "a", targetId: "b", type: "FS" },
        after: { id: "l1", sourceId: "a", targetId: "b", type: "SS" },
      },
    ]);
    const before = snapshot(store);
    for (const patch of patches) store.applyPatch(patch);
    expect(store.getLink("l1")?.type).toBe("SS");
    for (const patch of invertPatches(patches)) store.applyPatch(patch);
    expect(snapshot(store)).toBe(before);
  });

  it("keeps the untouched side of the link when only one of `type` / `lag` is given", () => {
    const store = linked({ lag: 86400000 });
    const [patch] = buildLinkUpdate(store, { id: "l1", type: "FF" }) as [
      Extract<Patch, { op: "link/update" }>,
    ];
    expect(patch.after).toEqual({
      id: "l1",
      sourceId: "a",
      targetId: "b",
      type: "FF",
      lag: 86400000,
    });
  });

  it("removes the lag for `lag: 0`, since a zero lag and no lag are the same dependency", () => {
    const store = linked({ lag: 86400000 });
    const [patch] = buildLinkUpdate(store, { id: "l1", lag: 0 }) as [
      Extract<Patch, { op: "link/update" }>,
    ];
    expect("lag" in patch.after).toBe(false);
    store.applyPatch(patch);
    expect("lag" in (store.getLink("l1") as Link)).toBe(false);
  });

  it("round-trips a link added with `lag: 0` exactly through retype and undo", () => {
    const store = newStore([makeTask("a"), makeTask("b", { orderKey: "z" })]);
    for (const patch of buildLinkAdd(
      store,
      { sourceId: "a", targetId: "b", type: "FS", lag: 0, id: "l1" },
      ids(),
    ))
      store.applyPatch(patch);
    expect("lag" in (store.getLink("l1") as Link)).toBe(false);
    expect(buildLinkUpdate(store, { id: "l1", type: "FS", lag: 0 })).toEqual([]);

    const before = snapshot(store);
    const patches = buildLinkUpdate(store, { id: "l1", type: "SS" });
    for (const patch of patches) store.applyPatch(patch);
    expect(store.getLink("l1")?.type).toBe("SS");
    for (const patch of invertPatches(patches)) store.applyPatch(patch);
    expect(snapshot(store)).toBe(before);
    expect("lag" in (store.getLink("l1") as Link)).toBe(false);
  });

  it("keeps both endpoints in the changed-id set, like the other link patches", () => {
    const store = linked();
    expect([...changedTaskIds(buildLinkUpdate(store, { id: "l1", type: "SF" }))].sort()).toEqual([
      "a",
      "b",
    ]);
  });

  it("builds nothing for an unknown link, a non-finite lag or a no-op payload", () => {
    const store = linked({ lag: 5 });
    expect(buildLinkUpdate(store, { id: "nope", type: "SS" })).toEqual([]);
    expect(buildLinkUpdate(store, { id: "l1", lag: Number.NaN })).toEqual([]);
    expect(buildLinkUpdate(store, { id: "l1", type: "FS", lag: 5 })).toEqual([]);
    expect(buildLinkUpdate(store, { id: "l1" })).toEqual([]);
  });

  it("leaves the link's buckets pointing at the updated object", () => {
    const store = linked();
    for (const patch of buildLinkUpdate(store, { id: "l1", type: "SS" })) store.applyPatch(patch);
    expect(store.query().linksByTask.get("a")?.out[0]?.type).toBe("SS");
    expect(store.query().linksByTask.get("b")?.in[0]?.type).toBe("SS");
  });
});
