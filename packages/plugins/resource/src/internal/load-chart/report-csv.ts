// docs/specs/plugins/resource.md §3.6 — CSV rendering of the utilization report (§6.2).
/**
 * RFC 4180: comma-separated fields, CRLF records, quoting only where a field needs it. Row 1 is the
 * header (`reportColumnHeader` over the fixed column order), then one record per resource × bucket
 * cell in row-major order.
 *
 * `allocated` and `capacity` are working-time quantities and are written as the texts the catalog's
 * `duration` member produces; raw milliseconds never reach the file. `utilization`
 * stays the plain decimal ratio, to at most four fractional digits.
 *
 * Headless: no DOM, no service reference.
 */
import { MS_DAY, MS_MINUTE, isoDay } from "@stargantt/sdk";
import type { UtilizationReportRow } from "../areas";

/** A number rounded to at most 4 fractional digits, rendered without trailing zeros. */
export function reportNumber(value: number): string {
  if (!Number.isFinite(value)) return "";
  return String(Math.round(value * 10_000) / 10_000);
}

/**
 * A locale-independent ISO UTC stamp at minute resolution, e.g. `"2024-01-31T09:00Z"` — `isoDay`'s
 * sibling for sub-day buckets. Returns `undefined` on the same inputs `isoDay` does,
 * so the two behave alike at a range boundary.
 */
export function isoMinute(t: number): string | undefined {
  if (typeof t !== "number" || !Number.isFinite(t)) return undefined;
  try {
    return `${new Date(t).toISOString().slice(0, 16)}Z`;
  } catch {
    // Finite but outside the range `Date` can represent.
    return undefined;
  }
}

/**
 * The bucket's INCLUSIVE ISO bounds — `from` its first point, `to` its last — at the resolution its
 * width calls for.
 *
 * A bucket at least a day wide keeps the calendar-day form and the "one day back" inclusive end; a
 * narrower bucket prints minutes and steps back one minute instead.
 */
export function bucketStamps(start: number, end: number): { from: string; to: string } {
  if (end - start < MS_DAY) {
    return {
      from: isoMinute(start) ?? "",
      to: isoMinute(Math.max(start, end - MS_MINUTE)) ?? "",
    };
  }
  return { from: isoDay(start) ?? "", to: isoDay(Math.max(start, end - MS_DAY)) ?? "" };
}

/** Quotes a field when it holds a comma, quote, CR or LF; inner quotes are doubled. */
function csvField(value: string): string {
  return /[",\r\n]/.test(value) ? `"${value.replaceAll('"', '""')}"` : value;
}

/**
 * Serializes the report: `headers` verbatim as row 1, then the cells. An empty report yields the
 * header row alone. No trailing record separator.
 */
export function reportToCsv(
  rows: readonly UtilizationReportRow[],
  headers: readonly string[],
  duration: (ms: number) => string,
): string {
  const lines: string[] = [headers.map(csvField).join(",")];
  for (const row of rows) {
    for (const cell of row.cells) {
      const { from, to } = bucketStamps(cell.start, cell.end);
      lines.push(
        [
          csvField(row.resourceName),
          from,
          to,
          csvField(duration(cell.allocated)),
          csvField(duration(cell.capacity)),
          cell.ratio === null ? "" : reportNumber(cell.ratio),
        ].join(","),
      );
    }
  }
  return lines.join("\r\n");
}
