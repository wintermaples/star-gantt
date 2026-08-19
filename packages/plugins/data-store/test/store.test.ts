import { describe, expect, it } from "vitest";
import { invertPatches } from "../src/patch";
import { Store } from "../src/store";
import type { Patch, Task, Transaction } from "../src/types";
import { makeLink, makeTask, newStore, snapshot } from "./_helpers";

function tx(patches: Patch[]): Transaction {
  return { id: "tx1", label: "t", patches, origin: "user" };
}

describe("Store indexes", () => {
  it("indexes a task by id and under its parent", () => {
    const store = newStore([makeTask("a"), makeTask("a1", { parentId: "a", orderKey: "b" })]);
    expect(store.byId.get("a1")?.name).toBe("task a1");
    expect(store.children.get(null)).toEqual(["a"]);
    expect(store.children.get("a")).toEqual(["a1"]);
  });

  it("keeps siblings in orderKey order regardless of insertion order", () => {
    const store = newStore([
      makeTask("c", { orderKey: "c" }),
      makeTask("a", { orderKey: "a" }),
      makeTask("b", { orderKey: "b" }),
    ]);
    expect(store.children.get(null)).toEqual(["a", "b", "c"]);
  });

  it("is stable for equal keys", () => {
    const store = newStore([
      makeTask("x", { orderKey: "a" }),
      makeTask("y", { orderKey: "a" }),
      makeTask("z", { orderKey: "a" }),
    ]);
    expect(store.children.get(null)).toEqual(["x", "y", "z"]);
  });

  it("buckets links in and out per task", () => {
    const store = newStore([makeTask("a"), makeTask("b")], [makeLink("l1", "a", "b")]);
    expect(store.linksByTask.get("a")?.out.map((l) => l.id)).toEqual(["l1"]);
    expect(store.linksByTask.get("a")?.in).toEqual([]);
    expect(store.linksByTask.get("b")?.in.map((l) => l.id)).toEqual(["l1"]);
  });

  it("rejects a duplicate task id", () => {
    const store = newStore([makeTask("a")]);
    expect(() => store.applyPatch({ op: "task/add", task: makeTask("a") })).toThrow(
      /already exists/,
    );
  });

  it("rejects a duplicate link id", () => {
    const store = newStore([], [makeLink("l1", "a", "b")]);
    expect(() => store.applyPatch({ op: "link/add", link: makeLink("l1", "a", "b") })).toThrow(
      /already exists/,
    );
  });

  it("rejects updating or removing an unknown task", () => {
    const store = new Store();
    expect(() =>
      store.applyPatch({ op: "task/update", id: "nope", before: {}, after: { start: 1 } }),
    ).toThrow(/does not exist/);
    expect(() => store.applyPatch({ op: "task/remove", task: makeTask("nope") })).toThrow(
      /does not exist/,
    );
  });

  it("removes a task from its sibling array", () => {
    const store = newStore([makeTask("a", { orderKey: "a" }), makeTask("b", { orderKey: "b" })]);
    store.applyPatch({ op: "task/remove", task: store.byId.get("a")! });
    expect(store.children.get(null)).toEqual(["b"]);
    expect(store.byId.has("a")).toBe(false);
  });

  it("removes a link from both buckets", () => {
    const store = newStore([makeTask("a"), makeTask("b")], [makeLink("l1", "a", "b")]);
    store.applyPatch({ op: "link/remove", link: makeLink("l1", "a", "b") });
    expect(store.linksByTask.get("a")?.out ?? []).toEqual([]);
    expect(store.linkCount()).toBe(0);
  });

  it("re-indexes on a parent change", () => {
    const store = newStore([makeTask("a", { orderKey: "a" }), makeTask("b", { orderKey: "b" })]);
    store.applyPatch({
      op: "task/update",
      id: "b",
      before: { parentId: null },
      after: { parentId: "a" },
    });
    expect(store.children.get(null)).toEqual(["a"]);
    expect(store.children.get("a")).toEqual(["b"]);
  });

  it("re-indexes on an orderKey change", () => {
    const store = newStore([
      makeTask("a", { orderKey: "a" }),
      makeTask("b", { orderKey: "b" }),
      makeTask("c", { orderKey: "c" }),
    ]);
    store.applyPatch({
      op: "task/update",
      id: "c",
      before: { orderKey: "c" },
      after: { orderKey: "aa" },
    });
    expect(store.children.get(null)).toEqual(["a", "c", "b"]);
  });

  it("removes a field when it is in `before` but not in `after`", () => {
    const store = newStore([makeTask("a", { progress: 0.5 })]);
    store.applyPatch({ op: "task/update", id: "a", before: { progress: 0.5 }, after: {} });
    expect("progress" in store.byId.get("a")!).toBe(false);
  });

  describe("`clears`", () => {
    it("assigns `after` and then deletes every key named in `clears`", () => {
      const store = newStore([makeTask("a", { progress: 0.5, calendarId: "cal-1" })]);
      store.applyPatch({
        op: "task/update",
        id: "a",
        before: { progress: 0.5 },
        after: { progress: 0.8 },
        clears: ["calendarId"],
      });
      expect(store.byId.get("a")?.progress).toBe(0.8);
      expect("calendarId" in store.byId.get("a")!).toBe(false);
    });

    it("treats a `clears` entry the task does not carry as a no-op", () => {
      const store = newStore([makeTask("a")]);
      store.applyPatch({
        op: "task/update",
        id: "a",
        before: {},
        after: {},
        clears: ["progress", "calendarId"],
      });
      expect(store.byId.get("a")?.name).toBe("task a");
      expect("progress" in store.byId.get("a")!).toBe(false);
    });

    it("treats an unknown `clears` key as a no-op", () => {
      const store = newStore([makeTask("a")]);
      store.applyPatch({
        op: "task/update",
        id: "a",
        before: {},
        after: {},
        clears: ["nope" as unknown as keyof Task],
      });
      expect(store.byId.get("a")?.name).toBe("task a");
    });

    it("never clears `id`, even when it is named explicitly", () => {
      const store = newStore([makeTask("a")]);
      store.applyPatch({
        op: "task/update",
        id: "a",
        before: {},
        after: {},
        clears: ["id"],
      });
      expect(store.byId.get("a")?.id).toBe("a");
      expect(store.byId.has("a")).toBe(true);
    });

    it("restores a field to fully absent on undo of the first write, via `invertPatches`", () => {
      const store = newStore([makeTask("a")]);
      const forward: Patch = {
        op: "task/update",
        id: "a",
        before: {},
        after: { progress: 0.4 },
      };
      store.applyPatch(forward);
      expect(store.byId.get("a")?.progress).toBe(0.4);

      const [inverse] = invertPatches([forward]);
      store.applyPatch(inverse as Patch);
      expect("progress" in store.byId.get("a")!).toBe(false);
    });
  });

  it("never removes a required field", () => {
    const store = newStore([makeTask("a")]);
    store.applyPatch({ op: "task/update", id: "a", before: { name: "task a" }, after: {} });
    expect(store.byId.get("a")?.name).toBe("task a");
  });

  it("does not re-key a task on an `id` in `after`", () => {
    const store = newStore([makeTask("a")]);
    store.applyPatch({ op: "task/update", id: "a", before: {}, after: { id: "b" } });
    expect(store.byId.has("a")).toBe(true);
    expect(store.byId.get("a")?.id).toBe("a");
  });

  it("throws on a bare task/remove patch that still has children (phantom-children guard)", () => {
    const store = newStore([makeTask("a"), makeTask("a1", { parentId: "a", orderKey: "b" })]);
    // A hand-built patch that skips the cascade `buildTaskRemove` normally does — the store must
    // refuse it rather than leave `children.get("a")` pointing at "a1" while "a" is gone from
    // `byId`, which would make "a1" a phantom row (still reachable via `query().children`, but
    // dangling under a parent that no longer exists).
    expect(() =>
      store.applyPatch({ op: "task/remove", task: store.byId.get("a")! }),
    ).toThrow(/still has children/);
    expect(store.byId.has("a")).toBe(true);
  });

  it("link/update refuses a patch whose before.id and after.id disagree", () => {
    const store = newStore([makeTask("a"), makeTask("b")], [makeLink("l1", "a", "b")]);
    const before = store.getLink("l1")!;
    expect(() =>
      store.applyPatch({
        op: "link/update",
        before,
        after: { ...before, id: "l2", type: "SS" },
      }),
    ).toThrow(/does not match/);
  });

  it("query() returns a stable live view", () => {
    const store = newStore([makeTask("a")]);
    const view = store.query();
    expect(store.query()).toBe(view);
    store.applyPatch({ op: "task/add", task: makeTask("b", { orderKey: "z" }) });
    expect(view.byId.size).toBe(2);
  });

  it("clear() empties the indexes in place", () => {
    const store = newStore([makeTask("a")], []);
    const view = store.query();
    store.clear();
    expect(view.byId.size).toBe(0);
    expect(view.children.size).toBe(0);
    expect(store.linkCount()).toBe(0);
  });
});

describe("Store transactions — atomic apply", () => {
  it("applies every patch of a transaction", () => {
    const store = newStore([makeTask("a")]);
    store.applyTransaction(
      tx([
        { op: "task/add", task: makeTask("b", { orderKey: "z" }) },
        { op: "task/update", id: "a", before: { start: 0 }, after: { start: 5 } },
      ]),
    );
    expect(store.byId.get("a")?.start).toBe(5);
    expect(store.byId.has("b")).toBe(true);
  });

  it("rolls back completely when a later patch throws", () => {
    const store = newStore([makeTask("a")]);
    const before = snapshot(store);
    expect(() =>
      store.applyTransaction(
        tx([
          { op: "task/add", task: makeTask("b", { orderKey: "z" }) },
          { op: "task/add", task: makeTask("a") }, // duplicate → throws
        ]),
      ),
    ).toThrow(/already exists/);
    expect(snapshot(store)).toBe(before);
  });

  // The rollback has to restore the resource indexes too, not just tasks and links: a transaction
  // that touches assignments and then throws must leave `resources` / `assignmentsByTask` exactly as
  // they were, empty buckets included.
  it("rolls back resource and assignment patches too", () => {
    const store = newStore([makeTask("a")]);
    store.applyPatch({ op: "resource/add", resource: { id: "r1", name: "R1" } });
    store.applyPatch({
      op: "assignment/add",
      assignment: { taskId: "a", resourceId: "r1", units: 1 },
    });
    const before = snapshot(store);

    expect(() =>
      store.applyTransaction(
        tx([
          { op: "resource/add", resource: { id: "r2", name: "R2" } },
          {
            op: "assignment/update",
            taskId: "a",
            resourceId: "r1",
            before: { units: 1 },
            after: { units: 0.5 },
          },
          { op: "assignment/remove", assignment: { taskId: "a", resourceId: "r1", units: 0.5 } },
          { op: "task/add", task: makeTask("a") }, // duplicate → throws
        ]),
      ),
    ).toThrow(/already exists/);

    expect(snapshot(store)).toBe(before);
    expect(store.getAssignment("a", "r1")?.units).toBe(1);
    expect(store.resources.has("r2")).toBe(false);
  });

  it("is reversible: applying the inverse restores the exact prior state", () => {
    const store = newStore(
      [
        makeTask("a", { orderKey: "a" }),
        makeTask("b", { orderKey: "b" }),
        makeTask("c", { orderKey: "c" }),
      ],
      [makeLink("l1", "a", "b")],
    );
    store.applyPatch({ op: "resource/add", resource: { id: "r1", name: "R1", capacity: 2 } });
    store.applyPatch({
      op: "assignment/add",
      assignment: { taskId: "a", resourceId: "r1", units: 1 },
    });
    const before = snapshot(store);

    const patches: Patch[] = [
      { op: "task/update", id: "b", before: { start: 0, end: 10 }, after: { start: 3, end: 9 } },
      { op: "task/update", id: "a", before: {}, after: { progress: 0.25 } },
      { op: "link/remove", link: store.linksByTask.get("a")!.out[0]! },
      { op: "task/remove", task: store.byId.get("c")! },
      { op: "link/add", link: makeLink("l2", "a", "b") },
      // the resource half of the model rides the same inverse-pairing
      { op: "resource/add", resource: { id: "r2", name: "R2" } },
      { op: "resource/update", id: "r1", before: { capacity: 2 }, after: { capacity: 3 } },
      {
        op: "assignment/update",
        taskId: "a",
        resourceId: "r1",
        before: { units: 1 },
        after: { units: 0.5 },
      },
      { op: "assignment/add", assignment: { taskId: "b", resourceId: "r1", units: 0.25 } },
    ];
    store.applyTransaction(tx(patches));
    expect(snapshot(store)).not.toBe(before);

    store.applyTransaction(tx(invertPatches(patches)));
    expect(snapshot(store)).toBe(before);
  });

  it("rethrows the original error, with a rollback failure attached as its cause, when the inverse also throws", () => {
    const store = newStore([makeTask("a")]);
    // A transaction whose first patch succeeds (adds "c") and whose second throws (duplicate "a")
    // triggers rollback, which inverts the first patch into `task/remove("c")`. Sabotage that
    // specific rollback call — and only it — by removing "c" out from under the store first, so
    // the rollback's own `applyPatch` throws too.
    const originalApplyPatch = store.applyPatch.bind(store);
    let calls = 0;
    store.applyPatch = (patch) => {
      calls += 1;
      if (calls === 3) store.removeTask("c"); // sabotage right before the rollback step runs
      originalApplyPatch(patch);
    };

    let thrown: unknown;
    try {
      store.applyTransaction(
        tx([
          { op: "task/add", task: makeTask("c", { orderKey: "y" }) }, // call 1 — succeeds
          { op: "task/add", task: makeTask("a") }, // call 2 — duplicate, throws (original error)
        ]),
      );
    } catch (err) {
      thrown = err;
    }

    expect(thrown).toBeInstanceOf(Error);
    expect((thrown as Error).message).toMatch(/already exists/);
    expect((thrown as { cause?: unknown }).cause).toBeInstanceOf(Error);
    expect(((thrown as { cause?: unknown }).cause as Error).message).toMatch(/does not exist/);
  });

  it("restores the exact sibling position of a re-added task", () => {
    const store = newStore([
      makeTask("a", { orderKey: "a" }),
      makeTask("b", { orderKey: "b" }),
      makeTask("c", { orderKey: "c" }),
    ]);
    const patches: Patch[] = [{ op: "task/remove", task: store.byId.get("b")! }];
    store.applyTransaction(tx(patches));
    expect(store.children.get(null)).toEqual(["a", "c"]);
    store.applyTransaction(tx(invertPatches(patches)));
    expect(store.children.get(null)).toEqual(["a", "b", "c"]);
  });
});
