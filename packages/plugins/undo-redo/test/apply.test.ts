import type { Patch, Task } from "@stargantt/plugin-data-store";
import { describe, expect, it } from "vitest";
import { invertPatch } from "../src/apply";

/**
 * `invertPatch` is re-exported from `@stargantt/plugin-data-store`: this plugin no
 * longer keeps its own inversion table, so these tests exercise the shared function through the
 * re-export undo-redo actually calls, rather than duplicating the store's own inversion coverage
 * (`packages/plugins/data-store/test/exhaustiveness.test.ts` proves the table covers every `Patch`
 * op).
 */
describe("task/update inversion — `clears` derivation", () => {
  it("names every field the forward patch introduced from nothing", () => {
    const inverse = invertPatch({
      op: "task/update",
      id: "a",
      before: {},
      after: { progress: 0.5, calendarId: "c1" },
    });
    expect(inverse.op).toBe("task/update");
    const clears = (inverse as { clears?: readonly (keyof Task)[] }).clears;
    expect(new Set(clears)).toEqual(new Set(["progress", "calendarId"]));
  });

  it("never names a required field, however incomplete the patch's `before` is", () => {
    // docs/specs/plugins/data-store.md "Field deletion — clears": a required field is never
    // clearable by any deletion path, the derivation while inverting included. A hand-built patch
    // whose `before` simply omitted an untouched required field must not invert into "delete that
    // field".
    const inverse = invertPatch({
      op: "task/update",
      id: "a",
      before: {},
      after: { id: "a", parentId: null, name: "A", start: 1, end: 2, progress: 0.5 },
    });
    const clears = (inverse as { clears?: readonly (keyof Task)[] }).clears;
    expect(clears).toEqual(["progress"]);
  });

  it("omits `clears` entirely when the forward patch introduced nothing", () => {
    const inverse = invertPatch({ op: "task/update", id: "a", before: { start: 1 }, after: { start: 2 } });
    expect(inverse).toEqual({ op: "task/update", id: "a", before: { start: 2 }, after: { start: 1 } });
  });

  it("does not touch a redo — the forward patch is replayed unchanged, `clears` included", () => {
    // Redo replays the forward patch exactly as recorded (docs/specs/plugins/undo-redo.md
    // "Replay": `redo()` dispatches `entry.patches` as-is), so this is a smoke check that
    // inversion is only ever computed for undo, not a claim about `invertPatch` itself.
    const patch: Patch = {
      op: "task/update",
      id: "a",
      before: { progress: 0.5 },
      after: {},
      clears: ["progress"],
    };
    expect(patch.clears).toEqual(["progress"]);
  });
});

describe("unknown patch op", () => {
  // An op with no row is a programming error and is reported as one. Skipping it would leave the
  // history claiming it replayed a step it did not.
  it("names the op when asked to invert one it does not know", () => {
    const bogus = { op: "calendar/add" } as unknown as Patch;
    expect(() => invertPatch(bogus)).toThrow('stargantt: unknown patch op "calendar/add"');
  });
});
