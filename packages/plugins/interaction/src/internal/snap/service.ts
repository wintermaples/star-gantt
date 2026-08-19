// docs/specs/plugins/interaction.md §2.2 — the `stargantt.snap` service.
/**
 * The rounding rule the chart edits with, assembled from the resolved `snap` config.
 *
 * Hostless: the timeline, the store and the two extension points arrive as plain accessors, so the
 * whole pipeline — rounding, alignment, working time and the successor push-out — is exercisable
 * without booting a plugin host.
 */
import { MS_DAY } from "@stargantt/sdk";
import type { CalendarId, Patch, ReadonlyDataView, Task } from "@stargantt/plugin-data-store";
import type { ResolvedSnap } from "../../config";
import type { PushGuard, SnapRuleContext, SnapService, SnapUnit, WorkingTimeProvider } from "../../types";
import { nearestEdge, taskEdges } from "./align";
import { pushOutPatches, standsDown } from "./push-out";
import { roundTo, unitStep } from "./units";
import type { ResolvedUnit } from "./units";
import { adjustToWorkingBoundary } from "./working-time";

/** What the snap pipeline reads from the rest of the composition. */
export interface SnapDeps {
  /** The finest scale row of the active zoom level, or `undefined` when the level defines none. */
  scaleUnit(): SnapUnit | undefined;
  /** The timeline's current pixel density, for the alignment tolerance. */
  pxPerMs(): number;
  /** Every stored task — the alignment edge source and the push-out's projection base. */
  tasks(): Iterable<Readonly<Task>>;
  /** The store's read-only view, for the push-out pass. */
  view(): ReadonlyDataView;
  /** The composed `snap/workingTime` provider, re-read on every adjustment. */
  workingTime(): WorkingTimeProvider | undefined;
  /** The composed `snap/pushGuards` contributions, re-read at commit time. */
  pushGuards(): readonly PushGuard[];
  /** Reports a fault in composed foreign code. */
  onFault(error: unknown): void;
}

/** The snap module: the published service plus the transaction hook the push-out rides. */
export interface SnapModule {
  readonly service: SnapService;
  /**
   * Appends the successor pushes a user-origin transaction forces onto its own patch list, unless
   * a composed guard suppresses the pass. A no-op when `pushSuccessors` is off.
   */
  appendPushOut(transaction: { origin: string; patches: Patch[] }): void;
  /**
   * Drops the cached task-edge snapshot the alignment reads. The caller wires it to the task
   * store's subscription, so a consultation is a binary search rather than a per-frame store scan.
   */
  invalidateEdges(): void;
}

/**
 * The module a composition with `snap.enabled: false` gets: the service still exists — consumers
 * hold a rounding rule, not an optional one — but it rounds nothing, steps by one UTC day, and
 * neither of the two transaction-time passes can fire.
 */
function inertModule(): SnapModule {
  return {
    service: {
      snap: (t) => t,
      step: (_t, direction) => direction * MS_DAY,
    },
    appendPushOut: () => {},
    invalidateEdges: () => {},
  };
}

/** Creates the snap module from the resolved config and its dependencies. */
export function createSnapModule(config: ResolvedSnap, deps: SnapDeps): SnapModule {
  if (!config.enabled) return inertModule();
  const fixed = config.unit;

  /** The unit in effect right now — re-resolved per consultation, so a zoom change lands at once. */
  function unit(): ResolvedUnit | undefined {
    if (fixed !== "scale") return fixed;
    return deps.scaleUnit();
  }

  function builtinSnap(t: number): number {
    const u = unit();
    return u === undefined ? t : roundTo(t, u);
  }

  function builtinStep(t: number, direction: 1 | -1): number {
    const u = unit();
    // Nothing is being rounded: one day keeps a keyboard edit available.
    return u === undefined ? direction * MS_DAY : unitStep(t, u, direction);
  }

  // The hook runs once, here, and is deliberately not wrapped in try/catch: swallowing a throw
  // would silently commit unrounded dates for the rest of the session.
  const base: SnapRuleContext = { unit, snap: builtinSnap, step: builtinStep };
  const rule = config.rule?.(base);

  let snapWith: (t: number) => number = builtinSnap;
  let stepWith: (t: number, direction: 1 | -1) => number = builtinStep;
  if (rule !== undefined) {
    snapWith = (t) => rule.snap(t);
    // A rule that only rounds differently keeps the built-in calendar stepping.
    const ruleStep = rule.step;
    if (ruleStep !== undefined) stepWith = (t, direction) => ruleStep.call(rule, t, direction);
  }

  /* --- task-edge alignment (opt-in) ------------------------------------- */

  const align = config.align;
  /** Sorted snapshot of every task's edges, rebuilt lazily after each data change. */
  let edges: readonly number[] | undefined;

  /** Drops the cached edge snapshot; wired to the task store's subscription by the caller. */
  function invalidateEdges(): void {
    edges = undefined;
  }

  /** The task edge `t` sticks to, or `undefined` when none is within tolerance. */
  function alignedEdge(t: number): number | undefined {
    if (align === undefined || !Number.isFinite(t)) return undefined;
    const pxPerMs = deps.pxPerMs();
    if (!(pxPerMs > 0)) return undefined;
    edges ??= taskEdges(deps.tasks());
    return nearestEdge(edges, t, align.tolerancePx / pxPerMs);
  }

  /* --- working-time avoidance (opt-in) ---------------------------------- */

  const working = config.working;
  const calendar: CalendarId | undefined = working?.calendar;

  /** Moves `t` into working time; identity when the feature is off or cannot resolve. */
  function workingAdjust(t: number): number {
    if (working === undefined || !Number.isFinite(t)) return t;
    const provider = deps.workingTime();
    if (provider === undefined) return t;
    // Freshness contract (§3): the probes are asked for on every adjustment and never cached
    // across adjustments — the provider owns its own invalidation.
    let bounds;
    try {
      bounds = calendar === undefined ? provider.boundaries() : provider.boundaries(calendar);
    } catch (error) {
      deps.onFault(error);
      return t;
    }
    if (bounds === undefined) return t;
    return adjustToWorkingBoundary(t, bounds);
  }

  /* --- the composed rule ------------------------------------------------ */

  // With neither extension configured the members are the pre-extension functions themselves, so a
  // default-config chart pays nothing.
  const plainSnap = snapWith;
  const composedSnap =
    align === undefined && working === undefined
      ? plainSnap
      : (t: number): number => {
          // An in-tolerance task edge replaces the rounding rule entirely; the working-time
          // adjustment runs last, so its answer is final.
          const edge = alignedEdge(t);
          return workingAdjust(edge !== undefined ? edge : plainSnap(t));
        };

  const service: SnapService = { snap: composedSnap, step: stepWith };

  /* --- successor push-out (opt-in) -------------------------------------- */

  function appendPushOut(transaction: { origin: string; patches: Patch[] }): void {
    if (!config.pushSuccessors) return;
    // Only a direct user edit starts a correction — scheduler output and history replays already
    // carry their final patches.
    if (transaction.origin !== "user") return;
    if (standsDown(deps.pushGuards(), deps.onFault)) return;
    const extra = pushOutPatches(deps.view(), transaction.patches);
    for (const patch of extra) transaction.patches.push(patch);
  }

  return { service, appendPushOut, invalidateEdges };
}
