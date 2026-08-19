// docs/specs/plugins/export.md §1.7, §9 (`internal/msproject/`).
/**
 * The MS Project MSPDI area's slice of the facade.
 *
 * `applyMsProjectXml` dispatches one ordinary, undoable transaction per command (§1.7's
 * per-command grain — unlike `internal/formats/`'s single-entry batch). Every planned command
 * either lands or none do: `planApply` only ever proposes a change that (absent read-only) the
 * store's own runner will accept unchanged, since the plan is computed from the same pre-apply
 * store state the dispatch itself reads synchronously — so the read-only veto (§2.1) is checked
 * once, up front, against the shared guard, rather than per dispatch.
 */
import type { Task, TaskId } from "@stargantt/plugin-data-store";
import { guardFor } from "../embed/guard";
import { DISPOSED_MESSAGE } from "../wiring";
import type { ExportWiring } from "../wiring";
import type {
  BaselineInit,
  ExportService,
  MsProjectApplyResult,
  MsProjectDocument,
  MsProjectExportOptions,
  MsProjectImportOptions,
  MsProjectImportResult,
} from "../../types";
import { planApply } from "./apply";
import { parseMsProjectXml } from "./parse";
import { serializeMsProjectXml } from "./serialize";
import type { SerializableBaseline } from "./serialize";

/** The members `internal/msproject/` owns. */
export type MsProjectSurface = Pick<ExportService, "toMsProjectXml" | "applyMsProjectXml">;

/**
 * The structural shape this area needs of a composed `stargantt.baselines` service.
 *
 * **STAYS structural — a typed swap was attempted and reverted.** The straightforward swap
 * (`import type { BaselinesService } from "@stargantt/plugin-tracking"` + a real
 * `@stargantt/plugin-export` devDependency on `@stargantt/plugin-tracking`) type-checks fine in
 * isolation, but it closes a THREE-package devDependency cycle that already exists:
 * `@stargantt/plugin-tracking` devDependency on `@stargantt/plugin-resource` (the
 * `stargantt.resource-pool` cost-rate-fallback swap) + `@stargantt/plugin-resource` devDependency
 * on `@stargantt/plugin-export` (the `export/auxiliarySurfaces` contribution type,
 * `internal/load-chart/{band-view,wire}.ts`) + this file's would-be edge back to tracking =
 * export → tracking → resource → export. Verified empirically (not merely reasoned): `pnpm run
 * build` fails deterministically on this cycle, every attempt, including after a
 * manually-sequenced bootstrap build — `vite build`'s `emptyOutDir` clears each package's `dist/`
 * on every invocation, so `pnpm -r --workspace-concurrency=-1 run build`'s inability to find ANY
 * valid topological order for three mutually-cyclic packages makes it schedule all three
 * concurrently EVERY run, and each one's `tsc -p tsconfig.build.json` then races the other two's
 * dist rebuild. `tsc --build`'s own project-reference mechanism refuses circular project graphs
 * outright for the identical reason. Resolving this needs a decision on which of the three edges
 * gives up its typed form (this one is the newest and least entrenched — the other two are
 * already-shipped, reviewed work), or a build-script change that sequences these three specially;
 * out of scope for a mechanical shim-repair pass.
 *
 * **The functional bug this pass DOES fix**, independent of the typed-vs-structural question: the
 * shim previously called a `list()` member that the real, later-published `BaselinesService` never
 * had (the id list lives in `state.get().baselines` — tracking.md §1.1) — every real
 * export+tracking composition threw inside `exportBaselines`'s try/catch and silently exported
 * zero baselines, every time. That member-shape mismatch is fixed below (structurally — the
 * shape now matches the real service exactly, verified against `packages/plugins/tracking/src/
 * types.ts`'s `BaselinesService`/`BaselinesState`), independent of whether the lookup itself is
 * ever converted to a typed one.
 */
interface BaselinesServiceShim {
  state: { get(): { baselines: readonly { id: string }[] } };
  get(id: string): { tasks: ReadonlyMap<TaskId, { start: number; end: number }> } | undefined;
}

function isBaselinesShim(value: unknown): value is BaselinesServiceShim {
  if (value === null || typeof value !== "object") return false;
  const state = (value as { state?: unknown }).state;
  return (
    state !== null &&
    typeof state === "object" &&
    typeof (state as { get?: unknown }).get === "function" &&
    typeof (value as { get?: unknown }).get === "function"
  );
}

/**
 * The one `ctx.useOptional("stargantt.baselines")` call this area makes — a VISIBLE, literal
 * member-expression call (never aliased, bound or cast on the `ctx.useOptional` expression itself),
 * so `tools/lint-deps.mjs`'s static scanner sees it exactly like any other service lookup. Same-
 * layer/downward `useOptional` is the documented escape hatch either way, so this call is legal
 * and lint-clean as written; hiding it behind an aliased/bound reference bought no lint relief and
 * is exactly what the scanner exists to catch.
 *
 * The cast lives on the ARGUMENT type (`ctx: { useOptional(key: string): unknown }`), not on the
 * `ctx.useOptional` member expression, because `"stargantt.baselines"` is not a declared key of
 * `keyof Services` in THIS package's program — see `BaselinesServiceShim`'s doc above for why the
 * typed form is deliberately not used here (a real devDependency edge closes a 3-package cycle).
 */
function lookupBaselinesService(ctx: { useOptional(key: string): unknown }): unknown {
  return ctx.useOptional("stargantt.baselines");
}

const ZERO_APPLY: MsProjectApplyResult = {
  tasksAdded: 0,
  tasksUpdated: 0,
  linksAdded: 0,
  resourcesAdded: 0,
  assignmentsSet: 0,
};

// Review m1 — mirrors the disposed-instance guard `../../index.ts`'s image path (`begin()`)
// already enforces; `ExportWiring.disposed()` had no caller in this area before this fix.
// Review m6 — `DISPOSED_MESSAGE` is `../wiring`'s, not a hand-copied literal.
function assertNotDisposed(w: ExportWiring): void {
  if (w.disposed()) throw new Error(DISPOSED_MESSAGE);
}

export function wireMsProject(w: ExportWiring): MsProjectSurface {
  const guard = guardFor(w);

  /** `document.baselines` reshaped into tracking `baselines` config entries (§1.7, a pure reshape). */
  function toBaselineInits(doc: MsProjectDocument): readonly BaselineInit[] {
    return doc.baselines.map((group) => ({
      id: `msp-baseline-${group.number}`,
      name: group.name,
      tasks: group.tasks.map((snapshot) => {
        const entry: { id: TaskId; start: number; end: number; type?: Task["type"] } = {
          id: snapshot.id,
          start: snapshot.start,
          end: snapshot.end,
        };
        if (snapshot.type !== undefined) entry.type = snapshot.type;
        return entry;
      }),
    }));
  }

  /** Every saved baseline of a composed `stargantt.baselines`, in registration order (the real
   *  service's `state.get().baselines`, tracking.md §1.1). Soft dependency. */
  function exportBaselines(include: boolean): SerializableBaseline[] {
    if (!include) return [];
    const service = lookupBaselinesService(w.ctx);
    if (!isBaselinesShim(service)) return [];
    try {
      const out: SerializableBaseline[] = [];
      for (const info of service.state.get().baselines) {
        const baseline = service.get(info.id);
        if (baseline !== undefined) out.push({ tasks: baseline.tasks });
      }
      return out;
    } catch (error) {
      w.reportError("stargantt.baselines", error);
      return [];
    }
  }

  function applyMsProjectXml(text: string, options?: MsProjectImportOptions): MsProjectImportResult {
    assertNotDisposed(w);
    const document = parseMsProjectXml(text);
    const baselineInits = toBaselineInits(document);
    if (options?.dryRun === true) return { document, baselineInits };

    // §2.1's read-only interplay: every planned command carries a non-exempt origin, so with
    // read-only active the shared guard would veto each dispatch anyway — checked once here
    // instead of per command, since the outcome is the same either way (see the module doc).
    if (guard.isReadOnly()) return { document, baselineInits, applied: ZERO_APPLY };

    const plan = planApply(document, w.data.query());
    for (const task of plan.taskAdds) {
      w.ctx.dispatch("task/add", { task, origin: "msproject" });
    }
    for (const update of plan.taskUpdates) {
      w.ctx.dispatch("task/update", { id: update.id, after: update.after, origin: "msproject" });
    }
    for (const resource of plan.resourceAdds) {
      w.ctx.dispatch("resource/add", { resource, origin: "msproject" });
    }
    for (const link of plan.linkAdds) {
      w.ctx.dispatch("link/add", {
        sourceId: link.sourceId,
        targetId: link.targetId,
        type: link.type,
        id: link.id,
        origin: "msproject",
        ...(typeof link.lag === "number" && Number.isFinite(link.lag) ? { lag: link.lag } : {}),
      });
    }
    for (const assignment of plan.assignmentSets) {
      w.ctx.dispatch("assignment/set", {
        taskId: assignment.taskId,
        resourceId: assignment.resourceId,
        units: assignment.units,
        origin: "msproject",
      });
    }
    const applied: MsProjectApplyResult = {
      tasksAdded: plan.taskAdds.length,
      tasksUpdated: plan.taskUpdates.length,
      linksAdded: plan.linkAdds.length,
      resourcesAdded: plan.resourceAdds.length,
      assignmentsSet: plan.assignmentSets.length,
    };
    const total =
      applied.tasksAdded +
      applied.tasksUpdated +
      applied.linksAdded +
      applied.resourcesAdded +
      applied.assignmentsSet;
    if (total > 0) w.ctx.emit("msprojectio/applied", { result: applied });
    return { document, baselineInits, applied };
  }

  return {
    toMsProjectXml(options?: MsProjectExportOptions): string {
      assertNotDisposed(w);
      const usable = options !== null && typeof options === "object" ? options : {};
      const baselines = exportBaselines(usable.baselines !== false);
      return serializeMsProjectXml(
        w.data.query(),
        baselines,
        typeof usable.projectName === "string" ? usable.projectName : undefined,
      );
    },
    applyMsProjectXml,
  };
}
