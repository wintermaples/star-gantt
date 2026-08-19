// docs/specs/plugins/view.md — status-date resolution, hostless.
/**
 * The value forms accepted for the status date: epoch milliseconds, a `Date`, or a date string
 * parseable by `Date.parse` (e.g. `"2026-03-01"`).
 */
export type StatusDateInput = number | Date | string;

// docs/specs/plugins/view.md
// unusable values are silently ignored, so every rejection path returns `undefined`.
/**
 * Normalizes a status-date config value to an epoch-milliseconds instant.
 *
 * Accepts a finite number (epoch ms), a valid `Date`, or a string `Date.parse` understands; a
 * date-only ISO string therefore resolves to UTC midnight of that day. Returns `undefined` for
 * anything unusable (non-finite number, invalid `Date`, unparseable string, other types), which
 * disables the status line.
 */
export function resolveStatusDate(value: StatusDateInput | undefined): number | undefined {
  if (typeof value === "number") {
    return Number.isFinite(value) ? value : undefined;
  }
  if (value instanceof Date) {
    const t = value.getTime();
    return Number.isNaN(t) ? undefined : t;
  }
  if (typeof value === "string") {
    const t = Date.parse(value);
    return Number.isNaN(t) ? undefined : t;
  }
  return undefined;
}
