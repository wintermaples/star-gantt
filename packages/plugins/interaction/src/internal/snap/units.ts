// docs/specs/plugins/interaction.md §2.2 — the boundary table and the tie rule.
/**
 * Calendar- and grid-unit rounding.
 *
 * Time is uniformly epoch milliseconds **UTC**, so every boundary below is computed with the
 * `getUTC*` / `Date.UTC` family — matching the timeline header, whose rows mark the same
 * boundaries. Pure arithmetic, unit-testable without a DOM.
 */
import { MS_DAY, MS_HOUR } from "@stargantt/sdk";
import type { SnapUnit } from "../../types";

/** One week in milliseconds. */
export const MS_WEEK = 604_800_000;

/**
 * A unit in effect: a calendar unit, or a positive number of milliseconds whose boundaries are
 * multiples of it measured from epoch 0.
 */
export type ResolvedUnit = SnapUnit | number;

/** Largest `unit` boundary at or before `t`, in UTC. Weeks start on Monday (ISO-8601). */
export function floorTo(t: number, unit: ResolvedUnit): number {
  if (typeof unit === "number") return Math.floor(t / unit) * unit;
  switch (unit) {
    case "year": {
      const d = new Date(t);
      return Date.UTC(d.getUTCFullYear(), 0, 1);
    }
    case "month": {
      const d = new Date(t);
      return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1);
    }
    case "week": {
      const day = Math.floor(t / MS_DAY) * MS_DAY;
      // getUTCDay(): 0 = Sunday. ISO weeks start on Monday, hence the +6 rotation.
      const back = (new Date(day).getUTCDay() + 6) % 7;
      return day - back * MS_DAY;
    }
    case "day":
      return Math.floor(t / MS_DAY) * MS_DAY;
    case "hour":
      return Math.floor(t / MS_HOUR) * MS_HOUR;
  }
}

/** The next `unit` boundary after the boundary `t`. */
export function next(t: number, unit: ResolvedUnit): number {
  if (typeof unit === "number") return t + unit;
  switch (unit) {
    case "year": {
      const d = new Date(t);
      return Date.UTC(d.getUTCFullYear() + 1, 0, 1);
    }
    case "month": {
      const d = new Date(t);
      return Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1);
    }
    case "week":
      return t + MS_WEEK;
    case "day":
      return t + MS_DAY;
    case "hour":
      return t + MS_HOUR;
  }
}

/**
 * How far one step in `direction` moves a time expressed in `unit`, in milliseconds.
 *
 * Forwards, that is the length of the unit containing `t`; backwards, the length of the unit
 * before it — so stepping forward and then back always returns to the same boundary. Months and
 * years are not a fixed number of milliseconds, so the step is measured against the time it starts
 * from rather than taken from a constant. The result is signed.
 */
export function unitStep(t: number, unit: ResolvedUnit, direction: 1 | -1): number {
  const low = floorTo(t, unit);
  if (direction === 1) return next(low, unit) - low;
  return floorTo(low - 1, unit) - low;
}

/**
 * Nearest `unit` boundary to `t`. A time exactly halfway between two boundaries rounds up, so
 * rounding never depends on which side of the edit the time came from.
 */
export function roundTo(t: number, unit: ResolvedUnit): number {
  if (!Number.isFinite(t)) return t;
  const low = floorTo(t, unit);
  const high = next(low, unit);
  return t - low < high - t ? low : high;
}
