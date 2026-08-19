// docs/specs/plugins/scheduling.md §1.2 / §2.2 / §6.1
/**
 * The working-calendar registry — the state half of `CalendarsService`, and the calendar-resolution
 * seam the engine and the `snap/workingTime` provider read through.
 *
 * With no `calendars` nest configured and no registry mutator wired, `state.get().calendars` is
 * `[]`, every registry lookup misses, and both consumers degrade to exactly the no-calendars
 * behaviour — the engine resolves against the data store alone and the provider resolves
 * `undefined`, which makes interaction's working-time adjustment a pass-through. When the nest is
 * present, `internal/calendars/wire.ts` fills the same store without touching `index.ts`.
 *
 * Registry edits are deliberately OUTSIDE the transaction/patch/undo pipeline (§1.2); this module
 * therefore owns a plain writable store rather than dispatching anything.
 *
 * The normalization + mutator half of this registry — `define` / `remove` / `setWorkingDays` /
 * `setWorkingHours` / `setException` / `removeException` / `setExceptionRange` /
 * `removeExceptionRange` / `setShadeCalendar` — the nine store-setting methods of §1.2. Each mutator
 * commits the store **once** per call (one announcement per gesture, however many days a special
 * period covers), and only on an actual change (an unusable or no-op call commits nothing and
 * returns `false`).
 *
 * The shaded-calendar resolution (`shadeCalendar()`) is a live computation, not a value that is
 * merely copied forward: `calendars.shadeCalendar` in the published state is always either the
 * explicit id the last `setShadeCalendar` call named, or — while no explicit choice was ever made —
 * the registry's current default calendar, re-derived on every commit so a later `define`/`remove`
 * that changes which calendar carries `isDefault` is reflected without a further `setShadeCalendar`
 * call. `explicitShade` / `shadeId` below are that bookkeeping, kept private to this closure —
 * folded in here because `CalendarsState` merges the registry and the shade choice into one
 * store (§1.2: the `list()` and `shadeCalendar()` accessors fold into the `state` store).
 */
import { createStore } from "@stargantt/core";
import type { WritableStore } from "@stargantt/core";
import {
  MAX_SKIPPED_DAYS,
  MS_DAY,
  dateKeyToTime,
  isDateKey,
  utcDateKey,
} from "@stargantt/sdk";
import type { CalendarDef, CalendarId } from "@stargantt/plugin-data-store";
import type { CalendarInit } from "../../config";
import type { CalendarResolver } from "../../engine/types";

/** The observable component of `CalendarsService` (§1.2). */
export interface CalendarsState {
  /** The registry's calendars, in registration order. */
  readonly calendars: readonly Readonly<CalendarInit>[];
  /** The calendar currently shaded in the chart body, or `undefined` for none. */
  readonly shadeCalendar: CalendarId | undefined;
}

/** One date's exception, as the registry stores it — `CalendarDef["exceptions"]`'s element type. */
type ExceptionEntry = { date: string; working: boolean; hours?: [number, number][] };

/** A special period: one working-time designation over an inclusive `"YYYY-MM-DD"` range (§1.2). */
export interface CalendarExceptionRangeInput {
  from: string;
  to: string;
  working: boolean;
  hours?: [number, number][];
}

/** The registry, as the areas and the engine seam consume it. */
export interface CalendarRegistry {
  /** The store `CalendarsService.state` publishes; the calendars area writes it, the engine only reads. */
  readonly state: WritableStore<CalendarsState>;
  /** The registry entry with this id, or `undefined`. Registry-only — the data store is separate. */
  find(id: CalendarId | undefined): Readonly<CalendarInit> | undefined;
  /**
   * The registry's default calendar: the first entry whose `isDefault === true`. `undefined` when
   * no entry claims it (which is always the case while the registry is empty).
   */
  defaultCalendar(): Readonly<CalendarInit> | undefined;

  /* --- the nine store-setting methods (§1.2) --------------------------- */

  /** Adds or replaces a registry calendar. Returns whether the definition was usable. */
  define(input: unknown): boolean;
  /** Removes a registry calendar. Returns whether it existed. */
  remove(id: CalendarId): boolean;
  /** Replaces a registry calendar's weekly working days. Returns whether anything changed. */
  setWorkingDays(id: CalendarId, days: readonly number[]): boolean;
  /**
   * Replaces a registry calendar's intra-day working windows. An empty (or entirely misshapen)
   * list clears them. Returns whether anything changed.
   */
  setWorkingHours(id: CalendarId, hours: readonly (readonly [number, number])[]): boolean;
  /** Adds or replaces one date's exception. Returns whether anything changed. */
  setException(id: CalendarId, exception: { date: string; working: boolean; hours?: [number, number][] }): boolean;
  /** Removes one date's exception. Returns whether it existed. */
  removeException(id: CalendarId, date: string): boolean;
  /**
   * Adds or replaces the exception of every UTC day in the inclusive `[from, to]` range. Returns
   * whether anything changed; a malformed or inverted range, and one spanning more than the
   * engine's walk bound, changes nothing.
   */
  setExceptionRange(id: CalendarId, range: CalendarExceptionRangeInput): boolean;
  /** Removes every exception dated inside the inclusive `[from, to]`. Returns whether anything changed. */
  removeExceptionRange(id: CalendarId, from: string, to: string): boolean;
  /**
   * Changes the shade choice: an explicit `id` (validated) or `undefined` to explicitly turn
   * shading off. Always commits — the published `shadeCalendar` becomes exactly `id` from this
   * call onward, until the next `setShadeCalendar` call, and no longer follows the registry
   * default even if `id` happens to equal it right now. Returns whether the id was usable
   * (`undefined` is always usable — "turn off" — and any string/number id is usable).
   */
  setShadeCalendar(id: CalendarId | undefined): boolean;
}

/** Whether `v` can serve as a calendar id. */
export function isId(v: unknown): v is CalendarId {
  return typeof v === "string" || typeof v === "number";
}

/** Keeps only integer weekdays 0–6, deduplicated, ascending. */
export function normalizeWorkingDays(days: unknown): number[] | undefined {
  if (!Array.isArray(days)) return undefined;
  const out = new Set<number>();
  for (const d of days) {
    if (typeof d === "number" && Number.isInteger(d) && d >= 0 && d <= 6) out.add(d);
  }
  return [...out].sort((a, b) => a - b);
}

/**
 * Keeps only entries shaped like a `[start, end]` window pair, copied so a later per-day edit
 * cannot alias the caller's arrays. Whether a window is *usable* (finite, positive span once
 * clamped into the day) stays `sdk/time`'s judgement (one working-time engine): this is
 * shape validation, not calendar arithmetic.
 */
export function normalizeWindows(hours: unknown): [number, number][] | undefined {
  if (!Array.isArray(hours)) return undefined;
  const out: [number, number][] = [];
  for (const w of hours) {
    if (!Array.isArray(w) || typeof w[0] !== "number" || typeof w[1] !== "number") continue;
    out.push([w[0], w[1]]);
  }
  return out;
}

/** Orders exception entries by their date key, which sorts chronologically as text. */
function byDateKey(a: { date: string }, b: { date: string }): number {
  return a.date < b.date ? -1 : a.date > b.date ? 1 : 0;
}

/** Keeps only usable exception entries; later entries for a date shadow earlier ones. */
function normalizeExceptions(list: unknown): ExceptionEntry[] | undefined {
  if (!Array.isArray(list)) return undefined;
  const byDate = new Map<string, ExceptionEntry>();
  for (const e of list) {
    if (typeof e !== "object" || e === null) continue;
    const entry = e as { date?: unknown; working?: unknown; hours?: unknown };
    if (!isDateKey(entry.date) || typeof entry.working !== "boolean") continue;
    const clean: ExceptionEntry = { date: entry.date, working: entry.working };
    const hours = normalizeWindows(entry.hours);
    if (hours !== undefined) clean.hours = hours;
    byDate.set(clean.date, clean);
  }
  return [...byDate.values()].sort(byDateKey);
}

/**
 * Normalizes one host-supplied calendar into a clean registry entry, or `undefined` when the
 * definition is unusable (no id, or `workingDays` not an array).
 */
function normalizeCalendarInput(input: unknown): CalendarInit | undefined {
  if (typeof input !== "object" || input === null) return undefined;
  const raw = input as CalendarInit;
  if (!isId(raw.id)) return undefined;
  const workingDays = normalizeWorkingDays(raw.workingDays);
  if (workingDays === undefined) return undefined;
  const out: CalendarInit = { id: raw.id, workingDays };
  const exceptions = normalizeExceptions(raw.exceptions);
  if (exceptions !== undefined && exceptions.length > 0) out.exceptions = exceptions;
  const workingHours = normalizeWindows(raw.workingHours);
  if (workingHours !== undefined && workingHours.length > 0) out.workingHours = workingHours;
  if (typeof raw.name === "string") out.name = raw.name;
  if (raw.isDefault === true) out.isDefault = true;
  return out;
}

/** The first entry in registration order that carries `isDefault === true`. */
function firstDefaultId(calendars: readonly Readonly<CalendarInit>[]): CalendarId | undefined {
  for (const c of calendars) if (c.isDefault === true) return c.id;
  return undefined;
}

/**
 * Builds the registry's initial calendar list from the host-supplied `calendars.calendars` config
 * (§11.3), running each entry through the SAME `normalizeCalendarInput` shape validation `define()`
 * applies to every later addition — an unusable entry is skipped rather than stored verbatim, and a
 * repeated id keeps its first insertion position, exactly as calling `define()` once per entry, in
 * order, would produce. Config is host-authored, so treating it as already-clean would let a
 * malformed `workingDays` (or any other field `normalizeCalendarInput` guards) reach `editCalendar`
 * and every other mutator, which all assume their input is already a valid `CalendarInit`.
 */
function seedCalendars(seed: readonly CalendarInit[]): CalendarInit[] {
  const out: CalendarInit[] = [];
  for (const raw of seed) {
    const clean = normalizeCalendarInput(raw);
    if (clean === undefined) continue;
    const at = out.findIndex((c) => c.id === clean.id);
    if (at >= 0) out[at] = clean;
    else out.push(clean);
  }
  return out;
}

/** Creates the registry, optionally seeded with the `calendars.calendars` entries of §11.3. */
export function createCalendarRegistry(seed: readonly CalendarInit[] = []): CalendarRegistry {
  const initial = seedCalendars(seed);

  // §1.2 shade-choice bookkeeping (module doc above) — private to this closure, never part of the
  // published `CalendarsState` shape itself, only of the `shadeCalendar` value derived from it.
  // Declared before `state` so the seeded calendars' own `isDefault` is already reflected in the
  // FIRST published state, exactly as `commit()` reflects it after every later mutator — a chart
  // seeded with a default calendar and no explicit `calendars.shadeCalendar` shades it from the
  // first paint, not only after the first registry edit.
  let explicitShade = false;
  let shadeId: CalendarId | undefined;

  const state = createStore<CalendarsState>({
    calendars: initial,
    shadeCalendar: explicitShade ? shadeId : firstDefaultId(initial),
  });

  /** Commits `calendars` with the shade choice re-derived, in exactly one `state.set()`. */
  function commit(calendars: readonly Readonly<CalendarInit>[]): void {
    const shadeCalendar = explicitShade ? shadeId : firstDefaultId(calendars);
    state.set({ calendars, shadeCalendar });
  }

  function find(id: CalendarId | undefined): Readonly<CalendarInit> | undefined {
    if (id === undefined) return undefined;
    for (const calendar of state.get().calendars) {
      if (calendar.id === id) return calendar;
    }
    return undefined;
  }

  function defaultCalendar(): Readonly<CalendarInit> | undefined {
    for (const calendar of state.get().calendars) {
      if (calendar.isDefault === true) return calendar;
    }
    return undefined;
  }

  /**
   * Runs `mutate` over a mutable copy of the calendar at `id`, committing the result when it
   * returns a replacement object and leaving the store untouched (returning `false`) when it
   * returns `undefined` — the shared shape every per-calendar mutator below follows.
   */
  function editCalendar(
    id: CalendarId,
    mutate: (cal: Readonly<CalendarInit>) => CalendarInit | undefined,
  ): boolean {
    const list = state.get().calendars;
    const at = list.findIndex((c) => c.id === id);
    if (at < 0) return false;
    const next = mutate(list[at] as Readonly<CalendarInit>);
    if (next === undefined) return false;
    const calendars = list.slice();
    calendars[at] = next;
    commit(calendars);
    return true;
  }

  return {
    state,
    find,
    defaultCalendar,

    define(input: unknown): boolean {
      const clean = normalizeCalendarInput(input);
      if (clean === undefined) return false;
      const list = state.get().calendars;
      const at = list.findIndex((c) => c.id === clean.id);
      const calendars = list.slice();
      // Re-defining keeps the original insertion position, which keeps the first-registered-
      // default rule (and this registry's insertion-order `list()`) stable across edits.
      if (at >= 0) calendars[at] = clean;
      else calendars.push(clean);
      commit(calendars);
      return true;
    },

    remove(id: CalendarId): boolean {
      const list = state.get().calendars;
      const at = list.findIndex((c) => c.id === id);
      if (at < 0) return false;
      const calendars = list.slice();
      calendars.splice(at, 1);
      commit(calendars);
      return true;
    },

    setWorkingDays(id, days): boolean {
      return editCalendar(id, (cal) => {
        const clean = normalizeWorkingDays(days);
        if (clean === undefined) return undefined;
        return { ...cal, workingDays: clean };
      });
    },

    setWorkingHours(id, hours): boolean {
      return editCalendar(id, (cal) => {
        const clean = normalizeWindows(hours);
        if (clean === undefined) return undefined;
        if (clean.length === 0) {
          const { workingHours: _drop, ...rest } = cal;
          return rest;
        }
        return { ...cal, workingHours: clean };
      });
    },

    setException(id, exception): boolean {
      return editCalendar(id, (cal) => {
        if (typeof exception !== "object" || exception === null) return undefined;
        if (!isDateKey(exception.date) || typeof exception.working !== "boolean") return undefined;
        const clean: ExceptionEntry = { date: exception.date, working: exception.working };
        const hours = normalizeWindows(exception.hours);
        if (hours !== undefined) clean.hours = hours;
        const list = cal.exceptions !== undefined ? [...cal.exceptions] : [];
        const at = list.findIndex((e) => e.date === clean.date);
        if (at >= 0) list[at] = clean;
        else {
          list.push(clean);
          list.sort(byDateKey);
        }
        return { ...cal, exceptions: list };
      });
    },

    removeException(id, date): boolean {
      return editCalendar(id, (cal) => {
        if (cal.exceptions === undefined) return undefined;
        const at = cal.exceptions.findIndex((e) => e.date === date);
        if (at < 0) return undefined;
        const list = cal.exceptions.slice();
        list.splice(at, 1);
        if (list.length === 0) {
          const { exceptions: _drop, ...rest } = cal;
          return rest;
        }
        return { ...cal, exceptions: list };
      });
    },

    setExceptionRange(id, range): boolean {
      return editCalendar(id, (cal) => {
        if (typeof range !== "object" || range === null) return undefined;
        if (typeof range.working !== "boolean") return undefined;
        if (!isDateKey(range.from) || !isDateKey(range.to)) return undefined;
        const from = dateKeyToTime(range.from);
        const to = dateKeyToTime(range.to);
        if (from === undefined || to === undefined || to < from) return undefined;
        const days = Math.round((to - from) / MS_DAY) + 1;
        if (days > MAX_SKIPPED_DAYS) return undefined;
        const hours = normalizeWindows(range.hours);
        const byDate = new Map<string, ExceptionEntry>();
        for (const e of cal.exceptions ?? []) byDate.set(e.date, e);
        for (let i = 0; i < days; i += 1) {
          const date = utcDateKey(from + i * MS_DAY);
          // Each day owns its own window array: editing one day afterwards must not rewrite
          // the rest.
          byDate.set(
            date,
            hours === undefined
              ? { date, working: range.working }
              : { date, working: range.working, hours: hours.map((w) => [w[0], w[1]] as [number, number]) },
          );
        }
        return { ...cal, exceptions: [...byDate.values()].sort(byDateKey) };
      });
    },

    removeExceptionRange(id, from, to): boolean {
      return editCalendar(id, (cal) => {
        if (cal.exceptions === undefined) return undefined;
        if (!isDateKey(from) || !isDateKey(to) || to < from) return undefined;
        // Date keys are fixed-width, so text order is chronological order.
        const kept = cal.exceptions.filter((e) => e.date < from || e.date > to);
        if (kept.length === cal.exceptions.length) return undefined;
        if (kept.length === 0) {
          const { exceptions: _drop, ...rest } = cal;
          return rest;
        }
        return { ...cal, exceptions: kept };
      });
    },

    setShadeCalendar(id: CalendarId | undefined): boolean {
      if (id !== undefined && !isId(id)) return false;
      // No-op guard: repeating the SAME already-explicit choice must not re-announce — §1.2's "one
      // commit per gesture" applies to the no-op case too, or a caller polling/re-applying the same
      // choice would repaint and refresh the open editor for nothing on every call. A call that
      // actually changes the pinning (first time explicit, or a different id) still commits, even
      // when the newly PUBLISHED `shadeCalendar` id happens to coincide with what the registry
      // default already produced — going from "follows the default live" to "pinned" is itself a
      // real change in what a LATER `define()`/`remove()` does to the shade.
      if (explicitShade && shadeId === id) return true;
      explicitShade = true;
      shadeId = id;
      commit(state.get().calendars);
      return true;
    },
  };
}

/**
 * The §2.2 calendar resolution the engine passes run with: the registry first, then the data store,
 * then the registry default.
 *
 * `reflect` is `calendars.scheduling` (§11.3): with it `false` the engine resolves against the data
 * store alone — the no-calendars behaviour — and the registry plays no part at all.
 *
 * Deliberate deviation (recorded in §2.2): the earlier implementation resolved registry-only calendars
 * inside propagation but not in the back-clamp or effort passes; with that seam gone, every engine
 * pass resolves through this one function, so a registry-only calendar now constrains those passes too.
 */
export function effectiveCalendarResolver(
  registry: CalendarRegistry,
  reflect: boolean,
): CalendarResolver {
  return (view, task): Readonly<CalendarDef> | undefined => {
    const id = task.calendarId;
    if (!reflect) return id === undefined ? undefined : view.calendars.get(id);
    if (id !== undefined) {
      // Registry calendars shadow store calendars with the same id.
      const registered = registry.find(id);
      if (registered !== undefined) return registered;
      const stored = view.calendars.get(id);
      if (stored !== undefined) return stored;
    }
    return registry.defaultCalendar();
  };
}
