/**
 * Doubles for the `stargantt.snap` pipeline, layered on top of the package's shared `_fakes.ts`
 * (`task`, `store`). Kept separate because `createSnapModule` is hostless — it reads plain
 * accessors (`SnapDeps`), never a booted chart — so its fixtures differ in shape from the
 * gesture-arbiter doubles the rest of this package tests against.
 */
import type { Link, ReadonlyDataView, Task, TaskId } from "@stargantt/plugin-data-store";
import {
  isWorkingInstant,
  nextWorkingStart,
  previousWorkingEnd,
} from "@stargantt/sdk";
import type { WorkingCalendar } from "@stargantt/sdk";
import { resolveConfig } from "../src/config";
import type { InteractionConfig, SnapConfig } from "../src/config";
import type { SnapDeps, SnapModule } from "../src/internal/snap/service";
import { createSnapModule } from "../src/internal/snap/service";
import type { WorkingBoundaries, WorkingTimeProvider } from "../src/types";

/* --- data view ----------------------------------------------------------- */

/** A read-only view built from a flat task/link list — the shape `pushOutPatches` projects onto. */
export function view(tasks: readonly Task[], links: readonly Link[] = []): ReadonlyDataView {
  const byId = new Map<TaskId, Task>(tasks.map((t) => [t.id, t]));
  const linksByTask = new Map<TaskId, { in: Link[]; out: Link[] }>();
  const slot = (id: TaskId): { in: Link[]; out: Link[] } => {
    let s = linksByTask.get(id);
    if (s === undefined) {
      s = { in: [], out: [] };
      linksByTask.set(id, s);
    }
    return s;
  };
  for (const l of links) {
    slot(l.sourceId).out.push(l);
    slot(l.targetId).in.push(l);
  }
  return {
    byId,
    children: new Map(),
    linksByTask,
    calendars: new Map(),
    resources: new Map(),
    assignmentsByTask: new Map(),
  };
}

/* --- working-time probes -------------------------------------------------- */

/** The engine's working-time probes bound to one calendar — the shape a provider composes. */
export function boundsOf(cal: Readonly<WorkingCalendar>): WorkingBoundaries {
  return {
    isWorkingInstant: (t) => isWorkingInstant(cal, t),
    nextWorkingStart: (t) => nextWorkingStart(cal, t),
    previousWorkingEnd: (t) => previousWorkingEnd(cal, t),
  };
}

/** Monday-Friday, whole days working (UTC) — a calendar with no intra-day windows. */
export const DAY_GRANULAR: WorkingCalendar = { workingDays: [1, 2, 3, 4, 5] };
/** The same week, working 09:00-17:00 (milliseconds from UTC midnight). */
export const NINE_TO_FIVE: WorkingCalendar = {
  workingDays: [1, 2, 3, 4, 5],
  workingHours: [[9 * 3_600_000, 17 * 3_600_000]],
};

/* --- SnapDeps -------------------------------------------------------------- */

/**
 * Builds `SnapDeps` from overrides. Every unset member answers the pipeline's "nothing extra
 * composed" case: no scale rows, no pixel density, no tasks, no working-time provider, no push
 * guards, faults swallowed silently (tests that care about faults pass their own `onFault`).
 */
export function depsOf(over: Partial<SnapDeps> = {}): SnapDeps {
  const tasks = over.tasks ?? ((): readonly Task[] => []);
  return {
    scaleUnit: over.scaleUnit ?? ((): undefined => undefined),
    pxPerMs: over.pxPerMs ?? ((): number => 0),
    tasks,
    view: over.view ?? ((): ReadonlyDataView => view(tasks() as Task[], [])),
    workingTime: over.workingTime ?? ((): undefined => undefined),
    pushGuards: over.pushGuards ?? ((): readonly [] => []),
    onFault: over.onFault ?? ((): void => {}),
  };
}

/** Builds the snap module from a `SnapConfig` nest (resolved exactly as the plugin resolves it). */
export function moduleOf(config: SnapConfig | undefined, over: Partial<SnapDeps> = {}): SnapModule {
  // Under `exactOptionalPropertyTypes`, an optional property must be either present-and-usable or
  // absent — never present-and-`undefined` — so the nest is only added when there is one.
  const raw: InteractionConfig = config === undefined ? {} : { snap: config };
  return createSnapModule(resolveConfig(raw).snap, depsOf(over));
}

/** A `snap/workingTime` provider that counts how many times `boundaries()` was consulted. */
export function countingProvider(
  answer: (calendar: string | number | undefined) => WorkingBoundaries | undefined,
): WorkingTimeProvider & { calls: number } {
  let calls = 0;
  return {
    boundaries: (calendar) => {
      calls += 1;
      return answer(calendar);
    },
    get calls(): number {
      return calls;
    },
  };
}

/** A recording fault sink: every reported error, in order. */
export function faultSink(): { onFault: (error: unknown) => void; faults: unknown[] } {
  const faults: unknown[] = [];
  return { onFault: (error): number => faults.push(error), faults };
}
