/**
 * Successor push-out on dependency violation (docs/specs/plugins/interaction.md §6.3
 * `pushSuccessors`).
 *
 * `pushOutPatches` is the relaxation arithmetic, unchanged from its original pure form
 * ("pushOutPatches (pure, §3.8)").
 *
 * `standsDown` replaces the earlier structural `stargantt.scheduler.propagationEnabled()`
 * stand-down with the interaction-owned `snap/pushGuards` extension point (collect, OR-combined).
 * The previous scheduler-composition tests
 * ("no-ops while a propagating stargantt.scheduler resolves", "keeps pushing alongside a scheduler
 * whose propagation is off", "stands down for a scheduler that cannot answer whether it
 * propagates", "resumes pushing once the scheduler plugin is absent again") have no equivalent
 * here: there is no scheduler service edge left to fake. They are replaced below by direct
 * tests of `standsDown`'s own contract (no guards -> runs; any guard true -> stands down; every
 * guard false -> runs; a throwing guard is reported and read as true; every guard is called
 * regardless of an earlier answer, so the result is order-independent) — the wiring-level
 * equivalent (`appendPushOut` reading `deps.pushGuards()`) is exercised in snap-service.test.ts.
 */
import { describe, expect, it } from "vitest";
import type { Link, Patch, TaskId } from "@stargantt/plugin-data-store";
import { PUSH_CAP_PER_TASK, pushOutPatches, standsDown } from "../src/internal/snap/push-out";
import { task } from "./_fakes";
import { view } from "./_snap-fakes";

const D = 86_400_000; // one UTC day, in ms

function move(id: TaskId, from: [number, number], to: [number, number]): Patch {
  return {
    op: "task/update",
    id,
    before: { start: from[0], end: from[1] },
    after: { start: to[0], end: to[1] },
  };
}

const link = (id: string, s: TaskId, t: TaskId, type: Link["type"], lag?: number): Link =>
  lag === undefined ? { id, sourceId: s, targetId: t, type } : { id, sourceId: s, targetId: t, type, lag };

describe("pushOutPatches", () => {
  it("pushes an FS successor forward by exactly the deficit, duration preserved", () => {
    const v = view(
      [task({ id: "a", start: 0, end: 2 * D }), task({ id: "b", start: 3 * D, end: 4 * D })],
      [link("l1", "a", "b", "FS")],
    );
    const out = pushOutPatches(v, [move("a", [0, 2 * D], [0, 5 * D])]);
    expect(out).toEqual([
      { op: "task/update", id: "b", before: { start: 3 * D, end: 4 * D }, after: { start: 5 * D, end: 6 * D } },
    ]);
  });

  it("cascades along a chain and honors lag", () => {
    const v = view(
      [
        task({ id: "a", start: 0, end: 2 * D }),
        task({ id: "b", start: 3 * D, end: 4 * D }),
        task({ id: "c", start: 5 * D, end: 6 * D }),
      ],
      [link("l1", "a", "b", "FS", D), link("l2", "b", "c", "FS")],
    );
    const out = pushOutPatches(v, [move("a", [0, 2 * D], [0, 4 * D])]);
    // b must start at 4d+1d = 5d (pushed 2d); c must start at b's new end 6d (pushed 1d).
    expect(out).toContainEqual(
      { op: "task/update", id: "b", before: { start: 3 * D, end: 4 * D }, after: { start: 5 * D, end: 6 * D } },
    );
    expect(out).toContainEqual(
      { op: "task/update", id: "c", before: { start: 5 * D, end: 6 * D }, after: { start: 6 * D, end: 7 * D } },
    );
  });

  it("handles SS, FF and SF bounds", () => {
    const v = view(
      [
        task({ id: "a", start: 0, end: 2 * D }),
        task({ id: "ss", start: 0, end: D }),
        task({ id: "ff", start: 0, end: 2 * D }),
        task({ id: "sf", start: 0, end: D }),
      ],
      [link("l1", "a", "ss", "SS"), link("l2", "a", "ff", "FF"), link("l3", "a", "sf", "SF")],
    );
    const out = pushOutPatches(v, [move("a", [0, 2 * D], [D, 3 * D])]);
    // SS: ss.start >= a.start = 1d -> push 1d; FF: ff.end >= a.end = 3d -> push 1d;
    // SF: sf.end >= a.start = 1d -> already 1d, no push.
    expect(out).toContainEqual(
      { op: "task/update", id: "ss", before: { start: 0, end: D }, after: { start: D, end: 2 * D } },
    );
    expect(out).toContainEqual(
      { op: "task/update", id: "ff", before: { start: 0, end: 2 * D }, after: { start: D, end: 3 * D } },
    );
    expect(out.find((p) => p.op === "task/update" && p.id === "sf")).toBeUndefined();
  });

  it("never pulls a successor backward and ignores non-date transactions", () => {
    const v = view(
      [task({ id: "a", start: 0, end: 2 * D }), task({ id: "b", start: 10 * D, end: 11 * D })],
      [link("l1", "a", "b", "FS")],
    );
    expect(pushOutPatches(v, [move("a", [0, 2 * D], [0, 3 * D])])).toEqual([]);
    expect(pushOutPatches(v, [])).toEqual([]);
  });

  it("relaxes an edge once when a transaction re-adds a link id the view already holds", () => {
    const stored = link("l1", "a", "b", "FS");
    const v = view(
      [task({ id: "a", start: 0, end: 2 * D }), task({ id: "b", start: 3 * D, end: 4 * D })],
      [stored],
    );
    const out = pushOutPatches(v, [
      move("a", [0, 2 * D], [0, 5 * D]),
      { op: "link/add", link: stored },
    ]);
    // One patch for b, not one per duplicate reading of the same edge.
    expect(out).toEqual([
      { op: "task/update", id: "b", before: { start: 3 * D, end: 4 * D }, after: { start: 5 * D, end: 6 * D } },
    ]);
  });

  it("corrects a violation introduced by adding a link", () => {
    const v = view([task({ id: "a", start: 0, end: 2 * D }), task({ id: "b", start: D, end: 2 * D })], []);
    const out = pushOutPatches(v, [{ op: "link/add", link: link("l1", "a", "b", "FS") }]);
    expect(out).toEqual([
      { op: "task/update", id: "b", before: { start: D, end: 2 * D }, after: { start: 2 * D, end: 3 * D } },
    ]);
  });

  // A retype / re-lag arrives as one `link/update` patch and must be read as a changed constraint,
  // not ignored.
  it("corrects a violation introduced by retyping a link", () => {
    const before = link("l1", "a", "b", "SS");
    const v = view([task({ id: "a", start: 0, end: 2 * D }), task({ id: "b", start: 0, end: D })], [before]);
    const out = pushOutPatches(v, [{ op: "link/update", before, after: link("l1", "a", "b", "FS") }]);
    // FS now demands b.start >= a.end = 2d; the old SS bound (0) is gone, not applied alongside.
    expect(out).toEqual([
      { op: "task/update", id: "b", before: { start: 0, end: D }, after: { start: 2 * D, end: 3 * D } },
    ]);
  });

  it("corrects a violation introduced by re-lagging a link", () => {
    const before = link("l1", "a", "b", "FS");
    const v = view(
      [task({ id: "a", start: 0, end: 2 * D }), task({ id: "b", start: 2 * D, end: 3 * D })],
      [before],
    );
    const out = pushOutPatches(v, [{ op: "link/update", before, after: link("l1", "a", "b", "FS", D) }]);
    expect(out).toEqual([
      { op: "task/update", id: "b", before: { start: 2 * D, end: 3 * D }, after: { start: 3 * D, end: 4 * D } },
    ]);
  });

  it("pulls nothing back when a re-lag only creates slack", () => {
    const before = link("l1", "a", "b", "FS", 2 * D);
    const v = view(
      [task({ id: "a", start: 0, end: 2 * D }), task({ id: "b", start: 4 * D, end: 5 * D })],
      [before],
    );
    expect(
      pushOutPatches(v, [{ op: "link/update", before, after: link("l1", "a", "b", "FS") }]),
    ).toEqual([]);
  });

  it("terminates on a cyclic link graph, patching each task once with its final resting date", () => {
    const v = view(
      [task({ id: "a", start: 0, end: 2 * D }), task({ id: "b", start: 0, end: D })],
      [link("l1", "a", "b", "FS"), link("l2", "b", "a", "FS")],
    );
    const out = pushOutPatches(v, [move("a", [0, 2 * D], [0, 3 * D])]);
    // The relaxation keeps re-pushing both tasks back and forth, but the cap
    // (`PUSH_CAP_PER_TASK`) bounds the walk, and each task's shifted dates are kept in a map
    // keyed by id, so the walk terminates with exactly one patch per touched task.
    expect(out.map((p) => (p.op === "task/update" ? p.id : undefined)).sort()).toEqual(["a", "b"]);
  });
});

describe("standsDown", () => {
  it("runs the pass (answers false) when there are no guards at all", () => {
    expect(standsDown([], () => {})).toBe(false);
  });

  it("keeps the pass running while every guard answers false", () => {
    expect(standsDown([() => false, () => false], () => {})).toBe(false);
  });

  it("stands the pass down when any guard answers true", () => {
    expect(standsDown([() => false, () => true, () => false], () => {})).toBe(true);
  });

  it("calls every guard even after an earlier one already answered true", () => {
    const calls: number[] = [];
    const guards = [
      (): boolean => {
        calls.push(0);
        return true;
      },
      (): boolean => {
        calls.push(1);
        return false;
      },
      (): boolean => {
        calls.push(2);
        return true;
      },
    ];
    expect(standsDown(guards, () => {})).toBe(true);
    expect(calls).toEqual([0, 1, 2]);
  });

  it("reports a throwing guard through onFault and reads it as standing down", () => {
    const faults: unknown[] = [];
    const boom = new Error("guard blew up");
    const down = standsDown(
      [() => { throw boom; }],
      (error) => faults.push(error),
    );
    expect(down).toBe(true);
    expect(faults).toEqual([boom]);
  });

  it("still calls a later guard after an earlier one throws", () => {
    const calls: number[] = [];
    const guards = [
      (): boolean => {
        calls.push(0);
        throw new Error("boom");
      },
      (): boolean => {
        calls.push(1);
        return false;
      },
    ];
    expect(standsDown(guards, () => {})).toBe(true);
    expect(calls).toEqual([0, 1]);
  });

  it("is order-independent: which guard answers true first does not change the outcome", () => {
    const trueGuard = (): boolean => true;
    const falseGuard = (): boolean => false;
    expect(standsDown([trueGuard, falseGuard], () => {})).toBe(
      standsDown([falseGuard, trueGuard], () => {}),
    );
  });
});

// Sanity check on the cap this module exports: it must be a usable, positive bound, not a
// placeholder — the cyclic-graph test above relies on it being reached, not on its exact value.
describe("PUSH_CAP_PER_TASK", () => {
  it("is a positive finite bound", () => {
    expect(Number.isFinite(PUSH_CAP_PER_TASK)).toBe(true);
    expect(PUSH_CAP_PER_TASK).toBeGreaterThan(0);
  });
});
