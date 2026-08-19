// Strict ISO date parsing (docs/specs/sdk.md, Module: sdk/time): rejects a calendar-invalid date
// such as "2024-02-30" rather than letting it roll over onto a neighboring date.

const ISO_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;

/**
 * Parses a `YYYY-MM-DD` string to the UTC-midnight epoch-ms instant of that calendar date, or
 * `undefined` when the string is not exactly that shape or names a date the calendar does not
 * contain (`"2024-02-30"`, `"2024-13-01"`).
 *
 * Strict on purpose: no trimming, no time-of-day, no timezone suffix, and no `Date.UTC` rollover —
 * a typo is rejected rather than silently landing on a neighboring date. Callers with `"" = clear`
 * semantics or whitespace tolerance handle those before calling.
 */
export function parseIsoDateStrict(s: string): number | undefined {
  const m = ISO_DATE.exec(s);
  if (m === null) return undefined;
  const year = Number(m[1]);
  const month = Number(m[2]);
  const day = Number(m[3]);
  const t = Date.UTC(year, month - 1, day);
  if (!Number.isFinite(t)) return undefined;
  const d = new Date(t);
  return d.getUTCFullYear() === year && d.getUTCMonth() === month - 1 && d.getUTCDate() === day
    ? t
    : undefined;
}
