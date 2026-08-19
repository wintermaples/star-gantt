// docs/specs/plugins/tracking.md §1.1's "Critical-path engine resolution" paragraph (normative):
// this plugin declares NO edge to `stargantt.critical-path`. Both the current schedule's critical
// path and a baseline-vs-current delta run through `sdk/cpm`'s `criticalTaskIds` directly, with
// `{ toleranceMs: 1 }`, so the two sides always classify through the same engine.
//
// The current path is invalidated on every `data.tasks` change; a baseline's path is computed at
// most once per baseline OBJECT
// (identity-keyed via `WeakMap`, not by id) — a re-defined or reminted baseline (even one reusing
// an id) gets a fresh object and therefore a fresh computation, so it can never inherit a stale path.
import { criticalTaskIds } from "@stargantt/sdk";
import type { DataService, TaskId } from "@stargantt/plugin-data-store";
import type { PluginContext } from "@stargantt/core";
import type { Baseline, BaselineId, CriticalPathDelta } from "../../types";

/** Classifies each critical id as added, removed or retained between a baseline and now. */
export function criticalPathDelta(
  baselineCritical: readonly TaskId[],
  currentCritical: readonly TaskId[],
): CriticalPathDelta {
  const before = new Set(baselineCritical);
  const now = new Set(currentCritical);
  const added: TaskId[] = [];
  const retained: TaskId[] = [];
  for (const id of currentCritical) (before.has(id) ? retained : added).push(id);
  const removed = baselineCritical.filter((id) => !now.has(id));
  return { added, removed, retained };
}

export interface CpmDeps {
  data: Pick<DataService, "query" | "links" | "tasks">;
  ctx: Pick<PluginContext, "own">;
  resolveBaseline(baselineId?: BaselineId): Readonly<Baseline> | undefined;
}

export interface CpmApi {
  criticalPath(): readonly TaskId[];
  criticalPathDelta(baselineId?: BaselineId): CriticalPathDelta | undefined;
}

/** Assembles the memoized §1.1 critical-path members. */
export function createCpmApi(deps: CpmDeps): CpmApi {
  let currentCritical: readonly TaskId[] | undefined;
  const baselineCritical = new WeakMap<Readonly<Baseline>, readonly TaskId[]>();

  deps.ctx.own(
    deps.data.tasks.subscribe(() => {
      currentCritical = undefined;
    }),
  );

  function criticalNow(): readonly TaskId[] {
    if (currentCritical === undefined) {
      const view = deps.data.query();
      const links = [...deps.data.links.get().values()];
      // Explicit 1 ms tolerance, the exact-to-the-millisecond rule this area pins.
      currentCritical = criticalTaskIds(view.byId.values(), links, { toleranceMs: 1 });
    }
    return currentCritical;
  }

  function criticalOf(baseline: Readonly<Baseline>): readonly TaskId[] {
    let path = baselineCritical.get(baseline);
    if (path === undefined) {
      path = criticalTaskIds(baseline.tasks.values(), baseline.links, { toleranceMs: 1 });
      baselineCritical.set(baseline, path);
    }
    return path;
  }

  return {
    criticalPath: criticalNow,
    criticalPathDelta(baselineId) {
      const baseline = deps.resolveBaseline(baselineId);
      if (baseline === undefined) return undefined;
      return criticalPathDelta(criticalOf(baseline), criticalNow());
    },
  };
}
