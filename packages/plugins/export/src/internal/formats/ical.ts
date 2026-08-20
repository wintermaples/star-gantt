// docs/specs/plugins/export.md §1.5 (iCal) — RFC 5545 serialization: one `VEVENT` per task. Hostless.
import type { Task } from "@stargantt/plugin-data-store";
import type { ICalExportOptions } from "../../types";

/** `TEXT` escaping per RFC 5545 §3.3.11: backslash, semicolon, comma, newline. */
export function escapeIcalText(text: string): string {
  return text.replace(/\\/g, "\\\\").replace(/;/g, "\\;").replace(/,/g, "\\,").replace(/\r?\n/g, "\\n");
}

/**
 * UTC date-time in the `YYYYMMDDTHHMMSSZ` basic format, or `undefined` when the value falls
 * outside the range `Date` can represent (±8.64e15 ms) — serialization skips such lines rather
 * than throwing (§1.1's "export must return a string, never throw" rule, carried here).
 */
export function icalDateTime(epochMs: number): string | undefined {
  if (!Number.isFinite(epochMs) || Math.abs(epochMs) > 8.64e15) return undefined;
  return new Date(epochMs).toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");
}

/** Folds a content line at 74 octets-ish (74 UTF-16 units — safe under the 75-octet limit for ASCII). */
export function foldLine(line: string): string[] {
  if (line.length <= 74) return [line];
  const out: string[] = [line.slice(0, 74)];
  for (let i = 74; i < line.length; i += 73) out.push(" " + line.slice(i, i + 73));
  return out;
}

/**
 * Serializes tasks to an iCalendar document (§1.5). `now` stamps `DTSTAMP` (injected for
 * testability). `DTEND` is exclusive in RFC 5545, matching `Task.end` exclusivity, so both are
 * written verbatim.
 */
export function serializeICal(
  tasks: Iterable<Readonly<Task>>,
  options: ICalExportOptions | undefined,
  now: number,
): string {
  // §1.5 — PRODID as fixed by the spec.
  const lines: string[] = ["BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//StarGantt//StarGantt//EN"];
  if (typeof options?.calendarName === "string" && options.calendarName !== "") {
    lines.push(`X-WR-CALNAME:${escapeIcalText(options.calendarName)}`);
  }
  // A non-representable `now` falls back to the epoch: DTSTAMP is required by RFC 5545.
  const stamp = icalDateTime(now) ?? "19700101T000000Z";
  for (const task of tasks) {
    if (task.type === "summary" && options?.includeSummaryTasks !== true) continue;
    // A VEVENT without a representable DTSTART cannot be expressed: skip the whole event.
    const dtStart = icalDateTime(task.start);
    if (dtStart === undefined) continue;
    lines.push("BEGIN:VEVENT");
    lines.push(`UID:${escapeIcalText(String(task.id))}@stargantt`);
    lines.push(`DTSTAMP:${stamp}`);
    lines.push(`DTSTART:${dtStart}`);
    // A milestone is a point in time: DTEND is omitted so consumers treat it as an instant.
    const dtEnd = task.type === "milestone" ? undefined : icalDateTime(task.end);
    if (dtEnd !== undefined) lines.push(`DTEND:${dtEnd}`);
    lines.push(`SUMMARY:${escapeIcalText(task.name)}`);
    if (typeof task.progress === "number" && Number.isFinite(task.progress)) {
      // §1.5 — RFC 5545 reserves PERCENT-COMPLETE for VTODO, not VEVENT; a vendor-extension
      // property (X-*) is the RFC-conformant way to carry it on a VEVENT.
      lines.push(
        `X-STARGANTT-PERCENT-COMPLETE:${Math.round(Math.min(1, Math.max(0, task.progress)) * 100)}`,
      );
    }
    lines.push("END:VEVENT");
  }
  lines.push("END:VCALENDAR");
  return lines.flatMap(foldLine).join("\r\n") + "\r\n";
}
