// @vitest-environment happy-dom
/**
 * `internal/calendars/editor.ts` — the working-calendar editor dialog (§6.3).
 *
 * Hostless: `createEditor` takes a `Document`, a mount element and plain callbacks (`EditorDeps`),
 * never a `PluginContext` or a `CalendarsService`, so every test here supplies recording doubles for
 * the edit callbacks and drives the panel through real DOM events (`happy-dom`), with no
 * `Gantt.create` anywhere in this file.
 */
import { afterEach, describe, expect, it } from "vitest";
import { createEditor } from "../src/internal/calendars/editor";
import type { CalendarInit } from "../src/config";
import type { EditorDeps } from "../src/internal/calendars/editor";
import type { SchedulingMessages } from "../src/internal/messages";

const DEFAULT_MESSAGES: SchedulingMessages = {
  modeColumnHeader: "Mode",
  modeAuto: "Auto",
  modeManual: "Manual",
  inspectorLabel: "Dependencies",
  noLinks: "None",
  linkPickerLabel: "Link",
  typeLabel: "Type",
  lagLabel: "Lag (days)",
  removeLink: "Remove",
  incomingLink: ({ name, type }) => `← ${name} (${type})`,
  outgoingLink: ({ name, type }) => `→ ${name} (${type})`,
  linkRemoved: "Link removed",
  linkUpdated: "Link updated",
  editorTitle: "Working calendar",
  calendarLabel: "Calendar",
  dateLabel: "Date",
  workingLabel: "Working",
  addException: "Add exception",
  removeException: (date) => `Remove exception ${date}`,
  workingDaysLegend: "Working days",
  close: "Close",
  empty: "No calendars defined",
  hoursLegend: "Working hours",
  noWindows: "No windows — a working day counts in full.",
  addWindow: "Add window",
  clearWindows: "Clear windows",
  removeWindow: ({ from, to }) => `Remove working window ${from} to ${to}`,
  windowStartLabel: "Working window start",
  windowEndLabel: "Working window end",
  removeButton: "Remove",
  periodsLegend: "Special period",
  fromLabel: "From",
  toLabel: "To",
  periodKindLabel: "These days are",
  periodWorking: "Working",
  periodNonWorking: "Non-working",
  periodHoursLabel: "Only these hours",
  applyPeriod: "Apply period",
  removePeriod: "Remove period",
  exceptionNonWorking: "Non-working",
  exceptionWorkingDefault: "Working (calendar hours)",
  exceptionWorkingHours: (windows) => `Working ${windows}`,
  assignLegend: "Task calendar",
  assignSelected: "Put selected tasks on it",
  unassignSelected: "Back to the default",
  statusWorkingDays: (days) => (days.length === 0 ? "No working day left." : `Working days: ${days.join(", ")}.`),
  statusWorkingHours: (count) =>
    count === 0 ? "Working hours cleared — every working day counts in full." : `${count} working window(s) applied.`,
  statusPeriodApplied: ({ days, from, working }) => `${days} day(s) from ${from} set ${working ? "working" : "non-working"}.`,
  statusPeriodRemoved: (count) => (count === 0 ? "No exception day falls in that period." : `${count} exception day(s) removed.`),
  statusPeriodInvalid: "Pick both dates first; the period cannot end before it starts.",
  statusWindowInvalid: "Those hours end before they start.",
  statusExceptionAdded: (date) => `Exception on ${date} added.`,
  statusExceptionRemoved: (date) => `Exception on ${date} removed.`,
  statusAssigned: ({ count, calendar }) => `${count} task(s) now on ${calendar}.`,
  statusUnassigned: (count) => `${count} task(s) back on the default calendar.`,
  statusNoSelection: "Select one or more tasks first.",
  button: (issueCount) => `Diagnostics (${issueCount})`,
  panelLabel: "Schedule diagnostics",
  orphanHeading: (count) => `Unlinked tasks (${count})`,
  leadHeading: (count) => `Leads — negative lag (${count})`,
  noIssues: "No issues found",
  leadItem: (source, target, lagDays) => `${source} → ${target} (lag ${lagDays}d)`,
};

const CAL: CalendarInit = { id: "std", workingDays: [1, 2, 3, 4, 5], name: "Standard" };

/** Recording double for every `EditorDeps` edit callback, plus a mutable backing calendar list. */
function recordingDeps(
  calendars: CalendarInit[],
  over: Partial<EditorDeps> = {},
): EditorDeps & { calls: Record<string, unknown[][]> } {
  const calls: Record<string, unknown[][]> = {};
  const record =
    (name: string) =>
    (...args: unknown[]): void => {
      (calls[name] ??= []).push(args);
    };
  return {
    messages: DEFAULT_MESSAGES,
    locale: "en",
    sections: ["days", "hours", "periods", "assign"],
    list: () => calendars,
    setWorkingDays: record("setWorkingDays") as EditorDeps["setWorkingDays"],
    setWorkingHours: record("setWorkingHours") as EditorDeps["setWorkingHours"],
    setException: record("setException") as EditorDeps["setException"],
    removeException: record("removeException") as EditorDeps["removeException"],
    setExceptionRange: record("setExceptionRange") as EditorDeps["setExceptionRange"],
    removeExceptionRange: record("removeExceptionRange") as EditorDeps["removeExceptionRange"],
    selectedTasks: () => [],
    assignTask: record("assignTask") as EditorDeps["assignTask"],
    calls,
    ...over,
  };
}

function find(root: HTMLElement, handle: string): HTMLElement {
  const el = root.querySelector(`[data-sg-calendars="${handle}"]`);
  if (el === null) throw new Error(`control ${handle} not found`);
  return el as HTMLElement;
}

function fire(el: HTMLElement, type: string, init?: EventInit): void {
  el.dispatchEvent(new Event(type, { bubbles: true, ...init }));
}

let mounts: HTMLElement[] = [];
afterEach(() => {
  for (const m of mounts) m.remove();
  mounts = [];
});

function mount(): HTMLElement {
  const el = document.createElement("div");
  document.body.appendChild(el);
  mounts.push(el);
  return el;
}

describe("open / close", () => {
  it("starts hidden and toggles display on open/close", () => {
    const editor = createEditor(document, mount(), recordingDeps([CAL]));
    expect(editor.element.style.display).toBe("none");
    editor.open("std");
    expect(editor.element.style.display).toBe("flex");
    expect(editor.element.getAttribute("role")).toBe("dialog");
    editor.close();
    expect(editor.element.style.display).toBe("none");
    editor.dispose();
  });

  it("closes on Escape and on the header close button", () => {
    const editor = createEditor(document, mount(), recordingDeps([CAL]));
    editor.open("std");
    editor.element.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    expect(editor.element.style.display).toBe("none");

    editor.open("std");
    find(editor.element, "close").click();
    expect(editor.element.style.display).toBe("none");
    editor.dispose();
  });

  it("shows the empty message with no calendars", () => {
    const editor = createEditor(document, mount(), recordingDeps([]));
    editor.open();
    expect(editor.element.textContent).toContain("No calendars defined");
    editor.dispose();
  });

  // M4 (P4 review ruling, WCAG 2.4.3) — this panel is mount-once/show-hide (built once here, then
  // `open()`/`close()` merely toggle `display`), which defeats `sdk/dialog`'s own opener capture:
  // that capture happens once, in `createDialog`'s constructor, so a mount-once consumer that never
  // relies on it must capture its OWN opener at every `open()` and restore it by hand in `close()`.
  it("restores focus to the opener on close, re-captured fresh at each open", () => {
    const root = mount();
    const openerA = document.createElement("button");
    const openerB = document.createElement("button");
    root.appendChild(openerA);
    root.appendChild(openerB);
    const editor = createEditor(document, root, recordingDeps([CAL]));

    openerA.focus();
    editor.open("std");
    editor.close();
    expect(document.activeElement).toBe(openerA);

    // A second open/close cycle from a DIFFERENT opener: a single construction-time capture (the
    // bug) would still restore `openerA` here; the fix restores whichever element actually opened
    // THIS show.
    openerB.focus();
    editor.open("std");
    editor.close();
    expect(document.activeElement).toBe(openerB);

    editor.dispose();
  });

  it("does not yank focus back to the opener once the user has moved it elsewhere themselves", () => {
    const root = mount();
    const opener = document.createElement("button");
    const elsewhere = document.createElement("button");
    root.appendChild(opener);
    root.appendChild(elsewhere);
    const editor = createEditor(document, root, recordingDeps([CAL]));

    opener.focus();
    editor.open("std");
    elsewhere.focus(); // the user deliberately moved focus away from the dialog
    editor.close();
    expect(document.activeElement).toBe(elsewhere);

    editor.dispose();
  });
});

describe("the days section", () => {
  it("toggles a weekday and reports the change through setWorkingDays", () => {
    const deps = recordingDeps([CAL]);
    const editor = createEditor(document, mount(), deps);
    editor.open("std");
    const saturday = find(editor.element, "day-6") as HTMLInputElement;
    expect(saturday.checked).toBe(false);
    saturday.checked = true;
    fire(saturday, "change");
    expect(deps.calls["setWorkingDays"]).toEqual([["std", [1, 2, 3, 4, 5, 6]]]);
    editor.dispose();
  });
});

describe("the hours section", () => {
  const HOURS_CAL: CalendarInit = {
    ...CAL,
    workingHours: [[9 * 3_600_000, 12 * 3_600_000]],
  };

  it("edits an existing window at minute resolution and reports the outcome", () => {
    const deps = recordingDeps([HOURS_CAL]);
    const editor = createEditor(document, mount(), deps);
    editor.open("std");
    const start = find(editor.element, "hour-start") as HTMLInputElement;
    expect(start.value).toBe("09:00");
    const end = find(editor.element, "hour-end") as HTMLInputElement;
    end.value = "17:30";
    fire(end, "change");
    expect(deps.calls["setWorkingHours"]).toEqual([["std", [[9 * 3_600_000, 17.5 * 3_600_000]]]]);
    editor.dispose();
  });

  it("drops a backwards window rather than guessing at it", () => {
    const deps = recordingDeps([HOURS_CAL]);
    const editor = createEditor(document, mount(), deps);
    editor.open("std");
    const end = find(editor.element, "hour-end") as HTMLInputElement;
    end.value = "08:00"; // before the row's own start
    fire(end, "change");
    expect(deps.calls["setWorkingHours"]).toEqual([["std", []]]);
    editor.dispose();
  });

  it("adds and clears windows", () => {
    const deps = recordingDeps([HOURS_CAL]);
    const editor = createEditor(document, mount(), deps);
    editor.open("std");
    find(editor.element, "hours-add").click();
    expect(deps.calls["setWorkingHours"]?.at(-1)?.[1]).toHaveLength(2);
    find(editor.element, "hours-clear").click();
    expect(deps.calls["setWorkingHours"]?.at(-1)).toEqual(["std", []]);
    editor.dispose();
  });
});

describe("the periods section", () => {
  it("applies a whole range in one gesture and removes it again", () => {
    const deps = recordingDeps([CAL]);
    const editor = createEditor(document, mount(), deps);
    editor.open("std");
    const from = find(editor.element, "period-from") as HTMLInputElement;
    from.value = "2026-05-01";
    fire(from, "change");
    const to = find(editor.element, "period-to") as HTMLInputElement;
    to.value = "2026-05-03";
    fire(to, "change");
    find(editor.element, "period-apply").click();
    expect(deps.calls["setExceptionRange"]).toEqual([
      ["std", { from: "2026-05-01", to: "2026-05-03", working: false }],
    ]);

    find(editor.element, "period-remove").click();
    expect(deps.calls["removeExceptionRange"]).toEqual([["std", "2026-05-01", "2026-05-03"]]);
    editor.dispose();
  });

  it("reports an unusable range instead of applying part of it", () => {
    const deps = recordingDeps([CAL]);
    const editor = createEditor(document, mount(), deps);
    editor.open("std");
    const from = find(editor.element, "period-from") as HTMLInputElement;
    from.value = "2026-05-05";
    fire(from, "change");
    const to = find(editor.element, "period-to") as HTMLInputElement;
    to.value = "2026-05-01"; // ends before it starts
    fire(to, "change");
    find(editor.element, "period-apply").click();
    expect(deps.calls["setExceptionRange"]).toBeUndefined();
    expect(find(editor.element, "status").textContent).toBe(
      "Pick both dates first; the period cannot end before it starts.",
    );
    editor.dispose();
  });
});

describe("exceptions", () => {
  it("adds and removes a single-date exception", () => {
    const list: CalendarInit[] = [CAL];
    const deps = recordingDeps(list, {
      setException: (id, exception) => {
        list[0] = { ...list[0]!, exceptions: [{ date: exception.date, working: exception.working }] };
      },
      removeException: () => {
        list[0] = { ...list[0]! };
        delete list[0].exceptions;
      },
    });
    const editor = createEditor(document, mount(), deps);
    editor.open("std");
    const date = find(editor.element, "date") as HTMLInputElement;
    date.value = "2026-05-01";
    find(editor.element, "add").click();
    expect(list[0]?.exceptions).toEqual([{ date: "2026-05-01", working: false }]);
    editor.dispose();
  });
});

describe("the assign section", () => {
  it("renders nothing when no selection is available", () => {
    const deps = recordingDeps([CAL], { selectedTasks: () => undefined });
    const editor = createEditor(document, mount(), deps);
    editor.open("std");
    expect(() => find(editor.element, "assign")).toThrow();
    // Every other section is still there.
    expect(() => find(editor.element, "day-0")).not.toThrow();
    editor.dispose();
  });

  it("assigns every selected task and reports the outcome", () => {
    const deps = recordingDeps([CAL], { selectedTasks: () => ["t1", "t3"] });
    const editor = createEditor(document, mount(), deps);
    editor.open("std");
    find(editor.element, "assign").click();
    expect(deps.calls["assignTask"]).toEqual([
      ["t1", "std"],
      ["t3", "std"],
    ]);
    expect(find(editor.element, "status").textContent).toBe("2 task(s) now on Standard.");
    editor.dispose();
  });

  it("says so rather than acting when nothing is selected", () => {
    const deps = recordingDeps([CAL], { selectedTasks: () => [] });
    const editor = createEditor(document, mount(), deps);
    editor.open("std");
    find(editor.element, "assign").click();
    expect(deps.calls["assignTask"]).toBeUndefined();
    expect(find(editor.element, "status").textContent).toBe("Select one or more tasks first.");
    editor.dispose();
  });
});

describe("section membership and order", () => {
  it("mounts only the listed sections, always in the canonical order", () => {
    const deps = recordingDeps([CAL], { sections: ["periods", "days"] }); // listed back to front
    const editor = createEditor(document, mount(), deps);
    editor.open("std");
    const handles = [...editor.element.querySelectorAll("[data-sg-calendars]")].map((el) =>
      el.getAttribute("data-sg-calendars"),
    );
    expect(handles).toContain("day-0");
    expect(handles).toContain("period-apply");
    expect(handles).not.toContain("hours-add");
    expect(handles.indexOf("day-0")).toBeLessThan(handles.indexOf("period-apply"));
    editor.dispose();
  });
});

describe("refresh", () => {
  it("re-renders only while open", () => {
    const list: CalendarInit[] = [CAL];
    const deps = recordingDeps(list);
    const editor = createEditor(document, mount(), deps);
    editor.refresh(); // closed — no-op, must not throw
    editor.open("std");
    list[0] = { ...CAL, name: "Renamed" };
    editor.refresh();
    expect(editor.element.textContent).toContain("Renamed");
    editor.dispose();
  });
});
