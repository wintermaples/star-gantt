// Hostless unit coverage of the aggregation math, the formula registry and the PDF report
// builder (docs/specs/plugins/portfolio.md §3.1–§3.5, §3.8).
import { describe, expect, it } from "vitest";
import type { Task } from "@stargantt/plugin-data-store";
import {
  computeBurndown,
  computeGroupProgress,
  computeMilestones,
  computeOverdue,
  computeSpi,
  computeStatusCounts,
  computeSummary,
  computeWorkload,
} from "../src/internal/dashboard/compute";
import { buildReportLines, exportPdf } from "../src/internal/dashboard/export";
import { createFormulaRegistry, evaluateFormulas } from "../src/internal/dashboard/formulas";
import { resolveMessages } from "../src/internal/messages";
import type { DashboardModel } from "../src/internal/dashboard/model";

const DAY0 = Date.UTC(2026, 0, 5);
const MS_DAY = 86_400_000;
const t = (id: string, start: number, end: number, over: Partial<Task> = {}): Task => ({
  id,
  parentId: null,
  name: `task ${id}`,
  start,
  end,
  ...over,
});

const fixture: Task[] = [
  t("sum", DAY0, DAY0 + 10 * MS_DAY, { type: "summary" }),
  t("done", DAY0, DAY0 + 2 * MS_DAY, { progress: 1 }),
  t("late", DAY0, DAY0 + 2 * MS_DAY, { progress: 0.5 }),
  t("running", DAY0, DAY0 + 10 * MS_DAY, { progress: 0.5 }),
  t("future", DAY0 + 20 * MS_DAY, DAY0 + 22 * MS_DAY),
  t("ms", DAY0 + 4 * MS_DAY, DAY0 + 4 * MS_DAY, { type: "milestone" }),
];
const NOW = DAY0 + 5 * MS_DAY;

describe("computeSummary", () => {
  it("counts leaves, completion and overdue, skipping summaries and milestones", () => {
    const s = computeSummary(fixture, NOW);
    expect(s.taskCount).toBe(4);
    expect(s.completedCount).toBe(1);
    expect(s.remainingCount).toBe(3);
    expect(s.overdueCount).toBe(1); // "late" ended day 2 with progress .5
    expect(s.milestoneCount).toBe(1);
    expect(s.progress).toBeGreaterThan(0);
    expect(s.progress).toBeLessThan(1);
  });

  it("is all-zero over an empty set", () => {
    expect(computeSummary([], NOW)).toEqual({
      taskCount: 0,
      completedCount: 0,
      remainingCount: 0,
      overdueCount: 0,
      milestoneCount: 0,
      progress: 0,
    });
  });
});

describe("computeOverdue", () => {
  it("lists only incomplete tasks whose end passed, most-overdue first", () => {
    const rows = computeOverdue(
      [...fixture, t("older", DAY0 - 5 * MS_DAY, DAY0 - 2 * MS_DAY)],
      NOW,
    );
    expect(rows.map((r) => r.id)).toEqual(["older", "late"]);
    expect(rows[1]).toMatchObject({ daysOverdue: 3, progress: 0.5 });
  });

  it("clamps daysOverdue to at least 1 at the exact end===now boundary (Math.ceil(0) would be 0)", () => {
    const rows = computeOverdue([t("just-ended", DAY0, NOW)], NOW);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.daysOverdue).toBe(1);
  });
});

describe("computeStatusCounts", () => {
  it("buckets by progress", () => {
    expect(computeStatusCounts(fixture)).toEqual({ notStarted: 1, inProgress: 2, completed: 1 });
  });
});

describe("computeMilestones", () => {
  it("classifies reached / overdue / pending, in date order", () => {
    const rows = computeMilestones(
      [
        t("m-late", DAY0, DAY0, { type: "milestone" }),
        t("m-done", DAY0 + 1 * MS_DAY, DAY0 + 1 * MS_DAY, { type: "milestone", progress: 1 }),
        t("m-future", DAY0 + 9 * MS_DAY, DAY0 + 9 * MS_DAY, { type: "milestone" }),
        t("plain", DAY0, DAY0 + MS_DAY),
      ],
      NOW,
    );
    expect(rows.map((r) => r.id)).toEqual(["m-late", "m-done", "m-future"]);
    expect(rows[0]).toMatchObject({ reached: false, overdue: true });
    expect(rows[1]).toMatchObject({ reached: true, overdue: false });
    expect(rows[2]).toMatchObject({ reached: false, overdue: false });
  });

  it("a milestone dated exactly now is overdue — the boundary is inclusive (start <= now)", () => {
    const rows = computeMilestones([t("m-now", NOW, NOW, { type: "milestone" })], NOW);
    expect(rows[0]).toMatchObject({ reached: false, overdue: true });
  });
});

describe("computeWorkload", () => {
  it("sums units × duration days per resource, largest first", () => {
    const rows = computeWorkload(
      fixture,
      [
        { taskId: "running", resourceId: "r1", units: 0.5 },
        { taskId: "done", resourceId: "r1", units: 1 },
        { taskId: "late", resourceId: "r2", units: 1 },
        { taskId: "sum", resourceId: "r2", units: 1 }, // summary — skipped
        { taskId: "ghost", resourceId: "r2", units: 1 }, // unknown task — skipped
      ],
      [{ id: "r1", name: "Alice" }],
    );
    expect(rows).toEqual([
      { resourceId: "r1", name: "Alice", personDays: 7, taskCount: 2 },
      { resourceId: "r2", name: "r2", personDays: 2, taskCount: 1 },
    ]);
  });
});

describe("computeGroupProgress", () => {
  it("buckets by label and reports weighted progress, alphabetically", () => {
    const rows = computeGroupProgress(fixture, (task) =>
      task.id === "done" || task.id === "late" ? "B" : task.id === "running" ? "A" : undefined,
    );
    expect(rows.map((r) => r.group)).toEqual(["A", "B"]);
    expect(rows[0]).toMatchObject({ progress: 0.5, taskCount: 1 });
    expect(rows[1]?.taskCount).toBe(2);
    expect(rows[1]?.progress).toBeCloseTo(0.75, 5);
  });
});

describe("computeBurndown", () => {
  it("steps the planned curve down at end dates and maps snapshots to the actual curve", () => {
    const series = computeBurndown(fixture, [
      { date: DAY0, completedCount: 0, taskCount: 4 },
      { date: DAY0 + 3 * MS_DAY, completedCount: 1, taskCount: 4 },
    ]);
    expect(series.taskCount).toBe(4);
    expect(series.planned[0]).toEqual({ date: DAY0, remaining: 4 });
    expect(series.planned).toEqual([
      { date: DAY0, remaining: 4 },
      { date: DAY0 + 2 * MS_DAY, remaining: 2 },
      { date: DAY0 + 10 * MS_DAY, remaining: 1 },
      { date: DAY0 + 22 * MS_DAY, remaining: 0 },
    ]);
    expect(series.actual).toEqual([
      { date: DAY0, remaining: 4 },
      { date: DAY0 + 3 * MS_DAY, remaining: 3 },
    ]);
  });

  it("is empty over an empty set", () => {
    expect(computeBurndown([], [])).toEqual({ taskCount: 0, planned: [], actual: [] });
  });

  it("handles 200,000 tasks without a call-stack overflow and reports the correct start", () => {
    const N = 200_000;
    const big: Task[] = [];
    for (let i = 0; i < N; i += 1) {
      big.push(t(`t${i}`, DAY0 + i * MS_DAY, DAY0 + (i + 1) * MS_DAY));
    }
    let series: ReturnType<typeof computeBurndown> | undefined;
    expect(() => {
      series = computeBurndown(big, []);
    }).not.toThrow();
    expect(series).toBeDefined();
    const s = series as NonNullable<typeof series>;
    expect(s.taskCount).toBe(N);
    expect(s.planned[0]).toEqual({ date: DAY0, remaining: N });
    expect(s.planned[s.planned.length - 1]).toEqual({
      date: DAY0 + N * MS_DAY,
      remaining: 0,
    });
  });
});

describe("computeSpi", () => {
  it("is EV/PV and undefined before any planned value accrues", () => {
    const one = [t("a", DAY0, DAY0 + 2 * MS_DAY, { progress: 0.5 })];
    expect(computeSpi(one, DAY0 + MS_DAY)).toBeCloseTo(1, 5); // 50% done at 50% elapsed
    expect(computeSpi(one, DAY0 + 2 * MS_DAY)).toBeCloseTo(0.5, 5);
    expect(computeSpi(one, DAY0 - MS_DAY)).toBeUndefined();
  });
});

describe("formulas", () => {
  it("evaluates with filter and format, and generates labels", () => {
    const registry = createFormulaRegistry((n) => `Metric ${n}`);
    const id = registry.define({
      filter: (task) => task.type !== "summary",
      evaluate: (tasks) => tasks.length,
      format: (v) => `${v} tasks`,
    });
    expect(id).toBe("formula-1");
    const values = evaluateFormulas(registry, fixture, "—", () => undefined);
    expect(values).toEqual([{ id: "formula-1", label: "Metric 1", value: 5, text: "5 tasks" }]);
  });

  it("contains throwing hooks and rejects inits without evaluate", () => {
    const registry = createFormulaRegistry((n) => `Metric ${n}`);
    expect(registry.define({} as never)).toBeUndefined();
    registry.define({
      id: "boom",
      evaluate: () => {
        throw new Error("x");
      },
    });
    registry.define({ id: "nan", evaluate: () => Number.NaN });
    const errors: string[] = [];
    const values = evaluateFormulas(registry, fixture, "—", (id) => void errors.push(id));
    expect(values.map((v) => v.text)).toEqual(["—", "—"]);
    expect(values.map((v) => v.value)).toEqual([undefined, undefined]);
    expect(errors).toEqual(["boom"]);
  });
});

function emptyModel(widgets: DashboardModel["widgets"]): DashboardModel {
  return {
    widgets,
    summary: {
      taskCount: 0,
      completedCount: 0,
      remainingCount: 0,
      overdueCount: 0,
      milestoneCount: 0,
      progress: 0,
    },
    overdue: [],
    burndown: { taskCount: 0, planned: [], actual: [] },
    workload: [],
    status: { notStarted: 0, inProgress: 0, completed: 0 },
    milestones: [],
    goals: [],
    portfolio: [],
    groups: [],
    formulas: [],
  };
}

describe("buildReportLines", () => {
  it("routes every heading and body line through the given catalog, never the built-in English default", () => {
    const messages = resolveMessages(
      {
        widgetTitle: (w) => `TITLE:${w}`,
        summaryText: () => "OVERRIDDEN-SUMMARY-LINE",
      },
      () => undefined,
    );
    const lines = buildReportLines(emptyModel(["summary"]), messages);
    expect(lines).toEqual(["## TITLE:summary", "OVERRIDDEN-SUMMARY-LINE"]);
    // The built-in English default never leaked through.
    expect(lines.join(" ")).not.toContain("Progress");
    expect(lines.join(" ")).not.toContain("% complete");
  });
});

describe("exportPdf", () => {
  it("builds a well-formed single-page PDF data URL", () => {
    const url = exportPdf("Dashboard report", ["line one", "50% (done)"]);
    expect(url.startsWith("data:application/pdf;base64,")).toBe(true);
    const pdf = Buffer.from(url.slice("data:application/pdf;base64,".length), "base64").toString(
      "latin1",
    );
    expect(pdf.startsWith("%PDF-1.4")).toBe(true);
    expect(pdf).toContain("(Dashboard report) Tj");
    expect(pdf).toContain("(line one) Tj");
    expect(pdf).toContain("(50% \\(done\\)) Tj");
    expect(pdf.trimEnd().endsWith("%%EOF")).toBe(true);
  });

  it("replaces non-Latin-1 characters with ? — the built-in Helvetica font covers WinAnsi only", () => {
    // "日本語" is three non-Latin-1 characters -> three "?"; the emoji is a UTF-16 surrogate pair,
    // each half individually outside the Latin-1 range -> two "?".
    const url = exportPdf("日本語 title", ["emoji \u{1F389} line"]);
    const pdf = Buffer.from(url.slice("data:application/pdf;base64,".length), "base64").toString(
      "latin1",
    );
    expect(pdf).toContain("(??? title) Tj");
    expect(pdf).toContain("(emoji ?? line) Tj");
    expect(pdf).not.toContain("日本語");
  });
});
