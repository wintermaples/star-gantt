// docs/specs/plugins/tracking.md §2.14 / §2.15 — the EVM computation core plus the §2.14
// input-resolution layer that feeds it.
//
// The upper half is hostless arithmetic: accrual fractions per method, the PV spread, the derived
// indices and the three EAC formulas. The lower half resolves one task's inputs — BAC, AC, planned
// dates, raw progress — and the status date.
//
// §2.14's recorded resolution: cost/baselines/progress are internal modules of this same plugin, so
// the fan-in is unconditional direct calls — the `EvmAreaExtras` functions the root wires in — and
// the raw progress percent is read straight off the claimed `progressTracking` bag rather than
// through the progress area. No `*Service` type crosses an area boundary.
import type { Task, TaskId } from "@stargantt/plugin-data-store";
import type {
  EacMethod,
  EarnedValueMethod,
  EvmAccrualFn,
  EvmEacFn,
  EvmIndices,
  EvmMilestone,
  EvmTaskMetrics,
} from "../../types";
import type { TrackingAreaDeps } from "../areas";
import { readBag } from "../shared/meta-bag";
import { evmStatusDateResolver, statusDateResolver } from "../shared/status-date";
import { evmValuesOf, isEarnedValueMethod } from "./values";
import type { EvmAreaExtras } from "./wire";

/* ==================================================================== *
 * The hostless core
 * ==================================================================== */

/** What the engine needs to know about one task, after §2.14 input resolution. */
export interface EvmTaskInput {
  id: TaskId;
  /** Planned start, epoch ms (active-baseline snapshot when one resolves, else current). */
  plannedStart: number;
  /** Planned end, epoch ms, exclusive. */
  plannedEnd: number;
  /** Resolved Budget at Completion. */
  bac: number;
  /** Resolved actual cost to date. */
  ac: number;
  /** Raw progress fraction 0–1 (physical percent when present, else `task.progress`). */
  progress: number;
  /** The effective accrual method. */
  method: EarnedValueMethod;
  /** Stored weighted milestones, empty when none. */
  milestones: readonly EvmMilestone[];
  /**
   * An already-resolved earned fraction that wins over `method` — how the caller feeds a host
   * accrual rule's answer in (§2.15, the `EvmAccrualFn` form of `evm.method`).
   */
  earned?: number;
}

/**
 * A resolved host EAC rule: given the indices carrying the built-in forecast, it returns the
 * replacement Estimate At Completion, or `undefined` to keep the built-in one. Containment lives in
 * the caller — this never throws (§2.15's latch).
 */
export type EacOverride = (indices: Readonly<EvmIndices>) => number | undefined;

const clamp01 = (v: number): number => (v <= 0 ? 0 : v >= 1 ? 1 : v);

/** The completed share of a weighted milestone list, or `undefined` when unusable. */
function milestoneFraction(milestones: readonly EvmMilestone[]): number | undefined {
  let total = 0;
  let done = 0;
  for (const m of milestones) {
    total += m.weight;
    if (m.complete) done += m.weight;
  }
  return total > 0 ? done / total : undefined;
}

type EarnRule = (progress: number, milestones: readonly EvmMilestone[]) => number;

// Table-driven and `satisfies`-checked so a future method variant cannot become a silent no-op.
const EARN_RULES = {
  percentComplete: (p) => clamp01(p),
  zeroHundred: (p) => (p >= 1 ? 1 : 0),
  fiftyFifty: (p) => (p >= 1 ? 1 : p > 0 ? 0.5 : 0),
  milestoneWeighted: (p, milestones) => milestoneFraction(milestones) ?? clamp01(p),
} satisfies Record<EarnedValueMethod, EarnRule>;

/** The earned fraction (0–1) per accrual method (§2.15's accrual table). */
export function earnedFraction(
  method: EarnedValueMethod,
  progress: number,
  milestones: readonly EvmMilestone[],
): number {
  return EARN_RULES[method](Number.isFinite(progress) ? progress : 0, milestones);
}

/** The planned-value fraction of a span at `t`: uniform spread, whole once past a zero span. */
export function pvFraction(start: number, end: number, t: number): number {
  const span = end - start;
  if (span <= 0) return t >= start ? 1 : 0;
  return clamp01((t - start) / span);
}

type EacRule = (bac: number, ev: number, ac: number, spi?: number, cpi?: number) => number;

const remainingEac: EacRule = (bac, ev, ac) => ac + (bac - ev);

const EAC_RULES = {
  cpi: (bac, _ev, _ac, _spi, cpi) => (cpi !== undefined && cpi > 0 ? bac / cpi : bac),
  remaining: remainingEac,
  cpiSpi: (bac, ev, ac, spi, cpi) => {
    const factor = (cpi ?? 0) * (spi ?? 0);
    return factor > 0 ? ac + (bac - ev) / factor : remainingEac(bac, ev, ac);
  },
} satisfies Record<EacMethod, EacRule>;

/** The built-in EAC formula names, derived from the rule table so the two never drift apart. */
export const EAC_METHODS: readonly EacMethod[] = Object.keys(EAC_RULES) as EacMethod[];

/**
 * Derives SV/CV/SPI/CPI/EAC/ETC from the four base figures (§2.15). `eacOverride`, when given, sees
 * the finished indices — including the built-in forecast — and may replace the EAC; ETC then
 * follows it.
 */
export function derive(
  bac: number,
  pv: number,
  ev: number,
  ac: number,
  eacMethod: EacMethod,
  eacOverride?: EacOverride,
): EvmIndices {
  const spi = pv > 0 ? ev / pv : undefined;
  const cpi = ac > 0 ? ev / ac : undefined;
  const eac = EAC_RULES[eacMethod](bac, ev, ac, spi, cpi);
  const out: EvmIndices = { bac, pv, ev, ac, sv: ev - pv, cv: ev - ac, eac, etc: eac - ac };
  if (spi !== undefined) out.spi = spi;
  if (cpi !== undefined) out.cpi = cpi;
  const custom = eacOverride?.(out);
  if (custom !== undefined) {
    out.eac = custom;
    out.etc = custom - ac;
  }
  return out;
}

/** The earned fraction that either wins from `input.earned` or falls back to the method rule. */
export function earnedOf(input: EvmTaskInput): number {
  return input.earned ?? earnedFraction(input.method, input.progress, input.milestones);
}

/** One task's metrics at the status date (§2.15). */
export function taskMetrics(
  input: EvmTaskInput,
  statusDate: number,
  eacMethod: EacMethod,
  eacOverride?: EacOverride,
): EvmTaskMetrics {
  const earned = earnedOf(input);
  const pv = input.bac * pvFraction(input.plannedStart, input.plannedEnd, statusDate);
  const ev = input.bac * earned;
  return { id: input.id, earned, ...derive(input.bac, pv, ev, input.ac, eacMethod, eacOverride) };
}

/**
 * The project aggregate: PV/EV/AC summed over the per-task metrics, BAC taken from the caller (the
 * session override, else the task-BAC sum), indices derived from the sums — never averaged (§2.15).
 */
export function aggregate(
  perTask: readonly EvmTaskMetrics[],
  projectBac: number,
  eacMethod: EacMethod,
  eacOverride?: EacOverride,
): EvmIndices {
  let pv = 0;
  let ev = 0;
  let ac = 0;
  for (const m of perTask) {
    pv += m.pv;
    ev += m.ev;
    ac += m.ac;
  }
  return derive(projectBac, pv, ev, ac, eacMethod, eacOverride);
}

/* ==================================================================== *
 * §2.14 input resolution
 * ==================================================================== */

/** The `progressTracking` bag's key — read directly here, never through the progress area (§2.14). */
const PROGRESS_META_KEY = "progressTracking";

/**
 * The latched barrier around a host rule that answers per task or per computation (§2.15):
 * the first throw is reported and the rule then declines for the instance's life, so a
 * broken rule costs one event rather than one per task per read. A rule answering with anything but
 * a finite number declines that call only, silently.
 */
export function latched<A extends readonly unknown[]>(
  report: (error: unknown) => void,
  fn: ((...args: A) => number) | undefined,
): (...args: A) => number | undefined {
  if (fn === undefined) return () => undefined;
  let broken = false;
  return (...args: A) => {
    if (broken) return undefined;
    let value: number;
    try {
      value = fn(...args);
    } catch (error) {
      broken = true;
      report(error);
      return undefined;
    }
    return typeof value === "number" && Number.isFinite(value) ? value : undefined;
  };
}

/** What {@link createEvmEngine} hands the service and the panels. */
export interface EvmEngine {
  /** The §2.14 status-date chain, tracked live (never latched at setup). */
  statusDate(): number;
  /** The default accrual method in effect; `"percentComplete"` under a host rule (§1.4). */
  readonly defaultMethod: EarnedValueMethod;
  /** The EAC formula in effect; `"cpi"` under a host rule. */
  readonly eacMethod: EacMethod;
  /** The already-contained host EAC rule, or a rule that always declines. */
  readonly runEac: EacOverride;
  bacOfTask(task: Readonly<Task>): number;
  acOfTask(task: Readonly<Task>): number;
  plannedDatesOf(task: Readonly<Task>): { start: number; end: number };
  progressOf(task: Readonly<Task>): number;
  inputOf(task: Readonly<Task>, at: number): EvmTaskInput;
  /** Every stored task, in store order. A fresh array per call. */
  allTasks(): Readonly<Task>[];
  projectBac(): number;
  allMetrics(): EvmTaskMetrics[];
  projectMetrics(): EvmIndices;
}

/**
 * Builds the input-resolution layer over the data store, the `EvmAreaExtras` fan-in and the shared
 * status-date chain.
 *
 * `projectBacOverride` reads the session override out of the area's `EvmState` store — the engine
 * itself holds no state.
 */
export function createEvmEngine(
  deps: TrackingAreaDeps,
  extras: EvmAreaExtras,
  projectBacOverride: () => number | undefined,
): EvmEngine {
  const evmConfig = deps.config.evm;

  // §2.15's widening: each option takes its enum **or** a host rule. The enum path is
  // untouched — a function form only adds an override on top of the enum position it falls back to.
  const rawMethod: EarnedValueMethod | EvmAccrualFn | undefined = evmConfig?.method;
  const rawEacMethod: EacMethod | EvmEacFn | undefined = evmConfig?.eacMethod;
  const defaultMethod: EarnedValueMethod = isEarnedValueMethod(rawMethod)
    ? rawMethod
    : "percentComplete";
  const accrualFn: EvmAccrualFn | undefined =
    typeof rawMethod === "function" ? rawMethod : undefined;
  const eacMethod: EacMethod = (EAC_METHODS as readonly unknown[]).includes(rawEacMethod)
    ? (rawEacMethod as EacMethod)
    : "cpi";
  const eacFn: EvmEacFn | undefined = typeof rawEacMethod === "function" ? rawEacMethod : undefined;

  const runAccrual = latched<[Readonly<Task>, number, number]>(
    (error) => deps.reportError("method", error),
    accrualFn,
  );
  const runEac: EacOverride = latched<[Readonly<EvmIndices>]>(
    (error) => deps.reportError("eacMethod", error),
    eacFn,
  );

  // §2.14's three-link chain, composed out of `internal/shared/status-date.ts`. The middle link is
  // the progress area's own chain over the very same `progress.statusDate` value — the identical
  // computation, expressed without a cross-area function reference.
  const progressStatusDate = statusDateResolver(deps.config.progress?.statusDate, deps.now);
  const statusDate = evmStatusDateResolver(evmConfig?.statusDate, progressStatusDate);

  /** BAC: stored `meta.evm.bac`, else the cost area's `estimated`, else 0 (§2.14). */
  function bacOfTask(task: Readonly<Task>): number {
    const stored = evmValuesOf(task).bac;
    if (stored !== undefined) return stored;
    return extras.costOf(task.id)?.estimated ?? 0;
  }

  /** AC: stored `meta.evm.actualCost`, else the cost area's `actual`, else 0 (§2.14). */
  function acOfTask(task: Readonly<Task>): number {
    const stored = evmValuesOf(task).actualCost;
    if (stored !== undefined) return stored;
    return extras.costOf(task.id)?.actual ?? 0;
  }

  /**
   * Planned dates: the task's snapshot in the ACTIVE baseline when one resolves, else the task's
   * current dates (§2.14). An `undefined` return from the lookup already means "no usable
   * planned-date override" — there is no separate "is a baseline active" question to ask.
   */
  function plannedDatesOf(task: Readonly<Task>): { start: number; end: number } {
    const snapshot = extras.baselineSnapshotOf(task.id);
    if (snapshot !== undefined) return { start: snapshot.start, end: snapshot.end };
    return { start: task.start, end: task.end };
  }

  /**
   * Raw progress `p`: a usable `physicalPercent` off the claimed `progressTracking` bag, clamped
   * 0–100 and read as a fraction, else the clamped `task.progress`, else 0 (§2.1 / §2.14).
   */
  function progressOf(task: Readonly<Task>): number {
    const physical = readBag(task, PROGRESS_META_KEY)["physicalPercent"];
    if (typeof physical === "number" && Number.isFinite(physical)) {
      return Math.min(Math.max(physical / 100, 0), 1);
    }
    const p = task.progress;
    return typeof p === "number" && Number.isFinite(p) ? Math.min(Math.max(p, 0), 1) : 0;
  }

  function inputOf(task: Readonly<Task>, at: number): EvmTaskInput {
    const values = evmValuesOf(task);
    const planned = plannedDatesOf(task);
    const bac = bacOfTask(task);
    const input: EvmTaskInput = {
      id: task.id,
      plannedStart: planned.start,
      plannedEnd: planned.end,
      bac,
      ac: acOfTask(task),
      progress: progressOf(task),
      method: values.method ?? defaultMethod,
      milestones: values.milestones ?? [],
    };
    // The host accrual rule stands in for the default method only: a task with its own stored
    // method keeps it, exactly as it does against the enum default (§2.15).
    if (accrualFn !== undefined && values.method === undefined) {
      const earnedValue = runAccrual(task, at, bac);
      // The rule answers in money; the engine works in fractions, and a zero-budget task can earn
      // nothing whatever the rule returns.
      if (earnedValue !== undefined) input.earned = bac > 0 ? earnedValue / bac : 0;
    }
    return input;
  }

  function allTasks(): Readonly<Task>[] {
    const out: Readonly<Task>[] = [];
    for (const id of deps.data.taskIds()) {
      const task = deps.data.getTask(id);
      if (task !== undefined) out.push(task);
    }
    return out;
  }

  function projectBac(): number {
    const override = projectBacOverride();
    if (override !== undefined) return override;
    let sum = 0;
    for (const task of allTasks()) sum += bacOfTask(task);
    return sum;
  }

  function allMetrics(): EvmTaskMetrics[] {
    const at = statusDate();
    return allTasks().map((task) => taskMetrics(inputOf(task, at), at, eacMethod, runEac));
  }

  function projectMetrics(): EvmIndices {
    return aggregate(allMetrics(), projectBac(), eacMethod, runEac);
  }

  return {
    statusDate,
    defaultMethod,
    eacMethod,
    runEac,
    bacOfTask,
    acOfTask,
    plannedDatesOf,
    progressOf,
    inputOf,
    allTasks,
    projectBac,
    allMetrics,
    projectMetrics,
  };
}
