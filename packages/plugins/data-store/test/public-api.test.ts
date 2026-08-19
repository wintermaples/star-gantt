/**
 * The package's published surface: the plugin factory plus the helpers sibling plugins share.
 * The type-level assertions are compile-time checks that double as documentation of the declared
 * shapes.
 */
import { describe, expect, it } from "vitest";
import * as entry from "../src/index";
import { REQUIRED_TASK_FIELDS, dataStore, mergeTaskUpdate, midKey } from "../src/index";
import type { Task } from "../src/index";
import { makeTask } from "./_helpers";

type Expect<T extends true> = T;
type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2
  ? true
  : false;

describe("entry exports", () => {
  it("publishes the factory and exactly the five shared helpers at runtime", () => {
    expect(Object.keys(entry).sort()).toEqual([
      "REQUIRED_TASK_FIELDS",
      "dataStore",
      "invertPatch",
      "invertPatches",
      "mergeTaskUpdate",
      "midKey",
    ]);
    expect(typeof dataStore().setup).toBe("function");
  });

  // The set is keyed by `keyof Task`, so a caller cannot test it against a name that is not a
  // task field at all.
  it("types the required-field set over `keyof Task`", () => {
    type _ = Expect<Equal<typeof REQUIRED_TASK_FIELDS, ReadonlySet<keyof Task>>>;
    expect([...REQUIRED_TASK_FIELDS].sort()).toEqual(["end", "id", "name", "parentId", "start"]);
  });
});

// The three merge steps, in order, and the required fields' immunity to all of them. This is the
// store's own merge: the same assertions therefore pin `Store#updateTask`'s behavior.
describe("mergeTaskUpdate", () => {
  it("step 1: assigns every field of `after`", () => {
    const merged = mergeTaskUpdate(makeTask("a"), {
      before: { start: 0, end: 10 },
      after: { start: 3, end: 9, progress: 0.5 },
    });
    expect(merged.start).toBe(3);
    expect(merged.end).toBe(9);
    expect(merged.progress).toBe(0.5);
  });

  it("step 2: deletes a field `before` carries and `after` does not mention", () => {
    const merged = mergeTaskUpdate(makeTask("a", { progress: 0.5 }), {
      before: { progress: 0.5 },
      after: {},
    });
    expect("progress" in merged).toBe(false);
  });

  it("step 2 does not delete a field `after` reassigns", () => {
    const merged = mergeTaskUpdate(makeTask("a", { progress: 0.5 }), {
      before: { progress: 0.5 },
      after: { progress: 0.25 },
    });
    expect(merged.progress).toBe(0.25);
  });

  it("step 3: deletes every field named in `clears`", () => {
    const merged = mergeTaskUpdate(makeTask("a", { progress: 0.5, calendarId: "c1" }), {
      before: {},
      after: {},
      clears: ["progress", "calendarId"],
    });
    expect("progress" in merged).toBe(false);
    expect("calendarId" in merged).toBe(false);
  });

  it("ignores a `clears` entry the task does not carry", () => {
    const merged = mergeTaskUpdate(makeTask("a"), {
      before: {},
      after: {},
      clears: ["progress"],
    });
    expect(merged).toEqual(makeTask("a"));
  });

  it("never deletes a required field, whatever the patch says", () => {
    const task = makeTask("a", { parentId: "p" });
    const merged = mergeTaskUpdate(task, {
      // both deletion paths at once: `before`-only keys and an explicit `clears`
      before: { id: "a", parentId: "p", name: "task a", start: 0, end: 10 },
      after: {},
      clears: ["id", "parentId", "name", "start", "end"],
    });
    expect(merged).toEqual(task);
  });

  it("never rewrites identity through `after`", () => {
    const merged = mergeTaskUpdate(makeTask("a"), { before: {}, after: { id: "b" } });
    expect(merged.id).toBe("a");
  });

  it("is pure: the input task is untouched and the result is a new object", () => {
    const task = makeTask("a", { progress: 0.5 });
    const merged = mergeTaskUpdate(task, { before: { progress: 0.5 }, after: { start: 4 } });
    expect(merged).not.toBe(task);
    expect(task.progress).toBe(0.5);
    expect(task.start).toBe(0);
    expect(merged.start).toBe(4);
  });
});

// The order-key arithmetic is published so no sibling plugin has to re-derive it; these
// assertions pin the exported behavior.
describe("midKey", () => {
  it("is exported with the store's own signature", () => {
    type _ = Expect<Equal<typeof midKey, (prev: string, next: string | undefined) => string>>;
    expect(typeof midKey).toBe("function");
  });

  it("returns a key strictly between its neighbours", () => {
    const a = midKey("", undefined);
    expect(a > "").toBe(true);
    const b = midKey(a, undefined);
    expect(b > a).toBe(true);
    const between = midKey(a, b);
    expect(a < between && between < b).toBe(true);
  });

  // "1" and "10" are the same value written two ways; the returned key must still be distinct
  // from `prev`, or two siblings would share an order key.
  it("stays strictly above `prev` when the neighbours are numerically equal", () => {
    expect(midKey("1", "10") > "1").toBe(true);
  });

  it("splits two adjacent single-digit keys", () => {
    const key = midKey("A", "B");
    expect(key > "A").toBe(true);
    expect(key < "B").toBe(true);
  });
});
