// @vitest-environment happy-dom
// docs/specs/plugins/export.md §1.5 — the pure plan/count arithmetic behind the harvest-and-cancel
// batch: `planApplyBatch` / `countApplied`. Unit-tested directly (not through the service) because
// two of the three compensations (`mergeUpdateIntoAdd`, `dropAddedSubtree`) need a same-batch
// add+update / add+remove collision that `diffDocument` can never itself produce for one document
// (each incoming task maps to exactly one change kind) — a hand-built list with such a collision
// is outside the public surface (§1's fold map), so the general-purpose engine that still has to
// handle it is exercised here at the unit level instead.
import { describe, expect, it } from "vitest";
import type { Patch, ReadonlyDataView, Task, TaskId } from "@stargantt/plugin-data-store";
import { countApplied, planApplyBatch } from "../src/internal/formats/apply-plan";
import { DAY } from "./_boot";

function viewOf(tasks: readonly Task[]): ReadonlyDataView {
  const byId = new Map<TaskId, Task>(tasks.map((t) => [t.id, t]));
  const children = new Map<TaskId | null, TaskId[]>();
  for (const t of tasks) {
    const list = children.get(t.parentId);
    if (list === undefined) children.set(t.parentId, [t.id]);
    else list.push(t.id);
  }
  return {
    byId,
    children,
    linksByTask: new Map(),
    calendars: new Map(),
    resources: new Map(),
    assignmentsByTask: new Map(),
  } as ReadonlyDataView;
}

const t = (id: string, parentId: string | null, name: string, day = 0): Task => ({
  id,
  parentId,
  name,
  start: day * DAY,
  end: (day + 1) * DAY,
});

describe("planApplyBatch", () => {
  it("preserves the given add order (parents-first ordering is diff.ts's job upstream), then updates, then one batched remove", () => {
    const view = viewOf([]);
    const batch = planApplyBatch(
      [
        { kind: "add", task: t("parent", null, "Parent") },
        { kind: "add", task: t("child", "parent", "Child") },
        { kind: "update", id: "existing", before: {}, after: { name: "x" } },
        { kind: "remove", id: "gone" },
      ],
      view,
    );
    expect(batch.calls.map((c) => c.command)).toEqual(["task/add", "task/add", "task/update", "task/remove"]);
    expect(batch.calls[0]).toMatchObject({ payload: { task: { id: "parent" } } });
    expect(batch.calls[1]).toMatchObject({ payload: { task: { id: "child" } } });
    expect(batch.calls[3]).toMatchObject({ payload: { ids: ["gone"] } });
    // Every call carries the batch's own origin.
    for (const call of batch.calls) expect(call.payload.origin).toBe("import");
  });

  it("chains midKey so sibling adds get distinct, strictly increasing orderKeys", () => {
    const view = viewOf([t("existing", null, "Existing")]);
    const batch = planApplyBatch(
      [
        { kind: "add", task: t("n1", null, "N1") },
        { kind: "add", task: t("n2", null, "N2") },
        { kind: "add", task: t("n3", null, "N3") },
      ],
      view,
    );
    const keys = batch.calls.map((c) => (c.command === "task/add" ? c.payload.task.orderKey : undefined));
    expect(new Set(keys).size).toBe(3);
    expect([...keys].sort()).toEqual(keys);
  });

  it("mergeUpdateIntoAdd: an update naming a same-batch add merges into it instead of dispatching separately", () => {
    const view = viewOf([]);
    const batch = planApplyBatch(
      [
        { kind: "add", task: t("n1", null, "N1") },
        { kind: "update", id: "n1", before: { name: "N1" }, after: { name: "N1-renamed" } },
      ],
      view,
    );
    expect(batch.calls).toHaveLength(1);
    expect(batch.calls[0]).toMatchObject({ command: "task/add", payload: { task: { name: "N1-renamed" } } });
    expect(batch.mergedInto.get(batch.calls[0] as never)).toBe(1);
  });

  it("mergeUpdateIntoAdd: a no-difference merge is dropped, counted in no bucket", () => {
    const view = viewOf([]);
    const batch = planApplyBatch(
      [
        { kind: "add", task: t("n1", null, "N1") },
        { kind: "update", id: "n1", before: { name: "N1" }, after: { name: "N1" } },
      ],
      view,
    );
    expect(batch.calls).toHaveLength(1);
    expect(batch.mergedInto.get(batch.calls[0] as never) ?? 0).toBe(0);
  });

  it("dropAddedSubtree: a remove naming a same-batch add drops it and every batch add parented under it", () => {
    const view = viewOf([]);
    const batch = planApplyBatch(
      [
        { kind: "add", task: t("n1", null, "N1") },
        { kind: "add", task: t("n2", "n1", "N2") },
        { kind: "remove", id: "n1" },
        { kind: "add", task: t("n3", null, "N3") },
      ],
      view,
    );
    expect(batch.calls).toHaveLength(1);
    expect(batch.calls[0]).toMatchObject({ payload: { task: { id: "n3" } } });
    expect(batch.removedIds).toEqual([]);
  });

  it("a non-array changes argument plans an empty, harmless batch", () => {
    expect(planApplyBatch(null as never, viewOf([]))).toEqual({ calls: [], mergedInto: new Map(), removedIds: [] });
  });
});

describe("countApplied", () => {
  it("counts only calls whose harvest is non-empty; the batched remove counts by matching op", () => {
    const view = viewOf([]);
    const batch = planApplyBatch(
      [
        { kind: "add", task: t("n1", null, "N1") },
        { kind: "update", id: "ghost", before: {}, after: { name: "x" } },
        { kind: "remove", id: "gone1" },
        { kind: "remove", id: "gone2" },
      ],
      view,
    );
    const harvested: Patch[][] = batch.calls.map((call) => {
      if (call.command === "task/add") return [{ op: "task/add", task: call.payload.task }];
      if (call.command === "task/update") return []; // "ghost" — vetoed/unknown, no patch
      return [
        { op: "task/remove", task: t("gone1", null, "Gone1") },
        { op: "task/remove", task: t("gone2", null, "Gone2") },
      ];
    });
    expect(countApplied(batch, harvested)).toEqual({ added: 1, updated: 0, removed: 2 });
  });

  it("an add's merged updates count only when the add itself lands", () => {
    const view = viewOf([]);
    const batch = planApplyBatch(
      [
        { kind: "add", task: t("n1", null, "N1") },
        { kind: "update", id: "n1", before: { name: "N1" }, after: { name: "N1-renamed" } },
      ],
      view,
    );
    // The merged add's own harvest came back empty (e.g. vetoed): nothing counts, not even the
    // merged update.
    expect(countApplied(batch, [[]])).toEqual({ added: 0, updated: 0, removed: 0 });
  });
});
