// docs/specs/plugins/portfolio.md §2.3, §2.4
/**
 * Schedule-health aggregation over a set of tasks: traffic-light status, late/at-risk counts and
 * duration-weighted mean progress. Pure and hostless. Also the goal-progress weighting §2.4
 * reuses (`weightedProgress`).
 */
import type { Task } from "@stargantt/plugin-data-store";
import type { PortfolioHealthStatus } from "../../types";

/** The kind-agnostic aggregate `computeHealth` produces (the caller stamps the node id on). */
export interface HealthAggregate {
  status: PortfolioHealthStatus;
  taskCount: number;
  lateCount: number;
  atRiskCount: number;
  progress: number;
}

function progressOf(task: Readonly<Task>): number {
  const p = task.progress;
  return typeof p === "number" && Number.isFinite(p) ? Math.min(1, Math.max(0, p)) : 0;
}

/**
 * Aggregates health over `tasks` as of `now` (epoch ms). Summary-typed tasks and tasks without
 * finite dates are skipped. A task is **late** when its end has passed and its progress is below
 * 1; **at-risk** when it is running (`start <= now < end`) and its progress trails the elapsed
 * fraction of its duration. Status is `"late"` if any task is late, else `"at-risk"` if any is
 * at risk, else `"on-track"`.
 */
export function computeHealth(tasks: Iterable<Readonly<Task>>, now: number): HealthAggregate {
  let taskCount = 0;
  let lateCount = 0;
  let atRiskCount = 0;
  let weighted = 0;
  let totalWeight = 0;
  for (const task of tasks) {
    if (task.type === "summary") continue;
    if (!Number.isFinite(task.start) || !Number.isFinite(task.end)) continue;
    taskCount += 1;
    const progress = progressOf(task);
    const duration = Math.max(1, task.end - task.start);
    weighted += progress * duration;
    totalWeight += duration;
    if (task.end <= now && progress < 1) {
      lateCount += 1;
    } else if (task.start <= now && now < task.end) {
      const expected = (now - task.start) / duration;
      if (progress < expected) atRiskCount += 1;
    }
  }
  const status: PortfolioHealthStatus =
    lateCount > 0 ? "late" : atRiskCount > 0 ? "at-risk" : "on-track";
  return {
    status,
    taskCount,
    lateCount,
    atRiskCount,
    progress: totalWeight > 0 ? weighted / totalWeight : 0,
  };
}

/** Duration-weighted mean progress over `tasks`, 0..1; 0 when the set is empty. */
export function weightedProgress(tasks: Iterable<Readonly<Task>>): {
  progress: number;
  taskCount: number;
} {
  let sum = 0;
  let weight = 0;
  let taskCount = 0;
  for (const task of tasks) {
    if (task.type === "summary") continue;
    if (!Number.isFinite(task.start) || !Number.isFinite(task.end)) continue;
    taskCount += 1;
    const duration = Math.max(1, task.end - task.start);
    sum += progressOf(task) * duration;
    weight += duration;
  }
  return { progress: weight > 0 ? sum / weight : 0, taskCount };
}
