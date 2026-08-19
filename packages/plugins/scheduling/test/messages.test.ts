// docs/specs/plugins/scheduling.md §12 — the 62-key merged catalog.
import { describe, expect, it, vi } from "vitest";
import { SCHEDULING_MESSAGE_KEYS, resolveMessages } from "../src/internal/messages";

const noFault = (): void => {};
const defaults = () => resolveMessages(undefined, noFault);

describe("catalog shape", () => {
  it("carries exactly the 62 keys the spec enumerates", () => {
    expect(SCHEDULING_MESSAGE_KEYS).toHaveLength(62);
    expect(new Set(SCHEDULING_MESSAGE_KEYS).size).toBe(62);
  });

  it("names every key of the four merged catalogs, unprefixed", () => {
    expect([...SCHEDULING_MESSAGE_KEYS].sort()).toEqual(
      [
        // auto-schedule (3)
        "modeColumnHeader",
        "modeAuto",
        "modeManual",
        // dependencies (10)
        "inspectorLabel",
        "noLinks",
        "linkPickerLabel",
        "typeLabel",
        "lagLabel",
        "removeLink",
        "incomingLink",
        "outgoingLink",
        "linkRemoved",
        "linkUpdated",
        // calendars (43)
        "editorTitle",
        "calendarLabel",
        "dateLabel",
        "workingLabel",
        "addException",
        "removeException",
        "workingDaysLegend",
        "close",
        "empty",
        "hoursLegend",
        "noWindows",
        "addWindow",
        "clearWindows",
        "removeWindow",
        "windowStartLabel",
        "windowEndLabel",
        "removeButton",
        "periodsLegend",
        "fromLabel",
        "toLabel",
        "periodKindLabel",
        "periodWorking",
        "periodNonWorking",
        "periodHoursLabel",
        "applyPeriod",
        "removePeriod",
        "exceptionNonWorking",
        "exceptionWorkingDefault",
        "exceptionWorkingHours",
        "assignLegend",
        "assignSelected",
        "unassignSelected",
        "statusWorkingDays",
        "statusWorkingHours",
        "statusPeriodApplied",
        "statusPeriodRemoved",
        "statusPeriodInvalid",
        "statusWindowInvalid",
        "statusExceptionAdded",
        "statusExceptionRemoved",
        "statusAssigned",
        "statusUnassigned",
        "statusNoSelection",
        // schedule-diagnostics (6)
        "button",
        "panelLabel",
        "orphanHeading",
        "leadHeading",
        "noIssues",
        "leadItem",
      ].sort(),
    );
  });
});

describe("built-in defaults", () => {
  it("keeps the plain strings byte-for-byte", () => {
    const m = defaults();
    expect(m.modeColumnHeader).toBe("Mode");
    expect(m.modeAuto).toBe("Auto");
    expect(m.modeManual).toBe("Manual");
    expect(m.inspectorLabel).toBe("Dependencies");
    expect(m.noLinks).toBe("None");
    expect(m.lagLabel).toBe("Lag (days)");
    expect(m.editorTitle).toBe("Working calendar");
    expect(m.empty).toBe("No calendars defined");
    expect(m.noWindows).toBe("No windows — a working day counts in full.");
    expect(m.exceptionWorkingDefault).toBe("Working (calendar hours)");
    expect(m.statusPeriodInvalid).toBe(
      "Pick both dates first; the period cannot end before it starts.",
    );
    expect(m.statusWindowInvalid).toBe("Those hours end before they start.");
    expect(m.statusNoSelection).toBe("Select one or more tasks first.");
    expect(m.panelLabel).toBe("Schedule diagnostics");
    expect(m.noIssues).toBe("No issues found");
  });

  it("formats the dependency-inspector lines, sign only for a positive lag", () => {
    const m = defaults();
    expect(m.incomingLink({ name: "A", type: "FS", lagDays: 0 })).toBe("← A (FS)");
    expect(m.incomingLink({ name: "A", type: "SS", lagDays: 2 })).toBe("← A (SS, +2d)");
    expect(m.outgoingLink({ name: "B", type: "FF", lagDays: -1 })).toBe("→ B (FF, -1d)");
  });

  it("pluralizes the calendar status lines with the plain English s", () => {
    const m = defaults();
    expect(m.statusWorkingDays(["Mon", "Tue"])).toBe("Working days: Mon, Tue.");
    expect(m.statusWorkingDays([])).toBe(
      "No working day left — every day of this calendar is non-working.",
    );
    expect(m.statusWorkingHours(1)).toBe("1 working window applied.");
    expect(m.statusWorkingHours(2)).toBe("2 working windows applied.");
    expect(m.statusWorkingHours(0)).toBe(
      "Working hours cleared — every working day counts in full.",
    );
    expect(m.statusPeriodApplied({ days: 1, from: "2024-01-01", working: false })).toBe(
      "1 day from 2024-01-01 set non-working.",
    );
    expect(m.statusPeriodApplied({ days: 3, from: "2024-01-01", working: true })).toBe(
      "3 days from 2024-01-01 set working.",
    );
    expect(m.statusPeriodRemoved(0)).toBe("No exception day falls in that period.");
    expect(m.statusPeriodRemoved(2)).toBe("2 exception days removed.");
    expect(m.statusAssigned({ count: 1, calendar: "Office" })).toBe("1 task now on Office.");
    expect(m.statusUnassigned(2)).toBe("2 tasks back on the default calendar.");
  });

  it("formats the remaining builders", () => {
    const m = defaults();
    expect(m.removeException("2024-01-06")).toBe("Remove exception 2024-01-06");
    expect(m.removeWindow({ from: "09:00", to: "17:00" })).toBe(
      "Remove working window 09:00 to 17:00",
    );
    expect(m.exceptionWorkingHours("06:00–14:00")).toBe("Working 06:00–14:00");
    expect(m.statusExceptionAdded("2024-01-06")).toBe("Exception on 2024-01-06 added.");
    expect(m.statusExceptionRemoved("2024-01-06")).toBe("Exception on 2024-01-06 removed.");
    expect(m.button(3)).toBe("Diagnostics (3)");
    expect(m.orphanHeading(2)).toBe("Unlinked tasks (2)");
    expect(m.leadHeading(1)).toBe("Leads — negative lag (1)");
    expect(m.leadItem("A", "B", -2)).toBe("A → B (lag -2d)");
  });
});

describe("host overrides", () => {
  it("overrides per key, takes the empty string verbatim and ignores wrong kinds", () => {
    const m = resolveMessages(
      { modeManual: "Pinned", noLinks: "", modeAuto: 7 as never, button: "x" as never },
      noFault,
    );
    expect(m.modeManual).toBe("Pinned");
    expect(m.noLinks).toBe("");
    expect(m.modeAuto).toBe("Auto");
    // A string where a builder is expected is the wrong kind and is ignored.
    expect(m.button(1)).toBe("Diagnostics (1)");
  });

  it("reports a throwing builder and answers with the built-in default for that call", () => {
    const onFault = vi.fn();
    const m = resolveMessages(
      {
        button: () => {
          throw new Error("boom");
        },
      },
      onFault,
    );
    expect(m.button(4)).toBe("Diagnostics (4)");
    expect(onFault).toHaveBeenCalledTimes(1);
    expect(onFault.mock.calls[0]?.[0]).toBe("button");
  });

  it("ignores a non-object overrides value entirely", () => {
    expect(resolveMessages("nope" as never, noFault).modeAuto).toBe("Auto");
    expect(resolveMessages(undefined, noFault).modeAuto).toBe("Auto");
  });
});
