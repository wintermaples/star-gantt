/**
 * `internal/calendars/working-time-provider.ts` × `internal/calendars/registry.ts`:
 * the §4.1 freshness dovetail — the provider caches `WorkingBoundaries` per calendar reference and
 * drops the whole cache whenever `registry.state`'s object identity changes, which is exactly what
 * every announcing mutator (and `setShadeCalendar`) does on each commit.
 *
 * Pure and hostless: both sides are plain factories, no `PluginContext` involved.
 */
import { describe, expect, it } from "vitest";
import { createCalendarRegistry } from "../src/internal/calendars/registry";
import { createWorkingTimeProvider } from "../src/internal/calendars/working-time-provider";

const DAY = 86_400_000;
const MON = 4 * DAY; // 1970-01-05

describe("cache invalidation on registry commit", () => {
  it("resolves the registry default when the reference is omitted, and reflects an edit", () => {
    const registry = createCalendarRegistry();
    registry.define({ id: "wd", workingDays: [1, 2, 3, 4, 5], isDefault: true });
    const provider = createWorkingTimeProvider(registry);

    const before = provider.boundaries();
    expect(before?.isWorkingInstant(MON + 5 * DAY)).toBe(false); // Saturday

    // A later edit widens the working week to include Saturday — an announcing mutator, one commit.
    registry.setWorkingDays("wd", [1, 2, 3, 4, 5, 6]);
    const after = provider.boundaries();
    expect(after).not.toBe(before); // the cache was dropped, not just refreshed in place
    expect(after?.isWorkingInstant(MON + 5 * DAY)).toBe(true);
  });

  it("caches per calendar reference until the next commit, not per call", () => {
    const registry = createCalendarRegistry();
    registry.define({ id: "wd", workingDays: [1, 2, 3, 4, 5] });
    const provider = createWorkingTimeProvider(registry);
    const first = provider.boundaries("wd");
    const second = provider.boundaries("wd");
    expect(second).toBe(first); // no registry change in between — same cached object
  });

  it("an id the registry does not contain resolves undefined, even after a later define", () => {
    const registry = createCalendarRegistry();
    const provider = createWorkingTimeProvider(registry);
    expect(provider.boundaries("later")).toBeUndefined();
    registry.define({ id: "later", workingDays: [1] });
    expect(provider.boundaries("later")).toBeDefined();
  });

  it("setShadeCalendar over-invalidates the cache too (§4.1, safe and deliberate)", () => {
    const registry = createCalendarRegistry();
    registry.define({ id: "wd", workingDays: [1, 2, 3, 4, 5] });
    const provider = createWorkingTimeProvider(registry);
    const before = provider.boundaries("wd");
    registry.setShadeCalendar("wd"); // touches only the shade choice, not the calendar definition
    const after = provider.boundaries("wd");
    expect(after).not.toBe(before); // cache dropped anyway
    expect(after?.isWorkingInstant(MON)).toBe(before?.isWorkingInstant(MON)); // same answer either way
  });

  it("a no-op mutator call (unknown id) does not change the registry's state identity", () => {
    const registry = createCalendarRegistry();
    registry.define({ id: "wd", workingDays: [1, 2, 3, 4, 5] });
    const provider = createWorkingTimeProvider(registry);
    const before = provider.boundaries("wd");
    const stateBefore = registry.state.get();
    registry.setWorkingDays("missing", [1]); // no calendar named "missing" — no commit
    expect(registry.state.get()).toBe(stateBefore);
    expect(provider.boundaries("wd")).toBe(before); // still cached
  });
});
