// docs/specs/plugins/tracking.md §2.14 (status-date chain) — shared by the evm and
// progress-tracking areas: every area falls back to "the start of the current UTC day",
// tracked live (never latched at setup — each call re-reads `now()`).
//
// evm   = `evm.statusDate` when finite → the progress area's `statusDate()` → current UTC day.
// cost  = `cost.statusDate` when finite → current UTC day.
// progress = `progress.statusDate` when finite → current UTC day.
//
// The evm→progress hop is a direct function call, not a cross-plugin service read: EVM's
// engine is handed the progress area's resolved `statusDate()` closure, not a `ProgressService`.
import { MS_DAY } from "@stargantt/sdk";

/** The start, in epoch ms, of the UTC day containing `t`. */
export function startOfUtcDay(t: number): number {
  return Math.floor(t / MS_DAY) * MS_DAY;
}

/** The start of "today" in UTC, per `now()` (defaults to `Date.now`) — never cached. */
export function currentUtcDayStart(now: () => number = Date.now): number {
  return startOfUtcDay(now());
}

/** `value` when it is a finite number, else `fallback()` — the one-hop version of every chain. */
export function finiteOr(value: number | undefined, fallback: () => number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback();
}

/** Builds the progress/cost area's own two-link chain: configured value, else the current UTC day. */
export function statusDateResolver(configured: number | undefined, now: () => number): () => number {
  return () => finiteOr(configured, () => currentUtcDayStart(now));
}

/**
 * Builds the EVM area's three-link chain: its own configured value, else the progress area's
 * resolved status date (itself already falling through to the current UTC day).
 */
export function evmStatusDateResolver(
  configured: number | undefined,
  progressStatusDate: () => number,
): () => number {
  return () => finiteOr(configured, progressStatusDate);
}
