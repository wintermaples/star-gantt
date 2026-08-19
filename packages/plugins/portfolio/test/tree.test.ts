// docs/specs/plugins/portfolio.md §2.1 — subtree walking; `isInSubtree` coverage is new (§2.7's
// move-cycle guard reads it directly).
import { describe, expect, it } from "vitest";
import type { Task } from "@stargantt/plugin-data-store";
import { childIndex, collectSubtree, isInSubtree } from "../src/internal/portfolio/tree";

function t(id: string, parentId: string | null): Task {
  return { id, parentId, name: id, start: 0, end: 1 };
}

describe("collectSubtree", () => {
  it("returns the subtree parent-before-child, in child-index order", () => {
    const tasks = [t("r", null), t("a", "r"), t("b", "r"), t("a1", "a"), t("b1", "b")];
    const byId = new Map(tasks.map((task) => [task.id, task] as const));
    const out = collectSubtree("r", byId, childIndex(tasks));
    expect(out.map((task) => task.id)).toEqual(["r", "a", "b", "a1", "b1"]);
  });

  it("is empty for an unknown root and bounded against corrupt parent cycles", () => {
    const tasks = [t("x", "y"), t("y", "x")];
    const byId = new Map(tasks.map((task) => [task.id, task] as const));
    const index = childIndex(tasks);
    expect(collectSubtree("missing", byId, index)).toEqual([]);
    expect(collectSubtree("x", byId, index).map((task) => task.id)).toEqual(["x", "y"]);
  });

  it("stays linear on a large flat subtree (O(subtree) per call)", () => {
    // Regression guard: a shift()-based BFS queue made this walk quadratic.
    const tasks: Task[] = [t("root", null)];
    for (let i = 0; i < 50_000; i++) tasks.push(t(`c${i}`, "root"));
    const byId = new Map(tasks.map((task) => [task.id, task] as const));
    const out = collectSubtree("root", byId, childIndex(tasks));
    expect(out).toHaveLength(50_001);
    expect(out[0]!.id).toBe("root");
  });
});

describe("isInSubtree", () => {
  it("is true for the node itself and every descendant, false otherwise", () => {
    const tasks = [t("r", null), t("a", "r"), t("b", "r"), t("a1", "a")];
    const byId = new Map(tasks.map((task) => [task.id, task] as const));
    expect(isInSubtree("r", "r", byId)).toBe(true);
    expect(isInSubtree("a1", "r", byId)).toBe(true);
    expect(isInSubtree("b", "a", byId)).toBe(false);
    expect(isInSubtree("r", "a", byId)).toBe(false);
  });

  it("is bounded against corrupt parent cycles", () => {
    const tasks = [t("x", "y"), t("y", "x")];
    const byId = new Map(tasks.map((task) => [task.id, task] as const));
    expect(isInSubtree("x", "missing", byId)).toBe(false);
  });
});
