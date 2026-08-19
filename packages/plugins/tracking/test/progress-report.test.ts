// Covers the "status report" behavior and the leaf-only enumeration rule of this area's `report.ts`.
import { describe, expect, it } from "vitest";
import { buildStatusReport, progressPointOf, reportTasks } from "../src/internal/progress/report";
import type { ReportTask } from "../src/internal/progress/report";
import { fakeDataService, stubTask } from "./progress-doubles";

const MS_DAY = 86_400_000;

describe("buildStatusReport", () => {
  const AT = 10 * MS_DAY;

  it("classifies completed / in-progress / not-started / late and counts RAG", () => {
    const report = buildStatusReport(
      [
        { id: "done", name: "done", start: 0, end: 5 * MS_DAY, progress: 1, done: false },
        { id: "late", name: "late", start: 0, end: 10 * MS_DAY, progress: 0.2, done: false, rag: "red" },
        { id: "future", name: "future", start: 15 * MS_DAY, end: 20 * MS_DAY, done: false },
        { id: "ok", name: "ok", start: 0, end: 20 * MS_DAY, progress: 0.6, done: false, rag: "green" },
        { id: "flagged", name: "flagged", start: 0, end: 4 * MS_DAY, progress: 0.1, done: true },
      ],
      AT,
    );
    expect(report.taskCount).toBe(5);
    expect(report.completedCount).toBe(2);
    expect(report.notStartedCount).toBe(1);
    expect(report.inProgressCount).toBe(2);
    // progress point 0 + 0.2×10d = 2d, trailing the 10d status date by 8 days.
    expect(report.lateTasks).toEqual([{ id: "late", name: "late", lateMs: 8 * MS_DAY }]);
    expect(report.ragCounts).toEqual({ red: 1, amber: 0, green: 1, none: 3 });
    expect(report.percentComplete).toBeCloseTo(((1 + 0.2 + 0 + 0.6 + 0.1) / 5) * 100, 5);
  });

  it("is empty-safe and clamps progress into 0..1", () => {
    expect(buildStatusReport([], AT).percentComplete).toBe(0);
    const r = buildStatusReport([{ id: "a", name: "a", start: 0, end: MS_DAY, progress: 7, done: false }], AT);
    expect(r.completedCount).toBe(1);
    expect(r.lateTasks).toEqual([]);
  });

  it("progressPointOf handles zero-length spans", () => {
    expect(progressPointOf(5, 5, 0.5)).toBe(5);
  });

  it("a task with progress > 0 starting at or after the status date counts as in progress", () => {
    const report = buildStatusReport(
      [{ id: "early", name: "early", start: 15 * MS_DAY, end: 20 * MS_DAY, progress: 0.3, done: false }],
      AT,
    );
    expect(report.notStartedCount).toBe(0);
    expect(report.inProgressCount).toBe(1);
    expect(report.completedCount).toBe(0);
  });

  it("completed + inProgress + notStarted always equals taskCount", () => {
    const tasks: ReportTask[] = [
      { id: 1, name: "done-flag", start: 0, end: MS_DAY, progress: 0.2, done: true },
      { id: 2, name: "done-progress", start: 0, end: MS_DAY, progress: 1, done: false },
      { id: 3, name: "running", start: 0, end: 20 * MS_DAY, progress: 0.4, done: false },
      { id: 4, name: "future-untouched", start: 15 * MS_DAY, end: 20 * MS_DAY, done: false },
      { id: 5, name: "future-progressed", start: 15 * MS_DAY, end: 20 * MS_DAY, progress: 0.1, done: false },
      { id: 6, name: "overdue-untouched", start: 0, end: 5 * MS_DAY, progress: 0, done: false },
      { id: 7, name: "starts-now", start: AT, end: 20 * MS_DAY, done: false },
    ];
    const report = buildStatusReport(tasks, AT);
    expect(report.completedCount + report.inProgressCount + report.notStartedCount).toBe(report.taskCount);
    expect(report.completedCount).toBe(2);
    expect(report.inProgressCount).toBe(3);
    expect(report.notStartedCount).toBe(2);
  });

  it("weights percentComplete by duration under 'duration', falling back to count when all-zero", () => {
    const tasks: ReportTask[] = [
      { id: "long", name: "long", start: 0, end: 9 * MS_DAY, progress: 1, done: false },
      { id: "short", name: "short", start: 0, end: MS_DAY, progress: 0, done: false },
    ];
    expect(buildStatusReport(tasks, 10 * MS_DAY, "count").percentComplete).toBeCloseTo(50, 5);
    expect(buildStatusReport(tasks, 10 * MS_DAY, "duration").percentComplete).toBeCloseTo(90, 5);

    const milestones: ReportTask[] = [
      { id: "m1", name: "m1", start: 0, end: 0, progress: 1, done: false },
      { id: "m2", name: "m2", start: 0, end: 0, progress: 0, done: false },
    ];
    expect(buildStatusReport(milestones, MS_DAY, "duration").percentComplete).toBeCloseTo(50, 5);
  });
});

describe("reportTasks (leaf enumeration, §2.6)", () => {
  it("excludes a parent from the enumeration, keeping only leaves", () => {
    const data = fakeDataService([
      stubTask("p", 0, 10 * MS_DAY, { progress: 0.5 }),
      stubTask("c1", 0, 5 * MS_DAY, { parentId: "p", progress: 1 }),
      stubTask("c2", 4 * MS_DAY, 10 * MS_DAY, { parentId: "p" }),
    ]);
    const leaves = reportTasks(data, true);
    expect(leaves.map((t) => t.id).sort()).toEqual(["c1", "c2"]);

    const all = reportTasks(data, false);
    expect(all.map((t) => t.id).sort()).toEqual(["c1", "c2", "p"]);
  });

  it("all-ancestors chain: only the true leaf at the bottom counts", () => {
    const data = fakeDataService([
      stubTask("p1", 0, 10 * MS_DAY, { progress: 0.2 }),
      stubTask("p2", 0, 10 * MS_DAY, { parentId: "p1", progress: 0.4 }),
      stubTask("leaf", 0, 10 * MS_DAY, { parentId: "p2", progress: 1 }),
    ]);
    const leaves = reportTasks(data, true);
    expect(leaves.map((t) => t.id)).toEqual(["leaf"]);
  });

  it("empty store: an empty list", () => {
    const data = fakeDataService([]);
    expect(reportTasks(data, true)).toEqual([]);
  });

  it("reads meta.taskFields.status defensively for the done flag", () => {
    const data = fakeDataService([
      stubTask("a", 0, MS_DAY, { meta: { taskFields: { status: "done" } } }),
      stubTask("b", 0, MS_DAY, { meta: { taskFields: "junk" } }),
      stubTask("c", 0, MS_DAY),
    ]);
    const leaves = reportTasks(data, true);
    expect(leaves.find((t) => t.id === "a")?.done).toBe(true);
    expect(leaves.find((t) => t.id === "b")?.done).toBe(false);
    expect(leaves.find((t) => t.id === "c")?.done).toBe(false);
  });

  it("carries the task's RAG value through from meta.progressTracking", () => {
    const data = fakeDataService([stubTask("a", 0, MS_DAY, { meta: { progressTracking: { rag: "green" } } })]);
    expect(reportTasks(data, true)[0]?.rag).toBe("green");
  });
});
