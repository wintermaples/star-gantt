// docs/specs/plugins/tracking.md §5 — the four configuration nests.
//
// **Presence semantics (normative).** Every one of the four nests — unlike scheduling's
// always-on `dependencies` nest — leaves its feature DORMANT when omitted: no layer draw, no bar
// contribution, no panel can open, and the rendered output equals a composition without that
// feature's contribution, while the nest's SERVICE stays provided over empty state (§1). Passing a
// nest, even `{}`, enables the feature with the defaults below. Unusable field values silently fall
// back to their defaults; everything is read once at `setup()` except the live "current UTC day"
// status-date fallbacks (`internal/shared/status-date.ts`).
import type {
  BaselineId,
  BaselineInit,
  CostFormulaInit,
  CostPanelRenderContext,
  CostRateInit,
  EacMethod,
  EarnedValueMethod,
  EvmAccrualFn,
  EvmEacFn,
  EvmFormulaInit,
  EvmPanelRenderContext,
  EvmSnapshot,
  ProgressSnapshot,
} from "./types";
import type { TrackingMessages } from "./internal/messages";

/* ------------------------------------------------------------------ *
 * Raw config (what the host passes)
 * ------------------------------------------------------------------ */

/** §5.1 — baselines. 8 fields. Dormant when the nest is omitted. */
export interface BaselinesConfig {
  /** Baselines registered at setup, in order (host persistence or export.md's `baselineInits`). */
  baselines?: readonly BaselineInit[];
  /** The initially active baseline; unknown ids ignored. */
  active?: BaselineId;
  /** Draw the active baseline's bars (§2.3). Default `true`. */
  bars?: boolean;
  /** Thin bottom-of-row bars vs translucent overlay rects. Default `"under"`. */
  barStyle?: "under" | "overlay";
  /** Draw actual bars for tasks carrying actual dates (§2.4). Default `true`. */
  actualBars?: boolean;
  /** Per-task slip glyph+text beside bars (§2.3). Default `true`. */
  slipIndicators?: boolean;
  /** Minimum absolute slip an indicator is shown for; exact comparison. Default `86_400_000` (1d). */
  slipThresholdMs?: number;
  /** Critical-path change rings (§2.3). Default `false`. */
  criticalPath?: boolean;
}

/** §5.2 — progress. 6 fields. Dormant when the nest is omitted. */
export interface ProgressConfig {
  /** Fixed status date for the line and the report. Default: start of current UTC day, live. */
  statusDate?: number;
  /** Initial state of the runtime line toggle (§2.7). Default `false`. */
  progressLine?: boolean;
  /** Recolor bars by RAG via `taskbars/style` (§3.2). Default `false`. */
  colorBars?: boolean;
  /** How the report's `percentComplete` weights each leaf (§2.6). Default `"count"`. */
  progressWeighting?: "count" | "duration";
  /** The lettered RAG badge left of classified bars. Default `true`. */
  showRagOnBars?: boolean;
  /** Seed trend snapshots; unusable entries dropped, order normalized. Default `[]`. */
  snapshots?: readonly ProgressSnapshot[];
}

/** §5.3 — cost. 8 fields. Dormant when the nest is omitted. */
export interface CostConfig {
  /** Rate-master seed; unusable inits dropped. Default `[]`. */
  rates?: readonly CostRateInit[];
  /** Working hours per UTC day — the labor-effort density (§2.8). Default `8`. */
  hoursPerDay?: number;
  /** Project budget. */
  budget?: number;
  /** Per-cost-code budgets; unusable entries dropped. Default `{}`. */
  budgets?: Readonly<Record<string, number>>;
  /** Alert threshold as a fraction of the reference (§2.10). Default `1`. */
  alertThreshold?: number;
  /** Fixed status date for curve/forecast. Default: start of current UTC day. */
  statusDate?: number;
  /** Custom table-panel metrics (§2.12). Default `[]`. */
  formulas?: readonly CostFormulaInit[];
  /** The §2.13 body seam over the three cost panels. */
  renderPanel?: (host: HTMLElement, ctx: CostPanelRenderContext) => void;
}

/** §5.4 — evm. 7 fields. Dormant when the nest is omitted. */
export interface EvmConfig {
  /** Default accrual method or host rule (§2.15). Default `"percentComplete"`. */
  method?: EarnedValueMethod | EvmAccrualFn;
  /** EAC formula or host rule (§2.15). Default `"cpi"`. */
  eacMethod?: EacMethod | EvmEacFn;
  /** Extra KPI tiles after the ten built-ins (§2.15). */
  formulas?: readonly EvmFormulaInit[];
  /** The §2.13 body seam over the two EVM panels. */
  renderPanel?: (host: HTMLElement, ctx: EvmPanelRenderContext) => void;
  /** Fixed status date. Default: §2.14 chain. */
  statusDate?: number;
  /** Seed of the session project-BAC override. Default: sum of task BACs (no override). */
  projectBac?: number;
  /** Seed EV/AC snapshots; last entry per UTC day kept, unusable dropped. Default `[]`. */
  snapshots?: readonly EvmSnapshot[];
}

/** Options for the tracking plugin. */
export interface TrackingConfig {
  /** Baselines (§2.3/§2.4). Dormant when omitted. */
  baselines?: BaselinesConfig;
  /** Progress tracking (§2.5/§2.6/§2.7). Dormant when omitted. */
  progress?: ProgressConfig;
  /** Cost tracking (§2.8–§2.13). Dormant when omitted. */
  cost?: CostConfig;
  /** Earned value management (§2.14/§2.15). Dormant when omitted. */
  evm?: EvmConfig;
  /** Per-key replacements for the plugin's user-visible strings (§6). */
  messages?: Partial<TrackingMessages>;
}

/* ------------------------------------------------------------------ *
 * Resolved config (what the plugin runs on)
 * ------------------------------------------------------------------ */

export interface ResolvedBaselinesConfig {
  baselines: readonly BaselineInit[];
  active: BaselineId | undefined;
  bars: boolean;
  barStyle: "under" | "overlay";
  actualBars: boolean;
  slipIndicators: boolean;
  slipThresholdMs: number;
  criticalPath: boolean;
}

export interface ResolvedProgressConfig {
  statusDate: number | undefined;
  progressLine: boolean;
  colorBars: boolean;
  progressWeighting: "count" | "duration";
  showRagOnBars: boolean;
  snapshots: readonly ProgressSnapshot[];
}

export interface ResolvedCostConfig {
  rates: readonly CostRateInit[];
  hoursPerDay: number;
  budget: number | undefined;
  budgets: Readonly<Record<string, number>>;
  alertThreshold: number;
  statusDate: number | undefined;
  formulas: readonly CostFormulaInit[];
  renderPanel: ((host: HTMLElement, ctx: CostPanelRenderContext) => void) | undefined;
}

export interface ResolvedEvmConfig {
  method: EarnedValueMethod | EvmAccrualFn;
  eacMethod: EacMethod | EvmEacFn;
  formulas: readonly EvmFormulaInit[];
  renderPanel: ((host: HTMLElement, ctx: EvmPanelRenderContext) => void) | undefined;
  statusDate: number | undefined;
  projectBac: number | undefined;
  snapshots: readonly EvmSnapshot[];
}

/** Everything `setup()` runs on, read once. `undefined` at the top level means dormant (§5). */
export interface ResolvedTrackingConfig {
  baselines: ResolvedBaselinesConfig | undefined;
  progress: ResolvedProgressConfig | undefined;
  cost: ResolvedCostConfig | undefined;
  evm: ResolvedEvmConfig | undefined;
}

/* ------------------------------------------------------------------ *
 * Field readers — an unusable value is exactly the default
 * ------------------------------------------------------------------ */

function bool(value: unknown, fallback: boolean): boolean {
  return typeof value === "boolean" ? value : fallback;
}

function finiteNumber(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function finiteNumberOrUndefined(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function baselineId(value: unknown): BaselineId | undefined {
  return typeof value === "string" || typeof value === "number" ? value : undefined;
}

function arrayOf<T>(value: unknown): readonly T[] {
  return Array.isArray(value) ? (value as T[]) : [];
}

function recordOfNumbers(value: unknown): Readonly<Record<string, number>> {
  if (typeof value !== "object" || value === null) return {};
  const out: Record<string, number> = {};
  for (const [key, v] of Object.entries(value as Record<string, unknown>)) {
    if (typeof v === "number" && Number.isFinite(v)) out[key] = v;
  }
  return out;
}

function functionOrUndefined<F>(value: unknown): F | undefined {
  return typeof value === "function" ? (value as F) : undefined;
}

/* ------------------------------------------------------------------ *
 * Per-nest resolvers
 * ------------------------------------------------------------------ */

function resolveBaselines(raw: BaselinesConfig | undefined): ResolvedBaselinesConfig | undefined {
  if (raw === undefined) return undefined;
  const nest = typeof raw === "object" && raw !== null ? raw : {};
  return {
    baselines: arrayOf<BaselineInit>(nest.baselines),
    active: baselineId(nest.active),
    bars: bool(nest.bars, true),
    barStyle: nest.barStyle === "overlay" ? "overlay" : "under",
    actualBars: bool(nest.actualBars, true),
    slipIndicators: bool(nest.slipIndicators, true),
    slipThresholdMs: finiteNumber(nest.slipThresholdMs, 86_400_000),
    criticalPath: bool(nest.criticalPath, false),
  };
}

function resolveProgress(raw: ProgressConfig | undefined): ResolvedProgressConfig | undefined {
  if (raw === undefined) return undefined;
  const nest = typeof raw === "object" && raw !== null ? raw : {};
  return {
    statusDate: finiteNumberOrUndefined(nest.statusDate),
    progressLine: bool(nest.progressLine, false),
    colorBars: bool(nest.colorBars, false),
    progressWeighting: nest.progressWeighting === "duration" ? "duration" : "count",
    showRagOnBars: bool(nest.showRagOnBars, true),
    snapshots: arrayOf<ProgressSnapshot>(nest.snapshots),
  };
}

function resolveCost(raw: CostConfig | undefined): ResolvedCostConfig | undefined {
  if (raw === undefined) return undefined;
  const nest = typeof raw === "object" && raw !== null ? raw : {};
  return {
    rates: arrayOf<CostRateInit>(nest.rates),
    hoursPerDay: finiteNumber(nest.hoursPerDay, 8),
    budget: finiteNumberOrUndefined(nest.budget),
    budgets: recordOfNumbers(nest.budgets),
    alertThreshold: (() => {
      const t = finiteNumberOrUndefined(nest.alertThreshold);
      return t !== undefined && t > 0 ? t : 1;
    })(),
    statusDate: finiteNumberOrUndefined(nest.statusDate),
    formulas: arrayOf<CostFormulaInit>(nest.formulas),
    renderPanel: functionOrUndefined(nest.renderPanel),
  };
}

const EVM_METHODS: readonly EarnedValueMethod[] = [
  "percentComplete",
  "zeroHundred",
  "fiftyFifty",
  "milestoneWeighted",
];
const EAC_METHODS: readonly EacMethod[] = ["cpi", "remaining", "cpiSpi"];

function resolveEvm(raw: EvmConfig | undefined): ResolvedEvmConfig | undefined {
  if (raw === undefined) return undefined;
  const nest = typeof raw === "object" && raw !== null ? raw : {};
  const method =
    typeof nest.method === "function"
      ? (nest.method as EvmAccrualFn)
      : EVM_METHODS.includes(nest.method as EarnedValueMethod)
        ? (nest.method as EarnedValueMethod)
        : "percentComplete";
  const eacMethod =
    typeof nest.eacMethod === "function"
      ? (nest.eacMethod as EvmEacFn)
      : EAC_METHODS.includes(nest.eacMethod as EacMethod)
        ? (nest.eacMethod as EacMethod)
        : "cpi";
  return {
    method,
    eacMethod,
    formulas: arrayOf<EvmFormulaInit>(nest.formulas),
    renderPanel: functionOrUndefined(nest.renderPanel),
    statusDate: finiteNumberOrUndefined(nest.statusDate),
    projectBac: finiteNumberOrUndefined(nest.projectBac),
    snapshots: arrayOf<EvmSnapshot>(nest.snapshots),
  };
}

/** Reads every nest once, applying the §5 presence semantics and per-field fallbacks. */
export function resolveConfig(raw: TrackingConfig): ResolvedTrackingConfig {
  return {
    baselines: resolveBaselines(raw.baselines),
    progress: resolveProgress(raw.progress),
    cost: resolveCost(raw.cost),
    evm: resolveEvm(raw.evm),
  };
}
