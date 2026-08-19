// docs/specs/plugins/tracking.md §2.6 — the leaf-only status report, its lateness rule, and the
// batched multi-task write path (`setProgressFieldsBatch`, §2.5). The report builder itself is
// pure and hostless (`buildStatusReport`); `reportTasks` and `createReportApi` are the two seams
// that touch the data store and `PluginContext` respectively.
//
// The pure builder is built on `internal/shared/numbers.ts`'s `clamp`; the batching half is rehomed
// here per §7's file table and re-based on the shared `sdk/aggregate` `createTransactionBatcher`.
import type { TransactionBatch } from "@stargantt/sdk";
import type { DataService, Patch, Task, TaskId } from "@stargantt/plugin-data-store";
import type {
  LateTaskEntry,
  ProgressFieldsBatchEntry,
  ProgressService,
  RagStatus,
  StatusReport,
} from "../../types";
import type { TrackingMessages } from "../messages";
import { readBag } from "../shared/meta-bag";
import { clamp } from "../shared/numbers";
import { mergeBatchEntries, pieceToPatch, progressFieldsPiece, progressValuesOf } from "./values";
import type { GetTask, UpdatePiece } from "./values";

/** What the pure report builder needs to know about one task. */
export interface ReportTask {
  /** The store's task id, passed through verbatim so consumers can resolve it back. */
  id: TaskId;
  name: string;
  start: number;
  end: number;
  /** The store's progress fraction, 0–1; absent counts as 0. */
  progress?: number | undefined;
  /** Whether `task.meta.taskFields.status` reads `"done"` (§2.6's defensive cross-plugin read). */
  done: boolean;
  rag?: RagStatus | undefined;
}

/** The instant a task's progress has reached: `start + clamp(progress) × (end − start)`. */
export function progressPointOf(start: number, end: number, progress: number | undefined): number {
  const span = Math.max(0, end - start);
  return start + clamp(progress ?? 0, 0, 1) * span;
}

/** How the report's `percentComplete` mean weights each leaf (§2.6). */
export type ProgressWeighting = "count" | "duration";

/**
 * Builds the status report at `statusDate`. A task is completed when marked done or its progress
 * reached 1; not started when untouched and not yet due to have started; late when its progress
 * point trails a status date its span has already entered.
 *
 * `weighting` shapes only `percentComplete`: `"count"` (the default) is the unweighted mean over
 * the tasks; `"duration"` weights each task by its duration (`max(0, end − start)`), so milestones
 * weigh 0 — unless every task weighs 0, in which case the count mean answers.
 */
export function buildStatusReport(
  tasks: readonly ReportTask[],
  statusDate: number,
  weighting: ProgressWeighting = "count",
): StatusReport {
  let completed = 0;
  let inProgress = 0;
  let notStarted = 0;
  let progressSum = 0;
  let weightedSum = 0;
  let weightSum = 0;
  const ragCounts = { red: 0, amber: 0, green: 0, none: 0 };
  const lateTasks: LateTaskEntry[] = [];

  for (const t of tasks) {
    const progress = clamp(t.progress ?? 0, 0, 1);
    progressSum += progress;
    const weight = Math.max(0, t.end - t.start);
    weightedSum += weight * progress;
    weightSum += weight;
    if (t.rag === undefined) ragCounts.none += 1;
    else ragCounts[t.rag] += 1;

    const isCompleted = t.done || progress >= 1;
    if (isCompleted) {
      completed += 1;
    } else if (progress > 0) {
      // Ambiguity, pinned: recorded progress wins over "not started per schedule".
      inProgress += 1;
    } else if (t.start >= statusDate) {
      notStarted += 1;
    } else {
      // Untouched but already due to have started: in progress (and typically also late).
      inProgress += 1;
    }
    if (!isCompleted && t.start < statusDate) {
      const point = progressPointOf(t.start, t.end, progress);
      if (point < statusDate) {
        lateTasks.push({ id: t.id, name: t.name, lateMs: statusDate - point });
      }
    }
  }

  const taskCount = tasks.length;
  return {
    statusDate,
    taskCount,
    completedCount: completed,
    inProgressCount: inProgress,
    notStartedCount: notStarted,
    lateTasks,
    percentComplete:
      taskCount === 0
        ? 0
        : weighting === "duration" && weightSum > 0
          ? (weightedSum / weightSum) * 100
          : (progressSum / taskCount) * 100,
    ragCounts,
  };
}

/**
 * Builds the `ReportTask` list from the data store, in store order (`view.byId` iteration order).
 *
 * `leafOnly` drives §2.6's leaf-only rule: with it, a task another task names as `parentId` (any
 * entry in `view.children`) is excluded — the status report and the trend snapshots derived from
 * it; without it, every task is kept — the bulk-update panel's own contract (an editing surface,
 * not an aggregate).
 */
export function reportTasks(data: DataService, leafOnly: boolean): ReportTask[] {
  const view = data.query();
  const out: ReportTask[] = [];
  for (const task of view.byId.values()) {
    if (leafOnly && (view.children.get(task.id)?.length ?? 0) > 0) continue;
    // §2.6 resolution — a defensive read of tree-grid's own bag; a non-object bag (or an absent
    // `status`) simply answers `false` here, never an error.
    const status = readBag(task, "taskFields")["status"];
    const entry: ReportTask = {
      id: task.id,
      name: task.name,
      start: task.start,
      end: task.end,
      progress: task.progress,
      done: status === "done",
    };
    const rag = progressValuesOf(task).rag;
    if (rag !== undefined) entry.rag = rag;
    out.push(entry);
  }
  return out;
}

/** The one `PluginContext` capability this module needs: dispatching the batch head as an
 *  ordinary, validated `task/update` command (so it computes its own `before` and lands one undo
 *  entry) stamped with the batcher's per-call `origin`. */
export type DispatchTaskUpdate = (payload: {
  id: TaskId;
  after: Partial<Task>;
  clears?: readonly (keyof Task)[];
  origin: string;
}) => void;

/** What `createReportApi` needs. */
export interface ReportApiDeps {
  data: DataService;
  messages: TrackingMessages;
  /** The effective status date (the resolved chain, §2.14/§5.2). */
  statusDate(): number;
  progressWeighting: ProgressWeighting;
  /** The shared batcher, created once at wiring time (§2.5's origin `stargantt.tracking/progress-bulk`). */
  batch: TransactionBatch<Patch>;
  dispatchTaskUpdate: DispatchTaskUpdate;
}

/** Builds `statusReport` / `statusReportText` / `setProgressFieldsBatch` over `deps`. */
export function createReportApi(
  deps: ReportApiDeps,
): Pick<ProgressService, "statusReport" | "statusReportText" | "setProgressFieldsBatch"> {
  const m = deps.messages;
  const getTask: GetTask = (id) => deps.data.getTask(id);

  function statusReport(statusDate?: number): StatusReport {
    const at = typeof statusDate === "number" && Number.isFinite(statusDate) ? statusDate : deps.statusDate();
    return buildStatusReport(reportTasks(deps.data, true), at, deps.progressWeighting);
  }

  function statusReportText(statusDate?: number): string {
    const report = statusReport(statusDate);
    const lines = [m.reportTitle(report.statusDate), m.reportSummary(report)];
    if (report.lateTasks.length > 0) {
      lines.push(m.reportLateHeading(report.lateTasks.length));
      for (const entry of report.lateTasks) lines.push(m.reportLateLine(entry));
    }
    return lines.join("\n");
  }

  function setProgressFieldsBatch(entries: readonly ProgressFieldsBatchEntry[]): void {
    if (!Array.isArray(entries)) return;
    const pieces: UpdatePiece[] = [];
    for (const [id, patch] of mergeBatchEntries(entries)) {
      const piece = progressFieldsPiece(getTask, id, patch);
      if (piece !== undefined) pieces.push(piece);
    }
    const [head, ...rest] = pieces;
    if (head === undefined) return;
    deps.batch(
      (origin) =>
        deps.dispatchTaskUpdate(
          head.clears !== undefined
            ? { id: head.id, after: head.after, clears: head.clears, origin }
            : { id: head.id, after: head.after, origin },
        ),
      rest.map(pieceToPatch),
    );
  }

  return { statusReport, statusReportText, setProgressFieldsBatch };
}
