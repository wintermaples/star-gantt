import { describe, expect, it } from "vitest";
import { changedTaskIds, invertPatch, invertPatches } from "../src/patch";
import type { Patch } from "../src/types";
import { makeLink, makeTask } from "./_helpers";

describe("patch inversion — the reversible minimal unit", () => {
  it("inverts task/add into task/remove", () => {
    const task = makeTask("a");
    expect(invertPatch({ op: "task/add", task })).toEqual({ op: "task/remove", task });
  });

  it("inverts task/remove into task/add", () => {
    const task = makeTask("a");
    expect(invertPatch({ op: "task/remove", task })).toEqual({ op: "task/add", task });
  });

  it("inverts task/update by swapping before and after", () => {
    const patch: Patch = { op: "task/update", id: "a", before: { start: 1 }, after: { start: 2 } };
    expect(invertPatch(patch)).toEqual({
      op: "task/update",
      id: "a",
      before: { start: 2 },
      after: { start: 1 },
    });
  });

  it("inverts link/add into link/remove and back", () => {
    const link = makeLink("l1", "a", "b");
    expect(invertPatch({ op: "link/add", link })).toEqual({ op: "link/remove", link });
    expect(invertPatch({ op: "link/remove", link })).toEqual({ op: "link/add", link });
  });

  it("is an involution", () => {
    const patches: Patch[] = [
      { op: "task/add", task: makeTask("a") },
      { op: "task/update", id: "a", before: {}, after: { progress: 0.5 } },
      { op: "link/add", link: makeLink("l1", "a", "b") },
    ];
    for (const p of patches) expect(invertPatch(invertPatch(p))).toEqual(p);
  });

  it("inverts a patch list in reverse order", () => {
    const a: Patch = { op: "task/add", task: makeTask("a") };
    const b: Patch = { op: "task/add", task: makeTask("b") };
    expect(invertPatches([a, b])).toEqual([invertPatch(b), invertPatch(a)]);
  });

  describe("`clears` derivation", () => {
    it("clears a field the forward patch introduced from nothing", () => {
      const patch: Patch = { op: "task/update", id: "a", before: {}, after: { progress: 0.5 } };
      expect(invertPatch(patch)).toEqual({
        op: "task/update",
        id: "a",
        before: { progress: 0.5 },
        after: {},
        clears: ["progress"],
      });
    });

    it("does not clear a field that had a different value, only reassigns it", () => {
      const patch: Patch = { op: "task/update", id: "a", before: { start: 1 }, after: { start: 2 } };
      const inverse = invertPatch(patch) as Extract<Patch, { op: "task/update" }>;
      expect(inverse.clears).toBeUndefined();
      expect(inverse.after).toEqual({ start: 1 });
    });

    it("never puts `id` into `clears`", () => {
      const patch: Patch = {
        op: "task/update",
        id: "a",
        before: {},
        after: { id: "a", progress: 0.5 },
      };
      const inverse = invertPatch(patch) as Extract<Patch, { op: "task/update" }>;
      expect(inverse.clears).toEqual(["progress"]);
    });

    it("clears every newly-introduced field, not just one", () => {
      const patch: Patch = {
        op: "task/update",
        id: "a",
        before: {},
        after: { progress: 0.5, calendarId: "cal-1" },
      };
      const inverse = invertPatch(patch) as Extract<Patch, { op: "task/update" }>;
      expect(new Set(inverse.clears)).toEqual(new Set(["progress", "calendarId"]));
    });

    it("round-trips through a second inversion back to the original patch", () => {
      const patch: Patch = { op: "task/update", id: "a", before: {}, after: { progress: 0.5 } };
      expect(invertPatch(invertPatch(patch))).toEqual(patch);
    });
  });
});

describe("changedTaskIds", () => {
  it("collects ids from task patches", () => {
    const ids = changedTaskIds([
      { op: "task/add", task: makeTask("a") },
      { op: "task/remove", task: makeTask("b") },
      { op: "task/update", id: "c", before: {}, after: {} },
    ]);
    expect([...ids].sort()).toEqual(["a", "b", "c"]);
  });

  it("marks both endpoints of a link patch", () => {
    const ids = changedTaskIds([{ op: "link/add", link: makeLink("l1", "a", "b") }]);
    expect([...ids].sort()).toEqual(["a", "b"]);
  });

  it("deduplicates", () => {
    const ids = changedTaskIds([
      { op: "task/update", id: "a", before: {}, after: {} },
      { op: "task/update", id: "a", before: {}, after: {} },
    ]);
    expect(ids.size).toBe(1);
  });
});
