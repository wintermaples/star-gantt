// docs/specs/plugins/scheduling.md §2.5 — the effort tri-state.
import { describe, expect, it } from "vitest";
import type { Assignment, Patch, ReadonlyDataView, Task } from "@stargantt/plugin-data-store";
import { effortFollowOn, effortModeOf, unitsOf, workOf } from "../src/engine/effort";
import { Projection } from "../src/engine/projection";
import { walkTransactionPatches } from "../src/engine/seeds";
import { DAY, task, view } from "./_helpers";

/** The helper view plus real assignment buckets. */
function viewWith(tasks: readonly Task[], assignments: readonly Assignment[]): ReadonlyDataView {
  const base = view(tasks);
  const byTask = new Map<Task["id"], Assignment[]>();
  for (const a of assignments) {
    const bucket = byTask.get(a.taskId) ?? [];
    bucket.push(a);
    byTask.set(a.taskId, bucket);
  }
  return { ...base, assignmentsByTask: byTask };
}

const assignmentPatch = (taskId: string, units: number): Patch => ({
  op: "assignment/update",
  taskId,
  resourceId: "r",
  before: { units: 1 },
  after: { units },
});

describe("meta readers", () => {
  it("reads only usable mode and work values", () => {
    expect(effortModeOf(task("a", 0, DAY))).toBeUndefined();
    expect(effortModeOf(task("a", 0, DAY, { meta: { effortMode: "fixed-work" } }))).toBe(
      "fixed-work",
    );
    expect(effortModeOf(task("a", 0, DAY, { meta: { effortMode: "nope" } }))).toBeUndefined();
    expect(workOf(task("a", 0, DAY, { meta: { work: 5 } }))).toBe(5);
    expect(workOf(task("a", 0, DAY, { meta: { work: -1 } }))).toBeUndefined();
    expect(workOf(task("a", 0, DAY))).toBeUndefined();
  });
});

describe("effortFollowOn", () => {
  it("fixed-work: an assignment change re-derives the duration", () => {
    // 2 days of work at 2 units → 1 day duration.
    const v = viewWith(
      [task("a", 0, 2 * DAY, { meta: { effortMode: "fixed-work", work: 2 * DAY } })],
      [{ taskId: "a", resourceId: "r", units: 1 }],
    );
    // The view still shows the pre-transaction unit (1); the patch raises it to 2.
    const follow = effortFollowOn(v, assignmentPatch("a", 2));
    expect(follow).toEqual({
      op: "task/update",
      id: "a",
      before: { end: 2 * DAY },
      after: { end: DAY },
    });
  });

  it("fixed-duration: an assignment change re-derives the work", () => {
    const meta = { effortMode: "fixed-duration", work: 2 * DAY };
    const v = viewWith(
      [task("a", 0, 2 * DAY, { meta })],
      [{ taskId: "a", resourceId: "r", units: 1 }],
    );
    const follow = effortFollowOn(v, assignmentPatch("a", 2));
    expect(follow).toEqual({
      op: "task/update",
      id: "a",
      before: { meta },
      after: { meta: { effortMode: "fixed-duration", work: 4 * DAY } },
    });
  });

  it("fixed-units: a date change re-derives the work", () => {
    const meta = { effortMode: "fixed-units", work: DAY };
    const v = viewWith(
      [task("a", 0, 3 * DAY, { meta })],
      [{ taskId: "a", resourceId: "r", units: 1 }],
    );
    const follow = effortFollowOn(v, {
      op: "task/update",
      id: "a",
      before: { end: DAY },
      after: { end: 3 * DAY },
    });
    expect(follow).toEqual({
      op: "task/update",
      id: "a",
      before: { meta },
      after: { meta: { effortMode: "fixed-units", work: 3 * DAY } },
    });
  });

  it("yields nothing without a mode, without units, or for meta-only updates", () => {
    const noMode = viewWith([task("a", 0, DAY)], [{ taskId: "a", resourceId: "r", units: 1 }]);
    expect(effortFollowOn(noMode, assignmentPatch("a", 1))).toBeUndefined();

    const noUnits = viewWith(
      [task("a", 0, DAY, { meta: { effortMode: "fixed-work", work: DAY } })],
      [],
    );
    expect(effortFollowOn(noUnits, assignmentPatch("a", 1))).toBeUndefined();

    const meta = { effortMode: "fixed-units", work: DAY };
    const v = viewWith([task("a", 0, DAY, { meta })], [{ taskId: "a", resourceId: "r", units: 1 }]);
    // A meta-only update (the shape this module itself appends) must not re-trigger.
    expect(
      effortFollowOn(v, { op: "task/update", id: "a", before: { meta }, after: { meta } }),
    ).toBeUndefined();
    expect(unitsOf(v, "a")).toBe(1);
  });

  it("a follow-on never triggers another follow-on of the same transaction", () => {
    // fixed-work's own output is a date change on a fixed-work task — classified inert.
    const v = viewWith(
      [task("a", 0, DAY, { meta: { effortMode: "fixed-work", work: DAY } })],
      [{ taskId: "a", resourceId: "r", units: 1 }],
    );
    const first = effortFollowOn(v, assignmentPatch("a", 1));
    // Units unchanged → duration already right → nothing at all.
    expect(first).toBeUndefined();
    const dateChange: Patch = { op: "task/update", id: "a", before: {}, after: { end: 2 * DAY } };
    expect(effortFollowOn(v, dateChange)).toBeUndefined();
  });

  it("bulk edit: two assignment patches for one task compound their unit deltas", () => {
    // fixed-duration, 2 days long, 1 unit assigned. A single transaction adds two more 1-unit
    // assignments: the second follow-on must see units 3 (1 stored + both deltas), not a stale 2.
    const meta = { effortMode: "fixed-duration", work: 2 * DAY };
    const v = viewWith(
      [task("a", 0, 2 * DAY, { meta })],
      [{ taskId: "a", resourceId: "r1", units: 1 }],
    );
    const patches: Patch[] = [
      { op: "assignment/add", assignment: { taskId: "a", resourceId: "r2", units: 1 } },
      { op: "assignment/add", assignment: { taskId: "a", resourceId: "r3", units: 1 } },
    ];
    const projection = new Projection(v);
    walkTransactionPatches(patches, projection, new Set(), true);
    const workValues = patches
      .filter((p): p is Extract<Patch, { op: "task/update" }> => p.op === "task/update")
      .map((p) => p.after.meta?.["work"]);
    // First follow-on: 2 days × 2 units; second: 2 days × 3 units.
    expect(workValues).toEqual([4 * DAY, 6 * DAY]);
  });

  it("measures the duration as working time against a working-hours calendar", () => {
    // §2.5 — the invariant is `work = duration × units` with duration measured as WORKING time
    // whenever the task's calendar declares usable windows.
    const H = 3_600_000;
    const MON = Date.UTC(2024, 0, 1);
    const office = {
      id: "o",
      workingDays: [1, 2, 3, 4, 5],
      workingHours: [[9 * H, 17 * H]] as [number, number][],
    };
    const meta = { effortMode: "fixed-duration", work: 0 };
    const base = view([task("a", MON + 9 * H, MON + 13 * H, { meta, calendarId: "o" })], [], [
      office,
    ]);
    const v: ReadonlyDataView = {
      ...base,
      assignmentsByTask: new Map([["a", [{ taskId: "a", resourceId: "r", units: 1 }]]]),
    };
    const follow = effortFollowOn(v, assignmentPatch("a", 2));
    // Four working hours × 2 units, not the elapsed span.
    expect(follow).toEqual({
      op: "task/update",
      id: "a",
      before: { meta },
      after: { meta: { effortMode: "fixed-duration", work: 8 * H } },
    });
  });
});
