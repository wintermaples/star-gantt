/**
 * docs/specs/plugins/scheduling.md §4 — this plugin's contributions into interaction's own
 * `snap/workingTime` and `snap/pushGuards` points, avoiding an upward dependency from snap onto
 * calendars or the scheduler.
 *
 * The provider is exercised here over an empty registry, so every reference resolves `undefined`
 * — which is exactly the correct no-calendars behaviour (interaction then passes dates through
 * unchanged).
 */
import { createStore } from "@stargantt/core";
import { describe, expect, it } from "vitest";
import { createCalendarRegistry, effectiveCalendarResolver } from "../src/internal/calendars/registry";
import type { CalendarsState } from "../src/internal/calendars/registry";
import { createWorkingTimeProvider } from "../src/internal/calendars/working-time-provider";
import { DAY, task, view } from "./_helpers";

const H = 3_600_000;
const MON = Date.UTC(2024, 0, 1);
const SAT = Date.UTC(2024, 0, 6);
const NEXT_MON = Date.UTC(2024, 0, 8);

const weekdays = { id: "w", workingDays: [1, 2, 3, 4, 5] };
const office = {
  id: "o",
  workingDays: [1, 2, 3, 4, 5],
  workingHours: [[9 * H, 17 * H]] as [number, number][],
};

describe("snap/workingTime provider (§4.1)", () => {
  it("resolves nothing at all while the registry is empty (pass-through behavior)", () => {
    const provider = createWorkingTimeProvider(createCalendarRegistry());
    expect(provider.boundaries()).toBeUndefined();
    expect(provider.boundaries("w")).toBeUndefined();
  });

  it("resolves a named id only when the registry declares it", () => {
    const provider = createWorkingTimeProvider(createCalendarRegistry([weekdays]));
    expect(provider.boundaries("w")).toBeDefined();
    // An id the registry does not contain resolves `undefined` even when a store knows it: the
    // provider deliberately refuses to hand snap a reference whose meaning the registry never
    // declared.
    expect(provider.boundaries("unknown")).toBeUndefined();
  });

  it("resolves an omitted reference to the registry default, and to nothing without one", () => {
    expect(createWorkingTimeProvider(createCalendarRegistry([weekdays])).boundaries()).toBeUndefined();
    const withDefault = createWorkingTimeProvider(
      createCalendarRegistry([{ ...weekdays, isDefault: true }]),
    );
    expect(withDefault.boundaries()).toBeDefined();
  });

  it("delegates the three probes to sdk/time at the calendar's own granularity", () => {
    const dayGranular = createWorkingTimeProvider(createCalendarRegistry([weekdays]));
    const day = dayGranular.boundaries("w");
    expect(day?.isWorkingInstant(SAT + 10 * H)).toBe(false);
    expect(day?.nextWorkingStart(SAT + 10 * H)).toBe(NEXT_MON);
    expect(day?.previousWorkingEnd(SAT)).toBe(Date.UTC(2024, 0, 6));

    const windowed = createWorkingTimeProvider(createCalendarRegistry([office]));
    const hours = windowed.boundaries("o");
    expect(hours?.isWorkingInstant(MON + 8 * H)).toBe(false);
    expect(hours?.isWorkingInstant(MON + 10 * H)).toBe(true);
    expect(hours?.nextWorkingStart(MON + 8 * H)).toBe(MON + 9 * H);
    expect(hours?.previousWorkingEnd(MON + 20 * H)).toBe(MON + 17 * H);
  });

  it("caches per reference and invalidates on every registry state set", () => {
    const registry = createCalendarRegistry([weekdays]);
    const provider = createWorkingTimeProvider(registry);
    const first = provider.boundaries("w");
    expect(provider.boundaries("w")).toBe(first);

    // A registry edit is visible to the very next adjustment, via the store's own reactivity.
    registry.state.set({ calendars: [office], shadeCalendar: undefined });
    expect(provider.boundaries("w")).toBeUndefined();
    expect(provider.boundaries("o")).toBeDefined();
  });

  it("never throws for an unresolvable reference", () => {
    const provider = createWorkingTimeProvider(createCalendarRegistry());
    expect(() => provider.boundaries("nope")).not.toThrow();
  });

  it("satisfies interaction's structural usability guard", () => {
    // interaction treats a contribution missing `boundaries` as absent; this provider always
    // carries it.
    const provider = createWorkingTimeProvider(createCalendarRegistry());
    expect(typeof provider.boundaries).toBe("function");
  });
});

describe("the §2.2 calendar resolution seam", () => {
  const storeView = view([task("t", 0, DAY, { calendarId: "w" })], [], [weekdays]);
  const bare = view([task("t", 0, DAY)], [], [weekdays]);

  it("falls back to the data store when the registry is empty", () => {
    const resolve = effectiveCalendarResolver(createCalendarRegistry(), true);
    expect(resolve(storeView, storeView.byId.get("t")!)).toBe(weekdays);
    expect(resolve(bare, bare.byId.get("t")!)).toBeUndefined();
  });

  it("lets a registry calendar shadow a store calendar with the same id", () => {
    const registered = { ...office, id: "w" };
    const resolve = effectiveCalendarResolver(createCalendarRegistry([registered]), true);
    // `toStrictEqual`, not `toBe`: the registry seed goes through the same `normalizeCalendarInput`
    // shape validation `define()` applies to every later addition, so the registry's own entry is
    // a clean COPY of `registered`, not the same reference (minor fix — the registry previously
    // stored a config seed verbatim, unvalidated, unlike every other way a calendar enters it).
    expect(resolve(storeView, storeView.byId.get("t")!)).toStrictEqual(registered);
  });

  it("falls back to the registry default for a task that names no calendar", () => {
    const fallback = { ...office, isDefault: true };
    const resolve = effectiveCalendarResolver(createCalendarRegistry([fallback]), true);
    expect(resolve(bare, bare.byId.get("t")!)).toStrictEqual(fallback);
  });

  it("ignores the registry entirely under `calendars.scheduling: false`", () => {
    const registered = { ...office, id: "w", isDefault: true };
    const resolve = effectiveCalendarResolver(createCalendarRegistry([registered]), false);
    expect(resolve(storeView, storeView.byId.get("t")!)).toBe(weekdays);
    expect(resolve(bare, bare.byId.get("t")!)).toBeUndefined();
  });
});

describe("the registry store", () => {
  it("starts empty and answers no lookup", () => {
    const registry = createCalendarRegistry();
    expect(registry.state.get()).toEqual({ calendars: [], shadeCalendar: undefined });
    expect(registry.find("w")).toBeUndefined();
    expect(registry.find(undefined)).toBeUndefined();
    expect(registry.defaultCalendar()).toBeUndefined();
  });

  it("takes the first entry claiming the default when several do", () => {
    const registry = createCalendarRegistry([
      { ...weekdays, isDefault: true },
      { ...office, isDefault: true },
    ]);
    expect(registry.defaultCalendar()?.id).toBe("w");
  });

  it("is an ordinary core store, so it can be published as CalendarsService.state", () => {
    const registry = createCalendarRegistry();
    const seen: CalendarsState[] = [];
    const off = registry.state.subscribe((next) => seen.push(next));
    registry.state.set({ calendars: [weekdays], shadeCalendar: "w" });
    off.dispose();
    expect(seen).toHaveLength(1);
    expect(seen[0]?.shadeCalendar).toBe("w");
    // The seam is a plain writable store; nothing here needs the core's plugin machinery.
    expect(typeof createStore).toBe("function");
  });
});
