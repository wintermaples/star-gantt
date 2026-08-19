// Hostless unit tests for the health aggregation (docs/specs/plugins/portfolio.md §2.3, §2.4).
import { describe, expect, it } from "vitest";
import { computeHealth, weightedProgress } from "../src/internal/portfolio/health";
import { DAY0, MS_DAY, task } from "./_boot";

describe("computeHealth", () => {
  it("is on-track for an empty set and for finished tasks", () => {
    expect(computeHealth([], DAY0).status).toBe("on-track");
    const done = task("a", DAY0, DAY0 + MS_DAY, { progress: 1 });
    const agg = computeHealth([done], DAY0 + 5 * MS_DAY);
    expect(agg).toMatchObject({ status: "on-track", taskCount: 1, lateCount: 0, atRiskCount: 0 });
    expect(agg.progress).toBe(1);
  });

  it("flags a past-due unfinished task as late", () => {
    const t = task("a", DAY0, DAY0 + 2 * MS_DAY, { progress: 0.9 });
    const agg = computeHealth([t], DAY0 + 3 * MS_DAY);
    expect(agg.status).toBe("late");
    expect(agg.lateCount).toBe(1);
  });

  it("flags a running task behind its elapsed fraction as at-risk", () => {
    const behind = task("a", DAY0, DAY0 + 10 * MS_DAY, { progress: 0.1 });
    const ahead = task("b", DAY0, DAY0 + 10 * MS_DAY, { progress: 0.9 });
    const agg = computeHealth([behind, ahead], DAY0 + 5 * MS_DAY);
    expect(agg.status).toBe("at-risk");
    expect(agg.atRiskCount).toBe(1);
    expect(agg.lateCount).toBe(0);
  });

  it("late outranks at-risk in the aggregated status", () => {
    const late = task("a", DAY0, DAY0 + MS_DAY, { progress: 0 });
    const risky = task("b", DAY0, DAY0 + 10 * MS_DAY, { progress: 0 });
    expect(computeHealth([late, risky], DAY0 + 2 * MS_DAY).status).toBe("late");
  });

  it("skips summaries and non-finite dates; missing progress counts as 0", () => {
    const summary = task("s", DAY0, DAY0 + MS_DAY, { type: "summary" });
    const broken = task("n", Number.NaN, DAY0 + MS_DAY);
    const plain = task("p", DAY0, DAY0 + MS_DAY);
    const agg = computeHealth([summary, broken, plain], DAY0);
    expect(agg.taskCount).toBe(1);
    expect(agg.progress).toBe(0);
  });

  it("weights progress by duration", () => {
    const long = task("a", DAY0, DAY0 + 3 * MS_DAY, { progress: 1 });
    const short = task("b", DAY0, DAY0 + MS_DAY, { progress: 0 });
    expect(computeHealth([long, short], DAY0).progress).toBeCloseTo(0.75);
    expect(weightedProgress([long, short]).progress).toBeCloseTo(0.75);
    expect(weightedProgress([long, short]).taskCount).toBe(2);
  });
});
