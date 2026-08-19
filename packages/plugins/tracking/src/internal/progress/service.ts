// docs/specs/plugins/tracking.md §1.2 — assembles the final `ProgressService`: the setters
// (`values.ts`), the report/batch API (`report.ts`), the session-state store (line-visible toggle
// + snapshot series), the snapshot recorder, and the two on-demand panels (`bulk-panel.ts`,
// `trend-panel.ts`). Built UNCONDITIONALLY — this runs whether or not the `progress` nest is
// present (§5.2's presence semantics: the service stays provided over empty/default state; only
// the visuals `wire.ts` registers around it are nest-gated).
//
// The setup-time closures (panels, snapshot store, batching) live here per §7's file table.
import { createStore } from "@stargantt/core";
import type { PluginContext, Store, WritableStore } from "@stargantt/core";
import type { TransactionBatch } from "@stargantt/sdk";
import type { DataService, Patch, Task, TaskId } from "@stargantt/plugin-data-store";
import type { ViewService } from "@stargantt/plugin-view";
import type {
  ProgressPatch,
  ProgressService,
  ProgressSnapshot,
  ProgressState,
} from "../../types";
import type { TrackingMessages } from "../messages";
import { recordOrReplaceByDay } from "../shared/snapshot-series";
import { startOfUtcDay } from "../shared/status-date";
import { clamp, finiteNonNegative, isFiniteNumber } from "../shared/numbers";
import { createReportApi, reportTasks } from "./report";
import type { ProgressWeighting } from "./report";
import { bulkEditPiece, isRag, progressFieldsPiece, progressValuesOf, remainingDurationPiece } from "./values";
import type { GetTask, UpdatePiece } from "./values";
import { createBulkPanel } from "./bulk-panel";
import type { BulkEdit, BulkPanel, BulkRow } from "./bulk-panel";
import { createTrendPanel } from "./trend-panel";
import type { TrendPanel } from "./trend-panel";

/** What `createProgressService` needs. */
export interface ServiceDeps {
  ctx: PluginContext;
  data: DataService;
  messages: TrackingMessages;
  /** The effective status date (§2.14/§5.2's resolution chain — configured value else the
   *  current UTC day, tracked live). */
  statusDate(): number;
  progressWeighting: ProgressWeighting;
  /** §5.2's default when the `progress` nest is dormant: `false`. */
  initialLineVisible: boolean;
  /** The normalized config seed (§5.2's `snapshots` field, already run through
   *  `normalizeSeededSeries` by `wire.ts`). */
  initialSnapshots: readonly ProgressSnapshot[];
  /** The shared batcher, created once at wiring time (§2.5's origin `stargantt.tracking/progress-bulk`). */
  batch: TransactionBatch<Patch>;
}

/** The assembled service, plus the bits `wire.ts` needs to build the order-65 layer around it. */
export interface ProgressServiceBundle {
  service: ProgressService;
  /** The session state store (also `service.state`, exposed separately so `wire.ts`'s layer draw
   *  reads the live toggle without going through the public surface). */
  state: Store<ProgressState>;
}

/** Builds the `ProgressService` object (§1.2), unconditionally — see the module doc. */
export function createProgressService(deps: ServiceDeps): ProgressServiceBundle {
  const { ctx, data, messages } = deps;
  const getTask: GetTask = (id) => data.getTask(id);

  const state: WritableStore<ProgressState> = createStore<ProgressState>({
    progressLineVisible: deps.initialLineVisible,
    snapshots: deps.initialSnapshots,
  });

  /* --- single-task writes (§2.5) ----------------------------------------------------------- */

  function dispatchPiece(piece: UpdatePiece): void {
    ctx.dispatch(
      "task/update",
      piece.clears !== undefined
        ? { id: piece.id, after: piece.after, clears: piece.clears }
        : { id: piece.id, after: piece.after },
    );
  }

  function setProgressFields(id: TaskId, patch: Readonly<ProgressPatch>): void {
    const piece = progressFieldsPiece(getTask, id, patch);
    if (piece !== undefined) dispatchPiece(piece);
  }

  /* --- the report + batch API (§2.5/§2.6) --------------------------------------------------- */

  const reportApi = createReportApi({
    data,
    messages,
    statusDate: deps.statusDate,
    progressWeighting: deps.progressWeighting,
    batch: deps.batch,
    dispatchTaskUpdate: (payload) => ctx.dispatch("task/update", payload),
  });

  function applyBulkEdits(edits: readonly BulkEdit[]): void {
    const pieces: UpdatePiece[] = [];
    for (const edit of edits) {
      const piece = bulkEditPiece(getTask, edit);
      if (piece !== undefined) pieces.push(piece);
    }
    const [head, ...rest] = pieces;
    if (head === undefined) return;
    deps.batch(
      (origin) =>
        ctx.dispatch(
          "task/update",
          head.clears !== undefined
            ? { id: head.id, after: head.after, clears: head.clears, origin }
            : { id: head.id, after: head.after, origin },
        ),
      rest.map((p) => ({
        op: "task/update",
        id: p.id,
        before: p.before,
        after: p.after,
        ...(p.clears !== undefined ? { clears: p.clears } : {}),
      })) as readonly Patch[],
    );
  }

  /* --- snapshots (§2.6) --------------------------------------------------------------------- */

  function recordSnapshot(date?: number): ProgressSnapshot {
    const report = reportApi.statusReport(date);
    const point: ProgressSnapshot = {
      date: startOfUtcDay(report.statusDate),
      percentComplete: report.percentComplete,
      completedCount: report.completedCount,
      lateCount: report.lateTasks.length,
      taskCount: report.taskCount,
    };
    const next = recordOrReplaceByDay(state.get().snapshots, point, (s) => s.date);
    state.set({ ...state.get(), snapshots: next });
    return point;
  }

  /* --- the progress-line runtime toggle (§2.7) ---------------------------------------------- */

  function setProgressLineVisible(visible: boolean): void {
    // Unusable (non-boolean) values are silently ignored.
    if (visible !== true && visible !== false) return;
    if (visible === state.get().progressLineVisible) return;
    state.set({ ...state.get(), progressLineVisible: visible });
    const view: ViewService | undefined = ctx.useOptional("stargantt.view");
    view?.invalidate("main");
  }

  /* --- the two on-demand panels (§2.5/§2.6/§2.16) ------------------------------------------- */

  let bulkPanel: BulkPanel | undefined;
  let trendPanel: TrendPanel | undefined;
  // Owned once at setup: disposal removes whichever panel is current.
  ctx.own({ dispose: () => closePanels() });

  function closeBulk(): void {
    bulkPanel?.dispose();
    bulkPanel = undefined;
  }
  function closeTrend(): void {
    trendPanel?.dispose();
    trendPanel = undefined;
  }
  function closePanels(): void {
    closeBulk();
    closeTrend();
  }

  function panelHost(): HTMLElement | undefined {
    // §2.16 — every `open…Panel()` returns `false` and mounts nothing while `stargantt.view` does
    // not resolve; hosted on the gantt root (`ctx.root`) so it opens centred over the whole widget
    // and drags across the tree grid too, not just the chart pane.
    const view: ViewService | undefined = ctx.useOptional("stargantt.view");
    return view === undefined ? undefined : ctx.root;
  }

  function themeGetter(): ((token: string) => string) | undefined {
    const theme = ctx.useOptional("stargantt.theme");
    return theme === undefined ? undefined : (token: string) => theme.get(token);
  }

  function openBulkUpdatePanel(): boolean {
    const host = panelHost();
    if (host === undefined) return false;
    closePanels();
    // Every task, parents included (§2.5: the panel edits, it does not aggregate).
    const rows: BulkRow[] = reportTasks(data, false).map((t) => {
      const task: Readonly<Task> | undefined = data.getTask(t.id);
      const values = progressValuesOf(task);
      return {
        id: t.id,
        name: t.name,
        progressPct: task?.progress === undefined ? undefined : Math.round(clamp(task.progress, 0, 1) * 100),
        remainingWork: values.remainingWork,
      };
    });
    bulkPanel = createBulkPanel(host, rows, messages, { apply: applyBulkEdits, close: closeBulk });
    bulkPanel.focus();
    return true;
  }

  function openTrendPanel(): boolean {
    const host = panelHost();
    if (host === undefined) return false;
    closePanels();
    trendPanel = createTrendPanel(host, state.get().snapshots, messages, {
      close: closeTrend,
      themeGet: themeGetter(),
    });
    trendPanel.focus();
    return true;
  }

  /* --- assembly ------------------------------------------------------------------------------ */

  const service: ProgressService = {
    state,
    progressOf: (id) => progressValuesOf(data.getTask(id)),
    setProgressFields,
    setProgressFieldsBatch: reportApi.setProgressFieldsBatch,
    ragOf: (id) => progressValuesOf(data.getTask(id)).rag,
    setRag(id, rag) {
      if (rag !== undefined && !isRag(rag)) return;
      setProgressFields(id, { rag });
    },
    setRemainingWork(id, ms) {
      if (finiteNonNegative(ms) === undefined) return;
      // Recomputes `task.progress` whenever a positive `totalWork` is known — the single shared
      // path for the remaining-work input (§2.5). `ms` is resource-milliseconds; the ratio
      // recompute is unit-blind.
      setProgressFields(id, { remainingWork: ms });
    },
    setPhysicalPercent(id, percent) {
      if (!isFiniteNumber(percent)) return;
      setProgressFields(id, { physicalPercent: clamp(percent, 0, 100) });
    },
    setRemainingDuration(id, ms) {
      const task = getTask(id);
      if (task === undefined || finiteNonNegative(ms) === undefined) return;
      const piece = remainingDurationPiece(task, ms, deps.statusDate());
      ctx.dispatch("task/update", { id: piece.id, after: piece.after });
    },
    statusDate: deps.statusDate,
    statusReport: reportApi.statusReport,
    statusReportText: reportApi.statusReportText,
    setProgressLineVisible,
    recordSnapshot,
    openBulkUpdatePanel,
    closeBulkUpdatePanel: closeBulk,
    openTrendPanel,
    closeTrendPanel: closeTrend,
  };

  return { service, state };
}
