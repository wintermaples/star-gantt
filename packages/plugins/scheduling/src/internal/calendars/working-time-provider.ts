// docs/specs/plugins/scheduling.md §4.1
/**
 * The official `snap/workingTime` contribution — the inversion of the earlier snap → calendars
 * upward edge (interaction.md §3 owns the point; this plugin is its official contributor).
 *
 * One provider, registered unconditionally at setup, backed by the registry of §1.2:
 *
 *  - a **named** `calendar` id resolves only when it is a member of the registry. An id the
 *    registry does not contain returns `undefined` — dates then pass through unchanged on
 *    interaction's side — even when the data store knows the id: this deliberately refuses to hand
 *    snap a reference whose meaning the registry never declared;
 *  - an **omitted** reference resolves to the registry's default calendar (the first entry whose
 *    `isDefault === true`). No default → `undefined`.
 *
 * The returned probes delegate to `sdk/time` over the resolved definition, at whatever granularity
 * the calendar declares. Walks are bounded on this side and return their argument when they give
 * up, satisfying interaction's provider contract; the provider never throws.
 *
 * **Freshness (the dovetail).** Interaction calls `boundaries()` on every working-time adjustment
 * and never caches the result across adjustments; caching is this provider's job. The cache is
 * keyed by calendar reference and dropped whenever the registry state object changes identity, with
 * the same observable freshness as the earlier `calendars/changed` dirty flag: a registry edit is
 * visible to the very next adjustment. (Because `setShadeCalendar` also sets the state store here,
 * shade changes over-invalidate the cache; safe and deliberate.)
 */
import { isWorkingInstant, nextWorkingStart, previousWorkingEnd } from "@stargantt/sdk";
import type { CalendarId } from "@stargantt/plugin-data-store";
// Type-only: loads interaction's `declare module "@stargantt/core"` augmentation so the
// `snap/workingTime` contribution below is checked against the real point. Erased at emit — no
// runtime dependency is added, and interaction is a strictly lower layer in any case.
import type { WorkingBoundaries, WorkingTimeProvider } from "@stargantt/plugin-interaction";
import type { CalendarRegistry, CalendarsState } from "./registry";

/** The cache slot an omitted calendar reference occupies. */
const DEFAULT_REFERENCE = Symbol("stargantt.scheduling:defaultCalendar");

type CacheKey = CalendarId | typeof DEFAULT_REFERENCE;

/** Builds the plugin's `snap/workingTime` provider over the registry. */
export function createWorkingTimeProvider(registry: CalendarRegistry): WorkingTimeProvider {
  const cache = new Map<CacheKey, WorkingBoundaries | undefined>();
  let cachedState: CalendarsState | undefined;

  return {
    boundaries(calendar?: CalendarId): WorkingBoundaries | undefined {
      const state = registry.state.get();
      if (state !== cachedState) {
        cache.clear();
        cachedState = state;
      }
      const key: CacheKey = calendar === undefined ? DEFAULT_REFERENCE : calendar;
      if (cache.has(key)) return cache.get(key);

      const resolved =
        calendar === undefined ? registry.defaultCalendar() : registry.find(calendar);
      const probes: WorkingBoundaries | undefined =
        resolved === undefined
          ? undefined
          : {
              isWorkingInstant: (t) => isWorkingInstant(resolved, t),
              nextWorkingStart: (t) => nextWorkingStart(resolved, t),
              previousWorkingEnd: (t) => previousWorkingEnd(resolved, t),
            };
      cache.set(key, probes);
      return probes;
    },
  };
}
