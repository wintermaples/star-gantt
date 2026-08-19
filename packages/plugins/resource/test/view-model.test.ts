/**
 * The resource-view area's hostless halves (docs/specs/plugins/resource.md §3.4): the row/segment/
 * team model, the boundary sweep, the row universe, the lane arithmetic of the `drag/lanes` seam,
 * and the write-path decision one lane drop makes.
 *
 * Everything here runs in plain Node: no DOM, no plugin host. The strip's DOM is covered by
 * `view-panel.test.ts` and the wiring by `view-wire.test.ts`.
 */
import { describe, expect, it } from "vitest";
import type { Assignment, Resource, Task, TaskId } from "@stargantt/plugin-data-store";
import {
  buildModel,
  buildUniverse,
  rowKeyOfTask,
  sweep,
  usableCapacity,
} from "../src/internal/view/model";
import type { RvGroup } from "../src/internal/view/model";
import { laneAtY, laneOfResource } from "../src/internal/view/lanes";
import { planReassign } from "../src/internal/view/reassign";

const DAY = 86_400_000;
const T0 = Date.UTC(2024, 0, 1);

function task(id: string, dayStart: number, dayEnd: number, meta?: Record<string, unknown>): Task {
  const t: Task = {
    id,
    parentId: null,
    name: `task ${id}`,
    start: T0 + dayStart * DAY,
    end: T0 + dayEnd * DAY,
  };
  if (meta !== undefined) t.meta = meta;
  return t;
}

function tasksOf(...list: Task[]): ReadonlyMap<TaskId, Task> {
  return new Map(list.map((t) => [t.id, t]));
}

function assignmentsOf(...list: Assignment[]): ReadonlyMap<TaskId, readonly Assignment[]> {
  const out = new Map<TaskId, Assignment[]>();
  for (const a of list) {
    const bucket = out.get(a.taskId);
    if (bucket === undefined) out.set(a.taskId, [a]);
    else bucket.push(a);
  }
  return out;
}

function resources(...list: Resource[]): ReadonlyMap<string, Resource> {
  return new Map(list.map((r) => [String(r.id), r]));
}

const noProject = (): string | null => null;

/* ================================================================== *
 * sweep
 * ================================================================== */

describe("sweep (§3.4 — the boundary sweep)", () => {
  it("reports the peak concurrent sum and no window while under capacity", () => {
    const result = sweep(
      [
        { start: 0, end: 10, units: 0.5 },
        { start: 5, end: 15, units: 0.5 },
      ],
      1,
    );
    expect(result.peak).toBe(1);
    expect(result.overWindows).toEqual([]);
  });

  it("records the half-open window where the sum exceeds capacity", () => {
    const result = sweep(
      [
        { start: 0, end: 10, units: 1 },
        { start: 4, end: 8, units: 1 },
      ],
      1,
    );
    expect(result.peak).toBe(2);
    expect(result.overWindows).toEqual([{ start: 4, end: 8 }]);
  });

  it("resolves an end and a start at the same instant as a hand-off, not an overload", () => {
    const result = sweep(
      [
        { start: 0, end: 10, units: 1 },
        { start: 10, end: 20, units: 1 },
      ],
      1,
    );
    expect(result.peak).toBe(1);
    expect(result.overWindows).toEqual([]);
  });

  it("tolerates float drift from summed fractional units", () => {
    // 0.1 + 0.2 === 0.30000000000000004 in binary floating point.
    const result = sweep(
      [
        { start: 0, end: 10, units: 0.1 },
        { start: 0, end: 10, units: 0.2 },
      ],
      0.3,
    );
    expect(result.overWindows).toEqual([]);
  });

  it("leaves an open window unclosed rather than inventing an end", () => {
    // Every segment ends, so the sum returns to 0 and the window always closes; this pins that a
    // window opened and closed by the same instant is not recorded.
    const result = sweep([{ start: 0, end: 0, units: 5 }], 1);
    expect(result.overWindows).toEqual([]);
  });
});

/* ================================================================== *
 * buildUniverse
 * ================================================================== */

describe("buildUniverse (§3.4 — the internalized choice universe)", () => {
  it("lists pool entries first, then the resources only the store knows", () => {
    const universe = buildUniverse(
      [
        { id: "p1", name: "Pat" },
        { id: "p2", name: "Sam" },
      ],
      resources({ id: "s1", name: "Store only" }),
    );
    expect([...universe.values()].map((r) => r.name)).toEqual(["Pat", "Sam", "Store only"]);
  });

  it("dedupes by the string form of the id, so a numeric pool id hides its string twin", () => {
    const universe = buildUniverse(
      [{ id: 1, name: "Pool one" }],
      resources({ id: "1", name: "Store one" }),
    );
    expect(universe.size).toBe(1);
    expect(universe.get("1")?.name).toBe("Pool one");
  });

  it("resolves capacity store-entry, then pool-entry, then 1", () => {
    const universe = buildUniverse(
      [
        { id: "both", name: "Both", capacity: 3 },
        { id: "poolOnly", name: "Pool only", capacity: 2 },
        { id: "neither", name: "Neither" },
      ],
      resources({ id: "both", name: "Both", capacity: 5 }, { id: "storeOnly", name: "Store only" }),
    );
    expect(universe.get("both")?.capacity).toBe(5);
    expect(universe.get("poolOnly")?.capacity).toBe(2);
    expect(universe.get("neither")?.capacity).toBe(1);
    expect(universe.get("storeOnly")?.capacity).toBe(1);
  });

  it("treats an unusable capacity as absent rather than as a rate", () => {
    expect(usableCapacity(0)).toBeUndefined();
    expect(usableCapacity(-1)).toBeUndefined();
    expect(usableCapacity(Number.POSITIVE_INFINITY)).toBeUndefined();
    expect(usableCapacity(Number.NaN)).toBeUndefined();
    expect(usableCapacity("2")).toBeUndefined();
    expect(usableCapacity(2)).toBe(2);
    const universe = buildUniverse(
      [{ id: "r", name: "R", capacity: 0 }],
      resources() as ReadonlyMap<string, Resource>,
    );
    expect(universe.get("r")?.capacity).toBe(1);
  });
});

/* ================================================================== *
 * buildModel
 * ================================================================== */

const ROSTER = [
  { id: "a", name: "Ann", capacity: 1 },
  { id: "b", name: "Bob", capacity: 2 },
];

describe("buildModel (§3.4 — rows, segments and overallocation)", () => {
  it("places one segment per assignment of a positive-duration task", () => {
    const groups = buildModel({
      tasks: tasksOf(task("t1", 0, 2), task("t2", 1, 4)),
      assignmentsByTask: assignmentsOf(
        { taskId: "t1", resourceId: "a", units: 0.5 },
        { taskId: "t2", resourceId: "a", units: 0.25 },
        { taskId: "t2", resourceId: "b", units: 1 },
      ),
      resources: ROSTER,
      teams: [],
      ungroupedName: "Other",
      projectOf: noProject,
    });
    expect(groups).toHaveLength(1);
    const [ann, bob] = (groups[0] as RvGroup).rows;
    expect(ann?.segments.map((s) => s.taskId)).toEqual(["t1", "t2"]);
    expect(bob?.segments.map((s) => s.taskId)).toEqual(["t2"]);
    expect(ann?.segments[0]?.units).toBe(0.5);
  });

  it("skips milestones and any non-positive-duration task", () => {
    const groups = buildModel({
      tasks: tasksOf(task("ms", 3, 3), task("neg", 5, 4)),
      assignmentsByTask: assignmentsOf(
        { taskId: "ms", resourceId: "a", units: 1 },
        { taskId: "neg", resourceId: "a", units: 1 },
      ),
      resources: ROSTER,
      teams: [],
      ungroupedName: "Other",
      projectOf: noProject,
    });
    expect((groups[0] as RvGroup).rows[0]?.segments).toEqual([]);
  });

  it("ignores an assignment whose task the store does not hold", () => {
    const groups = buildModel({
      tasks: tasksOf(task("t1", 0, 2)),
      assignmentsByTask: assignmentsOf({ taskId: "ghost", resourceId: "a", units: 1 }),
      resources: ROSTER,
      teams: [],
      ungroupedName: "Other",
      projectOf: noProject,
    });
    expect((groups[0] as RvGroup).rows[0]?.segments).toEqual([]);
  });

  it("sorts each row's segments by (start, end) — what the horizontal cull binary-searches", () => {
    const groups = buildModel({
      tasks: tasksOf(task("late", 5, 6), task("early", 0, 9), task("earlyShort", 0, 1)),
      assignmentsByTask: assignmentsOf(
        { taskId: "late", resourceId: "b", units: 0.1 },
        { taskId: "early", resourceId: "b", units: 0.1 },
        { taskId: "earlyShort", resourceId: "b", units: 0.1 },
      ),
      resources: ROSTER,
      teams: [],
      ungroupedName: "Other",
      projectOf: noProject,
    });
    const bob = (groups[0] as RvGroup).rows[1];
    expect(bob?.segments.map((s) => s.taskId)).toEqual(["earlyShort", "early", "late"]);
  });

  it("marks the row, its windows and the intersecting segments as over", () => {
    const groups = buildModel({
      tasks: tasksOf(task("t1", 0, 10), task("t2", 4, 8), task("t3", 20, 21)),
      assignmentsByTask: assignmentsOf(
        { taskId: "t1", resourceId: "a", units: 1 },
        { taskId: "t2", resourceId: "a", units: 1 },
        { taskId: "t3", resourceId: "a", units: 1 },
      ),
      resources: ROSTER,
      teams: [],
      ungroupedName: "Other",
      projectOf: noProject,
    });
    const ann = (groups[0] as RvGroup).rows[0];
    expect(ann?.over).toBe(true);
    expect(ann?.peak).toBe(2);
    expect(ann?.overWindows).toEqual([{ start: T0 + 4 * DAY, end: T0 + 8 * DAY }]);
    expect(ann?.segments.map((s) => [s.taskId, s.over])).toEqual([
      ["t1", true],
      ["t2", true],
      ["t3", false],
    ]);
  });

  it("measures the row against its own capacity, not against 1", () => {
    const groups = buildModel({
      tasks: tasksOf(task("t1", 0, 10), task("t2", 0, 10)),
      assignmentsByTask: assignmentsOf(
        { taskId: "t1", resourceId: "b", units: 1 },
        { taskId: "t2", resourceId: "b", units: 1 },
      ),
      resources: ROSTER,
      teams: [],
      ungroupedName: "Other",
      projectOf: noProject,
    });
    const bob = (groups[0] as RvGroup).rows[1];
    expect(bob?.peak).toBe(2);
    expect(bob?.over).toBe(false);
  });

  it("attributes segments through projectOf", () => {
    const groups = buildModel({
      tasks: tasksOf(task("t1", 0, 2, { project: "Apollo" }), task("t2", 0, 2)),
      assignmentsByTask: assignmentsOf(
        { taskId: "t1", resourceId: "a", units: 1 },
        { taskId: "t2", resourceId: "a", units: 1 },
      ),
      resources: ROSTER,
      teams: [],
      ungroupedName: "Other",
      projectOf: (t) => {
        const value = t.meta?.["project"];
        return typeof value === "string" && value !== "" ? value : null;
      },
    });
    const ann = (groups[0] as RvGroup).rows[0];
    expect(ann?.segments.map((s) => s.project)).toEqual(["Apollo", null]);
  });

  it("calls projectOf once per task, not once per assignment", () => {
    let calls = 0;
    buildModel({
      tasks: tasksOf(task("t1", 0, 2)),
      assignmentsByTask: assignmentsOf(
        { taskId: "t1", resourceId: "a", units: 1 },
        { taskId: "t1", resourceId: "b", units: 1 },
      ),
      resources: ROSTER,
      teams: [],
      ungroupedName: "Other",
      projectOf: () => {
        calls += 1;
        return null;
      },
    });
    expect(calls).toBe(1);
  });
});

describe("buildModel — team grouping (§3.4)", () => {
  const base = {
    tasks: tasksOf(task("t1", 0, 10), task("t2", 0, 10)),
    assignmentsByTask: assignmentsOf(
      { taskId: "t1", resourceId: "a", units: 2 },
      { taskId: "t2", resourceId: "b", units: 1 },
    ),
    resources: ROSTER,
    ungroupedName: "Other resources",
    projectOf: noProject,
  };

  it("renders one anonymous, unbanded group when no team is configured", () => {
    const groups = buildModel({ ...base, teams: [] });
    expect(groups).toHaveLength(1);
    expect(groups[0]?.name).toBeNull();
    expect(groups[0]?.rows).toHaveLength(2);
  });

  it("aggregates capacity, peak, free and the overloaded member count per group", () => {
    const groups = buildModel({ ...base, teams: [{ name: "Core", members: ["a", "b"] }] });
    const core = groups[0] as RvGroup;
    expect(core.name).toBe("Core");
    expect(core.capacity).toBe(3); // 1 + 2
    expect(core.peak).toBe(3); // 2 concurrent with 1
    expect(core.free).toBe(0);
    expect(core.overloadedMembers).toBe(1); // Ann alone: 2 units against a capacity of 1
  });

  it("gives a doubly-claimed resource to the first-listed team", () => {
    const groups = buildModel({
      ...base,
      teams: [
        { name: "First", members: ["a"] },
        { name: "Second", members: ["a", "b"] },
      ],
    });
    expect(groups.map((g) => [g.name, g.rows.map((r) => r.resourceId)])).toEqual([
      ["First", ["a"]],
      ["Second", ["b"]],
    ]);
  });

  it("collects unclaimed resources under the ungrouped name, and only when there are some", () => {
    const withRest = buildModel({ ...base, teams: [{ name: "Core", members: ["a"] }] });
    expect(withRest.map((g) => g.name)).toEqual(["Core", "Other resources"]);
    const withoutRest = buildModel({ ...base, teams: [{ name: "Core", members: ["a", "b"] }] });
    expect(withoutRest.map((g) => g.name)).toEqual(["Core"]);
  });

  it("renders a usable-name team with no (or no known) members as an empty group", () => {
    const groups = buildModel({
      ...base,
      teams: [
        { name: "Empty", members: [] },
        { name: "Ghosts", members: ["nobody"] },
        { name: "Core", members: ["a", "b"] },
      ],
    });
    expect(groups.map((g) => [g.name, g.rows.length, g.capacity, g.peak, g.free])).toEqual([
      ["Empty", 0, 0, 0, 0],
      ["Ghosts", 0, 0, 0, 0],
      ["Core", 2, 3, 3, 0],
    ]);
  });

  it("trims the configured team name and dedupes members within one team", () => {
    const groups = buildModel({
      ...base,
      teams: [{ name: "  Core  ", members: ["a", "a", 0 as unknown as string] }],
    });
    expect(groups[0]?.name).toBe("Core");
    expect(groups[0]?.rows.map((r) => r.resourceId)).toEqual(["a"]);
  });

  it("matches member ids in string form", () => {
    const groups = buildModel({
      tasks: tasksOf(),
      assignmentsByTask: assignmentsOf(),
      resources: [{ id: 7, name: "Seven", capacity: 1 }],
      teams: [{ name: "Core", members: ["7"] }],
      ungroupedName: "Other",
      projectOf: noProject,
    });
    expect(groups[0]?.rows.map((r) => r.resourceId)).toEqual([7]);
  });
});

describe("rowKeyOfTask (§3.4 — `laneOfTask`)", () => {
  const groups = buildModel({
    tasks: tasksOf(task("solo", 0, 2), task("shared", 0, 2)),
    assignmentsByTask: assignmentsOf(
      { taskId: "solo", resourceId: "a", units: 1 },
      { taskId: "shared", resourceId: "a", units: 1 },
      { taskId: "shared", resourceId: "b", units: 1 },
    ),
    resources: ROSTER,
    teams: [],
    ungroupedName: "Other",
    projectOf: noProject,
  });

  it("names the single row a task sits on", () => {
    expect(rowKeyOfTask(groups, "solo")).toBe("a");
  });

  it("declines when the task sits on more than one row", () => {
    expect(rowKeyOfTask(groups, "shared")).toBeUndefined();
  });

  it("declines when the task sits on none", () => {
    expect(rowKeyOfTask(groups, "unknown")).toBeUndefined();
  });
});

/* ================================================================== *
 * lane arithmetic
 * ================================================================== */

describe("laneAtY / laneOfResource (§3.4 — the lane seam's geometry)", () => {
  // Header band 28 px, then three 28 px rows, inside a body whose top sits 100 px below the root.
  const lanes = [
    { resourceId: "a", y: 28, height: 28 },
    { resourceId: "b", y: 56, height: 28 },
    { resourceId: "c", y: 84, height: 28 },
  ];

  it("answers undefined for every y while nothing has painted", () => {
    expect(laneAtY([], 120, 0, 100, 200)).toBeUndefined();
  });

  it("answers undefined above and below the body's own box", () => {
    expect(laneAtY(lanes, 99, 0, 100, 200)).toBeUndefined();
    expect(laneAtY(lanes, 300, 0, 100, 200)).toBeUndefined();
  });

  it("answers undefined on the header band, which is a gap, not a lane", () => {
    expect(laneAtY(lanes, 100 + 14, 0, 100, 200)).toBeUndefined();
  });

  it("names the lane under a root-relative y and reports it root-relative", () => {
    expect(laneAtY(lanes, 100 + 28, 0, 100, 200)).toEqual({
      resourceId: "a",
      y: 128,
      height: 28,
    });
    expect(laneAtY(lanes, 100 + 55, 0, 100, 200)?.resourceId).toBe("a");
    expect(laneAtY(lanes, 100 + 56, 0, 100, 200)?.resourceId).toBe("b");
  });

  it("applies the body's vertical scroll", () => {
    // Scrolled down by 28: the first row's content y is now at the body's own top edge.
    expect(laneAtY(lanes, 100 + 1, 28, 100, 200)).toEqual({ resourceId: "a", y: 100, height: 28 });
  });

  it("treats a team band between two lanes as a gap, not as the lane above it", () => {
    // Header 28, row a, a 28 px team band, then row b — the shape a grouped strip paints.
    const gapped = [
      { resourceId: "a", y: 28, height: 28 },
      { resourceId: "b", y: 84, height: 28 },
    ];
    expect(laneAtY(gapped, 100 + 56, 0, 100, 200)).toBeUndefined();
    expect(laneAtY(gapped, 100 + 83, 0, 100, 200)).toBeUndefined();
    expect(laneAtY(gapped, 100 + 84, 0, 100, 200)?.resourceId).toBe("b");
    expect(laneAtY(gapped, 100 + 111, 0, 100, 200)?.resourceId).toBe("b");
    expect(laneAtY(gapped, 100 + 112, 0, 100, 200)).toBeUndefined();
  });

  it("declines non-finite inputs rather than answering nonsense", () => {
    expect(laneAtY(lanes, Number.NaN, 0, 100, 200)).toBeUndefined();
    expect(laneAtY(lanes, 120, 0, Number.NaN, 200)).toBeUndefined();
    expect(laneAtY(lanes, 120, 0, 100, Number.NaN)).toBeUndefined();
  });

  it("reports one resource's lane in the very space laneAt answers in", () => {
    const byId = laneOfResource(lanes, "b", 10, 100, 200);
    const byY = laneAtY(lanes, byId?.y ?? -1, 10, 100, 200);
    expect(byId).toEqual({ resourceId: "b", y: 146, height: 28 });
    expect(byY).toEqual(byId);
  });

  it("declines a resource with no painted lane and a body with no height", () => {
    expect(laneOfResource(lanes, "zz", 0, 100, 200)).toBeUndefined();
    expect(laneOfResource(lanes, "a", 0, 100, 0)).toBeUndefined();
  });
});

/* ================================================================== *
 * the write path
 * ================================================================== */

describe("planReassign (§3.4 — one lane drop, one transaction)", () => {
  const source: Assignment = { taskId: "t1", resourceId: "a", units: 0.5 };
  const store = resources({ id: "a", name: "Ann" }, { id: "b", name: "Bob" });
  const noPool = (): undefined => undefined;

  it("sets the target with the source's rate and removes the source, in that order", () => {
    const plan = planReassign({
      taskId: "t1",
      from: "a",
      to: "b",
      assignments: [source],
      storeResources: store,
      poolEntry: noPool,
    });
    expect(plan).toEqual({
      kind: "set",
      taskId: "t1",
      resourceId: "b",
      units: 0.5,
      tail: [{ op: "assignment/remove", assignment: source }],
    });
  });

  it("updates rather than adds when the target already carries a different rate", () => {
    const existing: Assignment = { taskId: "t1", resourceId: "b", units: 1 };
    const plan = planReassign({
      taskId: "t1",
      from: "a",
      to: "b",
      assignments: [source, existing],
      storeResources: store,
      poolEntry: noPool,
    });
    expect(plan.kind).toBe("set");
    if (plan.kind !== "set") throw new Error("unreachable");
    expect(plan.tail).toEqual([{ op: "assignment/remove", assignment: source }]);
  });

  it("drops the source alone when the target already carries exactly the moved rate", () => {
    const existing: Assignment = { taskId: "t1", resourceId: "b", units: 0.5 };
    const plan = planReassign({
      taskId: "t1",
      from: "a",
      to: "b",
      assignments: [source, existing],
      storeResources: store,
      poolEntry: noPool,
    });
    // A head that changes nothing raises no transaction, so the removal becomes the head itself.
    expect(plan).toEqual({ kind: "removeSource", taskId: "t1", resourceId: "a" });
  });

  it("mirrors a pool-only target into the store as the transaction's head", () => {
    const plan = planReassign({
      taskId: "t1",
      from: "a",
      to: "pool",
      assignments: [source],
      storeResources: store,
      poolEntry: (id) => (String(id) === "pool" ? { id: "pool", name: "Pooled", capacity: 2 } : undefined),
    });
    expect(plan).toEqual({
      kind: "mirror",
      resource: { id: "pool", name: "Pooled", capacity: 2 },
      tail: [
        { op: "assignment/add", assignment: { taskId: "t1", resourceId: "pool", units: 0.5 } },
        { op: "assignment/remove", assignment: source },
      ],
    });
  });

  it("omits an absent capacity from the mirrored resource rather than defaulting it", () => {
    const plan = planReassign({
      taskId: "t1",
      from: "a",
      to: "pool",
      assignments: [source],
      storeResources: store,
      poolEntry: () => ({ id: "pool", name: "Pooled" }),
    });
    if (plan.kind !== "mirror") throw new Error("unreachable");
    expect("capacity" in plan.resource).toBe(false);
  });

  it("writes nothing for a same, unknown or unassigned move", () => {
    const none = { kind: "none" };
    expect(
      planReassign({
        taskId: "t1",
        from: "a",
        to: "a",
        assignments: [source],
        storeResources: store,
        poolEntry: noPool,
      }),
    ).toEqual(none);
    expect(
      planReassign({
        taskId: "t1",
        from: "b",
        to: "a",
        assignments: [source],
        storeResources: store,
        poolEntry: noPool,
      }),
    ).toEqual(none);
    expect(
      planReassign({
        taskId: "t1",
        from: "a",
        to: "ghost",
        assignments: [source],
        storeResources: store,
        poolEntry: noPool,
      }),
    ).toEqual(none);
  });

  it("matches the store's resource ids in string form", () => {
    const numeric = new Map<number, Resource>([[7, { id: 7, name: "Seven" }]]);
    const plan = planReassign({
      taskId: "t1",
      from: "a",
      to: "7",
      assignments: [source],
      storeResources: numeric as unknown as ReadonlyMap<string, Resource>,
      // A pool lookup must not be needed: the store already holds this resource.
      poolEntry: () => {
        throw new Error("the store already carries id 7");
      },
    });
    expect(plan.kind).toBe("set");
  });

  it("falls back to a full-time rate when the stored assignment carries an unusable one", () => {
    const plan = planReassign({
      taskId: "t1",
      from: "a",
      to: "b",
      assignments: [{ taskId: "t1", resourceId: "a", units: Number.NaN }],
      storeResources: store,
      poolEntry: noPool,
    });
    if (plan.kind !== "set") throw new Error("unreachable");
    expect(plan.units).toBe(1);
  });
});
