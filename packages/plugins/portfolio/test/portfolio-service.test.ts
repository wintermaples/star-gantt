// Behavior tests for the portfolio service over a real host and real data store
// (docs/specs/plugins/portfolio.md §2). Exercises the store-shaped API (`nodes`/`goals` stores
// replace the abolished `portfolio/nodesChanged`/`goalsChanged` events), the renamed
// `"stargantt.filter"` target, and the `"stargantt.portfolio/duplicate"` batcher origin prefix.
// Also covers store snapshot immutability + fresh-array-per-change, and the single-transaction
// proof for `duplicateProject`.
import { definePlugin } from "@stargantt/core";
import type { AnyPlugin } from "@stargantt/core";
import { describe, expect, it } from "vitest";
import type { FilterCriteria } from "@stargantt/plugin-interaction";
import type { Task, TaskId, Transaction } from "@stargantt/plugin-data-store";
import {
  DAY0,
  MS_DAY,
  bootHeadless,
  bootHeadlessFilterAfter,
  filterStub,
  loadTwoProjects,
  rowToggleRecorder,
  task,
} from "./_boot";

const projectNodes = [
  { id: "n1", kind: "project" as const, name: "One", taskId: "p1" },
  { id: "n2", kind: "project" as const, name: "Two", taskId: "p2" },
];

/** Counts applied transactions via the always-fired settle event (the `data/tasksChanged`
 *  replacement). */
function transactionRecorder(boot: ReturnType<typeof bootHeadless>): Transaction[] {
  const out: Transaction[] = [];
  boot.on("data/didApplyTransaction", (e) => out.push(e.transaction));
  return out;
}

describe("portfolio service basics", () => {
  it("boots with no config, provides an empty node set and stays silent", () => {
    const boot = bootHeadless();
    expect(boot.portfolioSvc.nodes.get()).toEqual([]);
    expect(boot.portfolioSvc.goals.get()).toEqual([]);
    expect(boot.portfolioSvc.tree()).toEqual([]);
    expect(boot.portfolioSvc.healthSummary()).toEqual([]);
    expect(boot.portfolioSvc.portfolioFilter()).toBeNull();
    boot.dispose();
  });

  it("seeds the nodes/goals stores before the first value is observable (no change owed for it)", () => {
    const boot = bootHeadless({ nodes: [{ id: "n1", name: "Seeded" }], goals: [{ id: "g1" }] });
    // The initial store value already carries the config seed — no subscriber ever saw a "from
    // empty" transition, matching §1.1's "seeding happens before the store's first value is
    // observable" rule.
    expect(boot.portfolioSvc.nodes.get().map((n) => n.id)).toEqual(["n1"]);
    expect(boot.portfolioSvc.goals.get().map((g) => g.id)).toEqual(["g1"]);
    boot.dispose();
  });

  it("resolves tasksOf and projectOf through the live task tree", () => {
    const boot = bootHeadless({
      nodes: [{ id: "prog", kind: "program", name: "P" }, ...projectNodes],
    });
    loadTwoProjects(boot.data);
    expect(boot.portfolioSvc.tasksOf("n1")).toEqual(["p1", "a", "b"]);
    expect(boot.portfolioSvc.projectOf("b")?.id).toBe("n1");
    expect(boot.portfolioSvc.projectOf("x")).toBeUndefined();
    expect(boot.portfolioSvc.tasksOf("unknown")).toEqual([]);
    boot.dispose();
  });

  it("projectOf resolves the earliest-defined project when two are bound to the same root (§2.1)", () => {
    const boot = bootHeadless({
      nodes: [
        { id: "first", kind: "project", taskId: "p1" },
        { id: "second", kind: "project", taskId: "p1" },
      ],
    });
    loadTwoProjects(boot.data);
    expect(boot.portfolioSvc.projectOf("a")?.id).toBe("first");
    expect(boot.portfolioSvc.projectOf("p1")?.id).toBe("first");
    boot.dispose();
  });

  it("tasksOf a program unions its project descendants", () => {
    const boot = bootHeadless({
      nodes: [
        { id: "prog", kind: "program" },
        { id: "n1", kind: "project", parentId: "prog", taskId: "p1" },
        { id: "n2", kind: "project", parentId: "prog", taskId: "p2" },
      ],
    });
    loadTwoProjects(boot.data);
    expect(boot.portfolioSvc.tasksOf("prog")).toEqual(["p1", "a", "b", "p2", "c"]);
    boot.dispose();
  });
});

describe("nodes/goals store publication (v2-new)", () => {
  it("publishes a fresh snapshot array per observable set change; an earlier snapshot's contents never change under it", () => {
    const boot = bootHeadless();
    const seen: (readonly unknown[])[] = [];
    boot.portfolioSvc.nodes.subscribe((next) => seen.push(next));
    const empty = boot.portfolioSvc.nodes.get();
    expect(empty).toEqual([]);
    const id = boot.portfolioSvc.defineNode({ name: "N" });
    const afterDefine = boot.portfolioSvc.nodes.get();
    expect(afterDefine).not.toBe(empty); // fresh array reference, not a mutated one
    expect(seen).toHaveLength(1);
    boot.portfolioSvc.removeNode(id as string);
    boot.portfolioSvc.removeNode("unknown"); // no-op: no further store set
    expect(seen).toHaveLength(2);
    const afterRemove = boot.portfolioSvc.nodes.get();
    expect(afterRemove).not.toBe(afterDefine);
    // The snapshot captured right after define() is untouched by the later removal — a later
    // change supersedes the store's value, it never mutates an already-handed-out array in place.
    expect(afterDefine.map((n) => n.id)).toEqual([id]);
    expect(afterRemove).toEqual([]);
    boot.dispose();
  });

  it("goals store publishes fresh snapshots the same way", () => {
    const boot = bootHeadless();
    const seen: number[] = [];
    boot.portfolioSvc.goals.subscribe((next) => seen.push(next.length));
    const gid = boot.portfolioSvc.defineGoal({});
    boot.portfolioSvc.removeGoal(gid as string);
    expect(seen).toEqual([1, 0]);
    boot.dispose();
  });
});

describe("project collapse", () => {
  it("dispatches view/rowToggle for bound project roots only", () => {
    const log: { id: TaskId; expanded?: boolean }[] = [];
    const boot = bootHeadless(
      { nodes: [...projectNodes, { id: "prog", kind: "program" }, { id: "unbound" }] },
      [rowToggleRecorder(log)],
    );
    loadTwoProjects(boot.data);
    boot.portfolioSvc.setProjectCollapsed("n1", true);
    boot.portfolioSvc.setProjectCollapsed("unbound", true);
    boot.portfolioSvc.setProjectCollapsed("prog", true);
    expect(log).toEqual([{ id: "p1", expanded: false }]);
    log.length = 0;
    boot.portfolioSvc.collapseAllProjects();
    expect(log).toEqual([
      { id: "p1", expanded: false },
      { id: "p2", expanded: false },
    ]);
    log.length = 0;
    boot.portfolioSvc.expandAllProjects();
    expect(log).toEqual([
      { id: "p1", expanded: true },
      { id: "p2", expanded: true },
    ]);
    boot.dispose();
  });

  it("is a silent no-op without the tree-grid command registered", () => {
    const boot = bootHeadless({ nodes: projectNodes });
    loadTwoProjects(boot.data);
    expect(() => boot.portfolioSvc.collapseAllProjects()).not.toThrow();
    boot.dispose();
  });
});

describe("health", () => {
  it("aggregates per node and across the summary", () => {
    const boot = bootHeadless({ nodes: projectNodes });
    loadTwoProjects(boot.data);
    const now = DAY0 + 12 * MS_DAY;
    const one = boot.portfolioSvc.health("n1", now);
    expect(one).toMatchObject({ nodeId: "n1", status: "late", lateCount: 1, taskCount: 2 });
    const early = DAY0 + 2 * MS_DAY;
    expect(boot.portfolioSvc.health("n1", early)?.status).toBe("on-track");
    expect(boot.portfolioSvc.health("n2", early)?.status).toBe("at-risk");
    expect(boot.portfolioSvc.health("unknown", now)).toBeUndefined();
    expect(boot.portfolioSvc.healthSummary(now).map((h) => h.status)).toEqual(["late", "late"]);
    boot.dispose();
  });
});

describe("goals", () => {
  it("rolls duration-weighted progress up from linked nodes and task subtrees", () => {
    const boot = bootHeadless({ nodes: projectNodes });
    loadTwoProjects(boot.data);
    const gid = boot.portfolioSvc.defineGoal({ nodeIds: ["n1"], target: 0.6 });
    const p = boot.portfolioSvc.goalProgress(gid as string);
    expect(p?.taskCount).toBe(2);
    expect(p?.progress).toBeCloseTo(0.7);
    expect(p?.achieved).toBe(true);
    const gid2 = boot.portfolioSvc.defineGoal({ nodeIds: ["n1"], taskIds: ["p1"] });
    expect(boot.portfolioSvc.goalProgress(gid2 as string)?.taskCount).toBe(2);
    expect(boot.portfolioSvc.goalProgress("unknown")).toBeUndefined();
    boot.dispose();
  });

  it("a goal with no resolvable task is never achieved", () => {
    const boot = bootHeadless();
    const gid = boot.portfolioSvc.defineGoal({});
    const p = boot.portfolioSvc.goalProgress(gid as string);
    expect(p).toMatchObject({ progress: 0, taskCount: 0, achieved: false });
    boot.portfolioSvc.removeGoal(gid as string);
    expect(boot.portfolioSvc.goals.get()).toEqual([]);
    boot.dispose();
  });

  it("goal progress follows store edits with no subscription (resolved fresh at call time)", () => {
    const boot = bootHeadless({ nodes: projectNodes });
    loadTwoProjects(boot.data);
    const gid = boot.portfolioSvc.defineGoal({ nodeIds: ["n2"] });
    expect(boot.portfolioSvc.goalProgress(gid as string)?.progress).toBe(0);
    boot.dispatch("task/update", { id: "c", after: { progress: 1 } });
    expect(boot.portfolioSvc.goalProgress(gid as string)?.progress).toBe(1);
    boot.dispose();
  });
});

describe("template duplication", () => {
  it("copies the subtree and internal links as one transaction, shifted and reset", () => {
    const boot = bootHeadless({ nodes: projectNodes });
    loadTwoProjects(boot.data);
    const transactions = transactionRecorder(boot);
    const before = [...boot.data.taskIds()].length;
    const newRoot = boot.portfolioSvc.duplicateProject("n1", { startAt: DAY0 + 20 * MS_DAY });
    expect(newRoot).toBeDefined();
    // One transaction covers all three copied tasks and the copied a->b link — one undo step.
    expect(transactions).toHaveLength(1);
    expect(transactions[0]?.origin).toMatch(/^stargantt\.portfolio\/duplicate#\d+$/);
    expect([...boot.data.taskIds()].length).toBe(before + 3);
    const root = boot.data.getTask(newRoot as TaskId) as Task;
    expect(root.parentId).toBeNull();
    expect(root.name).toBe("Project One (copy)");
    expect(root.start).toBe(DAY0 + 20 * MS_DAY);
    const children = [...boot.data.taskIds()]
      .map((id) => boot.data.getTask(id) as Task)
      .filter((t) => t.parentId === root.id);
    expect(children).toHaveLength(2);
    for (const child of children) expect(child.progress).toBeUndefined();
    const copiedLinks = [...boot.data.links.get().values()].filter(
      (l) => l.sourceId !== "a" && children.some((c) => c.id === l.sourceId),
    );
    expect(copiedLinks).toHaveLength(1);
    // The source project node spawned a sibling node bound to the copy.
    const nodes = boot.portfolioSvc.nodes.get();
    expect(nodes.some((n) => n.taskId === newRoot && n.kind === "project")).toBe(true);
    boot.dispose();
  });

  it("accepts a raw root task id, keeps progress on request, and rejects unknown sources", () => {
    const boot = bootHeadless();
    loadTwoProjects(boot.data);
    const copy = boot.portfolioSvc.duplicateProject("p1", { keepProgress: true, name: "T" });
    const root = boot.data.getTask(copy as TaskId) as Task;
    expect(root.name).toBe("T");
    const children = [...boot.data.taskIds()]
      .map((id) => boot.data.getTask(id) as Task)
      .filter((t) => t.parentId === root.id);
    expect(children.map((c) => c.progress).sort()).toEqual([0.5, 1]);
    expect(boot.portfolioSvc.duplicateProject("missing")).toBeUndefined();
    expect(boot.portfolioSvc.nodes.get()).toEqual([]);
    boot.dispose();
  });

  it("keys the duplication patch-append on origin, not a bare re-entrancy flag", () => {
    // A stand-in for a command-bus interceptor: on seeing the duplication's own transaction, it
    // dispatches an unrelated `task/add` (a different origin) synchronously nested inside that
    // same `data/willApplyTransaction` notification — before the duplication's own patches have
    // landed. Registered ahead of the portfolio plugin so its handler runs first on that event.
    const interloper: AnyPlugin = definePlugin({
      meta: { id: "test.interloper" },
      setup: (ctx) => {
        let fired = false;
        ctx.on("data/willApplyTransaction", (e) => {
          if (fired || !e.transaction.origin.startsWith("stargantt.portfolio/duplicate")) return;
          fired = true;
          ctx.dispatch("task/add", {
            task: { id: "interloper", name: "Interloper", start: DAY0, end: DAY0 + MS_DAY },
            origin: "foreign",
          });
        });
      },
    });
    const boot = bootHeadless({ nodes: projectNodes }, [interloper]);
    loadTwoProjects(boot.data);
    const transactions = transactionRecorder(boot);
    const newRoot = boot.portfolioSvc.duplicateProject("n1", { startAt: DAY0 + 20 * MS_DAY });
    expect(newRoot).toBeDefined();
    const root = boot.data.getTask(newRoot as TaskId) as Task;
    const children = [...boot.data.taskIds()]
      .map((id) => boot.data.getTask(id) as Task)
      .filter((t) => t.parentId === root.id);
    expect(children).toHaveLength(2);
    // Two undo-visible transactions: the interloper's own bare add, and the whole copy still
    // landing as one grouped transaction.
    const foreignTx = transactions.find((t) => t.origin === "foreign");
    const duplicateTx = transactions.find((t) => t.origin.startsWith("stargantt.portfolio/duplicate"));
    expect(foreignTx?.patches).toHaveLength(1);
    expect(duplicateTx?.patches.length).toBeGreaterThan(1);
    expect(boot.data.getTask("interloper")?.parentId).toBeNull();
    boot.dispose();
  });
});

describe("cross-project task move", () => {
  it("reparents into the target project's root as one update", () => {
    const boot = bootHeadless({ nodes: projectNodes });
    loadTwoProjects(boot.data);
    expect(boot.portfolioSvc.moveTaskToProject("a", "n2")).toBe(true);
    expect(boot.data.getTask("a")?.parentId).toBe("p2");
    expect(boot.portfolioSvc.projectOf("a")?.id).toBe("n2");
    boot.dispose();
  });

  it("refuses unknown targets, unbound projects, cycles and unknown tasks", () => {
    const boot = bootHeadless({
      nodes: [...projectNodes, { id: "unbound", kind: "project" }],
    });
    loadTwoProjects(boot.data);
    expect(boot.portfolioSvc.moveTaskToProject("a", "missing")).toBe(false);
    expect(boot.portfolioSvc.moveTaskToProject("a", "unbound")).toBe(false);
    expect(boot.portfolioSvc.moveTaskToProject("missing", "n1")).toBe(false);
    expect(boot.portfolioSvc.moveTaskToProject("p1", "n1")).toBe(false);
    expect(boot.data.getTask("a")?.parentId).toBe("p1");
    const transactions = transactionRecorder(boot);
    expect(boot.portfolioSvc.moveTaskToProject("a", "n1")).toBe(true);
    expect(transactions).toHaveLength(0);
    boot.dispose();
  });
});

describe("portfolio filter and saved views", () => {
  it("narrows through the filter service and re-resolves after data changes", () => {
    const state: { criteria: FilterCriteria | null } = { criteria: null };
    const boot = bootHeadless({ nodes: projectNodes }, [filterStub(state)]);
    loadTwoProjects(boot.data);
    boot.portfolioSvc.applyPortfolioFilter(["n1"]);
    expect(boot.portfolioSvc.portfolioFilter()).toEqual(["n1"]);
    const visible = (id: TaskId): boolean =>
      state.criteria?.predicate?.(boot.data.getTask(id) as Task) === true;
    expect(visible("a")).toBe(true);
    expect(visible("c")).toBe(false);
    // A task added under p1 later becomes visible without re-applying (the invalidate-on-
    // `data.tasks` rule of §2.6).
    boot.dispatch("task/add", {
      task: { id: "a2", parentId: "p1", name: "late add", start: DAY0, end: DAY0 + MS_DAY },
    });
    expect(visible("a2")).toBe(true);
    boot.portfolioSvc.applyPortfolioFilter(null);
    expect(state.criteria).toBeNull();
    expect(boot.portfolioSvc.portfolioFilter()).toBeNull();
    boot.dispose();
  });

  it("saves, applies, lists and deletes views, seeded from config", () => {
    const state: { criteria: FilterCriteria | null } = { criteria: null };
    const boot = bootHeadless(
      { nodes: projectNodes, views: { seeded: { nodeIds: ["n2"] } } },
      [filterStub(state)],
    );
    loadTwoProjects(boot.data);
    boot.portfolioSvc.applyPortfolioFilter(["n1"]);
    boot.portfolioSvc.savePortfolioView("mine");
    expect(boot.portfolioSvc.portfolioViewNames()).toEqual(["seeded", "mine"]);
    expect(boot.portfolioSvc.applyPortfolioView("seeded")).toBe(true);
    expect(boot.portfolioSvc.portfolioFilter()).toEqual(["n2"]);
    expect(boot.portfolioSvc.applyPortfolioView("nope")).toBe(false);
    expect(boot.portfolioSvc.deletePortfolioView("mine")).toBe(true);
    expect(boot.portfolioSvc.portfolioViewNames()).toEqual(["seeded"]);
    boot.portfolioSvc.savePortfolioView("");
    expect(boot.portfolioSvc.portfolioViewNames()).toEqual(["seeded"]);
    boot.dispose();
  });

  it("narrows rows regardless of registration order (v2: meta.optional never orders startup)", () => {
    const state: { criteria: FilterCriteria | null } = { criteria: null };
    const boot = bootHeadlessFilterAfter({ nodes: projectNodes }, [filterStub(state)]);
    loadTwoProjects(boot.data);
    boot.portfolioSvc.applyPortfolioFilter(["n1"]);
    expect(boot.portfolioSvc.portfolioFilter()).toEqual(["n1"]);
    const visible = (id: TaskId): boolean =>
      state.criteria?.predicate?.(boot.data.getTask(id) as Task) === true;
    expect(visible("a")).toBe(true);
    expect(visible("c")).toBe(false);
    boot.dispose();
  });

  it("is a silent no-op without the filter service", () => {
    const boot = bootHeadless({ nodes: projectNodes });
    loadTwoProjects(boot.data);
    expect(() => boot.portfolioSvc.applyPortfolioFilter(["n1"])).not.toThrow();
    expect(boot.portfolioSvc.portfolioFilter()).toBeNull();
    boot.dispose();
  });
});

describe("messages", () => {
  it("uses supplied builders and contains a throwing one", () => {
    const errors: unknown[] = [];
    const boot = bootHeadless({
      nodes: [{ kind: "program" }],
      messages: {
        nodeName: ({ kind, ordinal }) => `K:${kind}:${ordinal}`,
        copyName: () => {
          throw new Error("boom");
        },
      },
    });
    boot.on("core/pluginError", (e) => errors.push(e.pluginId));
    expect(boot.portfolioSvc.nodes.get()[0]?.name).toBe("K:program:1");
    boot.data.load([task("p", DAY0, DAY0 + MS_DAY, { name: "Root" })]);
    const copy = boot.portfolioSvc.duplicateProject("p");
    // The throwing copyName builder is contained: default text, one report.
    expect(boot.data.getTask(copy as TaskId)?.name).toBe("Root (copy)");
    expect(errors).toEqual(["stargantt.portfolio"]);
    boot.dispose();
  });
});
