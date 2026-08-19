// docs/specs/plugins/tracking.md §6 — `TrackingMessages`, the single merged catalog.
//
// Merged from four catalogs — baselines (11 keys), progress-tracking (15), cost-tracking (20) and
// evm (29) — into 73 keys total. Six key names collided across the four areas; two merge into one
// shared key each (`duration`, `panelClose`), four are prefixed by feature area on the side whose
// name was not already area-specific (`costBaselineName`, `costCurveTitle`/`evmCurveTitle`,
// `costCurveEmpty`/`evmCurveEmpty`, `costCurvePoint`/`evmCurvePoint`). Every other key keeps its
// original name and default byte-for-byte.
//
// Resolved once at setup via `sdk/dom`'s `resolveCatalog` (the same uniform mechanism every other
// merged-catalog plugin in this codebase uses — see `@stargantt/plugin-scheduling`'s
// `internal/messages.ts`): per-key shallow override, wrong-kind keys ignored, the empty string
// usable verbatim, a throwing/non-string-returning builder reported once via `onFault` and answered
// by the built-in default for the rest of the instance's life. `slipLabel` and `duration` are the
// two builders actually called on a paint path (§6 preamble's "latched … per paint" pair); every
// other builder is gesture/report-driven, so `resolveCatalog`'s uniform latch is a no-op difference
// in practice for them — the same accepted equivalence scheduling.md's own catalog already relies
// on, not a divergence introduced here.
//
// `duration` composes into two other DEFAULT builders (`slipLabel`, `reportLateLine`) as the
// plugin's one duration formatter. Those defaults read the RESOLVED `duration` member (host
// override included) through `durationRef`, a box `resolveMessages` fills in right after resolving
// the whole catalog, so overriding just `duration` reshapes every default that composes it without
// having to also override `slipLabel/reportLateLine`.
import { formatDurationMs, isoDay, resolveCatalog } from "@stargantt/sdk";
import type {
  BreakdownEntryData,
  CostCurvePoint,
  EvmCurvePoint,
  LateTaskEntry,
  ProgressSnapshot,
  StatusReport,
} from "../types";
import { formatAmount } from "./shared/format";

/** Every user-visible string this plugin can show. */
export interface TrackingMessages {
  /* --- baselines (11, `duration` shared with progress) ---------------------------------- */
  baselineName(ordinal: number): string;
  slipLabel(slipMs: number): string;
  duration(ms: number): string;
  reportTask: string;
  reportBaselineStart: string;
  reportBaselineFinish: string;
  reportStart: string;
  reportFinish: string;
  reportStartVariance: string;
  reportFinishVariance: string;
  reportDurationVariance: string;

  /* --- progress-tracking (15, minus `duration`) ------------------------------------------ */
  bulkTitle: string;
  bulkTaskHeader: string;
  bulkProgressHeader: string;
  bulkRemainingHeader: string;
  bulkApply: string;
  bulkCancel: string;
  trendTitle: string;
  trendClose: string;
  trendEmpty: string;
  trendLine(snapshot: Readonly<ProgressSnapshot>): string;
  reportTitle(statusDate: number): string;
  reportSummary(report: Readonly<StatusReport>): string;
  reportLateHeading(count: number): string;
  reportLateLine(entry: Readonly<LateTaskEntry>): string;

  /* --- cost-tracking (20, minus the four prefixed-on-collision keys) --------------------- */
  tableTitle: string;
  tableTaskHeader: string;
  tableEstimatedHeader: string;
  tableActualHeader: string;
  tableVarianceHeader: string;
  tableFixedHeader: string;
  tableMaterialHeader: string;
  tableActualInputHeader: string;
  tableApply: string;
  tableCancel: string;
  overBudgetFlag: string;
  totalLabel: string;
  costCurveTitle: string;
  costCurveEmpty: string;
  /** Shared with evm (identical role and default on every cost/EVM panel). */
  panelClose: string;
  costCurvePoint(point: Readonly<CostCurvePoint>): string;
  breakdownTitle: string;
  breakdownEntry(entry: Readonly<BreakdownEntryData>): string;
  costBaselineName(ordinal: number): string;
  formulaName(ordinal: number): string;

  /* --- evm (29, minus `panelClose`) ------------------------------------------------------- */
  dashboardTitle: string;
  evmCurveTitle: string;
  evmCurveEmpty: string;
  bacLabel: string;
  pvLabel: string;
  evLabel: string;
  acLabel: string;
  svLabel: string;
  cvLabel: string;
  spiLabel: string;
  cpiLabel: string;
  eacLabel: string;
  etcLabel: string;
  spiBehindFlag: string;
  cpiOverFlag: string;
  bacGloss: string;
  pvGloss: string;
  evGloss: string;
  acGloss: string;
  svGloss: string;
  cvGloss: string;
  spiGloss: string;
  cpiGloss: string;
  eacGloss: string;
  etcGloss: string;
  dashboardDescription: string;
  curveDescription: string;
  evmCurvePoint(point: Readonly<EvmCurvePoint>): string;
}

/** A day stamp rendered `"YYYY-MM-DD"`; falls back to the raw number's string form on the (never
 *  expected) case `isoDay` cannot represent it. */
function day(t: number): string {
  return isoDay(t) ?? String(t);
}

/** Mutable box the default `duration`-composing builders read through, filled by `resolveMessages`
 *  right after the whole catalog resolves — see the module doc. */
const durationRef: { current: (ms: number) => string } = { current: (ms) => formatDurationMs(ms) };

const DEFAULT_MESSAGES: TrackingMessages = {
  /* --- baselines --- */
  baselineName: (ordinal) => `Baseline ${String(ordinal)}`,
  slipLabel: (slipMs) => {
    const sign = slipMs > 0 ? "+" : slipMs < 0 ? "-" : "";
    return `${sign}${durationRef.current(Math.abs(slipMs))}`;
  },
  duration: (ms) => formatDurationMs(ms),
  reportTask: "Task",
  reportBaselineStart: "Baseline start",
  reportBaselineFinish: "Baseline finish",
  reportStart: "Start",
  reportFinish: "Finish",
  reportStartVariance: "Start variance",
  reportFinishVariance: "Finish variance",
  reportDurationVariance: "Duration variance",

  /* --- progress-tracking --- */
  bulkTitle: "Update progress",
  bulkTaskHeader: "Task",
  bulkProgressHeader: "Progress %",
  bulkRemainingHeader: "Remaining work",
  bulkApply: "Apply",
  bulkCancel: "Cancel",
  trendTitle: "Progress trend",
  trendClose: "Close",
  trendEmpty: "No snapshots recorded",
  trendLine: (s) =>
    `${day(s.date)} — ${String(s.percentComplete)}% complete, ${String(s.lateCount)} late, ` +
    `${String(s.completedCount)} done`,
  reportTitle: (statusDate) => `Status report — ${day(statusDate)}`,
  reportSummary: (r) =>
    `${String(r.taskCount)} tasks — ${String(r.completedCount)} completed, ` +
    `${String(r.inProgressCount)} in progress, ${String(r.notStartedCount)} not started, ` +
    `${String(r.percentComplete)}% complete`,
  reportLateHeading: (count) => `Late tasks (${String(count)})`,
  reportLateLine: (e) => `${e.name} — ${durationRef.current(e.lateMs)} late`,

  /* --- cost-tracking --- */
  tableTitle: "Budget vs actual",
  tableTaskHeader: "Task",
  tableEstimatedHeader: "Planned",
  tableActualHeader: "Actual",
  tableVarianceHeader: "Variance",
  tableFixedHeader: "Fixed cost",
  tableMaterialHeader: "Material cost",
  tableActualInputHeader: "Actual cost",
  tableApply: "Apply",
  tableCancel: "Cancel",
  overBudgetFlag: "over budget",
  totalLabel: "Total",
  costCurveTitle: "Cost curve",
  costCurveEmpty: "No cost data",
  panelClose: "Close",
  costCurvePoint: (p) => {
    const base = `${day(p.t)} — planned ${formatAmount(p.planned)}, actual ${formatAmount(p.actual)}`;
    return p.forecast === undefined ? base : `${base}, forecast ${formatAmount(p.forecast)}`;
  },
  breakdownTitle: "Cost breakdown",
  breakdownEntry: (e) => `${e.type} — ${formatAmount(e.amount)} (${String(Math.round(e.percent))}%)`,
  costBaselineName: (ordinal) => `Cost baseline ${String(ordinal)}`,
  formulaName: (ordinal) => `Formula ${String(ordinal)}`,

  /* --- evm --- */
  dashboardTitle: "Earned value",
  evmCurveTitle: "EVM S-curve",
  evmCurveEmpty: "No EVM data",
  bacLabel: "BAC",
  pvLabel: "PV",
  evLabel: "EV",
  acLabel: "AC",
  svLabel: "SV",
  cvLabel: "CV",
  spiLabel: "SPI",
  cpiLabel: "CPI",
  eacLabel: "EAC",
  etcLabel: "ETC",
  spiBehindFlag: "behind schedule",
  cpiOverFlag: "over cost",
  bacGloss: "Total budget for all the work.",
  pvGloss: "Budgeted cost of the work planned by now.",
  evGloss: "Budgeted cost of the work actually finished.",
  acGloss: "What has actually been spent.",
  svGloss: "Earned minus planned. Below zero means behind schedule.",
  cvGloss: "Earned minus spent. Below zero means over budget.",
  spiGloss: "Schedule efficiency. Above 1 is ahead of plan.",
  cpiGloss: "Cost efficiency. Above 1 is under budget.",
  eacGloss: "Projected total cost if the current trend holds.",
  etcGloss: "Projected cost of the work still to do.",
  dashboardDescription: "Earned-value metrics as of the status date, in the project's cost unit.",
  curveDescription: "Cumulative cost over time: planned (PV), earned (EV) and actual (AC).",
  evmCurvePoint: (p) => {
    let text = `${day(p.t)} — PV ${formatAmount(p.pv)}`;
    if (p.ev !== undefined) text += `, EV ${formatAmount(p.ev)}`;
    if (p.ac !== undefined) text += `, AC ${formatAmount(p.ac)}`;
    return text;
  },
};

/** The key set of the catalog, in declaration order — the count the spec pins at 73. */
export const TRACKING_MESSAGE_KEYS = Object.keys(DEFAULT_MESSAGES) as readonly (keyof TrackingMessages)[];

/** Resolves the host's per-key overrides against the built-in defaults (§6). */
export function resolveMessages(
  overrides: Partial<TrackingMessages> | undefined,
  onFault: (messageKey: keyof TrackingMessages & string, error: unknown) => void,
): TrackingMessages {
  const resolved = resolveCatalog(DEFAULT_MESSAGES, overrides, onFault);
  // See the module doc: default `slipLabel` / `reportLateLine` compose the RESOLVED `duration`
  // member (host override included), not the built-in default — this is what makes them do that.
  durationRef.current = resolved.duration;
  return resolved;
}
