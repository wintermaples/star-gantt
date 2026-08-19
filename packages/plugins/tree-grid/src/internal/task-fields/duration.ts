// docs/specs/plugins/tree-grid.md § Config — "Duration units".
import { MS_DAY } from "@stargantt/sdk";
import type { DurationUnit } from "../../types";

const MS_HOUR = 3_600_000;
const MS_WEEK = 7 * MS_DAY;

/** Milliseconds per unit; the exhaustive table over `DurationUnit`. */
export const UNIT_MS = {
  days: MS_DAY,
  hours: MS_HOUR,
  weeks: MS_WEEK,
} as const satisfies Record<DurationUnit, number>;

/** The one-letter suffix shown after a duration value. */
export const UNIT_SUFFIX = {
  days: "d",
  hours: "h",
  weeks: "w",
} as const satisfies Record<DurationUnit, string>;

/** Narrows an arbitrary config value to a `DurationUnit`, or the `"days"` default. */
export function resolveUnit(raw: unknown): DurationUnit {
  return raw === "hours" || raw === "weeks" || raw === "days" ? raw : "days";
}

/** `(end − start)` expressed in `unit`, unrounded. */
export function durationIn(unit: DurationUnit, startMs: number, endMs: number): number {
  return (endMs - startMs) / UNIT_MS[unit];
}

/** Renders a duration for a cell: at most two decimals, plus the unit suffix (`"3 d"`). */
export function formatDuration(unit: DurationUnit, startMs: number, endMs: number): string {
  const value = durationIn(unit, startMs, endMs);
  const rounded = Math.round(value * 100) / 100;
  return `${rounded} ${UNIT_SUFFIX[unit]}`;
}

/**
 * Parses a committed duration string: a positive decimal number with an optional `d` / `h` / `w`
 * suffix that overrides the configured unit. Returns the duration in milliseconds, or
 * `undefined` for anything unusable (unparsable input is ignored).
 */
export function parseDurationInput(unit: DurationUnit, raw: unknown): number | undefined {
  if (typeof raw !== "string" && typeof raw !== "number") return undefined;
  const text = String(raw).trim().toLowerCase();
  const match = /^([0-9]*\.?[0-9]+)\s*([dhw]?)$/.exec(text);
  if (match === null) return undefined;
  const value = Number(match[1]);
  if (!Number.isFinite(value) || value <= 0) return undefined;
  const suffix = match[2];
  const effective: DurationUnit =
    suffix === "d" ? "days" : suffix === "h" ? "hours" : suffix === "w" ? "weeks" : unit;
  return value * UNIT_MS[effective];
}
