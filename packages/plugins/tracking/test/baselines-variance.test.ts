/**
 * `internal/baselines/variance.ts` — the pure `varianceRows`/`milestoneRows`/`projectSummary`/
 * `reportCSV` (hostless: plain fixtures, no host) plus `createVarianceApi`'s memoization contract (§1.1's closing
 * paragraph — "memoized and invalidated on `data.tasks` store notifications"), exercised through a
 * real `DataService` via the shared `_baselines-boot` harness.
 */
import { describe, expect, it } from "vitest";
import { createVarianceApi, milestoneRows, projectSummary, reportCSV, varianceRows } from "../src/internal/baselines/variance";
import type { Baseline } from "../src/types";
import type { Task } from "@stargantt/plugin-data-store";
import { DAY, bootWithData, messages, task } from "./_baselines-boot";

function baselineOf(
  snaps: { id: string; start: number; end: number; type?: Task["type"] }[],
): Baseline {
  return {
    id: "b",
    name: "b",
    capturedAt: 0,
    taskCount: snaps.length,
    tasks: new Map(snaps.map((s) => [s.id, s])),
    links: [],
  };
}

describe("varianceRows", () => {
  it("pairs tasks with their snapshots and signs variances current-minus-baseline", () => {
    const baseline = baselineOf([
      { id: "a", start: 0, end: 5 * DAY },
      { id: "gone", start: 0, end: DAY },
    ]);
    const rows = varianceRows(baseline, [
      task("a", 2 * DAY, 8 * DAY),
      task("new", 0, DAY), // not in the baseline: no row
    ]);
    expect(rows).toHaveLength(1);
    const row = rows[0];
    expect(row?.startVarianceMs).toBe(2 * DAY);
    expect(row?.endVarianceMs).toBe(3 * DAY);
    expect(row?.durationVarianceMs).toBe(1 * DAY);
  });

  it("skips a paired task whose current dates are not finite", () => {
    const baseline = baselineOf([{ id: "a", start: 0, end: DAY }]);
    const rows = varianceRows(baseline, [task("a", Number.NaN, DAY)]);
    expect(rows).toHaveLength(0);
  });
});

describe("milestoneRows", () => {
  it("keeps rows that are milestones now or were at capture time", () => {
    const baseline = baselineOf([
      { id: "was", start: 0, end: 0, type: "milestone" },
      { id: "is", start: 0, end: 0 },
      { id: "plain", start: 0, end: DAY },
    ]);
    const rows = varianceRows(baseline, [
      task("was", DAY, DAY),
      task("is", DAY, DAY, { type: "milestone" }),
      task("plain", 0, DAY),
    ]);
    expect(milestoneRows(baseline, rows).map((r) => r.id)).toEqual(["was", "is"]);
  });
});

describe("projectSummary", () => {
  it("compares the project envelopes and reports finish and duration variance", () => {
    const baseline = baselineOf([
      { id: "a", start: 0, end: 5 * DAY },
      { id: "b", start: 2 * DAY, end: 10 * DAY },
    ]);
    const rows = varianceRows(baseline, [task("a", 0, 5 * DAY), task("b", 2 * DAY, 13 * DAY)]);
    const summary = projectSummary(rows);
    expect(summary?.baselineDurationMs).toBe(10 * DAY);
    expect(summary?.durationMs).toBe(13 * DAY);
    expect(summary?.finishVarianceMs).toBe(3 * DAY);
    expect(summary?.durationVarianceMs).toBe(3 * DAY);
    expect(summary?.taskCount).toBe(2);
    expect(projectSummary([])).toBeUndefined();
  });
});

describe("reportCSV", () => {
  it("renders the catalog header (unit-free), ISO dates, duration-formatted variances and quoted names", () => {
    const baseline = baselineOf([{ id: "a", start: 0, end: 2 * DAY }]);
    const rows = varianceRows(baseline, [
      task("a", DAY / 2, 2 * DAY, { name: 'risky, "phase 1"' }),
    ]);
    const csv = reportCSV(rows, messages());
    const lines = csv.split("\n");
    expect(lines[0]).toBe(
      "Task,Baseline start,Baseline finish,Start,Finish,Start variance,Finish variance,Duration variance",
    );
    // startVarianceMs = DAY/2 - 0 = 12h; endVarianceMs = 2*DAY - 2*DAY = 0 ("0s");
    // durationVarianceMs = (2*DAY - DAY/2) - (2*DAY - 0) = -12h.
    expect(lines[1]).toBe(
      '"risky, ""phase 1""",1970-01-01,1970-01-03,1970-01-01,1970-01-03,12h,0s,-12h',
    );
  });

  it("re-skins every duration-embedding cell when only the `duration` catalog member is overridden", () => {
    const baseline = baselineOf([{ id: "a", start: 0, end: 2 * DAY }]);
    const rows = varianceRows(baseline, [task("a", 0, 3 * DAY)]);
    const csv = reportCSV(rows, messages({ duration: (ms) => `<${ms}>` }));
    expect(csv.split("\n")[1]).toBe(`task a,1970-01-01,1970-01-03,1970-01-01,1970-01-04,<0>,<${DAY}>,<${DAY}>`);
  });
});

describe("createVarianceApi", () => {
  function bootApi() {
    const { host, data, result: api } = bootWithData((ctx, data) =>
      createVarianceApi({ data, messages: messages(), ctx, resolveBaseline: () => baseline }),
    );
    return { host, data, api };
  }

  // A fixed active baseline shared by the memoization tests below (identity matters: the cache is
  // keyed by baseline id, so this fixture's `id` must stay stable across a test).
  const baseline = baselineOf([{ id: "a", start: 0, end: DAY }]);

  it("returns [] / undefined when no baseline resolves", () => {
    const { result: api } = bootWithData((ctx, data) =>
      createVarianceApi({ data, messages: messages(), ctx, resolveBaseline: () => undefined }),
    );
    expect(api.variance()).toEqual([]);
    expect(api.milestoneVariance()).toEqual([]);
    expect(api.summary()).toBeUndefined();
    expect(api.reportCSV()).toBe(api.reportCSV()); // still a stable header-only string
  });

  it("memoizes variance() per baseline id and invalidates on a data.tasks notification", () => {
    const { host, data, api } = bootApi();
    data.load([task("a", 2 * DAY, 8 * DAY)]);
    const first = api.variance();
    const second = api.variance();
    expect(second).toBe(first); // same array reference: served from cache

    host.host.dispatch("task/update", { id: "a", after: { end: 9 * DAY } });
    const third = api.variance();
    expect(third).not.toBe(first); // invalidated by the data.tasks change
    expect(third[0]?.endVarianceMs).toBe(8 * DAY);
  });

  it("milestoneVariance/summary/reportCSV read through the same memoized rows", () => {
    const { data, api } = bootApi();
    data.load([task("a", 0, DAY)]);
    expect(api.summary()?.taskCount).toBe(1);
    expect(api.milestoneVariance()).toEqual([]);
    expect(api.reportCSV().split("\n")).toHaveLength(2);
  });
});
