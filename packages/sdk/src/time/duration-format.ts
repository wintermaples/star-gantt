// The shared duration display rule (docs/specs/sdk.md, Module: sdk/time): a millisecond quantity
// is never printed raw and no consumer invents its own formatting. Localization is the consumer's
// responsibility, through its own message catalog — nothing here touches `Intl`.
/**
 * The shared duration display rule: turns a millisecond quantity into short, locale-independent
 * text such as `"1.5d"`, `"4h"`, `"30m"` or `"12s"`.
 */
import { MS_DAY, MS_HOUR, MS_MINUTE, MS_SECOND } from "./time";

/** Options for formatting a duration. */
export interface FormatDurationOptions {
  /**
   * How many digits may follow the decimal point, 0 to 3. Trailing zeros are stripped either way,
   * so a whole number never grows a `.0`. Defaults to 1; a value outside the range is clamped, and
   * one that is not a number is ignored.
   */
  maxFractionDigits?: number;
  /**
   * Whether a positive duration is prefixed with `+`. A negative one always carries `-`, and zero
   * never carries a sign. Defaults to `false`.
   */
  signed?: boolean;
}

/** One rung of the unit ladder: its size, its suffix, and the count at which it promotes upward. */
interface DurationUnit {
  readonly ms: number;
  readonly suffix: string;
  readonly per: number;
}

/** The unit ladder, largest first. Days never promote, so their `per` is unused. */
const UNITS: readonly DurationUnit[] = [
  { ms: MS_DAY, suffix: "d", per: 0 },
  { ms: MS_HOUR, suffix: "h", per: 24 },
  { ms: MS_MINUTE, suffix: "m", per: 60 },
  { ms: MS_SECOND, suffix: "s", per: 60 },
];

/** The ladder rung at `index`, which every caller here keeps inside the array. */
function unitAt(index: number): DurationUnit {
  return UNITS[index] as DurationUnit;
}

/**
 * The rung of the ladder a magnitude belongs to: the first whose size it reaches, and the smallest
 * rung when it reaches none. One implementation, so the exported magnitude query and the formatter
 * can never select different units for the same quantity.
 */
function unitIndexFor(magnitude: number): number {
  for (let i = 0; i < UNITS.length; i += 1) {
    if (magnitude >= unitAt(i).ms) return i;
  }
  return UNITS.length - 1;
}

/**
 * The size, in milliseconds, of the unit a duration of `ms` is displayed in: a day from a day up,
 * then an hour, a minute, and a second for anything smaller — the same selection
 * `formatDurationMs` makes, from the same ladder.
 *
 * It answers the magnitude the sign-less quantity falls in, before any rounding the formatter
 * applies can promote a value onto the next unit's boundary. Callers that need a round *displayed*
 * quantity — a chart axis choosing its step, say — work in this unit so the numbers they produce
 * print as round text rather than as round millisecond counts. A value that is not a finite number
 * answers a second, the smallest unit.
 */
export function durationUnitMs(ms: number): number {
  const magnitude = typeof ms === "number" && Number.isFinite(ms) ? Math.abs(ms) : 0;
  return unitAt(unitIndexFor(magnitude)).ms;
}

/**
 * The unit ladder as `[size in milliseconds, suffix]` pairs, largest first — day, hour, minute,
 * second.
 *
 * Exported for the one caller a formatter cannot serve: a parser that must accept exactly the
 * durations this ladder writes. Reading the ladder is what keeps an entry field's grammar and the
 * text it echoes back from drifting apart when a rung is renamed.
 */
export function durationUnits(): readonly (readonly [ms: number, suffix: string])[] {
  return UNIT_PAIRS;
}

/**
 * The `[ms, suffix]` pairs `durationUnits()` hands back, built once: the ladder never changes at
 * runtime, so there is no reason for every call to allocate a fresh array and fresh tuples.
 */
const UNIT_PAIRS: readonly (readonly [ms: number, suffix: string])[] = Object.freeze(
  UNITS.map((u) => Object.freeze([u.ms, u.suffix] as const)),
);

/** Rounds a non-negative number to `digits` decimals, half away from zero. */
function roundTo(value: number, digits: number): number {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

/** `value` with `digits` decimals, trailing zeros and a bare trailing point removed. */
function decimals(value: number, digits: number): string {
  const text = value.toFixed(digits);
  if (digits === 0 || !text.includes(".")) return text;
  return text.replace(/\.?0+$/, "");
}

/**
 * Formats a duration in milliseconds for display.
 *
 * The unit follows the magnitude — days from a day up, then hours, then minutes, then seconds —
 * and a value that rounds up to the next unit's boundary is re-expressed in that unit, so a
 * millisecond short of a day reads `"1d"` rather than `"24h"`. The output is deliberately
 * locale-independent: ASCII digits, a `.` decimal separator and the single-letter suffixes
 * `d`, `h`, `m`, `s`. A negative duration carries `-`, and `signed` adds `+` to a positive one;
 * zero is never signed. A value that is not a finite number produces the empty string rather than
 * throwing.
 */
export function formatDurationMs(ms: number, options?: FormatDurationOptions): string {
  if (typeof ms !== "number" || !Number.isFinite(ms)) return "";

  const requested = options?.maxFractionDigits;
  const digits =
    typeof requested === "number" && Number.isFinite(requested)
      ? Math.min(3, Math.max(0, Math.round(requested)))
      : 1;

  const magnitude = Math.abs(ms);
  let index = unitIndexFor(magnitude);

  // Rounding can push a value onto the next unit's boundary (23.9999h, 59.6m): re-express it there
  // rather than print a count the unit itself cannot reach.
  let value = roundTo(magnitude / unitAt(index).ms, digits);
  while (index > 0 && value >= unitAt(index).per) {
    index -= 1;
    value = roundTo(magnitude / unitAt(index).ms, digits);
  }

  const text = decimals(value, digits) + unitAt(index).suffix;
  if (value === 0) return text;
  if (ms < 0) return `-${text}`;
  return options?.signed === true ? `+${text}` : text;
}
