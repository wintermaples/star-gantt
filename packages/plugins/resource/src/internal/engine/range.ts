// docs/specs/plugins/resource.md §2.5 — the two range-resolution policies.
/**
 * Range resolution and the task extent.
 *
 * Range resolution is CALLER policy — the engine takes an already-resolved `[start, end)` — but
 * the two policies themselves are pure arithmetic, so they live here beside the grid rather than
 * being written twice in the two consumers (§8's file plan).
 *
 * The utilization query path (`alignRange` + `deriveRange`) aligns outward to UTC day boundaries
 * and clamps to 3660 days, falling from query → config `utilization.range` → task extent. The
 * report/heatmap path (`taskExtent` + `resolveReportRange`) replaces each unusable bound by its
 * derived task-extent bound.
 *
 * Headless: no DOM, no service reference.
 */
import { MS_DAY } from "@stargantt/sdk";

/** A half-open analysis range, epoch milliseconds UTC. */
export interface EngineRange {
  start: number;
  end: number;
}

/** The analysis-range cap of the utilization query path (§2.2). */
export const MAX_RANGE_DAYS = 3660;

/**
 * Aligns a half-open range outward to UTC day boundaries and clamps its length; `null` when the
 * pair is unusable (a non-finite member, or bounds that do not order).
 */
export function alignRange(start: number, end: number): EngineRange | null {
  if (!Number.isFinite(start) || !Number.isFinite(end)) return null;
  const s = Math.floor(start / MS_DAY) * MS_DAY;
  let e = Math.ceil(end / MS_DAY) * MS_DAY;
  if (e <= s) return null;
  if (e - s > MAX_RANGE_DAYS * MS_DAY) e = s + MAX_RANGE_DAYS * MS_DAY;
  return { start: s, end: e };
}

/**
 * The extent of the task set — `[min start, max end)` over tasks with finite `start < end` — or
 * `null` when no task has a usable span. Not day-aligned: the report path wants the raw extent.
 */
export function taskExtent(tasks: Iterable<{ start: number; end: number }>): EngineRange | null {
  let min = Infinity;
  let max = -Infinity;
  for (const task of tasks) {
    if (!(Number.isFinite(task.start) && task.end > task.start)) continue;
    if (task.start < min) min = task.start;
    if (task.end > max) max = task.end;
  }
  return min < max ? { start: min, end: max } : null;
}

/** The day-aligned extent of the task set — the utilization path's fallback. */
export function deriveRange(
  tasks: Iterable<{ start: number; end: number }>,
): EngineRange | null {
  const extent = taskExtent(tasks);
  return extent === null ? null : alignRange(extent.start, extent.end);
}

/**
 * Resolves the report/heatmap `[start, end)` from the options and the derived extent.
 *
 * An unusable bound is silently ignored and replaced by the derived task-extent bound; with no
 * usable bound on either side and no extent, there is no range (`null` ⇒ empty matrix).
 *
 * A pair of usable bounds that fails to order (`start >= end`) gets the same treatment as
 * an unusable member, not an empty matrix: every SUPPLIED bound of the offending pair is replaced
 * by its derived bound (one bound when only one was supplied, both when both were), and only when
 * the result still fails to order — or there is no extent to fall back on — is there no range.
 */
export function resolveReportRange(
  extent: EngineRange | null,
  start: number | undefined,
  end: number | undefined,
): EngineRange | null {
  const startSupplied = typeof start === "number" && Number.isFinite(start);
  const endSupplied = typeof end === "number" && Number.isFinite(end);
  let from = startSupplied ? start : extent?.start;
  let to = endSupplied ? end : extent?.end;
  if (from !== undefined && to !== undefined && !(to > from)) {
    // The inverted (or empty) pair: each supplied side is the offending one and falls back to the
    // derived bound, exactly as an unusable member would.
    if (startSupplied) from = extent?.start;
    if (endSupplied) to = extent?.end;
  }
  if (from === undefined || to === undefined || !(to > from)) return null;
  return { start: from, end: to };
}
