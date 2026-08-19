// Headless behavior of the dashboard service over the real host and data store
// (docs/specs/plugins/portfolio.md §3). The dashboard and portfolio areas are one plugin instance,
// so the portfolio-backed aggregations are always composed (§3.3, "recorded consequence of the
// merge").
import { describe, expect, it } from "vitest";
import { tracking } from "@stargantt/plugin-tracking";
import { DAY0, MS_DAY, bootHeadless, task } from "./_boot";

const NOW = DAY0 + 5 * MS_DAY;

function loadFixture(data: ReturnType<typeof bootHeadless>["data"]): void {
  data.load({
    tasks: [
      task("done", DAY0, DAY0 + 2 * MS_DAY, { progress: 1 }),
      task("late", DAY0, DAY0 + 2 * MS_DAY, { name: "Late one", progress: 0.5 }),
      task("running", DAY0, DAY0 + 10 * MS_DAY, { progress: 0.5 }),
      task("ms", DAY0 + 4 * MS_DAY, DAY0 + 4 * MS_DAY, { type: "milestone" }),
    ],
    resources: [{ id: "r1", name: "Alice" }],
    assignments: [{ taskId: "running", resourceId: "r1", units: 0.5 }],
  });
}

describe("aggregations over the store", () => {
  it("summary, overdue, status, milestones and workload reflect the loaded data", () => {
    const b = bootHeadless();
    try {
      loadFixture(b.data);
      expect(b.dashboardSvc.summary(NOW)).toMatchObject({
        taskCount: 3,
        completedCount: 1,
        remainingCount: 2,
        overdueCount: 1,
        milestoneCount: 1,
      });
      expect(b.dashboardSvc.overdueTasks(NOW).map((r) => r.id)).toEqual(["late"]);
      expect(b.dashboardSvc.statusCounts()).toEqual({ notStarted: 0, inProgress: 2, completed: 1 });
      expect(b.dashboardSvc.milestones(NOW)).toEqual([
        { id: "ms", name: "task ms", date: DAY0 + 4 * MS_DAY, reached: false, overdue: true },
      ]);
      expect(b.dashboardSvc.workload()).toEqual([
        { resourceId: "r1", name: "Alice", personDays: 5, taskCount: 1 },
      ]);
      // Default grouping: the first assigned resource's name.
      expect(b.dashboardSvc.groupComparison()).toEqual([
        { group: "Alice", progress: 0.5, taskCount: 1 },
      ]);
    } finally {
      b.dispose();
    }
  });

  it("follows store edits without any explicit refresh", () => {
    const b = bootHeadless();
    try {
      loadFixture(b.data);
      b.dispatch("task/update", { id: "late", after: { progress: 1 } });
      expect(b.dashboardSvc.overdueTasks(NOW)).toEqual([]);
      expect(b.dashboardSvc.statusCounts().completed).toBe(2);
    } finally {
      b.dispose();
    }
  });
});

describe("groupOf containment (§3.2)", () => {
  it("a throwing groupOf drops just that task, reports exactly one core/pluginError, and groupComparison() never throws", () => {
    const b = bootHeadless({
      dashboard: {
        groupOf: (t) => {
          if (t.id === "boom") throw new Error("groupOf boom");
          return "Team";
        },
      },
    });
    try {
      b.data.load([
        task("boom", DAY0, DAY0 + MS_DAY),
        task("ok", DAY0, DAY0 + MS_DAY),
      ]);
      const errors: { pluginId: string; error: unknown }[] = [];
      b.on("core/pluginError", (e) => errors.push(e));
      let rows: ReturnType<typeof b.dashboardSvc.groupComparison> = [];
      expect(() => {
        rows = b.dashboardSvc.groupComparison();
      }).not.toThrow();
      // Only "ok" is bucketed — the throwing task is left out, not crashed on.
      expect(rows).toEqual([{ group: "Team", progress: 0, taskCount: 1 }]);
      expect(errors).toHaveLength(1);
      expect(errors[0]?.pluginId).toBe("stargantt.portfolio");
    } finally {
      b.dispose();
    }
  });
});

describe("formulas", () => {
  it("evaluates config-seeded and service-defined formulas over the task set", () => {
    const b = bootHeadless({
      dashboard: { formulas: [{ id: "count", label: "Tasks", evaluate: (tasks) => tasks.length }] },
    });
    try {
      loadFixture(b.data);
      expect(b.dashboardSvc.formulaValues()).toEqual([
        { id: "count", label: "Tasks", value: 4, text: "4" },
      ]);
      const id = b.dashboardSvc.defineFormula({
        evaluate: (tasks) => tasks.filter((t) => (t.progress ?? 0) >= 1).length,
      });
      expect(id).toBeDefined();
      expect(b.dashboardSvc.formulaValues().map((v) => v.value)).toEqual([4, 1]);
      expect(b.dashboardSvc.removeFormula(id as string)).toBe(true);
      expect(b.dashboardSvc.removeFormula("ghost")).toBe(false);
    } finally {
      b.dispose();
    }
  });
});

describe("updateTaskStatus", () => {
  it("commits progress as one undoable task/update and rejects unusable patches", () => {
    const b = bootHeadless();
    try {
      loadFixture(b.data);
      expect(b.dashboardSvc.updateTaskStatus("late", { progress: 2 })).toBe(true); // clamped
      expect(b.data.getTask("late")?.progress).toBe(1);
      expect(b.dashboardSvc.updateTaskStatus("ghost", { progress: 1 })).toBe(false);
      expect(b.dashboardSvc.updateTaskStatus("late", {})).toBe(false);
      expect(b.dashboardSvc.updateTaskStatus("late", { progress: Number.NaN })).toBe(false);
      // Without the tracking plugin a rag-only patch applies nothing.
      expect(b.dashboardSvc.updateTaskStatus("late", { rag: "red" })).toBe(false);
    } finally {
      b.dispose();
    }
  });

  it("routes rag through the tracking plugin when composed", () => {
    const b = bootHeadless(undefined, [tracking()]);
    try {
      loadFixture(b.data);
      const progress = b.host.service("stargantt.progress");
      expect(b.dashboardSvc.updateTaskStatus("late", { rag: "red" })).toBe(true);
      expect(progress.ragOf("late")).toBe("red");
      expect(b.dashboardSvc.updateTaskStatus("late", { rag: null })).toBe(true);
      expect(progress.ragOf("late")).toBeUndefined();
      expect(b.dashboardSvc.updateTaskStatus("late", { rag: "purple" as never })).toBe(false);
    } finally {
      b.dispose();
    }
  });
});

describe("burndown", () => {
  it("derives the actual curve from tracking-plugin snapshots", () => {
    const b = bootHeadless(undefined, [tracking()]);
    try {
      loadFixture(b.data);
      const progress = b.host.service("stargantt.progress");
      progress.recordSnapshot(DAY0 + 3 * MS_DAY);
      const series = b.dashboardSvc.burndown();
      expect(series.taskCount).toBe(3);
      expect(series.planned[0]?.remaining).toBe(3);
      expect(series.planned[series.planned.length - 1]?.remaining).toBe(0);
      expect(series.actual.length).toBe(1);
    } finally {
      b.dispose();
    }
  });

  it("has an empty actual curve without the tracking plugin", () => {
    const b = bootHeadless();
    try {
      loadFixture(b.data);
      expect(b.dashboardSvc.burndown().actual).toEqual([]);
    } finally {
      b.dispose();
    }
  });
});

describe("portfolio roll-ups", () => {
  it("reports goal roll-ups and per-node status rows through the (always-composed) portfolio area", () => {
    const b = bootHeadless({
      nodes: [{ id: "p1", kind: "project", name: "Project One", taskId: "root" }],
      goals: [{ id: "g1", name: "Ship it", nodeIds: ["p1"], target: 0.5 }],
    });
    try {
      b.data.load({
        tasks: [
          task("root", DAY0, DAY0 + 4 * MS_DAY, { type: "summary" }),
          task("a", DAY0, DAY0 + 2 * MS_DAY, { parentId: "root", progress: 1 }),
          task("b", DAY0 + 2 * MS_DAY, DAY0 + 4 * MS_DAY, { parentId: "root", progress: 0 }),
        ],
      });
      const goals = b.dashboardSvc.goalRollups();
      expect(goals).toEqual([
        { goalId: "g1", name: "Ship it", progress: 0.5, target: 0.5, achieved: true, taskCount: 2 },
      ]);
      const rows = b.dashboardSvc.portfolioStatus(DAY0 + 4 * MS_DAY);
      expect(rows.length).toBe(1);
      expect(rows[0]).toMatchObject({
        nodeId: "p1",
        name: "Project One",
        lateCount: 1,
        taskCount: 2,
        status: "late",
      });
      expect(rows[0]?.progress).toBeCloseTo(0.5, 5);
      expect(rows[0]?.spi).toBeCloseTo(0.5, 5);
    } finally {
      b.dispose();
    }
  });

  it("is empty over an empty node/goal set (no config) — always composed, never a service gap", () => {
    const b = bootHeadless();
    try {
      loadFixture(b.data);
      expect(b.dashboardSvc.goalRollups()).toEqual([]);
      expect(b.dashboardSvc.portfolioStatus()).toEqual([]);
    } finally {
      b.dispose();
    }
  });
});

describe("panel surface without stargantt.view", () => {
  it("open() refuses and export falls back per format", () => {
    const b = bootHeadless();
    try {
      loadFixture(b.data);
      expect(b.dashboardSvc.open()).toBe(false);
      expect(b.dashboardSvc.isOpen()).toBe(false);
      expect(b.dashboardSvc.element()).toBeUndefined();
      expect(b.dashboardSvc.exportReport("png")).toBeUndefined();
      const pdf = b.dashboardSvc.exportReport("pdf");
      expect(typeof pdf).toBe("string");
      expect((pdf as string).startsWith("data:application/pdf;base64,")).toBe(true);
    } finally {
      b.dispose();
    }
  });
});
