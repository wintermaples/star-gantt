// docs/specs/plugins/tracking.md §6 — the 73-key merged catalog.
import { describe, expect, it, vi } from "vitest";
import { TRACKING_MESSAGE_KEYS, resolveMessages } from "../src/internal/messages";

const noFault = (): void => {};
const defaults = () => resolveMessages(undefined, noFault);

describe("catalog shape", () => {
  it("carries exactly the 73 keys the spec enumerates", () => {
    expect(TRACKING_MESSAGE_KEYS).toHaveLength(73);
    expect(new Set(TRACKING_MESSAGE_KEYS).size).toBe(73);
  });

  it("names every key of the four merged catalogs, per the collision resolution", () => {
    expect([...TRACKING_MESSAGE_KEYS].sort()).toEqual(
      [
        // baselines (11, `duration` shared with progress)
        "baselineName",
        "slipLabel",
        "duration",
        "reportTask",
        "reportBaselineStart",
        "reportBaselineFinish",
        "reportStart",
        "reportFinish",
        "reportStartVariance",
        "reportFinishVariance",
        "reportDurationVariance",
        // progress-tracking (15, minus duration)
        "bulkTitle",
        "bulkTaskHeader",
        "bulkProgressHeader",
        "bulkRemainingHeader",
        "bulkApply",
        "bulkCancel",
        "trendTitle",
        "trendClose",
        "trendEmpty",
        "trendLine",
        "reportTitle",
        "reportSummary",
        "reportLateHeading",
        "reportLateLine",
        // cost-tracking (20, four keys prefixed on collision)
        "tableTitle",
        "tableTaskHeader",
        "tableEstimatedHeader",
        "tableActualHeader",
        "tableVarianceHeader",
        "tableFixedHeader",
        "tableMaterialHeader",
        "tableActualInputHeader",
        "tableApply",
        "tableCancel",
        "overBudgetFlag",
        "totalLabel",
        "costCurveTitle",
        "costCurveEmpty",
        "panelClose",
        "costCurvePoint",
        "breakdownTitle",
        "breakdownEntry",
        "costBaselineName",
        "formulaName",
        // evm (29, minus panelClose)
        "dashboardTitle",
        "evmCurveTitle",
        "evmCurveEmpty",
        "bacLabel",
        "pvLabel",
        "evLabel",
        "acLabel",
        "svLabel",
        "cvLabel",
        "spiLabel",
        "cpiLabel",
        "eacLabel",
        "etcLabel",
        "spiBehindFlag",
        "cpiOverFlag",
        "bacGloss",
        "pvGloss",
        "evGloss",
        "acGloss",
        "svGloss",
        "cvGloss",
        "spiGloss",
        "cpiGloss",
        "eacGloss",
        "etcGloss",
        "dashboardDescription",
        "curveDescription",
        "evmCurvePoint",
      ].sort(),
    );
  });
});

describe("built-in defaults", () => {
  it("keeps the plain strings byte-for-byte", () => {
    const m = defaults();
    expect(m.reportTask).toBe("Task");
    expect(m.reportStart).toBe("Start");
    expect(m.bulkTitle).toBe("Update progress");
    expect(m.trendEmpty).toBe("No snapshots recorded");
    expect(m.tableTitle).toBe("Budget vs actual");
    expect(m.overBudgetFlag).toBe("over budget");
    expect(m.panelClose).toBe("Close");
    expect(m.dashboardTitle).toBe("Earned value");
    expect(m.bacGloss).toBe("Total budget for all the work.");
    expect(m.spiBehindFlag).toBe("behind schedule");
  });

  it("formats baselineName / costBaselineName / formulaName ordinal builders", () => {
    const m = defaults();
    expect(m.baselineName(1)).toBe("Baseline 1");
    expect(m.costBaselineName(2)).toBe("Cost baseline 2");
    expect(m.formulaName(3)).toBe("Formula 3");
  });

  it("formats duration as an auto-magnitude string", () => {
    const m = defaults();
    expect(m.duration(90_000_000)).toBe("1d");
    expect(m.duration(3_600_000)).toBe("1h");
  });

  it("composes slipLabel from the resolved duration member, signed", () => {
    const m = defaults();
    expect(m.slipLabel(3 * 86_400_000)).toBe("+3d");
    expect(m.slipLabel(-4 * 3_600_000)).toBe("-4h");
    expect(m.slipLabel(0)).toBe("0s");
  });

  it("re-composes slipLabel through a host-overridden duration builder", () => {
    const m = resolveMessages({ duration: (ms) => `${String(ms)}ms` }, noFault);
    expect(m.slipLabel(5)).toBe("+5ms");
    expect(m.slipLabel(-5)).toBe("-5ms");
  });

  it("formats reportLateLine through the resolved duration member", () => {
    const m = defaults();
    expect(m.reportLateLine({ id: "t1", name: "Task A", lateMs: 2 * 86_400_000 })).toBe(
      "Task A — 2d late",
    );
  });

  it("formats trendLine / reportTitle / reportSummary / reportLateHeading", () => {
    const m = defaults();
    expect(
      m.trendLine({ date: Date.UTC(2024, 0, 15), percentComplete: 42, completedCount: 3, lateCount: 1, taskCount: 10 }),
    ).toBe("2024-01-15 — 42% complete, 1 late, 3 done");
    expect(m.reportTitle(Date.UTC(2024, 0, 15))).toBe("Status report — 2024-01-15");
    expect(
      m.reportSummary({
        statusDate: 0,
        taskCount: 10,
        completedCount: 3,
        inProgressCount: 4,
        notStartedCount: 3,
        lateTasks: [],
        percentComplete: 55,
        ragCounts: { red: 0, amber: 0, green: 0, none: 10 },
      }),
    ).toBe("10 tasks — 3 completed, 4 in progress, 3 not started, 55% complete");
    expect(m.reportLateHeading(2)).toBe("Late tasks (2)");
  });

  it("formats costCurvePoint with and without a forecast figure", () => {
    const m = defaults();
    const t = Date.UTC(2024, 0, 1);
    expect(m.costCurvePoint({ t, planned: 1000, actual: 900 })).toBe(
      "2024-01-01 — planned 1,000, actual 900",
    );
    expect(m.costCurvePoint({ t, planned: 1000, actual: 900, forecast: 950 })).toBe(
      "2024-01-01 — planned 1,000, actual 900, forecast 950",
    );
  });

  it("formats breakdownEntry with a rounded percent", () => {
    const m = defaults();
    expect(m.breakdownEntry({ type: "labor", amount: 1234, percent: 33.4 })).toBe(
      "labor — 1,234 (33%)",
    );
  });

  it("formats evmCurvePoint, appending EV/AC only when present", () => {
    const m = defaults();
    const t = Date.UTC(2024, 0, 1);
    expect(m.evmCurvePoint({ t, pv: 500 })).toBe("2024-01-01 — PV 500");
    expect(m.evmCurvePoint({ t, pv: 500, ev: 400, ac: 420 })).toBe(
      "2024-01-01 — PV 500, EV 400, AC 420",
    );
  });
});

describe("host overrides", () => {
  it("overrides per key, takes the empty string verbatim and ignores wrong kinds", () => {
    const m = resolveMessages(
      { reportTask: "Job", trendEmpty: "", bulkTitle: 7 as never },
      noFault,
    );
    expect(m.reportTask).toBe("Job");
    expect(m.trendEmpty).toBe("");
    expect(m.bulkTitle).toBe("Update progress");
  });

  it("reports a throwing builder and answers with the built-in default for that call", () => {
    const onFault = vi.fn();
    const m = resolveMessages(
      {
        baselineName: () => {
          throw new Error("boom");
        },
      },
      onFault,
    );
    expect(m.baselineName(4)).toBe("Baseline 4");
    expect(onFault).toHaveBeenCalledTimes(1);
    expect(onFault.mock.calls[0]?.[0]).toBe("baselineName");
  });

  it("ignores a non-object overrides value entirely", () => {
    expect(resolveMessages("nope" as never, noFault).reportTask).toBe("Task");
    expect(resolveMessages(undefined, noFault).reportTask).toBe("Task");
  });
});
