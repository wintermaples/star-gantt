/** One day in milliseconds. */
export const MS_DAY = 86_400_000;

/** One hour in milliseconds. */
export const MS_HOUR = 3_600_000;

/** One minute in milliseconds. */
export const MS_MINUTE = 60_000;

/** One second in milliseconds. */
export const MS_SECOND = 1_000;

/**
 * Formats an epoch-millisecond instant as an ISO calendar day in UTC, e.g. `"2024-01-31"`.
 *
 * The result is locale-independent by design: it is the form date columns, date inputs and
 * spoken announcements share. Returns `undefined` — rather than throwing — for a value that is
 * not a finite number, or one outside the range a `Date` can represent.
 */
export function isoDay(t: number): string | undefined {
  if (typeof t !== "number" || !Number.isFinite(t)) return undefined;
  try {
    return new Date(t).toISOString().slice(0, 10);
  } catch {
    // Finite but outside the range `Date` can represent.
    return undefined;
  }
}
