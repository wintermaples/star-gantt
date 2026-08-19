// Hostless unit tests for the portfolio node/goal registry (docs/specs/plugins/portfolio.md §2.1,
// §2.4).
import { describe, expect, it } from "vitest";
import { PortfolioRegistry } from "../src/internal/portfolio/registry";
import { resolveMessages } from "../src/internal/messages";

const DEFAULT_MESSAGES = resolveMessages(undefined, () => undefined);
const make = (): PortfolioRegistry =>
  new PortfolioRegistry(DEFAULT_MESSAGES.nodeName, DEFAULT_MESSAGES.goalName);

describe("PortfolioRegistry nodes", () => {
  it("defines nodes with defaults: kind project, generated id and name", () => {
    const r = make();
    const id = r.defineNode({});
    expect(id).toBeDefined();
    const node = r.node(id as string);
    expect(node?.kind).toBe("project");
    expect(node?.name).toBe("Project 1");
  });

  it("generates per-kind ordinals for names", () => {
    const r = make();
    r.defineNode({ kind: "initiative" });
    r.defineNode({ kind: "program" });
    const second = r.defineNode({ kind: "program" });
    expect(r.node(second as string)?.name).toBe("Program 2");
  });

  it("honors a parent only when it is an existing node of a strictly higher rank", () => {
    const r = make();
    r.defineNode({ id: "init", kind: "initiative" });
    r.defineNode({ id: "prog", kind: "program", parentId: "init" });
    r.defineNode({ id: "proj", kind: "project", parentId: "prog" });
    r.defineNode({ id: "bad-peer", kind: "program", parentId: "prog" }); // same rank
    r.defineNode({ id: "bad-up", kind: "initiative", parentId: "proj" }); // inverted
    r.defineNode({ id: "bad-missing", parentId: "nope" }); // unknown parent
    expect(r.node("prog")?.parentId).toBe("init");
    expect(r.node("proj")?.parentId).toBe("prog");
    expect(r.node("bad-peer")?.parentId).toBeUndefined();
    expect(r.node("bad-up")?.parentId).toBeUndefined();
    expect(r.node("bad-missing")?.parentId).toBeUndefined();
  });

  it("redefining a node to an equal-or-lower rank unparents its rank-violating children", () => {
    const r = make();
    r.defineNode({ id: "p1", kind: "initiative" });
    r.defineNode({ id: "prog", kind: "program", parentId: "p1" });
    r.defineNode({ id: "proj", kind: "project", parentId: "p1" });
    // Redefine p1 down to project: neither child may keep it as a parent.
    r.defineNode({ id: "p1", kind: "project" });
    expect(r.node("prog")?.parentId).toBeUndefined();
    expect(r.node("proj")?.parentId).toBeUndefined();
    // A redefinition that keeps a strictly higher rank leaves the children alone.
    const r2 = make();
    r2.defineNode({ id: "top", kind: "initiative" });
    r2.defineNode({ id: "child", kind: "project", parentId: "top" });
    r2.defineNode({ id: "top", kind: "program", name: "renamed" });
    expect(r2.node("child")?.parentId).toBe("top");
  });

  it("keeps taskId on project nodes only", () => {
    const r = make();
    r.defineNode({ id: "p", kind: "project", taskId: "t1" });
    r.defineNode({ id: "g", kind: "program", taskId: "t1" });
    expect(r.node("p")?.taskId).toBe("t1");
    expect(r.node("g")?.taskId).toBeUndefined();
  });

  it("a colliding id replaces its holder in place", () => {
    const r = make();
    r.defineNode({ id: "n", name: "first" });
    r.defineNode({ id: "other", name: "middle" });
    r.defineNode({ id: "n", name: "second" });
    expect(r.list().map((n) => n.name)).toEqual(["second", "middle"]);
  });

  it("nests the tree and lifts children of a removed node to its parent", () => {
    const r = make();
    r.defineNode({ id: "init", kind: "initiative" });
    r.defineNode({ id: "prog", kind: "program", parentId: "init" });
    r.defineNode({ id: "proj", kind: "project", parentId: "prog" });
    const tree = r.tree();
    expect(tree).toHaveLength(1);
    expect(tree[0]?.children[0]?.children[0]?.id).toBe("proj");
    expect(r.removeNode("prog")).toBe(true);
    expect(r.node("proj")?.parentId).toBe("init");
    expect(r.removeNode("prog")).toBe(false);
  });

  it("projectsUnder resolves transitive project descendants", () => {
    const r = make();
    r.defineNode({ id: "init", kind: "initiative" });
    r.defineNode({ id: "prog", kind: "program", parentId: "init" });
    r.defineNode({ id: "pr1", kind: "project", parentId: "prog" });
    r.defineNode({ id: "pr2", kind: "project", parentId: "init" });
    r.defineNode({ id: "outside", kind: "project" });
    expect(r.projectsUnder("init").map((n) => n.id)).toEqual(["pr1", "pr2"]);
    expect(r.projectsUnder("pr1").map((n) => n.id)).toEqual(["pr1"]);
    expect(r.projectsUnder("nope")).toEqual([]);
  });

  it("projectsUnder stays correct and fast over a wide hierarchy (thousands of siblings)", () => {
    const r = make();
    r.defineNode({ id: "init", kind: "initiative" });
    r.defineNode({ id: "prog", kind: "program", parentId: "init" });
    const n = 4000;
    const ids: string[] = [];
    for (let i = 0; i < n; i++) {
      const id = `pr-${i}`;
      ids.push(id);
      r.defineNode({ id, kind: "project", parentId: "prog" });
    }
    for (let i = 0; i < n; i++) r.defineNode({ id: `noise-${i}`, kind: "project" });
    const start = performance.now();
    const under = r.projectsUnder("init").map((x) => x.id);
    const elapsed = performance.now() - start;
    expect(under).toEqual(ids);
    expect(r.projectsUnder("prog").map((x) => x.id)).toEqual(ids);
    expect(elapsed).toBeLessThan(1000);
  });

  it("removeNode lifts stay correct and fast through a long chain of removals", () => {
    const r = make();
    r.defineNode({ id: "init", kind: "initiative" });
    const depth = 500;
    for (let i = 0; i < depth; i++) {
      r.defineNode({ id: `prog-${i}`, kind: "program", parentId: "init" });
    }
    r.defineNode({ id: "leaf", kind: "project", parentId: "prog-0" });
    const start = performance.now();
    for (let i = 0; i < depth; i++) r.removeNode(`prog-${i}`);
    const elapsed = performance.now() - start;
    expect(r.node("leaf")?.parentId).toBe("init");
    expect(r.list().filter((x) => x.kind === "program")).toHaveLength(0);
    expect(elapsed).toBeLessThan(1000);
  });
});

describe("PortfolioRegistry goals", () => {
  it("defines goals with generated names, clamped targets and filtered links", () => {
    const r = make();
    const id = r.defineGoal({ target: 7, nodeIds: ["n", 3], taskIds: ["t"] });
    const goal = r.goal(id as string);
    expect(goal?.name).toBe("Goal 1");
    expect(goal?.target).toBe(1);
    expect(goal?.nodeIds).toEqual(["n", 3]);
    const other = r.defineGoal({ target: 0.5 });
    expect(r.goal(other as string)?.target).toBe(0.5);
  });

  it("removes goals", () => {
    const r = make();
    const id = r.defineGoal({ id: "g" });
    expect(id).toBe("g");
    expect(r.removeGoal("g")).toBe(true);
    expect(r.goals()).toEqual([]);
  });
});
