// docs/specs/plugins/tracking.md §7 — the day-stamped, replace-per-day snapshot series shared by
// progress-tracking and evm's seed/record logic. Generic over the point
// type: the progress trend (`ProgressSnapshot.date`) and the EVM history (`EvmSnapshot.t`) both
// thread through this module rather than keeping their own copy of the same day-bucketing.
import { startOfUtcDay } from "./status-date";

/** Normalizes a config seed: keeps only usable entries, sorts ascending by day. No deduplication —
 *  the progress trend seed's own contract ("unusable entries dropped, order normalized"). */
export function normalizeSeededSeries<T>(
  seed: readonly T[] | undefined,
  dateOf: (item: T) => unknown,
  isUsable: (item: T) => boolean,
  withDay: (item: T, day: number) => T,
): T[] {
  if (!Array.isArray(seed)) return [];
  const out: T[] = [];
  for (const item of seed) {
    if (!isUsable(item)) continue;
    const raw = dateOf(item);
    if (typeof raw !== "number" || !Number.isFinite(raw)) continue;
    out.push(withDay(item, startOfUtcDay(raw)));
  }
  return out.sort((a, b) => (dateOf(a) as number) - (dateOf(b) as number));
}

/** Like {@link normalizeSeededSeries}, but collapses same-day entries — the last one wins (the EVM
 *  seed's own contract: "last entry per UTC day kept, unusable dropped"). */
export function normalizeSeededSeriesDedupeByDay<T>(
  seed: readonly T[] | undefined,
  dateOf: (item: T) => unknown,
  isUsable: (item: T) => boolean,
  withDay: (item: T, day: number) => T,
): T[] {
  if (!Array.isArray(seed)) return [];
  const byDay = new Map<number, T>();
  for (const item of seed) {
    if (!isUsable(item)) continue;
    const raw = dateOf(item);
    if (typeof raw !== "number" || !Number.isFinite(raw)) continue;
    const day = startOfUtcDay(raw);
    byDay.set(day, withDay(item, day));
  }
  return [...byDay.entries()].sort((a, b) => a[0] - b[0]).map(([, v]) => v);
}

/**
 * Records `point` (already day-stamped, via `dateOf(point)`) into `series`, replacing whichever
 * existing entry falls on the same UTC day — "recording is host-initiated only" and "inserts in
 * date order REPLACING a same-day point" (§2.6).
 */
export function recordOrReplaceByDay<T>(
  series: readonly T[],
  point: T,
  dateOf: (item: T) => number,
): T[] {
  const day = dateOf(point);
  const next = series.filter((item) => dateOf(item) !== day);
  next.push(point);
  next.sort((a, b) => dateOf(a) - dateOf(b));
  return next;
}
