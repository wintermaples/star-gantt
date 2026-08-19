// docs/specs/plugins/scheduling.md §6.3
/**
 * The working-calendar editor: a hidden draggable dialog over the chart carrying the whole service
 * surface — the calendar picker, the weekly pattern, the intra-day working windows, special periods
 * with the exception list, and putting the selection on a calendar. Hostless — it takes a document,
 * a mount element and callbacks, so the whole panel is unit-testable without booting a chart,
 * built on `sdk/dialog`'s `createDialog`.
 */
import { createDialog } from "@stargantt/sdk";
import type { Dialog } from "@stargantt/sdk";
import type { CalendarId, TaskId } from "@stargantt/plugin-data-store";
import type { CalendarEditorSection, CalendarInit } from "../../config";
import type { SchedulingMessages } from "../messages";
import type { CalendarExceptionRange } from "./service";

/** What the editor needs from the plugin — registry reads and edit callbacks. */
export interface EditorDeps {
  messages: SchedulingMessages;
  /** BCP-47 tag driving the weekday initials (`Intl`, not the catalog). */
  locale: string;
  /** Which sections to build, already normalized to the canonical order. */
  sections: readonly CalendarEditorSection[];
  list(): readonly Readonly<CalendarInit>[];
  setWorkingDays(id: CalendarId, days: readonly number[]): void;
  setWorkingHours(id: CalendarId, windows: readonly (readonly [number, number])[]): void;
  setException(id: CalendarId, exception: { date: string; working: boolean; hours?: [number, number][] }): void;
  removeException(id: CalendarId, date: string): void;
  setExceptionRange(id: CalendarId, range: CalendarExceptionRange): void;
  removeExceptionRange(id: CalendarId, from: string, to: string): void;
  /**
   * The selected task ids, or `undefined` when no selection service is available — in which case
   * the `"assign"` section renders nothing rather than showing controls that cannot work.
   */
  selectedTasks(): readonly TaskId[] | undefined;
  assignTask(taskId: TaskId, calendarId: CalendarId | undefined): void;
}

/** The editor's handle, owned and disposed by the plugin. */
export interface Editor {
  open(id?: CalendarId): void;
  close(): void;
  /** Re-renders the panel if it is open (registry changed underneath it). */
  refresh(): void;
  readonly element: HTMLElement;
  dispose(): void;
}

const MS_HOUR = 3_600_000;
const MS_MINUTE = 60_000;
/** One minute short of midnight: the latest instant an `<input type="time">` can express. */
const LAST_EXPRESSIBLE_MS = 86_340_000;

/**
 * The box the dialog opens at (§6.3): wide enough for a date range plus its designation on one
 * line, never wide enough to cover the bars the calendar is being edited against, and pane-relative
 * at both ends so the 720×540 floor needs no special case.
 */
const BOX = {
  width: "min(460px, 92%)",
  minWidth: "min(380px, 92%)",
  maxWidth: "min(560px, 92%)",
  maxHeight: "82%",
  top: 16,
} as const;

/** The 8px rhythm the body is laid out on (visual-design: 4/8/12/16/24). */
const GAP = { row: "8px", section: "16px", legend: "6px", label: "6px" } as const;

/** Control height: past WCAG 2.2 §2.5.8's 24px target floor with room for a border. */
const CONTROL_HEIGHT = "28px";

/** Short localized weekday initials for Sunday..Saturday, via `Intl` (never the catalog). */
export function weekdayInitials(locale: string): string[] {
  let format: (d: Date) => string;
  try {
    const f = new Intl.DateTimeFormat(locale, { weekday: "short", timeZone: "UTC" });
    format = (d) => f.format(d);
  } catch {
    format = (d) => ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"][d.getUTCDay()] as string;
  }
  // 2023-01-01 was a Sunday.
  return [0, 1, 2, 3, 4, 5, 6].map((i) => format(new Date(Date.UTC(2023, 0, 1 + i))));
}

/** `"09:30"` → milliseconds from UTC midnight; `undefined` for an empty or partial field. */
export function timeToMs(value: string): number | undefined {
  const parts = /^(\d{1,2}):(\d{2})/.exec(value);
  if (parts === null) return undefined;
  const h = Number(parts[1]);
  const m = Number(parts[2]);
  if (h > 23 || m > 59) return undefined;
  return h * MS_HOUR + m * MS_MINUTE;
}

/** The inverse, at the minute resolution `<input type="time">` offers. */
export function msToTime(ms: number): string {
  // 24:00 is not expressible in a time field, so a window closing at midnight shows as 23:59.
  const total = Math.max(0, Math.min(LAST_EXPRESSIBLE_MS, Math.round(ms / MS_MINUTE) * MS_MINUTE));
  const h = Math.floor(total / MS_HOUR);
  const m = Math.floor((total % MS_HOUR) / MS_MINUTE);
  return `${h < 10 ? "0" : ""}${String(h)}:${m < 10 ? "0" : ""}${String(m)}`;
}

/**
 * Builds the (initially hidden) editor panel and appends it to `mount`.
 *
 * All controls are native form elements, keyboard operable and labelled from the catalog; Escape
 * inside the panel closes it (the dialog's own `onClose`). Every edit is forwarded to the deps
 * callbacks immediately, and states its outcome in the panel's polite live region (§6.3) — a
 * registry edit's effect is a shading change the reader may not be looking at, and an assignment's
 * is nothing at all until something reschedules.
 */
export function createEditor(doc: Document, mount: HTMLElement, deps: EditorDeps): Editor {
  const m = deps.messages;

  // §6.3 — the shared dialog chrome, not a corner panel: a header the pointer drags, a scrolling
  // body, a resize grip, pointer containment and Escape, all themed through the `--sg-dialog-*`
  // family. Editing a calendar is watching the shading move, so the box has to be movable off the
  // bars it is about.
  const dialog: Dialog = createDialog({
    host: mount,
    className: "sg-calendars-editor",
    label: m.editorTitle,
    draggable: true,
    resizable: true,
    // Not `closeButton`: `sdk/dialog`'s built-in button carries no `data-sg-calendars` handle, and
    // the earlier close control did (`"close"`, matched by every editor test and by any host script
    // driving the panel the same way it drives every other control here) — built by hand below,
    // through the same `button()` helper every other control uses, so it gets the handle too.
    width: BOX.width,
    minWidth: BOX.minWidth,
    maxWidth: BOX.maxWidth,
    maxHeight: BOX.maxHeight,
    top: BOX.top,
    onClose: () => close(),
  });
  const panel = dialog.root;
  panel.style.display = "none";
  const closeBtn = button("close", m.close);
  dialog.header.appendChild(closeBtn);
  closeBtn.addEventListener("click", () => close());

  const initials = weekdayInitials(deps.locale);
  const wants = (section: CalendarEditorSection): boolean => deps.sections.includes(section);
  let openState = false;
  let current: CalendarId | undefined;
  /** The period form's fields, kept across re-renders so a half-filled period is not lost. */
  const period = { from: "", to: "", working: false, useHours: false, fromMs: "09:00", toMs: "13:00" };

  // The body is two nodes: the content, which every render replaces wholesale, and the live region,
  // which is built once and only ever has its text rewritten — an aria-live node that is removed
  // and re-created on each edit announces nothing reliably.
  const content = doc.createElement("div");
  const live = doc.createElement("p");
  live.setAttribute("data-sg-calendars", "status");
  live.setAttribute("role", "status");
  live.setAttribute("aria-live", "polite");
  live.style.margin = `${GAP.row} 0 0`;
  live.style.minHeight = "1em";
  dialog.body.appendChild(content);
  dialog.body.appendChild(live);

  function labelled(tag: string, text: string): HTMLElement {
    const el = doc.createElement(tag);
    el.textContent = text;
    return el;
  }

  /** A wrapping row of controls on the 8px grid — the layout every section is built from. */
  function row(): HTMLElement {
    const el = doc.createElement("div");
    el.style.display = "flex";
    el.style.flexWrap = "wrap";
    el.style.alignItems = "center";
    el.style.gap = GAP.row;
    el.style.marginTop = GAP.legend;
    // At the 720×540 floor the chart pane is 240px wide and the box with it: a row that cannot
    // shrink below its content pushes its controls out through the body's edge.
    el.style.minWidth = "0";
    return el;
  }

  function button(handle: string, text: string, ariaLabel?: string): HTMLButtonElement {
    const el = doc.createElement("button") as HTMLButtonElement;
    el.setAttribute("type", "button");
    el.setAttribute("data-sg-calendars", handle);
    el.textContent = text;
    if (ariaLabel !== undefined) el.setAttribute("aria-label", ariaLabel);
    // WCAG 2.2 §2.5.8 — the visible box already clears the 24×24 CSS px target floor.
    el.style.minHeight = CONTROL_HEIGHT;
    el.style.padding = "2px 10px";
    el.style.border = "1px solid var(--sg-dialog-border, #d6d3d1)";
    el.style.borderRadius = "4px";
    el.style.background = "var(--sg-dialog-header-bg, #f4f6f8)";
    el.style.color = "inherit";
    el.style.font = "inherit";
    el.style.cursor = "pointer";
    return el;
  }

  function field(type: string, handle: string, value: string, ariaLabel?: string): HTMLInputElement {
    const el = doc.createElement("input") as HTMLInputElement;
    el.setAttribute("type", type);
    el.setAttribute("data-sg-calendars", handle);
    el.value = value;
    if (ariaLabel !== undefined) el.setAttribute("aria-label", ariaLabel);
    el.style.minHeight = CONTROL_HEIGHT;
    el.style.padding = "2px 6px";
    el.style.border = "1px solid var(--sg-dialog-border, #d6d3d1)";
    el.style.borderRadius = "4px";
    el.style.font = "inherit";
    return el;
  }

  /** A checkbox with its caption, as one 24px-tall target. */
  function checkbox(handle: string, caption: string, checked: boolean): HTMLElement {
    const label = doc.createElement("label");
    label.style.display = "inline-flex";
    label.style.alignItems = "center";
    label.style.gap = GAP.label;
    label.style.minHeight = "24px";
    label.style.cursor = "pointer";
    const box = doc.createElement("input") as HTMLInputElement;
    box.setAttribute("type", "checkbox");
    box.setAttribute("data-sg-calendars", handle);
    box.checked = checked;
    label.appendChild(box);
    label.appendChild(labelled("span", caption));
    return label;
  }

  /** A label wrapping its own control, so the caption is part of the control's target. */
  function labelFor(caption: string, control: HTMLElement): HTMLElement {
    const label = doc.createElement("label");
    label.style.display = "inline-flex";
    label.style.alignItems = "center";
    label.style.gap = GAP.label;
    // Shrinkable, so a wide control inside it (the calendar picker) narrows with the box instead
    // of overflowing it at the viewport floor.
    label.style.minWidth = "0";
    label.style.maxWidth = "100%";
    label.appendChild(labelled("span", caption));
    label.appendChild(control);
    return label;
  }

  function select(handle: string, ariaLabel: string): HTMLSelectElement {
    const el = doc.createElement("select") as HTMLSelectElement;
    el.setAttribute("data-sg-calendars", handle);
    el.setAttribute("aria-label", ariaLabel);
    el.style.minHeight = CONTROL_HEIGHT;
    el.style.font = "inherit";
    return el;
  }

  function fieldset(legend: string): HTMLElement {
    const set = doc.createElement("fieldset");
    set.style.margin = `0 0 ${GAP.section}`;
    set.style.border = "0";
    set.style.padding = "0";
    set.style.minWidth = "0";
    const caption = labelled("legend", legend);
    caption.style.padding = "0";
    caption.style.fontWeight = "600";
    set.appendChild(caption);
    return set;
  }

  /** One row of a hairline-separated list (the window rows, the exception rows). */
  function listRow(): HTMLElement {
    const el = row();
    el.style.marginTop = "0";
    el.style.minHeight = CONTROL_HEIGHT;
    el.style.padding = "4px 0";
    el.style.borderTop = "1px solid var(--sg-dialog-border, #d6d3d1)";
    return el;
  }

  /**
   * Announces an edit's outcome. Only the live region is rewritten: a registry edit reaches the
   * panel again through the plugin's own `CalendarsService.state` refresh, so re-rendering here too
   * would do it twice and pull the focus out of the control that was just used.
   */
  function say(text: string): void {
    live.textContent = text;
  }

  /* ---------------------------------------------------------------- sections */

  function renderDays(cal: Readonly<CalendarInit>): HTMLElement {
    const set = fieldset(m.workingDaysLegend);
    const days = row();
    // 12px between weekdays rather than the row's 8px: seven checkbox+caption pairs at 8px read as
    // one run of text, and the pair is what has to be scannable.
    days.style.gap = "12px";
    for (let day = 0; day < 7; day += 1) {
      const caption = initials[day] ?? String(day);
      const label = checkbox(`day-${String(day)}`, caption, cal.workingDays.includes(day));
      const box = label.children[0] as HTMLInputElement;
      box.addEventListener("change", () => {
        const set2 = new Set(cal.workingDays);
        if (box.checked) set2.add(day);
        else set2.delete(day);
        const next = [...set2].sort((a, b) => a - b);
        deps.setWorkingDays(cal.id, next);
        say(m.statusWorkingDays(next.map((d) => initials[d] ?? String(d))));
      });
      days.appendChild(label);
    }
    set.appendChild(days);
    return set;
  }

  function renderHours(cal: Readonly<CalendarInit>): HTMLElement {
    const set = fieldset(m.hoursLegend);
    const rows = doc.createElement("div");
    rows.setAttribute("data-sg-calendars", "hours");
    const windows = cal.workingHours ?? [];
    /** The live rows, in display order; a removed row is dropped from it, never re-read. */
    const editors: { from: HTMLInputElement; to: HTMLInputElement }[] = [];

    /** Reads every row and writes the whole window list back in one service call. */
    const commit = (): void => {
      const next: [number, number][] = [];
      for (const editor of editors) {
        const start = timeToMs(editor.from.value);
        const end = timeToMs(editor.to.value);
        // An incomplete or backwards window is dropped rather than guessed at; the row stays on
        // screen so the reader can see what was rejected and fix it.
        if (start === undefined || end === undefined || end <= start) continue;
        next.push([start, end]);
      }
      deps.setWorkingHours(cal.id, next);
      say(m.statusWorkingHours(next.length));
    };

    for (const [start, end] of windows) {
      const line = listRow();
      const from = field("time", "hour-start", msToTime(start), m.windowStartLabel);
      const to = field("time", "hour-end", msToTime(end), m.windowEndLabel);
      const entry = { from, to };
      editors.push(entry);
      // A word, not a glyph: an unlabelled "−" beside a state marker reads as a second marker
      // (§6.3). The accessible name still names the window it removes.
      const remove = button(
        "hour-remove",
        m.removeButton,
        m.removeWindow({ from: msToTime(start), to: msToTime(end) }),
      );
      remove.style.marginLeft = "auto";
      from.addEventListener("change", commit);
      to.addEventListener("change", commit);
      remove.addEventListener("click", () => {
        const at = editors.indexOf(entry);
        if (at >= 0) editors.splice(at, 1);
        line.remove();
        commit();
      });
      line.appendChild(from);
      line.appendChild(labelled("span", "–"));
      line.appendChild(to);
      line.appendChild(remove);
      rows.appendChild(line);
    }
    if (windows.length === 0) {
      const empty = labelled("p", m.noWindows);
      empty.style.margin = `${GAP.legend} 0 0`;
      empty.style.color = "var(--sg-muted-fg, #78716c)";
      set.appendChild(empty);
    }
    set.appendChild(rows);

    const actions = row();
    const add = button("hours-add", m.addWindow);
    add.addEventListener("click", () => {
      const next: [number, number][] = windows.map(([s, e]): [number, number] => [s, e]);
      next.push([9 * MS_HOUR, 17 * MS_HOUR]);
      deps.setWorkingHours(cal.id, next);
      say(m.statusWorkingHours(next.length));
    });
    const clear = button("hours-clear", m.clearWindows);
    clear.addEventListener("click", () => {
      deps.setWorkingHours(cal.id, []);
      say(m.statusWorkingHours(0));
    });
    actions.appendChild(add);
    actions.appendChild(clear);
    set.appendChild(actions);
    return set;
  }

  /** The inclusive `[from, to]` range in the period form, or `undefined` with a reason said. */
  function periodRange(): { from: string; to: string; days: number } | undefined {
    if (period.from === "" || period.to === "" || period.to < period.from) {
      say(m.statusPeriodInvalid);
      return undefined;
    }
    const from = Date.parse(period.from);
    const to = Date.parse(period.to);
    if (!Number.isFinite(from) || !Number.isFinite(to)) {
      say(m.statusPeriodInvalid);
      return undefined;
    }
    return { from: period.from, to: period.to, days: Math.round((to - from) / 86_400_000) + 1 };
  }

  function renderPeriods(cal: Readonly<CalendarInit>): HTMLElement {
    const set = fieldset(m.periodsLegend);

    const fromField = field("date", "period-from", period.from, m.fromLabel);
    fromField.addEventListener("change", () => void (period.from = fromField.value));
    const toField = field("date", "period-to", period.to, m.toLabel);
    toField.addEventListener("change", () => void (period.to = toField.value));

    const kind = select("period-kind", m.periodKindLabel);
    for (const [value, text] of [
      ["off", m.periodNonWorking],
      ["on", m.periodWorking],
    ] as const) {
      const option = doc.createElement("option") as HTMLOptionElement;
      option.value = value;
      option.textContent = text;
      if ((value === "on") === period.working) option.setAttribute("selected", "selected");
      kind.appendChild(option);
    }
    kind.value = period.working ? "on" : "off";
    kind.addEventListener("change", () => {
      period.working = kind.value === "on";
      render();
    });

    const hoursLabel = checkbox("period-hours", m.periodHoursLabel, period.useHours);
    const hoursBox = hoursLabel.children[0] as HTMLInputElement;
    // Intra-day windows only mean something on a working period.
    hoursBox.disabled = !period.working;
    hoursBox.addEventListener("change", () => {
      period.useHours = hoursBox.checked;
      render();
    });

    const enabled = period.working && period.useHours;
    const hoursFrom = field("time", "period-hours-start", period.fromMs, m.windowStartLabel);
    hoursFrom.disabled = !enabled;
    hoursFrom.addEventListener("change", () => void (period.fromMs = hoursFrom.value));
    const hoursTo = field("time", "period-hours-end", period.toMs, m.windowEndLabel);
    hoursTo.disabled = !enabled;
    hoursTo.addEventListener("change", () => void (period.toMs = hoursTo.value));

    const apply = button("period-apply", m.applyPeriod);
    apply.addEventListener("click", () => {
      const range = periodRange();
      if (range === undefined) return;
      const designation: CalendarExceptionRange = {
        from: range.from,
        to: range.to,
        working: period.working,
      };
      if (period.working && period.useHours) {
        const start = timeToMs(period.fromMs);
        const end = timeToMs(period.toMs);
        if (start === undefined || end === undefined || end <= start) {
          say(m.statusWindowInvalid);
          return;
        }
        designation.hours = [[start, end]];
      }
      // One call, one store commit, one repaint — however many days the period covers.
      deps.setExceptionRange(cal.id, designation);
      say(m.statusPeriodApplied({ days: range.days, from: range.from, working: period.working }));
    });

    const remove = button("period-remove", m.removePeriod);
    remove.addEventListener("click", () => {
      const range = periodRange();
      if (range === undefined) return;
      const before = (cal.exceptions ?? []).length;
      deps.removeExceptionRange(cal.id, range.from, range.to);
      const after = (deps.list().find((c) => c.id === cal.id)?.exceptions ?? []).length;
      say(m.statusPeriodRemoved(before - after));
    });

    // One thought per row rather than one wrapping run — the range, its designation, its hours,
    // then the two actions — so nothing lands mid-sentence at the narrow end of the box (§6.3).
    const range = row();
    range.appendChild(labelFor(m.fromLabel, fromField));
    range.appendChild(labelFor(m.toLabel, toField));
    set.appendChild(range);

    const designationRow = row();
    // The picker carries a visible caption as well as its accessible name: on its own a lone
    // "Non-working" says nothing about what it governs.
    designationRow.appendChild(labelFor(m.periodKindLabel, kind));
    set.appendChild(designationRow);

    const hours = row();
    hours.appendChild(hoursLabel);
    hours.appendChild(hoursFrom);
    hours.appendChild(labelled("span", "–"));
    hours.appendChild(hoursTo);
    set.appendChild(hours);

    const actions = row();
    actions.appendChild(apply);
    actions.appendChild(remove);
    set.appendChild(actions);

    // The exception list and the single-date add form the editor has always carried.
    set.appendChild(renderExceptions(cal));
    set.appendChild(renderAddException(cal));
    return set;
  }

  /** How one exception day reads: the date, then its designation **in words** (§6.3). */
  function exceptionTag(
    exception: Readonly<{ working: boolean; hours?: readonly (readonly [number, number])[] }>,
  ): string {
    if (!exception.working) return m.exceptionNonWorking;
    const windows = exception.hours ?? [];
    if (windows.length === 0) return m.exceptionWorkingDefault;
    return m.exceptionWorkingHours(
      windows.map(([start, end]) => `${msToTime(start)}–${msToTime(end)}`).join(", "),
    );
  }

  function renderExceptions(cal: Readonly<CalendarInit>): HTMLElement {
    const list = doc.createElement("ul");
    list.setAttribute("data-sg-calendars", "exceptions");
    list.style.listStyle = "none";
    list.style.margin = `${GAP.row} 0 0`;
    list.style.padding = "0";
    list.style.maxHeight = "180px";
    list.style.overflowY = "auto";
    for (const exception of cal.exceptions ?? []) {
      const line = listRow();
      // `li` cannot be produced by `listRow()` without giving up its list semantics, so the row's
      // styles are re-applied to one.
      const item = doc.createElement("li");
      item.style.cssText = line.style.cssText;
      const date = labelled("span", exception.date);
      date.style.fontVariantNumeric = "tabular-nums";
      const tag = labelled("span", exceptionTag(exception));
      tag.style.color = "var(--sg-muted-fg, #78716c)";
      const remove = button(`remove-${exception.date}`, m.removeButton, m.removeException(exception.date));
      remove.style.marginLeft = "auto";
      remove.addEventListener("click", () => {
        deps.removeException(cal.id, exception.date);
        say(m.statusExceptionRemoved(exception.date));
      });
      item.appendChild(date);
      item.appendChild(tag);
      item.appendChild(remove);
      list.appendChild(item);
    }
    return list;
  }

  function renderAddException(cal: Readonly<CalendarInit>): HTMLElement {
    const wrap = row();
    const date = field("date", "date", "");
    wrap.appendChild(labelFor(m.dateLabel, date));

    const workingLabel = checkbox("working", m.workingLabel, false);
    const working = workingLabel.children[0] as HTMLInputElement;
    wrap.appendChild(workingLabel);

    const add = button("add", m.addException);
    add.addEventListener("click", () => {
      if (date.value === "") return;
      // Coerced, not forwarded: the registry drops an entry whose `working` is not a boolean, and
      // an unchecked box reports `undefined` wherever the property was never assigned.
      deps.setException(cal.id, { date: date.value, working: working.checked === true });
      say(m.statusExceptionAdded(date.value));
    });
    wrap.appendChild(add);
    return wrap;
  }

  function renderAssign(cal: Readonly<CalendarInit>): HTMLElement | undefined {
    // A view of a selection that does not exist is dead controls, so the section stands down
    // entirely when no selection service is available (§6.3).
    if (deps.selectedTasks() === undefined) return undefined;
    const set = fieldset(m.assignLegend);

    const assign = button("assign", m.assignSelected);
    assign.addEventListener("click", () => void applyAssignment(cal.id, true));
    const unassign = button("unassign", m.unassignSelected);
    unassign.addEventListener("click", () => void applyAssignment(cal.id, false));

    const actions = row();
    actions.appendChild(assign);
    actions.appendChild(unassign);
    set.appendChild(actions);
    return set;
  }

  function applyAssignment(id: CalendarId, attach: boolean): void {
    const ids = deps.selectedTasks() ?? [];
    if (ids.length === 0) {
      say(m.statusNoSelection);
      return;
    }
    for (const taskId of ids) deps.assignTask(taskId, attach ? id : undefined);
    const cal = deps.list().find((c) => c.id === id);
    say(
      attach
        ? m.statusAssigned({ count: ids.length, calendar: cal?.name ?? String(id) })
        : m.statusUnassigned(ids.length),
    );
  }

  /* ---------------------------------------------------------------- panel */

  function render(): void {
    // The title and the close button are the dialog's header, built once; only the body is
    // re-rendered, so a re-render can never move the box or the control that opened it.
    content.textContent = "";

    const calendars = deps.list();
    if (calendars.length === 0) {
      content.appendChild(labelled("p", m.empty));
      return;
    }
    if (current === undefined || !calendars.some((c) => c.id === current)) {
      current = calendars[0]?.id;
    }
    const cal = calendars.find((c) => c.id === current);
    if (cal === undefined) return;

    // Calendar picker.
    const picker = select("picker", m.calendarLabel);
    picker.style.minWidth = "0";
    picker.style.flex = "1 1 auto";
    for (const c of calendars) {
      const opt = doc.createElement("option") as HTMLOptionElement;
      opt.value = String(c.id);
      opt.textContent = c.name ?? String(c.id);
      if (c.id === current) opt.setAttribute("selected", "selected");
      picker.appendChild(opt);
    }
    picker.addEventListener("change", () => {
      const chosen = calendars.find((c) => String(c.id) === picker.value);
      current = chosen?.id;
      say("");
      render();
    });
    const pickerRow = row();
    pickerRow.style.marginTop = "0";
    pickerRow.style.marginBottom = GAP.section;
    pickerRow.appendChild(labelFor(m.calendarLabel, picker));
    content.appendChild(pickerRow);

    // Canonical section order, whatever order the config listed them in (§6.3).
    const CANONICAL: readonly CalendarEditorSection[] = ["days", "hours", "periods", "assign"];
    for (const section of CANONICAL) {
      if (!wants(section)) continue;
      const built =
        section === "days"
          ? renderDays(cal)
          : section === "hours"
            ? renderHours(cal)
            : section === "periods"
              ? renderPeriods(cal)
              : renderAssign(cal);
      if (built !== undefined) content.appendChild(built);
    }
  }

  // WCAG 2.4.3 (Focus Order) — `sdk/dialog`'s own opener-restore fires only from `dispose()`
  // (`createDialog`'s module doc), because `sdk/dialog` is built for the mount-per-open callers
  // that dominate the codebase, where dispose IS close. This panel is mount-once/show-hide instead
  // (built once in `createEditor`, then `open()`/`close()` merely toggle `display`), so
  // `sdk/dialog`'s ONE opener capture — taken when `createDialog` first runs, at most once per
  // panel's whole lifetime — would keep restoring focus to whatever had it the very first time the
  // panel opened, not to each individual show's actual opener. M4 (P4 review ruling): captured
  // fresh at every `open()` instead, and restored by hand in `close()`, mirroring `sdk/dialog`'s
  // own dispose()-time safety rule verbatim (only when focus is still "ours", only when the
  // captured element is still connected) so a user who has since moved focus elsewhere is not
  // fought.
  let openerFocus: HTMLElement | null = null;

  function close(): void {
    if (!openState) return;
    openState = false;
    panel.style.display = "none";
    const active = doc.activeElement as HTMLElement | null;
    const focusIsOurs = active === null || active === doc.body || panel.contains?.(active) === true;
    if (
      focusIsOurs &&
      openerFocus !== null &&
      (openerFocus as unknown as { isConnected?: boolean }).isConnected !== false
    ) {
      openerFocus.focus?.();
    }
    openerFocus = null;
  }

  return {
    element: panel,
    open(id?: CalendarId): void {
      if (id !== undefined) current = id;
      // Captured before focus moves into the panel below, exactly as `sdk/dialog` captures its own
      // (constructor-time, single-shot) opener — here taken fresh on every show instead.
      openerFocus = doc.activeElement as HTMLElement | null;
      openState = true;
      render();
      // `flex` rather than `block`: the dialog's own column layout is what makes its body scroll
      // inside the box instead of pushing the footer out of it.
      panel.style.display = "flex";
      // The editor is opened by a deliberate gesture, so the keyboard follows the pointer into it.
      dialog.focus();
    },
    close,
    refresh(): void {
      if (openState) render();
    },
    dispose(): void {
      dialog.dispose();
    },
  };
}
