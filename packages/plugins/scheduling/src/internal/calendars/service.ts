// docs/specs/plugins/scheduling.md §1.2 / §6.1
/**
 * `CalendarsService` — the store-shaped public surface (§1.2) — and `regionCalendar`, the pure
 * weekend+holiday builder; filed here per the file map, §13, which assigns `regionCalendar` to
 * `service.ts` alongside the rest of the service surface.
 *
 * `CalendarExceptionRange`, `RegionCalendarInit` and `CalendarsService` itself are declared here
 * rather than in `../../config` or `../../types` (both outside this file's scope — `src/index.ts`
 * re-exports them and `src/types.ts` carries the matching `declare module` augmentation to make
 * them this package's public surface). `createCalendarsService` is pure/hostless: it
 * takes plain callbacks, never a `PluginContext`, so it is unit-testable with recording doubles.
 */
import {
  addWorkingMs as engineAddWorkingMs,
  isDateKey,
  isWorkingDay as engineIsWorkingDay,
  isWorkingInstant as engineIsWorkingInstant,
  nextWorkingStart as engineNextWorkingStart,
  nonWorkingIntervals,
  previousWorkingEnd as enginePreviousWorkingEnd,
  subtractWorkingMs as engineSubtractWorkingMs,
  workingIntervals as engineWorkingIntervals,
  workingMsBetween as engineWorkingMsBetween,
} from "@stargantt/sdk";
import type { Store } from "@stargantt/core";
import type { CalendarDef, CalendarId, Task, TaskId } from "@stargantt/plugin-data-store";
import type { TimeRange } from "@stargantt/sdk";
import type { CalendarInit } from "../../config";
import { isId, normalizeWindows, normalizeWorkingDays } from "./registry";
import type { CalendarExceptionRangeInput, CalendarRegistry, CalendarsState } from "./registry";

/** Input of the {@link regionCalendar} builder (weekend pattern + holiday list → `CalendarInit`). */
export interface RegionCalendarInit {
  id: CalendarId;
  name?: string;
  isDefault?: boolean;
  /** Weekly non-working days, 0 = Sunday … 6 = Saturday (UTC). Defaults to `[0, 6]`. */
  weekend?: readonly number[];
  /** Holiday dates, `"YYYY-MM-DD"` (UTC). Each becomes a non-working exception. */
  holidays?: readonly string[];
  /** Optional working windows, `[startMs, endMs)` in ms from UTC midnight, forwarded verbatim. */
  workingHours?: [number, number][];
}

/** A special period: one working-time designation over an inclusive `"YYYY-MM-DD"` range. */
export type CalendarExceptionRange = CalendarExceptionRangeInput;

/** Pure builder; unusable weekend entries and malformed dates are dropped. Package export (§1.2). */
export function regionCalendar(init: RegionCalendarInit): CalendarInit {
  const weekend = normalizeWorkingDays(init?.weekend) ?? [0, 6];
  const workingDays = [0, 1, 2, 3, 4, 5, 6].filter((d) => !weekend.includes(d));
  const out: CalendarInit = { id: init?.id as CalendarId, workingDays };
  const holidays = Array.isArray(init?.holidays) ? init.holidays.filter(isDateKey) : [];
  if (holidays.length > 0) {
    out.exceptions = [...new Set(holidays)].sort().map((date) => ({ date, working: false }));
  }
  const workingHours = normalizeWindows(init?.workingHours);
  if (workingHours !== undefined && workingHours.length > 0) out.workingHours = workingHours;
  if (typeof init?.name === "string") out.name = init.name;
  if (init?.isDefault === true) out.isDefault = true;
  return out;
}

/**
 * The working-calendar service other plugins and hosts consult: registry management, working-day
 * queries, per-task calendar assignment, non-working shading control and the exception editor.
 * Member count: 24 (§1.2) — the `state` store + 23 methods.
 */
export interface CalendarsService {
  readonly state: Store<CalendarsState>;
  resolve(id: CalendarId | undefined): Readonly<CalendarDef> | undefined;
  define(calendar: CalendarInit): void;
  remove(id: CalendarId): void;
  setWorkingDays(id: CalendarId, workingDays: readonly number[]): void;
  setWorkingHours(id: CalendarId, workingHours: readonly (readonly [number, number])[]): void;
  setExceptionRange(id: CalendarId, range: CalendarExceptionRange): void;
  removeExceptionRange(id: CalendarId, from: string, to: string): void;
  setException(id: CalendarId, exception: { date: string; working: boolean; hours?: [number, number][] }): void;
  removeException(id: CalendarId, date: string): void;
  effectiveCalendar(taskId: TaskId): Readonly<CalendarDef> | undefined;
  assignTask(taskId: TaskId, calendarId: CalendarId | undefined): void;
  isWorkingDay(calendar: CalendarId | Readonly<CalendarDef> | undefined, t: number): boolean;
  isWorkingInstant(calendar: CalendarId | Readonly<CalendarDef> | undefined, t: number): boolean;
  workingIntervals(calendar: CalendarId | Readonly<CalendarDef> | undefined, from: number, to: number): readonly TimeRange[];
  workingMsBetween(calendar: CalendarId | Readonly<CalendarDef> | undefined, from: number, to: number): number;
  addWorkingMs(calendar: CalendarId | Readonly<CalendarDef> | undefined, start: number, workingMs: number): number;
  subtractWorkingMs(calendar: CalendarId | Readonly<CalendarDef> | undefined, end: number, workingMs: number): number;
  nextWorkingStart(calendar: CalendarId | Readonly<CalendarDef> | undefined, t: number): number;
  previousWorkingEnd(calendar: CalendarId | Readonly<CalendarDef> | undefined, t: number): number;
  nonWorkingRanges(calendar: CalendarId | Readonly<CalendarDef> | undefined, from: number, to: number): readonly TimeRange[];
  setShadeCalendar(id: CalendarId | undefined): void;
  openEditor(id?: CalendarId): void;
  closeEditor(): void;
}

/** What the service needs from the plugin around the registry: data reads, dispatch, the editor. */
export interface CalendarsServiceDeps {
  registry: CalendarRegistry;
  getTask(id: TaskId): Readonly<Task> | undefined;
  /** The data store's own calendars, for `resolve`'s "registry first, then the data store" rule. */
  storeCalendars(): ReadonlyMap<CalendarId, Readonly<CalendarDef>>;
  /** One `task/update` dispatch; `clears` names fields to clear (assignTask's `undefined` path). */
  dispatchTaskUpdate(id: TaskId, after: Record<string, unknown>, clears?: readonly (keyof Task)[]): void;
  openEditor(id?: CalendarId): void;
  closeEditor(): void;
}

export function createCalendarsService(deps: CalendarsServiceDeps): CalendarsService {
  const { registry } = deps;

  function resolve(id: CalendarId | undefined): Readonly<CalendarDef> | undefined {
    if (id === undefined) return undefined;
    return registry.find(id) ?? deps.storeCalendars().get(id);
  }

  /** A raw `CalendarDef` object is accepted as-is when it looks like one; an id is resolved. */
  function toCalendar(
    calendar: CalendarId | Readonly<CalendarDef> | undefined,
  ): Readonly<CalendarDef> | undefined {
    if (calendar === undefined) return undefined;
    if (typeof calendar === "object") {
      return Array.isArray((calendar as CalendarDef).workingDays) ? calendar : undefined;
    }
    return resolve(calendar);
  }

  return {
    // A wrapper rather than `registry.state` handed out directly: third parties get exactly the
    // core `Store` contract (get/subscribe), never the registry's own `set` (§15 "no back-door
    // APIs" — every mutation goes through the named methods below, which is what keeps "one commit
    // per gesture" true for callers who only see this service).
    state: {
      get: () => registry.state.get(),
      subscribe: (fn) => registry.state.subscribe(fn),
    },
    resolve,
    define(calendar): void {
      registry.define(calendar);
    },
    remove(id): void {
      registry.remove(id);
    },
    setWorkingDays(id, workingDays): void {
      registry.setWorkingDays(id, workingDays);
    },
    setWorkingHours(id, workingHours): void {
      registry.setWorkingHours(id, workingHours);
    },
    setExceptionRange(id, range): void {
      registry.setExceptionRange(id, range);
    },
    removeExceptionRange(id, from, to): void {
      registry.removeExceptionRange(id, from, to);
    },
    setException(id, exception): void {
      registry.setException(id, exception);
    },
    removeException(id, date): void {
      registry.removeException(id, date);
    },
    effectiveCalendar(taskId: TaskId): Readonly<CalendarDef> | undefined {
      const task = deps.getTask(taskId);
      if (task === undefined) return undefined;
      const own = resolve(task.calendarId);
      if (own !== undefined) return own;
      return registry.defaultCalendar();
    },
    assignTask(taskId: TaskId, calendarId: CalendarId | undefined): void {
      const task = deps.getTask(taskId);
      if (task === undefined) return;
      if (calendarId === undefined) {
        deps.dispatchTaskUpdate(taskId, {}, ["calendarId"]);
        return;
      }
      if (!isId(calendarId)) return;
      deps.dispatchTaskUpdate(taskId, { calendarId });
    },
    // Every working-time answer below resolves the calendar and delegates to `sdk/time`; the only
    // policy this service adds is what an unresolvable calendar answers — "no calendar, no rest
    // days", i.e. everything is working time (kept verbatim, §1.2).
    isWorkingDay(calendar, t): boolean {
      const cal = toCalendar(calendar);
      if (cal === undefined || !Number.isFinite(t)) return true;
      return engineIsWorkingDay(cal, t);
    },
    isWorkingInstant(calendar, t): boolean {
      const cal = toCalendar(calendar);
      if (cal === undefined || !Number.isFinite(t)) return true;
      return engineIsWorkingInstant(cal, t);
    },
    workingIntervals(calendar, from, to): readonly TimeRange[] {
      const cal = toCalendar(calendar);
      if (cal === undefined) return [];
      return engineWorkingIntervals(cal, from, to);
    },
    workingMsBetween(calendar, from, to): number {
      const cal = toCalendar(calendar);
      if (cal !== undefined) return engineWorkingMsBetween(cal, from, to);
      if (!(Number.isFinite(from) && Number.isFinite(to))) return 0;
      return Math.max(0, to - from);
    },
    addWorkingMs(calendar, start, workingMs): number {
      const cal = toCalendar(calendar);
      if (cal === undefined) return start + workingMs;
      return engineAddWorkingMs(cal, start, workingMs);
    },
    subtractWorkingMs(calendar, end, workingMs): number {
      const cal = toCalendar(calendar);
      if (cal === undefined) return end - workingMs;
      return engineSubtractWorkingMs(cal, end, workingMs);
    },
    nextWorkingStart(calendar, t): number {
      const cal = toCalendar(calendar);
      if (cal === undefined) return t;
      return engineNextWorkingStart(cal, t);
    },
    previousWorkingEnd(calendar, t): number {
      const cal = toCalendar(calendar);
      if (cal === undefined) return t;
      return enginePreviousWorkingEnd(cal, t);
    },
    nonWorkingRanges(calendar, from, to): readonly TimeRange[] {
      const cal = toCalendar(calendar);
      if (cal === undefined) return [];
      return nonWorkingIntervals(cal, from, to);
    },
    setShadeCalendar(id): void {
      registry.setShadeCalendar(id);
    },
    openEditor(id?: CalendarId): void {
      deps.openEditor(id);
    },
    closeEditor(): void {
      deps.closeEditor();
    },
  };
}
