// Resource/assignment domain: commands, reversible patches, cascade delete, indexes, load/toJSON.
import { describe, expect, it } from "vitest";
import type { GanttInstance } from "@stargantt/core";
import {
  buildAssignmentRemove,
  buildAssignmentSet,
  buildResourceAdd,
  buildResourceRemove,
  buildResourceUpdate,
  buildTaskRemove,
} from "../src/commands";
import { IdGen } from "../src/ids";
import { changedTaskIds, invertPatches } from "../src/patch";
import { Store } from "../src/store";
import type { Assignment, Patch, Resource, TaskId } from "../src/types";
import { createGantt, dataOf, makeTask, newStore } from "./_helpers";

function makeResource(id: string, over: Partial<Resource> = {}): Resource {
  return { id, name: `resource ${id}`, ...over };
}

function withResources(
  store: Store,
  resources: readonly Resource[],
  assignments: readonly Assignment[] = [],
): Store {
  for (const resource of resources) store.applyPatch({ op: "resource/add", resource });
  for (const assignment of assignments) store.applyPatch({ op: "assignment/add", assignment });
  return store;
}

describe("resource/* builders", () => {
  it("resource/add mints an id when none is given", () => {
    const store = newStore();
    const patches = buildResourceAdd(store, { resource: { name: "Alice" } }, new IdGen());
    expect(patches).toEqual([{ op: "resource/add", resource: { id: "r1", name: "Alice" } }]);
  });

  it("resource/add under an explicit id re-creates that identity; a taken id creates nothing", () => {
    const store = withResources(newStore(), [makeResource("x")]);
    expect(
      buildResourceAdd(store, { resource: { id: "y", name: "Y", capacity: 2 } }, new IdGen()),
    ).toEqual([{ op: "resource/add", resource: { id: "y", name: "Y", capacity: 2 } }]);
    expect(buildResourceAdd(store, { resource: { id: "x", name: "X" } }, new IdGen())).toEqual([]);
  });

  it("resource/update captures before/after and ignores unknown ids", () => {
    const store = withResources(newStore(), [makeResource("x", { capacity: 1 })]);
    expect(buildResourceUpdate(store, { id: "x", after: { capacity: 2 } })).toEqual([
      { op: "resource/update", id: "x", before: { capacity: 1 }, after: { capacity: 2 } },
    ]);
    expect(buildResourceUpdate(store, { id: "nope", after: { capacity: 2 } })).toEqual([]);
  });

  it("resource/update omits `before.capacity` when the resource had none, so undo removes it", () => {
    const store = withResources(newStore(), [makeResource("x")]);
    const patches = buildResourceUpdate(store, { id: "x", after: { capacity: 3 } });
    expect(patches[0]).toEqual({
      op: "resource/update",
      id: "x",
      before: {},
      after: { capacity: 3 },
    });
    store.applyPatch(patches[0] as Patch);
    for (const p of invertPatches(patches)) store.applyPatch(p);
    expect("capacity" in (store.resources.get("x") as Resource)).toBe(false);
  });

  it("resource/remove cascades over the resource's assignments", () => {
    const store = withResources(
      newStore([makeTask("a"), makeTask("b")]),
      [makeResource("x"), makeResource("y")],
      [
        { taskId: "a", resourceId: "x", units: 1 },
        { taskId: "b", resourceId: "x", units: 0.5 },
        { taskId: "b", resourceId: "y", units: 1 },
      ],
    );
    expect(buildResourceRemove(store, { ids: ["x", "x", "nope"] })).toEqual([
      { op: "assignment/remove", assignment: { taskId: "a", resourceId: "x", units: 1 } },
      { op: "assignment/remove", assignment: { taskId: "b", resourceId: "x", units: 0.5 } },
      { op: "resource/remove", resource: makeResource("x") },
    ]);
  });
});

describe("assignment/* builders", () => {
  it("assignment/set adds on a new pair and updates on an existing one (upsert)", () => {
    const store = withResources(newStore([makeTask("a")]), [makeResource("x")]);
    expect(buildAssignmentSet(store, { taskId: "a", resourceId: "x", units: 0.5 })).toEqual([
      { op: "assignment/add", assignment: { taskId: "a", resourceId: "x", units: 0.5 } },
    ]);
    store.applyPatch({ op: "assignment/add", assignment: { taskId: "a", resourceId: "x", units: 0.5 } });
    expect(buildAssignmentSet(store, { taskId: "a", resourceId: "x", units: 1 })).toEqual([
      {
        op: "assignment/update",
        taskId: "a",
        resourceId: "x",
        before: { units: 0.5 },
        after: { units: 1 },
      },
    ]);
  });

  it("is a no-op for invalid units or unknown endpoints", () => {
    const store = withResources(newStore([makeTask("a")]), [makeResource("x")]);
    expect(buildAssignmentSet(store, { taskId: "a", resourceId: "x", units: 0 })).toEqual([]);
    expect(buildAssignmentSet(store, { taskId: "a", resourceId: "x", units: -1 })).toEqual([]);
    expect(buildAssignmentSet(store, { taskId: "a", resourceId: "x", units: Number.NaN })).toEqual([]);
    expect(buildAssignmentSet(store, { taskId: "a", resourceId: "x", units: Infinity })).toEqual([]);
    expect(buildAssignmentSet(store, { taskId: "nope", resourceId: "x", units: 1 })).toEqual([]);
    expect(buildAssignmentSet(store, { taskId: "a", resourceId: "nope", units: 1 })).toEqual([]);
  });

  it("assignment/remove yields the stored assignment; an unknown pair yields nothing", () => {
    const store = withResources(
      newStore([makeTask("a")]),
      [makeResource("x")],
      [{ taskId: "a", resourceId: "x", units: 1 }],
    );
    expect(buildAssignmentRemove(store, { taskId: "a", resourceId: "x" })).toEqual([
      { op: "assignment/remove", assignment: { taskId: "a", resourceId: "x", units: 1 } },
    ]);
    expect(buildAssignmentRemove(store, { taskId: "a", resourceId: "y" })).toEqual([]);
  });
});

describe("task/remove cascade over assignments", () => {
  it("emits assignment/remove for every assignment of a removed task", () => {
    const store = withResources(
      newStore([makeTask("a"), makeTask("b", { parentId: "a" })]),
      [makeResource("x")],
      [
        { taskId: "a", resourceId: "x", units: 1 },
        { taskId: "b", resourceId: "x", units: 0.5 },
      ],
    );
    const patches = buildTaskRemove(store, { ids: ["a"] });
    const ops = patches.map((p) => p.op);
    expect(ops.filter((op) => op === "assignment/remove")).toHaveLength(2);
    // Applying and inverting round-trips tasks and assignments together.
    for (const p of patches) store.applyPatch(p);
    expect(store.assignmentsByTask.size).toBe(0);
    for (const p of invertPatches(patches)) store.applyPatch(p);
    expect(store.getAssignment("a", "x")).toEqual({ taskId: "a", resourceId: "x", units: 1 });
    expect(store.getAssignment("b", "x")).toEqual({ taskId: "b", resourceId: "x", units: 0.5 });
  });
});

describe("store apply / invert for resource patches", () => {
  it("normalizes to at most one assignment per (taskId, resourceId)", () => {
    const store = withResources(
      newStore([makeTask("a")]),
      [makeResource("x")],
      [{ taskId: "a", resourceId: "x", units: 1 }],
    );
    expect(() =>
      store.applyPatch({
        op: "assignment/add",
        assignment: { taskId: "a", resourceId: "x", units: 2 },
      }),
    ).toThrow();
    expect(() =>
      store.applyPatch({ op: "resource/add", resource: makeResource("x") }),
    ).toThrow();
  });

  it("every resource/assignment patch round-trips through its inverse", () => {
    const store = withResources(
      newStore([makeTask("a")]),
      [makeResource("x", { capacity: 2 })],
      [{ taskId: "a", resourceId: "x", units: 0.5 }],
    );
    const patches: Patch[] = [
      { op: "resource/update", id: "x", before: { capacity: 2 }, after: { capacity: 3 } },
      {
        op: "assignment/update",
        taskId: "a",
        resourceId: "x",
        before: { units: 0.5 },
        after: { units: 1 },
      },
      { op: "assignment/remove", assignment: { taskId: "a", resourceId: "x", units: 1 } },
      { op: "resource/remove", resource: makeResource("x", { capacity: 3 }) },
    ];
    const beforeJson = JSON.stringify([[...store.resources.values()], [...store.assignments()]]);
    for (const p of patches) store.applyPatch(p);
    expect(store.resources.size).toBe(0);
    for (const p of invertPatches(patches)) store.applyPatch(p);
    expect(JSON.stringify([[...store.resources.values()], [...store.assignments()]])).toBe(
      beforeJson,
    );
  });
});

describe("changedTaskIds — resource/assignment domain", () => {
  it("assignment patches mark their task; resource-only patches mark nothing", () => {
    expect(
      changedTaskIds([
        { op: "assignment/add", assignment: { taskId: "a", resourceId: "x", units: 1 } },
        {
          op: "assignment/update",
          taskId: "b",
          resourceId: "x",
          before: { units: 1 },
          after: { units: 2 },
        },
      ]),
    ).toEqual(new Set<TaskId>(["a", "b"]));
    expect(
      changedTaskIds([
        { op: "resource/add", resource: makeResource("x") },
        { op: "resource/update", id: "x", before: {}, after: { capacity: 2 } },
      ]),
    ).toEqual(new Set());
  });
});

describe("plugin integration — commands, stores, load, toJSON", () => {
  function loaded(): { gantt: GanttInstance; tasksBursts: number } {
    const gantt = createGantt();
    dataOf(gantt).load({
      tasks: [makeTask("a"), makeTask("b")],
      resources: [
        { id: "x", name: "Alice", capacity: 2 },
        { id: "y", name: "Bob" },
      ],
      assignments: [
        { taskId: "a", resourceId: "x", units: 1 },
        { taskId: "a", resourceId: "x", units: 0.5 }, // duplicate pair — last one wins
        { taskId: "b", resourceId: "y", units: 0 }, // invalid units — dropped
        { taskId: "zzz", resourceId: "y", units: 1 }, // unknown task — dropped
      ],
    });
    let tasksBursts = 0;
    dataOf(gantt).tasks.subscribe(() => void tasksBursts++);
    return { gantt, tasksBursts };
  }

  it("load() object form loads resources and normalized assignments", () => {
    const { gantt } = loaded();
    const data = dataOf(gantt);
    expect([...data.resources.get().values()]).toEqual([
      { id: "x", name: "Alice", capacity: 2 },
      { id: "y", name: "Bob" },
    ]);
    expect([...data.assignments.get().values()].flat()).toEqual([
      { taskId: "a", resourceId: "x", units: 0.5 },
    ]);
    const view = data.query();
    expect(view.resources.get("x")).toEqual({ id: "x", name: "Alice", capacity: 2 });
    expect(view.assignmentsByTask.get("a")).toEqual([
      { taskId: "a", resourceId: "x", units: 0.5 },
    ]);
    gantt.dispose();
  });

  it("commands run through the transaction pipeline and publish per docs/specs — Notification order", () => {
    const { gantt } = loaded();
    const data = dataOf(gantt);
    const publishes: string[] = [];
    dataOf(gantt).links.subscribe(() => publishes.push("links"));
    dataOf(gantt).resources.subscribe(() => publishes.push("resources"));
    dataOf(gantt).assignments.subscribe(() => publishes.push("assignments"));
    dataOf(gantt).tasks.subscribe(() => publishes.push("tasks"));

    gantt.dispatch("assignment/set", { taskId: "b", resourceId: "y", units: 1 });
    expect(publishes).toEqual(["assignments", "tasks"]);
    expect(data.assignments.get().get("b")).toEqual([
      { taskId: "b", resourceId: "y", units: 1 },
    ]);

    publishes.length = 0;
    // Resource-only transaction still publishes `tasks` last, unconditionally.
    gantt.dispatch("resource/update", { id: "x", after: { capacity: 3 } });
    expect(publishes).toEqual(["resources", "tasks"]);

    // Cascade on resource removal: the assignment goes with the resource.
    publishes.length = 0;
    gantt.dispatch("resource/remove", { ids: ["y"] });
    expect([...data.resources.get().values()].map((r) => r.id)).toEqual(["x"]);
    expect(data.query().assignmentsByTask.get("b")).toBeUndefined();
    expect(publishes).toEqual(["resources", "assignments", "tasks"]);

    // Cascade on task removal: the assignment goes with the task.
    gantt.dispatch("task/remove", { ids: ["a"] });
    expect(data.query().assignmentsByTask.size).toBe(0);
    gantt.dispose();
  });

  it("toJSON() carries resources and assignments, and round-trips through load()", () => {
    const { gantt } = loaded();
    const data = dataOf(gantt);
    const json = data.toJSON();
    expect(json.resources).toEqual([
      { id: "x", name: "Alice", capacity: 2 },
      { id: "y", name: "Bob" },
    ]);
    expect(json.assignments).toEqual([{ taskId: "a", resourceId: "x", units: 0.5 }]);

    data.load(json);
    expect(data.toJSON()).toEqual(json);
    gantt.dispose();
  });

  it("load() with the bare-array form clears previously loaded resources", () => {
    const { gantt } = loaded();
    const data = dataOf(gantt);
    data.load([makeTask("c")]);
    expect([...data.resources.get().values()]).toEqual([]);
    expect([...data.assignments.get().values()]).toEqual([]);
    gantt.dispose();
  });
});
