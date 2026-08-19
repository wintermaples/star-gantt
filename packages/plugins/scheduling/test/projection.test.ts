/**
 * The copy-on-write view used to compute follow-on patches against the *post*-transaction state
 * while the store still holds the pre-transaction state (docs/specs/plugins/scheduling.md §2.1).
 */
import { describe, expect, it } from "vitest";
import { OverlayMap, Projection } from "../src/engine/projection";
import { link, task, view } from "./_helpers";

describe("OverlayMap", () => {
  const base = new Map<string, number>([
    ["a", 1],
    ["b", 2],
  ]);

  it("reads through to the base", () => {
    const m = new OverlayMap(base);
    expect(m.get("a")).toBe(1);
    expect(m.has("b")).toBe(true);
    expect(m.has("z")).toBe(false);
  });

  it("shadows without mutating the base", () => {
    const m = new OverlayMap(base);
    m.set("a", 9);
    m.set("c", 3);
    expect(m.get("a")).toBe(9);
    expect(m.get("c")).toBe(3);
    expect(base.get("a")).toBe(1);
    expect(base.has("c")).toBe(false);
  });

  it("hides deleted keys, including base ones", () => {
    const m = new OverlayMap(base);
    m.delete("a");
    expect(m.get("a")).toBeUndefined();
    expect(m.has("a")).toBe(false);
    expect(base.has("a")).toBe(true);
  });

  it("resurrects a deleted key on a later set", () => {
    const m = new OverlayMap(base);
    m.delete("a");
    m.set("a", 7);
    expect(m.get("a")).toBe(7);
    expect(m.has("a")).toBe(true);
  });

  it("iterates the merged content", () => {
    const m = new OverlayMap(base);
    m.set("c", 3);
    m.delete("b");
    expect([...m.keys()].sort()).toEqual(["a", "c"]);
    expect([...m.values()].sort()).toEqual([1, 3]);
    expect(m.size).toBe(2);
    expect([...m]).toEqual([
      ["a", 1],
      ["c", 3],
    ]);
    const seen: string[] = [];
    m.forEach((_v, k) => seen.push(k));
    expect(seen.sort()).toEqual(["a", "c"]);
  });

  it("refreshes the iteration cache after a write", () => {
    const m = new OverlayMap(base);
    expect(m.size).toBe(2);
    m.set("c", 3);
    expect(m.size).toBe(3);
    m.delete("a");
    expect(m.size).toBe(2);
  });
});

describe("Projection", () => {
  it("adds a task and indexes it under its parent", () => {
    const p = new Projection(view([task("p", 0, 0)]));
    p.apply({ op: "task/add", task: task("a", 5, 8, { parentId: "p" }) });
    expect(p.view.byId.get("a")?.start).toBe(5);
    expect(p.view.children.get("p")).toEqual(["a"]);
  });

  it("removes a task and detaches it from its parent", () => {
    const base = view([task("p", 0, 0), task("a", 5, 8, { parentId: "p" })]);
    const p = new Projection(base);
    p.apply({ op: "task/remove", task: task("a", 5, 8, { parentId: "p" }) });
    expect(p.view.byId.has("a")).toBe(false);
    expect(p.view.children.get("p")).toEqual([]);
    expect(base.byId.has("a")).toBe(true);
  });

  it("applies an update without touching the base task object", () => {
    const base = view([task("a", 0, 10)]);
    const p = new Projection(base);
    p.apply({
      op: "task/update",
      id: "a",
      before: { start: 0, end: 10 },
      after: { start: 20, end: 30 },
    });
    expect(p.view.byId.get("a")?.start).toBe(20);
    expect(base.byId.get("a")?.start).toBe(0);
  });

  it("drops optional fields that `before` carries and `after` does not", () => {
    const p = new Projection(view([task("a", 0, 10, { progress: 0.5 })]));
    p.apply({ op: "task/update", id: "a", before: { progress: 0.5 }, after: {} });
    expect(p.view.byId.get("a")?.progress).toBeUndefined();
  });

  it("never drops a required field", () => {
    const p = new Projection(view([task("a", 0, 10)]));
    p.apply({ op: "task/update", id: "a", before: { start: 0, end: 10 }, after: {} });
    expect(p.view.byId.get("a")?.start).toBe(0);
    expect(p.view.byId.get("a")?.end).toBe(10);
  });

  // The projection runs the store's own merge, so a patch's `clears` deletions are projected too.
  // Ignoring them would leave the engine scheduling against a field the transaction is about to
  // delete.
  it("honors a patch's `clears` deletions, like the store", () => {
    const p = new Projection(
      view([task("a", 0, 10, { constraint: { type: "SNET", date: 5 }, progress: 0.5 })]),
    );
    p.apply({
      op: "task/update",
      id: "a",
      before: {},
      after: {},
      clears: ["constraint", "progress"],
    });
    expect(p.view.byId.get("a")?.constraint).toBeUndefined();
    expect(p.view.byId.get("a")?.progress).toBeUndefined();
  });

  it("re-parents on an update that changes parentId", () => {
    const p = new Projection(
      view([task("p", 0, 0), task("q", 0, 0), task("a", 0, 10, { parentId: "p" })]),
    );
    p.apply({ op: "task/update", id: "a", before: { parentId: "p" }, after: { parentId: "q" } });
    expect(p.view.children.get("p")).toEqual([]);
    expect(p.view.children.get("q")).toEqual(["a"]);
  });

  it("ignores an update to a task that is not there", () => {
    const p = new Projection(view([task("a", 0, 10)]));
    p.apply({ op: "task/update", id: "ghost", before: {}, after: { start: 1 } });
    expect(p.view.byId.has("ghost")).toBe(false);
  });

  it("adds a link into both endpoint buckets", () => {
    const base = view([task("a", 0, 10), task("b", 0, 5)]);
    const p = new Projection(base);
    p.apply({ op: "link/add", link: link("l1", "a", "b") });
    expect(p.view.linksByTask.get("a")?.out.map((l) => l.id)).toEqual(["l1"]);
    expect(p.view.linksByTask.get("b")?.in.map((l) => l.id)).toEqual(["l1"]);
    expect(base.linksByTask.get("a")).toBeUndefined();
  });

  it("removes a link from both endpoint buckets", () => {
    const l = link("l1", "a", "b");
    const p = new Projection(view([task("a", 0, 10), task("b", 0, 5)], [l]));
    p.apply({ op: "link/remove", link: l });
    expect(p.view.linksByTask.get("a")?.out).toEqual([]);
    expect(p.view.linksByTask.get("b")?.in).toEqual([]);
  });

  it("replaces the stored link on a link/update", () => {
    const before = link("l1", "a", "b", "FS");
    const after = link("l1", "a", "b", "SS", 5);
    const p = new Projection(view([task("a", 0, 10), task("b", 0, 5)], [before]));
    p.apply({ op: "link/update", before, after });
    expect(p.view.linksByTask.get("b")?.in).toEqual([after]);
    expect(p.view.linksByTask.get("a")?.out).toEqual([after]);
  });

  it("shares the calendars map with the base", () => {
    const base = view([], [], [{ id: "w", workingDays: [1, 2, 3, 4, 5] }]);
    const p = new Projection(base);
    expect(p.view.calendars.get("w")?.workingDays).toEqual([1, 2, 3, 4, 5]);
  });
});
