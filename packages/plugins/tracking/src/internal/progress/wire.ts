// docs/specs/plugins/tracking.md §1.2/§2.5-§2.7/§3.2 — entry point of the progress area.
//
// The `ProgressService` is built UNCONDITIONALLY (§5.2's presence semantics: a dormant `progress`
// nest still provides a functional service over empty/default session state — the calendars-service
// precedent). Only the visuals below the `if (progressConfig === undefined) return service;` line
// are nest-gated, with ONE exception: the order-65 progress-line layer contribution is registered
// unconditionally too (`renderer/layers` has no withdrawal path once claimed), its `draw` itself
// checking the live `state.progressLineVisible` toggle and bailing out while hidden or while
// `view`/`task-bars`/`timeline` do not resolve (§2.7).
//
// The setup-time wiring half (soft-dependency resolution, the order-65 `renderer/layers` claim,
// the `taskbars/style` and `taskbars/overlays` contributions) — the service-assembly half lives in
// `service.ts` per §7's file table.
import { createTransactionBatcher } from "@stargantt/sdk";
import type { Patch, TaskId } from "@stargantt/plugin-data-store";
import type { LayerContribution, ThemeService, TimelineService } from "@stargantt/plugin-view";
import type { TaskBarsService } from "@stargantt/plugin-task-bars";
import type { ResolvedProgressConfig } from "../../config";
import type { ProgressService, ProgressSnapshot } from "../../types";
import type { TrackingAreaDeps } from "../areas";
import { PROGRESS_LINE_LAYER_ID, PROGRESS_LINE_LAYER_ORDER } from "../shared/layer-ids";
import { clamp, isFiniteNumber } from "../shared/numbers";
import { normalizeSeededSeries } from "../shared/snapshot-series";
import { statusDateResolver } from "../shared/status-date";
import { createProgressLineDraw } from "./line";
import { makeRagBadgeRenderer, makeRagStyleProvider } from "./rag";
import { createProgressService } from "./service";
import { progressValuesOf } from "./values";

/** §5.2 defaults, applied "as if `progress: {}` had been passed" while the nest is dormant — the
 *  service is built over these unconditionally; only the block below the dormant check reads the
 *  REAL (possibly `undefined`) `progressConfig` for its nest-gating decision. */
const DORMANT_DEFAULTS: ResolvedProgressConfig = {
  statusDate: undefined,
  progressLine: false,
  colorBars: false,
  progressWeighting: "count",
  showRagOnBars: true,
  snapshots: [],
};

function isFiniteDateSeed(item: ProgressSnapshot): boolean {
  return isFiniteNumber((item as unknown as Record<string, unknown>)["date"]);
}

/** Coerces one raw seed entry into a well-shaped `ProgressSnapshot` on the given (already
 *  day-normalized) date, applying the field-by-field normalization rules. */
function coerceSnapshotSeed(item: ProgressSnapshot, day: number): ProgressSnapshot {
  const r = item as unknown as Record<string, unknown>;
  const count = (v: unknown): number => (isFiniteNumber(v) && v >= 0 ? Math.floor(v) : 0);
  return {
    date: day,
    percentComplete: isFiniteNumber(r["percentComplete"]) ? clamp(r["percentComplete"], 0, 100) : 0,
    completedCount: count(r["completedCount"]),
    lateCount: count(r["lateCount"]),
    taskCount: count(r["taskCount"]),
  };
}

/** Wires the progress area: builds the service unconditionally, registers the order-65 layer
 *  unconditionally, and (only with the `progress` nest present) the RAG bar decorations. */
export function wireProgress(deps: TrackingAreaDeps): ProgressService {
  const { ctx, config, messages, data, now } = deps;
  const progressConfig = config.progress;
  const effective = progressConfig ?? DORMANT_DEFAULTS;

  const statusDate = statusDateResolver(effective.statusDate, now);

  // §5.2 "unusable entries dropped, order normalized" — NO dedup-by-day for the config seed
  // (`normalizeSeededSeries`, not the dedupe variant; `recordSnapshot` alone replaces same-day).
  const initialSnapshots = normalizeSeededSeries<ProgressSnapshot>(
    effective.snapshots,
    (item) => (item as unknown as Record<string, unknown>)["date"],
    isFiniteDateSeed,
    coerceSnapshotSeed,
  );

  // §2.5 — the one shared batcher for `setProgressFieldsBatch` and the bulk panel's Apply.
  const batch = createTransactionBatcher<Patch>(ctx, "stargantt.tracking/progress-bulk");

  const { service, state } = createProgressService({
    ctx,
    data,
    messages,
    statusDate,
    progressWeighting: effective.progressWeighting,
    initialLineVisible: effective.progressLine === true,
    initialSnapshots,
    batch,
  });

  /* --- the order-65 progress line: ALWAYS registered (§2.7) ------------------------------- */

  // Soft dependencies, resolved lazily and cached once found (never re-looked-up per frame once
  // resolved — `optional` carries no ordering edge so a
  // composition activating these plugins after this one still gets served once it appears).
  let barsSvc: TaskBarsService | undefined;
  let timelineSvc: TimelineService | undefined;
  let themeSvc: ThemeService | undefined;
  const themeGet = (token: string): string => (themeSvc ??= ctx.useOptional("stargantt.theme"))?.get(token) ?? "";

  const draw = createProgressLineDraw({
    visible: () => state.get().progressLineVisible,
    statusDate,
    bars: () => (barsSvc ??= ctx.useOptional("stargantt.task-bars")),
    timeline: () => (timelineSvc ??= ctx.useOptional("stargantt.timeline")),
    taskOf: (id) => {
      const task = data.getTask(id as TaskId);
      return task === undefined ? undefined : { start: task.start, end: task.end, progress: task.progress };
    },
    themeGet: () => themeGet,
  });
  const layer: LayerContribution = { id: PROGRESS_LINE_LAYER_ID, zIndex: PROGRESS_LINE_LAYER_ORDER, draw };
  ctx.contribute("renderer/layers", layer);

  // §5.2 presence semantics — the nest gates only the visuals below.
  if (progressConfig === undefined) return service;

  /* --- RAG bar decorations (§3.2) ----------------------------------------------------------- */

  const ragOfTask = (task: Parameters<typeof progressValuesOf>[0]): ReturnType<typeof progressValuesOf>["rag"] =>
    progressValuesOf(task).rag;

  if (progressConfig.colorBars) {
    ctx.contribute("taskbars/style", makeRagStyleProvider({ ragOf: ragOfTask, themeGet }));
  }
  if (progressConfig.showRagOnBars) {
    ctx.contribute(
      "taskbars/overlays",
      makeRagBadgeRenderer({ ragOf: ragOfTask, themeGet, taskOf: (id) => data.getTask(id as TaskId) }),
    );
  }

  return service;
}
