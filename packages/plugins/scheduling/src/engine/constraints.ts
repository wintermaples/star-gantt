// docs/specs/plugins/scheduling.md §2.3 / §3.1 (`engine/constraints.ts`)
/**
 * The eight built-in constraint types and the two contribution seams the passes consult.
 *
 * `ASAP` is an intentional no-op: "as soon as possible" is exactly what the unconstrained forward
 * pass already computes, so the constraint bounds nothing and changes nothing. `ALAP` likewise
 * carries no bound of its own — its upper bound comes from its successors and is derived in the
 * back-clamp pass. The four MS-Project-style additions (SNLT / FNET / MSO / MFO) are date bounds
 * expressed through the task's own duration model, so they clamp with exactly the machinery SNET
 * and FNLT already use.
 *
 * Only a constraint type outside those eight reaches `schedule/constraintBounds`; the composed
 * contribution (already "first non-declining wins", guarded by the plugin that owns the point) may
 * resolve it to bounds, and where every contribution declines the constraint is ignored.
 *
 * The `ctx`-bound half of the two points — `defineExtensionPoint`, the `core/pluginError` guard
 * around a foreign contribution — lives in the root `index.ts`, because it needs a plugin context
 * the headless engine deliberately does not have (§13).
 */
import type { ReadonlyDataView, Task, TaskId } from "@stargantt/plugin-data-store";
import type {
  ConstraintBounds,
  DurationModel,
  PlacementAnchor,
  SchedulerHooks,
  Times,
} from "./types";

/** No bound at all — the shared empty answer, never handed out mutably. */
const NO_BOUNDS: ConstraintBounds = {};

/**
 * Everything the passes carry around: the view, the composed contributions plus the calendar seam,
 * and a per-run memo of each task's constraint bounds so a contribution is asked about a task at
 * most once per `schedule()` call however many times the passes visit it.
 */
export interface EngineEnv {
  readonly view: ReadonlyDataView;
  readonly hooks: SchedulerHooks;
  readonly bounds: Map<TaskId, ConstraintBounds>;
}

/** The bounds the task's constraint imposes, memoized for the run. */
export function boundsOf(
  env: EngineEnv,
  task: Readonly<Task>,
  model: DurationModel,
): ConstraintBounds {
  const memo = env.bounds.get(task.id);
  if (memo !== undefined) return memo;
  const computed = computeBounds(env, task, model);
  env.bounds.set(task.id, computed);
  return computed;
}

function computeBounds(
  env: EngineEnv,
  task: Readonly<Task>,
  model: DurationModel,
): ConstraintBounds {
  const constraint = task.constraint;
  if (constraint === undefined) return NO_BOUNDS;

  const date = constraint.date;
  switch (constraint.type) {
    case "ASAP":
    case "ALAP":
      return NO_BOUNDS;
    case "SNET":
      return date === undefined ? NO_BOUNDS : { earliestStart: date };
    case "FNLT":
      return date === undefined ? NO_BOUNDS : { latestEnd: date };
    case "SNLT":
      // Start no later than `date` ⇔ end no later than the end a start at `date` implies.
      return date === undefined ? NO_BOUNDS : { latestEnd: model.endFor(date) };
    case "FNET":
      // Finish no earlier than `date` ⇔ start no earlier than the start an end at `date` implies.
      return date === undefined ? NO_BOUNDS : { earliestStart: model.startFor(date) };
    case "MSO":
      // Must start on `date`: both sides bound at once. Where a dependency forces a later start
      // the early side wins, so MSO degrades to SNET rather than breaking the graph.
      return date === undefined
        ? NO_BOUNDS
        : { earliestStart: date, latestEnd: model.endFor(date) };
    case "MFO":
      // Must finish on `date`: the mirror of MSO on the finish side.
      return date === undefined
        ? NO_BOUNDS
        : { earliestStart: model.startFor(date), latestEnd: date };
    default:
      break;
  }

  // Only an open-union constraint type reaches here, the switch above having taken every built-in.
  const mapped = env.hooks.constraintBounds?.(task, { view: env.view, constraint });
  return mapped ?? NO_BOUNDS;
}

/** The propagation rule's replacement dates, or `undefined` when no contribution claims the task. */
export function applyRuleOrUndefined(
  env: EngineEnv,
  task: Readonly<Task>,
  proposed: Times,
  anchor: PlacementAnchor,
): Times | undefined {
  // Consulted for every task the engine derives dates for; the first non-declining contribution
  // claims it. The anchor tells a claiming rule which side of the proposal it must not move.
  const rule = env.hooks.propagationRule;
  if (rule === undefined) return undefined;
  const claimed = rule(task, { view: env.view, proposed, anchor });
  if (claimed === undefined) return undefined;
  if (!Number.isFinite(claimed.start) || !Number.isFinite(claimed.end)) return undefined;
  return { start: claimed.start, end: claimed.end };
}

/**
 * As `applyRuleOrUndefined`, but falling back to the proposal — used for the summary roll-up,
 * where both sides come from the children and the start is the anchor a rule should hold still.
 */
export function applyRule(env: EngineEnv, task: Readonly<Task>, proposed: Times): Times {
  return applyRuleOrUndefined(env, task, proposed, "start") ?? proposed;
}
