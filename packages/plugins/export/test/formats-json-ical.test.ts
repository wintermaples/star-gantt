// @vitest-environment happy-dom
// docs/specs/plugins/export.md §1.5 (JSON, iCal).
import { afterEach, describe, expect, it } from "vitest";
import { escapeIcalText, foldLine, icalDateTime, serializeICal } from "../src/internal/formats/ical";
import { boot, DAY, sampleData } from "./_boot";
import type { Booted } from "./_boot";

let booted: Booted | undefined;
afterEach(() => {
  booted?.dispose();
  booted = undefined;
});

describe("JSON export / import (service)", () => {
  it("round-trips the whole project through the stargantt/v1 schema", () => {
    const { tasks, resources, assignments } = sampleData();
    booted = boot({ tasks, resources, assignments });
    const text = booted.service.exportJson();
    const parsed = JSON.parse(text) as {
      schema: string;
      tasks: unknown[];
      resources: unknown[];
      assignments: unknown[];
    };
    expect(parsed.schema).toBe("stargantt/v1");
    expect(parsed.tasks).toHaveLength(4);
    const result = booted.service.importJson(text, { dryRun: true });
    expect(result.document.issues).toEqual([]);
    expect(result.document.tasks).toHaveLength(4);
    expect(result.document.resources).toEqual([{ id: "r1", name: "Alice" }]);
    expect(result.document.assignments).toEqual([{ taskId: "a1", resourceId: "r1", units: 1 }]);
    expect(result.changes).toEqual([]);
  });

  it("accepts a bare task array with foreign key spellings", () => {
    booted = boot();
    const result = booted.service.importJson(
      JSON.stringify([
        { uid: 7, title: "Foreign", start_date: "1970-01-01", due: "1970-01-03", percentComplete: 50, parent: null },
        { text: "No id", startDate: 0, finish: DAY },
      ]),
      { dryRun: true },
    );
    expect(result.document.issues).toEqual([]);
    expect(result.document.tasks).toEqual([
      { id: 7, parentId: null, name: "Foreign", start: 0, end: 2 * DAY, progress: 0.5 },
      { id: "import-2", parentId: null, name: "No id", start: 0, end: DAY },
    ]);
  });

  it("also accepts percent_complete (the snake_case spelling)", () => {
    booted = boot();
    const result = booted.service.importJson(
      JSON.stringify([{ id: "p", name: "Percent", start: 0, end: DAY, percent_complete: 75 }]),
      { dryRun: true },
    );
    expect(result.document.tasks[0]?.progress).toBe(0.75);
  });

  it("reads a non-empty data.tasks, but not an empty one", () => {
    booted = boot();
    const withData = booted.service.importJson(
      JSON.stringify({ data: { tasks: [{ id: "d1", name: "D", start: 0, end: DAY }] } }),
      { dryRun: true },
    );
    expect(withData.document.issues).toEqual([]);
    expect(withData.document.tasks).toHaveLength(1);

    const emptyData = booted.service.importJson(JSON.stringify({ data: { tasks: [] } }), { dryRun: true });
    expect(emptyData.document.issues[0]?.code).toBe("invalid-json");
  });

  it("reports invalid JSON and objects without a task array as one issue", () => {
    booted = boot();
    expect(booted.service.importJson("{nope", { dryRun: true }).document.issues[0]?.code).toBe("invalid-json");
    expect(booted.service.importJson('{"foo": 1}', { dryRun: true }).document.issues[0]?.code).toBe("invalid-json");
    expect(booted.errors).toEqual([]);
  });

  it("flags unusable rows and duplicate ids while keeping good tasks and links", () => {
    booted = boot();
    const result = booted.service.importJson(
      JSON.stringify({
        tasks: [
          { id: "j1", name: "One", start: 0, end: DAY },
          { id: "j1", name: "Dup", start: 0, end: DAY },
          { id: "j2", name: "Backwards", start: DAY, end: 0 },
          42,
        ],
        links: [
          { from: "j1", to: "j2", type: "SS", lag: 5 },
          { source: "j1" },
        ],
      }),
      { dryRun: true },
    );
    expect(result.document.tasks.map((t) => t.id)).toEqual(["j1"]);
    expect(result.document.issues.map((i) => i.code)).toEqual(["duplicate-id", "invalid-row", "invalid-row"]);
    expect(result.document.links).toEqual([{ id: "import-link-1", sourceId: "j1", targetId: "j2", type: "SS", lag: 5 }]);
  });

  it("a non-string text argument yields an invalid-json issue", () => {
    booted = boot();
    const result = booted.service.importJson(undefined as unknown as string, { dryRun: true });
    expect(result.document.issues).toEqual([{ code: "invalid-json", reason: "not a string" }]);
  });
});

describe("iCal export (unit + service)", () => {
  it("writes one VEVENT per non-summary task with UTC stamps, escaping, and the v2 PRODID", () => {
    const now = Date.UTC(2026, 0, 2, 3, 4, 5);
    const ics = serializeICal(sampleData().tasks, { calendarName: "My; plan" }, now);
    expect(ics.startsWith("BEGIN:VCALENDAR\r\nVERSION:2.0\r\nPRODID:-//StarGantt//StarGantt v2//EN\r\n")).toBe(true);
    expect(ics).toContain("X-WR-CALNAME:My\\; plan");
    expect(ics).toContain("DTSTAMP:20260102T030405Z");
    // The summary task is skipped by default: three events for four tasks.
    expect(ics.match(/BEGIN:VEVENT/g)).toHaveLength(3);
    expect(ics).toContain("UID:a1@stargantt");
    expect(ics).toContain("DTSTART:19700101T000000Z");
    expect(ics).toContain(`DTEND:${icalDateTime(3 * DAY)}`);
    expect(ics).toContain("X-STARGANTT-PERCENT-COMPLETE:100");
    expect(ics).toContain('SUMMARY:Visual\\, "final" design');
    // Milestone: an instant — DTSTART without DTEND.
    const milestone = ics.split("BEGIN:VEVENT").find((block) => block.includes("UID:m1@stargantt"));
    expect(milestone).toBeDefined();
    expect(milestone).not.toContain("DTEND:");
    expect(ics.endsWith("END:VCALENDAR\r\n")).toBe(true);
  });

  it("includes summary tasks on request, and the service delegates with Date.now", () => {
    const { tasks } = sampleData();
    booted = boot({ tasks });
    const ics = booted.service.exportICal({ includeSummaryTasks: true });
    expect(ics.match(/BEGIN:VEVENT/g)).toHaveLength(4);
  });

  it("returns a string for out-of-Date-range task dates instead of throwing", () => {
    expect(icalDateTime(1e16)).toBeUndefined();
    const tasks = [
      { id: "far", parentId: null, name: "Far", start: 1e16, end: 1e16 + DAY },
      { id: "half", parentId: null, name: "Half", start: 0, end: 1e16 },
      { id: "ok", parentId: null, name: "Ok", start: 0, end: DAY },
    ];
    const ics = serializeICal(tasks, undefined, 0);
    // The event with an unrepresentable start is skipped whole; the unrepresentable end drops
    // only its DTEND line; the plain event survives untouched.
    expect(ics).not.toContain("UID:far@stargantt");
    const half = ics.split("BEGIN:VEVENT").find((block) => block.includes("UID:half@stargantt"));
    expect(half).toBeDefined();
    expect(half).not.toContain("DTEND:");
    expect(ics).toContain("UID:ok@stargantt");
  });

  it("escapes text and folds long lines under the 75-octet limit", () => {
    expect(escapeIcalText("a\\b;c,d\ne")).toBe("a\\\\b\\;c\\,d\\ne");
    const folded = foldLine(`SUMMARY:${"x".repeat(200)}`);
    expect(folded.length).toBeGreaterThan(1);
    expect(folded.every((l) => l.length <= 74 + 1)).toBe(true);
    expect(folded.slice(1).every((l) => l.startsWith(" "))).toBe(true);
    expect(folded.join("").replace(/^SUMMARY:/, "").replace(/ /g, "")).toBe("x".repeat(200));
  });
});
