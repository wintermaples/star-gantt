/**
 * `internal/assign/commit.ts` — hostless raw-patch construction for the editor's Apply and for a
 * drag-reassign drop (docs/specs/plugins/resource.md §3.3). No `PluginContext`, no DOM: these are
 * pure functions over a small `AssignStoreView` fake, so the patch shapes and the head/tail split
 * (`buildReassignPatches`'s degenerate "no target change" case) are verified directly against the
 * data store's real `Patch` shapes.
 */
import { describe, expect, it, vi } from "vitest";
import { buildEditorApplyPatches, buildReassignPatches, runAssignPatches } from "../src/internal/assign/commit";
import type { AssignStoreView } from "../src/internal/assign/commit";
import type { AssignmentLike, Id } from "../src/internal/assign/model";

interface FakeEntry {
  id: Id;
  name: string;
  capacity?: number;
}

function view(opts: {
  storeResourceIds?: readonly Id[];
  assignments?: Readonly<Record<string, readonly AssignmentLike[]>>;
  pool?: readonly FakeEntry[];
}): AssignStoreView {
  const storeIds = new Set((opts.storeResourceIds ?? []).map((id) => String(id)));
  const assignments = opts.assignments ?? {};
  const pool = new Map((opts.pool ?? []).map((e) => [String(e.id), e]));
  return {
    hasResource: (id) => storeIds.has(String(id)),
    assignmentsOf: (taskId) => assignments[String(taskId)] ?? [],
    poolEntry: (id) => pool.get(String(id)),
  };
}

describe("buildEditorApplyPatches", () => {
  it("produces nothing when the desired state matches the current one", () => {
    const v = view({ storeResourceIds: ["r1"], assignments: { t1: [{ resourceId: "r1", units: 0.5 }] } });
    expect(buildEditorApplyPatches(v, "t1", new Map([["r1", 0.5]]))).toEqual([]);
  });

  it("adds a new pair already known to the store as a plain assignment/add", () => {
    const v = view({ storeResourceIds: ["r1"], assignments: {} });
    const patches = buildEditorApplyPatches(v, "t1", new Map([["r1", 1]]));
    expect(patches).toEqual([{ op: "assignment/add", assignment: { taskId: "t1", resourceId: "r1", units: 1 } }]);
  });

  it("mirrors a pool-only resource with resource/add before its assignment/add", () => {
    const v = view({ pool: [{ id: "p1", name: "Ana", capacity: 0.8 }] });
    const patches = buildEditorApplyPatches(v, "t1", new Map([["p1", 1]]));
    expect(patches).toEqual([
      { op: "resource/add", resource: { id: "p1", name: "Ana", capacity: 0.8 } },
      { op: "assignment/add", assignment: { taskId: "t1", resourceId: "p1", units: 1 } },
    ]);
  });

  it("updates units of an existing pair as assignment/update", () => {
    const v = view({ storeResourceIds: ["r1"], assignments: { t1: [{ resourceId: "r1", units: 0.5 }] } });
    const patches = buildEditorApplyPatches(v, "t1", new Map([["r1", 0.75]]));
    expect(patches).toEqual([
      { op: "assignment/update", taskId: "t1", resourceId: "r1", before: { units: 0.5 }, after: { units: 0.75 } },
    ]);
  });

  it("removes a pair missing from desired", () => {
    const v = view({ storeResourceIds: ["r1"], assignments: { t1: [{ resourceId: "r1", units: 0.5 }] } });
    const patches = buildEditorApplyPatches(v, "t1", new Map());
    expect(patches).toEqual([
      { op: "assignment/remove", assignment: { taskId: "t1", resourceId: "r1", units: 0.5 } },
    ]);
  });

  it("silently skips a pair known to neither the store nor the pool", () => {
    const v = view({});
    expect(buildEditorApplyPatches(v, "t1", new Map([["ghost", 1]]))).toEqual([]);
  });

  it("orders sets before removes, in one combined patch list (one undo step)", () => {
    const v = view({
      storeResourceIds: ["r1", "r2"],
      assignments: { t1: [{ resourceId: "r1", units: 0.5 }] },
    });
    const patches = buildEditorApplyPatches(
      v,
      "t1",
      new Map([["r2", 1]]), // add r2, drop r1
    );
    expect(patches.map((p) => p.op)).toEqual(["assignment/add", "assignment/remove"]);
  });
});

describe("buildReassignPatches", () => {
  it("no-ops on a same-task drop", () => {
    const v = view({ storeResourceIds: ["r1"], assignments: { t1: [{ resourceId: "r1", units: 0.6 }] } });
    expect(buildReassignPatches(v, "t1", "t1", "r1")).toEqual([]);
  });

  it("no-ops when the source has no such assignment", () => {
    const v = view({ storeResourceIds: ["r1"], assignments: {} });
    expect(buildReassignPatches(v, "t1", "t2", "r1")).toEqual([]);
  });

  it("no-ops when the target resource is known to neither store nor pool", () => {
    const v = view({ assignments: { t1: [{ resourceId: "ghost", units: 0.6 }] } });
    expect(buildReassignPatches(v, "t1", "t2", "ghost")).toEqual([]);
  });

  it("moves target-set before source-removal, carrying the source's units", () => {
    const v = view({ storeResourceIds: ["r1"], assignments: { t1: [{ resourceId: "r1", units: 0.6 }] } });
    const patches = buildReassignPatches(v, "t1", "t2", "r1");
    expect(patches).toEqual([
      { op: "assignment/add", assignment: { taskId: "t2", resourceId: "r1", units: 0.6 } },
      { op: "assignment/remove", assignment: { taskId: "t1", resourceId: "r1", units: 0.6 } },
    ]);
  });

  it("degenerates to a lone removal when the target already carries the exact moved units", () => {
    const v = view({
      storeResourceIds: ["r1"],
      assignments: {
        t1: [{ resourceId: "r1", units: 0.6 }],
        t2: [{ resourceId: "r1", units: 0.6 }],
      },
    });
    const patches = buildReassignPatches(v, "t1", "t2", "r1");
    expect(patches).toEqual([
      { op: "assignment/remove", assignment: { taskId: "t1", resourceId: "r1", units: 0.6 } },
    ]);
  });

  it("mirrors a pool-only target resource first, target-set, then source-removal", () => {
    const v = view({
      pool: [{ id: "p1", name: "Ana" }],
      assignments: { t1: [{ resourceId: "p1", units: 0.5 }] },
    });
    const patches = buildReassignPatches(v, "t1", "t2", "p1");
    expect(patches).toEqual([
      { op: "resource/add", resource: { id: "p1", name: "Ana" } },
      { op: "assignment/add", assignment: { taskId: "t2", resourceId: "p1", units: 0.5 } },
      { op: "assignment/remove", assignment: { taskId: "t1", resourceId: "p1", units: 0.5 } },
    ]);
  });
});

describe("runAssignPatches", () => {
  it("dispatches nothing for an empty patch list", () => {
    const dispatch = vi.fn();
    const batch = vi.fn();
    runAssignPatches(
      { dispatch } as never,
      batch as never,
      [],
    );
    expect(batch).not.toHaveBeenCalled();
  });

  it("dispatches the head via the command bus and hands the batcher the tail patches verbatim", () => {
    const dispatch = vi.fn();
    const batchCalls: unknown[] = [];
    const batch = (dispatchHead: (origin: string) => void, tail: readonly unknown[]): void => {
      batchCalls.push(tail);
      dispatchHead("test-origin");
    };
    const patches = [
      { op: "resource/add" as const, resource: { id: "p1", name: "Ana" } },
      { op: "assignment/add" as const, assignment: { taskId: "t1", resourceId: "p1", units: 1 } },
    ];
    runAssignPatches({ dispatch } as never, batch as never, patches);
    expect(batchCalls).toEqual([[patches[1]]]);
    expect(dispatch).toHaveBeenCalledWith("resource/add", {
      resource: { id: "p1", name: "Ana" },
      origin: "test-origin",
    });
  });
});
