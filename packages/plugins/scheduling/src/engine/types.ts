// docs/specs/plugins/scheduling.md §2 / §3.1 / §13 (`engine/types.ts`)
/**
 * The engine's shared type vocabulary: the time shapes its passes carry, the duration model every
 * repositioning goes through, the two public contribution shapes, and the internal hook bundle the
 * passes receive them through.
 *
 * The file is deliberately free of every runtime import: the engine subtree is headless (§13), and
 * this module is what the rest of the package's public surface re-exports from.
 */
import type {
  CalendarDef,
  ConstraintType,
  Patch,
  ReadonlyDataView,
  Task,
  TaskId,
} from "@stargantt/plugin-data-store";

/** A task's scheduled interval during a pass. `end` is exclusive; duration is always derived. */
export interface Times {
  start: number;
  end: number;
}

/** One task's backward-pass result. */
export interface LatestTimes {
  latestStart: number;
  latestFinish: number;
}

/** Which side of a proposed span the relation applying it pins (§2.1, the two-anchor rule). */
export type PlacementAnchor = "start" | "end";

/**
 * How one task's start and end move together.
 *
 * Against a calendar with usable working hours the two are separated by working time, so a task
 * pushed across a non-working stretch keeps its working duration and grows in elapsed terms;
 * otherwise they are separated by a fixed elapsed duration. Everything that repositions a task
 * goes through this pair, so both granularities share one code path.
 */
export interface DurationModel {
  /** The end the task takes when it starts at `start`. */
  endFor(start: number): number;
  /** The start the task takes when it ends at `end`. */
  startFor(end: number): number;
}

/** One link's forward bound: an instant, and the side of the target it applies to. */
export interface LinkBound {
  anchor: PlacementAnchor;
  time: number;
}

/* ------------------------------------------------------------------ *
 * Extension-point contribution shapes (§3.1)
 * ------------------------------------------------------------------ */

/**
 * Time bounds a constraint places on a task, in epoch milliseconds.
 *
 * `earliestStart` is a lower bound on the task's start; `latestEnd` is an upper bound on its end.
 * Either or both may be present; an absent member imposes no bound on that side.
 */
export interface ConstraintBounds {
  earliestStart?: number;
  latestEnd?: number;
}

/** The task's constraint, as handed to a `ConstraintBounds` contribution. */
export interface ConstraintRef {
  readonly type: ConstraintType;
  readonly date?: number;
}

/**
 * Maps a task's constraint to time bounds when the built-in engine does not recognize the
 * constraint type.
 *
 * Called only for constraint types outside the eight built-ins (§2.3). Return the bounds the
 * constraint imposes, or `undefined` to decline the type and let the next contribution try; if no
 * contribution handles it, the constraint is ignored and the task schedules as unconstrained.
 */
export type ConstraintBoundsContribution = (
  task: Readonly<Task>,
  ctx: {
    readonly view: ReadonlyDataView;
    readonly constraint: ConstraintRef;
  },
) => ConstraintBounds | undefined;

/**
 * A per-task propagation rule that replaces the engine's built-in date derivation for the tasks it
 * claims.
 *
 * The rule is called with the dates the built-in derivation proposes. Return replacement dates to
 * claim the task, or `undefined` to decline it, in which case the built-in proposal stands.
 *
 * `anchor` names which side of the proposal the relation being applied pins: `"end"` while an
 * FF/SF predecessor decides the task's finish, `"start"` otherwise (FS/SS, a constraint date, a
 * summary roll-up). A rule that re-derives the span from a duration of its own holds the anchored
 * side still and moves the other, or its placement will not be a fixed point; ignoring the anchor
 * is allowed.
 */
export type PropagationRuleContribution = (
  task: Readonly<Task>,
  ctx: {
    readonly view: ReadonlyDataView;
    /** The dates the built-in derivation would assign. */
    readonly proposed: { readonly start: number; readonly end: number };
    /** Which side of `proposed` the relation being applied pins. */
    readonly anchor: PlacementAnchor;
  },
) => { start: number; end: number } | undefined;

/**
 * The calendar a task is scheduled against.
 *
 * §2.2: the official resolution is registry-first, then the data store, then
 * the registry default. The engine takes it as a seam so it stays a pure function of its inputs —
 * `storeCalendarOf` (the data-store-only rule) is the default, and the root
 * wiring substitutes the registry-aware resolver.
 */
export type CalendarResolver = (
  view: ReadonlyDataView,
  task: Readonly<Task>,
) => Readonly<CalendarDef> | undefined;

/**
 * The composed contributions plus the calendar seam every engine pass is parameterized by.
 *
 * Each contribution member is already the "first non-declining contribution wins" composite; an
 * absent member means nothing was contributed. `calendarOf` is not a contribution — it is the
 * §2.2 internal resolution, bundled here so one object carries everything a pass needs beyond its
 * view.
 */
export interface SchedulerHooks {
  constraintBounds?: ConstraintBoundsContribution;
  propagationRule?: PropagationRuleContribution;
  calendarOf?: CalendarResolver;
}

/** What a reschedule run consists of (§2.6). */
export interface ReschedulePlan {
  /** Direct `task/update` moves, ready to apply; each patched task is a propagation seed. */
  patches: Patch[];
  /**
   * Candidates handed to propagation instead of being patched directly (they are downstream of a
   * patched candidate); the follow-on pass floors them at `floor` via `withStatusDateFloor`.
   * Always empty in a flat (no-propagation) plan.
   */
  floorIds: Set<TaskId>;
  /** The status date the plan was computed against. */
  floor: number;
}
