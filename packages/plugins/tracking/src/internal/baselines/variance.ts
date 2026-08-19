// docs/specs/plugins/tracking.md §2.3 "Variance" — plan-vs-current comparison rows, the milestone
// filter, the project summary and the CSV report. The pure per-baseline compute is wrapped here with
// baseline resolution and §1.1's closing-paragraph memoization: "Baseline results are memoized and
// invalidated on `data.tasks` store notifications … baseline-side paths are memoized per baseline
// (snapshots are immutable once captured)."
//
// Memoization choice (recorded): a single `Map<BaselineId, VarianceRow[]>` cache, keyed by the
// resolved baseline's id and cleared IN FULL on every `data.tasks` notification. This satisfies the
// spec's intent — a baseline's rows are computed once per data "generation" and reused across
// `variance()`/`milestoneVariance()`/`summary()`/`reportCSV()` calls against it — without a second,
// more finely separated cache axis for "baseline-side" vs. "current-side" results: correctness
// first, per the task brief's explicit guidance not to over-engineer this. `milestoneVariance`,
// `summary` and `reportCSV` all funnel through the same memoized `variance()` rows rather than
// recomputing the current-vs-baseline pairing themselves.
import { isoDay } from "@stargantt/sdk";
import type { DataService, Task } from "@stargantt/plugin-data-store";
import type { Baseline, BaselineId, ScheduleSummary, VarianceRow } from "../../types";
import type { TrackingMessages } from "../messages";

/** The variance rows of a baseline against the current tasks. */
export function varianceRows(
  baseline: Readonly<Baseline>,
  tasks: Iterable<Readonly<Task>>,
): VarianceRow[] {
  const rows: VarianceRow[] = [];
  for (const task of tasks) {
    const snap = baseline.tasks.get(task.id);
    if (snap === undefined) continue;
    if (!Number.isFinite(task.start) || !Number.isFinite(task.end)) continue;
    rows.push({
      id: task.id,
      name: task.name,
      type: task.type ?? "task",
      baselineStart: snap.start,
      baselineEnd: snap.end,
      start: task.start,
      end: task.end,
      startVarianceMs: task.start - snap.start,
      endVarianceMs: task.end - snap.end,
      durationVarianceMs: task.end - task.start - (snap.end - snap.start),
    });
  }
  return rows;
}

/** Rows that are milestones now, or were at capture time. */
export function milestoneRows(
  baseline: Readonly<Baseline>,
  rows: readonly VarianceRow[],
): VarianceRow[] {
  return rows.filter(
    (row) => row.type === "milestone" || baseline.tasks.get(row.id)?.type === "milestone",
  );
}

/** The project-level envelope comparison, or `undefined` for an empty comparison. */
export function projectSummary(rows: readonly VarianceRow[]): ScheduleSummary | undefined {
  if (rows.length === 0) return undefined;
  let baselineStart = Infinity;
  let baselineEnd = -Infinity;
  let start = Infinity;
  let end = -Infinity;
  for (const row of rows) {
    if (row.baselineStart < baselineStart) baselineStart = row.baselineStart;
    if (row.baselineEnd > baselineEnd) baselineEnd = row.baselineEnd;
    if (row.start < start) start = row.start;
    if (row.end > end) end = row.end;
  }
  const baselineDurationMs = baselineEnd - baselineStart;
  const durationMs = end - start;
  return {
    baselineStart,
    baselineEnd,
    start,
    end,
    baselineDurationMs,
    durationMs,
    finishVarianceMs: end - baselineEnd,
    durationVarianceMs: durationMs - baselineDurationMs,
    taskCount: rows.length,
  };
}

/** A CSV field, quoted only when it needs to be (RFC-4180 style). */
function csvField(value: string): string {
  return /[",\n\r]/.test(value) ? `"${value.replaceAll('"', '""')}"` : value;
}

/** An instant formatted as an ISO day, or the raw number when out of `Date` range. */
function formatDate(t: number): string {
  return isoDay(t) ?? String(t);
}

/** The catalog slice the CSV report reads. */
export type ReportHeaders = Pick<
  TrackingMessages,
  | "reportTask"
  | "reportBaselineStart"
  | "reportBaselineFinish"
  | "reportStart"
  | "reportFinish"
  | "reportStartVariance"
  | "reportFinishVariance"
  | "reportDurationVariance"
  | "duration"
>;

/**
 * The variance report as CSV text: a header row plus one line per variance row. The three variance
 * cells render through the resolved `duration` catalog member, not a private
 * formatter — a host overriding `duration` re-skins these cells too.
 */
export function reportCSV(rows: readonly VarianceRow[], headers: ReportHeaders): string {
  const lines: string[] = [
    [
      headers.reportTask,
      headers.reportBaselineStart,
      headers.reportBaselineFinish,
      headers.reportStart,
      headers.reportFinish,
      headers.reportStartVariance,
      headers.reportFinishVariance,
      headers.reportDurationVariance,
    ]
      .map(csvField)
      .join(","),
  ];
  for (const row of rows) {
    lines.push(
      [
        csvField(row.name),
        formatDate(row.baselineStart),
        formatDate(row.baselineEnd),
        formatDate(row.start),
        formatDate(row.end),
        headers.duration(row.startVarianceMs),
        headers.duration(row.endVarianceMs),
        headers.duration(row.durationVarianceMs),
      ].join(","),
    );
  }
  return lines.join("\n");
}

export interface VarianceDeps {
  data: Pick<DataService, "query" | "tasks">;
  messages: ReportHeaders;
  ctx: { own(d: { dispose(): void }): void };
  resolveBaseline(baselineId?: BaselineId): Readonly<Baseline> | undefined;
}

export interface VarianceApi {
  variance(baselineId?: BaselineId): readonly VarianceRow[];
  milestoneVariance(baselineId?: BaselineId): readonly VarianceRow[];
  summary(baselineId?: BaselineId): ScheduleSummary | undefined;
  reportCSV(baselineId?: BaselineId): string;
}

/** Assembles the memoized §1.1 API from the pure functions above. */
export function createVarianceApi(deps: VarianceDeps): VarianceApi {
  const cache = new Map<BaselineId, readonly VarianceRow[]>();
  deps.ctx.own(deps.data.tasks.subscribe(() => cache.clear()));

  function rowsOf(baselineId?: BaselineId): readonly VarianceRow[] {
    const baseline = deps.resolveBaseline(baselineId);
    if (baseline === undefined) return [];
    const cached = cache.get(baseline.id);
    if (cached !== undefined) return cached;
    const rows = varianceRows(baseline, deps.data.query().byId.values());
    cache.set(baseline.id, rows);
    return rows;
  }

  return {
    variance: rowsOf,
    milestoneVariance(baselineId) {
      const baseline = deps.resolveBaseline(baselineId);
      if (baseline === undefined) return [];
      return milestoneRows(baseline, rowsOf(baselineId));
    },
    summary(baselineId) {
      return projectSummary(rowsOf(baselineId));
    },
    reportCSV(baselineId) {
      return reportCSV(rowsOf(baselineId), deps.messages);
    },
  };
}
