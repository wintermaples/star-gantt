// docs/specs/plugins/portfolio.md §3.1–§3.3 — hostless aggregation math. Every function is pure
// over plain task/assignment/resource arrays so it is unit-testable without a host.
import { MS_DAY } from "@stargantt/sdk";
import type { Assignment, Resource, Task } from "@stargantt/plugin-data-store";
import type {
  BurndownPoint,
  BurndownSeries,
  GroupProgressEntry,
  MilestoneEntry,
  OverdueEntry,
  ProgressSummary,
  StatusCounts,
  WorkloadEntry,
} from "../../types";

/** A snapshot row as the tracking plugin's `ProgressService.state` records it (structural subset). */
export interface SnapshotLike {
  date: number;
  completedCount: number;
  taskCount: number;
}

const hasDates = (t: Task): boolean => Number.isFinite(t.start) && Number.isFinite(t.end);

/** Clamped progress, 0 when absent. */
export function progressOf(t: Task): number {
  const p = typeof t.progress === "number" && Number.isFinite(t.progress) ? t.progress : 0;
  return p < 0 ? 0 : p > 1 ? 1 : p;
}

/** Duration weight in ms, never below 1 (milestones count as 1). */
const weightOf = (t: Task): number => Math.max(1, t.end - t.start);

/**
 * The tasks the dashboard aggregates over: non-summary, non-milestone tasks with finite dates.
 * Summary rows would double-count their children; milestones are summarized separately (§3.2).
 */
export function leafTasks(tasks: readonly Task[]): Task[] {
  return tasks.filter((t) => t.type !== "summary" && t.type !== "milestone" && hasDates(t));
}

/** Duration-weighted mean progress over the given tasks, 0 for an empty set. */
export function weightedProgress(tasks: readonly Task[]): number {
  let sum = 0;
  let total = 0;
  for (const t of tasks) {
    const w = weightOf(t);
    sum += w * progressOf(t);
    total += w;
  }
  return total > 0 ? sum / total : 0;
}

/** The summary widget's KPIs (§3.1). */
export function computeSummary(tasks: readonly Task[], now: number): ProgressSummary {
  const leaves = leafTasks(tasks);
  let completed = 0;
  let overdue = 0;
  for (const t of leaves) {
    const p = progressOf(t);
    if (p >= 1) completed += 1;
    else if (t.end <= now) overdue += 1;
  }
  return {
    taskCount: leaves.length,
    completedCount: completed,
    remainingCount: leaves.length - completed,
    overdueCount: overdue,
    milestoneCount: tasks.filter((t) => t.type === "milestone" && hasDates(t)).length,
    progress: weightedProgress(leaves),
  };
}

/** The overdue-task list, most-overdue first (§3.1). */
export function computeOverdue(tasks: readonly Task[], now: number): OverdueEntry[] {
  const out: OverdueEntry[] = [];
  for (const t of leafTasks(tasks)) {
    const p = progressOf(t);
    if (p >= 1 || t.end > now) continue;
    out.push({
      id: t.id,
      name: t.name,
      end: t.end,
      daysOverdue: Math.max(1, Math.ceil((now - t.end) / MS_DAY)),
      progress: p,
    });
  }
  out.sort((a, b) => b.daysOverdue - a.daysOverdue || a.end - b.end);
  return out;
}

/** Task counts by state for the donut widget (§3.1). */
export function computeStatusCounts(tasks: readonly Task[]): StatusCounts {
  const counts: StatusCounts = { notStarted: 0, inProgress: 0, completed: 0 };
  for (const t of leafTasks(tasks)) {
    const p = progressOf(t);
    if (p >= 1) counts.completed += 1;
    else if (p > 0) counts.inProgress += 1;
    else counts.notStarted += 1;
  }
  return counts;
}

/** The milestone summary, in date order (§3.1). */
export function computeMilestones(tasks: readonly Task[], now: number): MilestoneEntry[] {
  const out: MilestoneEntry[] = [];
  for (const t of tasks) {
    if (t.type !== "milestone" || !hasDates(t)) continue;
    const reached = progressOf(t) >= 1;
    out.push({ id: t.id, name: t.name, date: t.start, reached, overdue: !reached && t.start <= now });
  }
  out.sort((a, b) => a.date - b.date);
  return out;
}

/** Per-resource assigned effort in person-days (§3.2). */
export function computeWorkload(
  tasks: readonly Task[],
  assignments: readonly Assignment[],
  resources: readonly Resource[],
): WorkloadEntry[] {
  const byId = new Map(tasks.map((t) => [t.id, t]));
  const names = new Map(resources.map((r) => [r.id, r.name]));
  const rows = new Map<Assignment["resourceId"], WorkloadEntry>();
  for (const a of assignments) {
    const task = byId.get(a.taskId);
    if (task === undefined || task.type === "summary" || !hasDates(task)) continue;
    const days = Math.max(0, (task.end - task.start) / MS_DAY) * a.units;
    const row = rows.get(a.resourceId) ?? {
      resourceId: a.resourceId,
      name: names.get(a.resourceId) ?? String(a.resourceId),
      personDays: 0,
      taskCount: 0,
    };
    row.personDays += days;
    row.taskCount += 1;
    rows.set(a.resourceId, row);
  }
  return [...rows.values()].sort((a, b) => b.personDays - a.personDays);
}

/**
 * Group comparison: tasks bucketed by a label, each bucket reporting its weighted progress.
 * `groupOf` must never throw (the caller wraps the host-supplied hook); returning a non-string
 * or empty label leaves the task out.
 */
export function computeGroupProgress(
  tasks: readonly Task[],
  groupOf: (task: Task) => string | undefined,
): GroupProgressEntry[] {
  const buckets = new Map<string, Task[]>();
  for (const t of leafTasks(tasks)) {
    const label = groupOf(t);
    if (typeof label !== "string" || label === "") continue;
    const list = buckets.get(label);
    if (list === undefined) buckets.set(label, [t]);
    else list.push(t);
  }
  const out: GroupProgressEntry[] = [];
  for (const [group, list] of buckets) {
    out.push({ group, progress: weightedProgress(list), taskCount: list.length });
  }
  out.sort((a, b) => a.group.localeCompare(b.group));
  return out;
}

/** The burndown model (§3.3). */
export function computeBurndown(
  tasks: readonly Task[],
  snapshots: readonly SnapshotLike[],
): BurndownSeries {
  const leaves = leafTasks(tasks);
  const planned: BurndownPoint[] = [];
  if (leaves.length > 0) {
    // A plain loop, not `Math.min(...spread)` — a burndown over a very large task set (up to
    // ~200k leaves) would otherwise spread that many call arguments and blow the call stack.
    let start = Infinity;
    for (const t of leaves) if (t.start < start) start = t.start;
    // Step down one task at each distinct end date, in date order.
    const ends = [...leaves.map((t) => t.end)].sort((a, b) => a - b);
    planned.push({ date: start, remaining: leaves.length });
    let remaining = leaves.length;
    for (let i = 0; i < ends.length; i += 1) {
      remaining -= 1;
      const date = ends[i] as number;
      if (i + 1 < ends.length && ends[i + 1] === date) continue; // collapse equal dates
      planned.push({ date, remaining });
    }
  }
  const actual: BurndownPoint[] = snapshots.map((s) => ({
    date: s.date,
    remaining: Math.max(0, s.taskCount - s.completedCount),
  }));
  return { taskCount: leaves.length, planned, actual };
}

/**
 * Schedule performance index over a task set as of `now`: earned value (weighted progress) over
 * planned value (weighted elapsed fraction). `undefined` when no planned value has accrued.
 */
export function computeSpi(tasks: readonly Task[], now: number): number | undefined {
  let ev = 0;
  let pv = 0;
  for (const t of leafTasks(tasks)) {
    const w = weightOf(t);
    const elapsed = (now - t.start) / w;
    pv += w * (elapsed < 0 ? 0 : elapsed > 1 ? 1 : elapsed);
    ev += w * progressOf(t);
  }
  return pv > 0 ? ev / pv : undefined;
}
