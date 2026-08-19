// docs/specs/plugins/a11y.md § Announcements — the keyboard edit-commit announcement.
/**
 * `internal/edit-announce.ts` and `internal/ids.ts` on their own, with no host: the arming
 * protocol, and the id-set hardening the optional selection edge relies on.
 */
import { describe, expect, it } from "vitest";
import type { Task, TaskId } from "@stargantt/plugin-data-store";
import { createEditAnnouncer } from "../src/internal/edit-announce";
import type { TaskSnapshot } from "../src/internal/edit-announce";
import { asIdSet, idSetHas } from "../src/internal/ids";

function task(id: TaskId, name: string): Task {
  return { id, parentId: null, name, start: 0, end: 1 };
}

/** A snapshot pair: the store before, and the store after replacing `changed`'s object. */
function snapshots(names: Record<string, string>, changed?: TaskId): [TaskSnapshot, TaskSnapshot] {
  const prev = new Map<TaskId, Task>();
  for (const [id, name] of Object.entries(names)) prev.set(id, task(id, name));
  const next = new Map(prev);
  if (changed !== undefined) {
    const before = prev.get(changed);
    if (before === undefined) next.delete(changed);
    else next.set(changed, { ...before, name: `${before.name}!` });
  }
  return [next, prev];
}

function announcer(names: Record<string, string>): { spoken: string[]; make: ReturnType<typeof createEditAnnouncer> } {
  const spoken: string[] = [];
  const make = createEditAnnouncer({
    taskName: (id) => names[String(id)],
    announce: (message) => spoken.push(message),
    editCommitted: (name) => (name === undefined ? "updated" : `${name}, updated`),
  });
  return { spoken, make };
}

describe("the keyboard edit-commit announcement", () => {
  it("announces the armed task's commit, once", () => {
    const a = announcer({ t1: "build" });
    a.make.arm("t1");
    const [next, prev] = snapshots({ t0: "design", t1: "build" }, "t1");
    a.make.onTasksChanged(next, prev);
    expect(a.spoken).toEqual(["build, updated"]);
    // A second change to the same task speaks nothing: the announcement disarmed itself.
    a.make.onTasksChanged(...snapshots({ t0: "design", t1: "build" }, "t1"));
    expect(a.spoken).toEqual(["build, updated"]);
  });

  it("says nothing while nothing is armed, or for a change touching another task", () => {
    const a = announcer({ t0: "design", t1: "build" });
    a.make.onTasksChanged(...snapshots({ t0: "design", t1: "build" }, "t0"));
    expect(a.spoken).toEqual([]);
    a.make.arm("t1");
    a.make.onTasksChanged(...snapshots({ t0: "design", t1: "build" }, "t0"));
    expect(a.spoken).toEqual([]);
  });

  it("stays silent after disarming — a cancelled edit or a pointer gesture", () => {
    const a = announcer({ t1: "build" });
    a.make.arm("t1");
    a.make.disarm();
    a.make.onTasksChanged(...snapshots({ t1: "build" }, "t1"));
    expect(a.spoken).toEqual([]);
  });

  it("hands the catalog `undefined` for a task the store no longer knows", () => {
    const a = announcer({});
    a.make.arm("gone");
    a.make.onTasksChanged(...snapshots({ gone: "gone" }, "gone"));
    expect(a.spoken).toEqual(["updated"]);
  });

  it("ignores a republished snapshot in which the armed task is the very same object", () => {
    const a = announcer({ t1: "build" });
    a.make.arm("t1");
    // The store republished (a different Map) without touching any task object.
    const [next, prev] = snapshots({ t0: "design", t1: "build" });
    a.make.onTasksChanged(next, prev);
    expect(a.spoken).toEqual([]);
    // …and the announcement is still armed for the real commit that follows.
    a.make.onTasksChanged(...snapshots({ t0: "design", t1: "build" }, "t1"));
    expect(a.spoken).toEqual(["build, updated"]);
  });
});

describe("the id-set guard", () => {
  it("reads membership from a set, an array, or nothing at all", () => {
    expect(idSetHas(new Set<TaskId>(["a"]), "a")).toBe(true);
    expect(idSetHas(["a", "b"], "b")).toBe(true);
    expect(idSetHas(["a"], "z")).toBe(false);
    expect(idSetHas(undefined, "a")).toBe(false);
    expect(idSetHas(42 as unknown as Iterable<TaskId>, "a")).toBe(false);
  });

  it("passes a real set through untouched and copies any other iterable", () => {
    const set = new Set<TaskId>(["a"]);
    expect(asIdSet(set)).toBe(set);
    expect(asIdSet(["a", "b"])).toEqual(new Set(["a", "b"]));
    expect(asIdSet(undefined)).toBeUndefined();
    // A string is iterable but would explode into characters — rejected as malformed.
    expect(asIdSet("ab" as unknown as Iterable<TaskId>)).toBeUndefined();
    expect(asIdSet(7 as unknown as Iterable<TaskId>)).toBeUndefined();
  });
});
