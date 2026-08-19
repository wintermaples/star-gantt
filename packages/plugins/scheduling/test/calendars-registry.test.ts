/**
 * `internal/calendars/registry.ts` — normalization, per-calendar mutators, `regionCalendar`, and
 * the shade-choice bookkeeping (§1.2).
 *
 * Hostless: `createCalendarRegistry` takes no `PluginContext`, so every test here talks to it
 * directly — no `Gantt.create`, no data store, no DOM. Covers `define`'s return value + `find()`
 * (there is no standalone normalize export) plus the acceptance checks: one store commit per
 * gesture for the eight announcing mutators, and the shade-calendar deviation (§1.2's ninth
 * store-setting method).
 */
import { describe, expect, it } from "vitest";
import { createCalendarRegistry } from "../src/internal/calendars/registry";
import { regionCalendar } from "../src/internal/calendars/service";

describe("define (normalizeCalendar equivalence)", () => {
  it("rejects entries without a usable id or workingDays", () => {
    const r = createCalendarRegistry();
    expect(r.define(undefined)).toBe(false);
    expect(r.define({ workingDays: [1] })).toBe(false);
    expect(r.define({ id: "a", workingDays: "mon" })).toBe(false);
  });

  it("drops out-of-range weekdays and malformed exceptions", () => {
    const r = createCalendarRegistry();
    r.define({
      id: "a",
      workingDays: [1, 2, 9, -1, 2.5, 3],
      exceptions: [
        { date: "2026-01-01", working: false },
        { date: "bogus", working: false },
        { date: "2026-01-02", working: "no" },
      ],
    });
    const clean = r.find("a");
    expect(clean?.workingDays).toEqual([1, 2, 3]);
    expect(clean?.exceptions).toEqual([{ date: "2026-01-01", working: false }]);
  });
});

describe("regionCalendar", () => {
  it("builds a Fri/Sat weekend region with holidays", () => {
    const cal = regionCalendar({
      id: "gulf",
      weekend: [5, 6],
      holidays: ["2026-12-02", "2026-01-01", "2026-01-01"],
    });
    expect(cal.workingDays).toEqual([0, 1, 2, 3, 4]);
    expect(cal.exceptions).toEqual([
      { date: "2026-01-01", working: false },
      { date: "2026-12-02", working: false },
    ]);
  });

  it("defaults to a Sat/Sun weekend and drops malformed holidays", () => {
    const cal = regionCalendar({ id: "std", holidays: ["nope"] });
    expect(cal.workingDays).toEqual([1, 2, 3, 4, 5]);
    expect(cal.exceptions).toBeUndefined();
  });
});

describe("CalendarRegistry: define / list / remove", () => {
  it("defines, lists in insertion order, and removes", () => {
    const r = createCalendarRegistry();
    expect(r.define({ id: "a", workingDays: [1] })).toBe(true);
    expect(r.define({ id: "b", workingDays: [2] })).toBe(true);
    expect(r.define("junk")).toBe(false);
    expect(r.state.get().calendars.map((c) => c.id)).toEqual(["a", "b"]);
    expect(r.remove("a")).toBe(true);
    expect(r.remove("a")).toBe(false);
    expect(r.find("b")?.workingDays).toEqual([2]);
  });

  it("first registered default wins", () => {
    const r = createCalendarRegistry();
    r.define({ id: "a", workingDays: [1], isDefault: true });
    r.define({ id: "b", workingDays: [2], isDefault: true });
    expect(r.defaultCalendar()?.id).toBe("a");
  });

  it("keeps insertion position across a redefine", () => {
    const r = createCalendarRegistry();
    r.define({ id: "a", workingDays: [1] });
    r.define({ id: "b", workingDays: [2] });
    r.define({ id: "a", workingDays: [3], name: "renamed" });
    expect(r.state.get().calendars.map((c) => c.id)).toEqual(["a", "b"]);
    expect(r.find("a")?.name).toBe("renamed");
  });
});

describe("CalendarRegistry: per-calendar edits", () => {
  it("edits working days and exceptions, ignoring unusable input", () => {
    const r = createCalendarRegistry();
    r.define({ id: "a", workingDays: [1, 2, 3, 4, 5] });
    expect(r.setWorkingDays("a", [0, 1, 9])).toBe(true);
    expect(r.find("a")?.workingDays).toEqual([0, 1]);
    expect(r.setWorkingDays("missing", [1])).toBe(false);

    expect(r.setException("a", { date: "2026-05-01", working: false })).toBe(true);
    expect(r.setException("a", { date: "2026-05-01", working: true })).toBe(true); // replace
    expect(r.find("a")?.exceptions).toEqual([{ date: "2026-05-01", working: true }]);
    expect(r.setException("a", { date: "junk", working: true })).toBe(false);

    expect(r.removeException("a", "2026-05-01")).toBe(true);
    expect(r.removeException("a", "2026-05-01")).toBe(false);
    expect(r.find("a")?.exceptions).toBeUndefined();
  });

  it("replaces and clears the intra-day working windows", () => {
    const r = createCalendarRegistry();
    r.define({ id: "a", workingDays: [1], workingHours: [[0, 1000]] });
    expect(r.setWorkingHours("a", [[9 * 3600000, 17 * 3600000]])).toBe(true);
    expect(r.find("a")?.workingHours).toEqual([[32400000, 61200000]]);
    // A misshapen window is dropped, and a list that keeps nothing clears the windows entirely.
    expect(r.setWorkingHours("a", [["9", 17] as unknown as [number, number]])).toBe(true);
    expect(r.find("a")?.workingHours).toBeUndefined();
    expect(r.setWorkingHours("a", "09:00" as unknown as [number, number][])).toBe(false);
    expect(r.setWorkingHours("missing", [[0, 1]])).toBe(false);
  });

  it("designates a special period over an inclusive date range", () => {
    const r = createCalendarRegistry();
    r.define({ id: "a", workingDays: [1, 2, 3, 4, 5] });
    r.setException("a", { date: "2026-05-05", working: true });

    expect(r.setExceptionRange("a", { from: "2026-05-04", to: "2026-05-06", working: false })).toBe(
      true,
    );
    expect(r.find("a")?.exceptions).toEqual([
      { date: "2026-05-04", working: false },
      { date: "2026-05-05", working: false },
      { date: "2026-05-06", working: false },
    ]);

    expect(
      r.setExceptionRange("a", {
        from: "2026-05-09",
        to: "2026-05-10",
        working: true,
        hours: [[0, 3600000]],
      }),
    ).toBe(true);
    const windows = r.find("a")?.exceptions?.filter((e) => e.hours !== undefined) ?? [];
    expect(windows.map((e) => e.date)).toEqual(["2026-05-09", "2026-05-10"]);
    expect(windows[0]?.hours).not.toBe(windows[1]?.hours);
  });

  it("ignores an unusable, inverted or oversized special period", () => {
    const r = createCalendarRegistry();
    r.define({ id: "a", workingDays: [1] });
    expect(r.setExceptionRange("a", { from: "junk", to: "2026-05-01", working: false })).toBe(false);
    expect(r.setExceptionRange("a", { from: "2026-05-02", to: "2026-05-01", working: false })).toBe(
      false,
    );
    expect(r.setExceptionRange("a", { from: "2026-05-01", to: "2046-05-01", working: false })).toBe(
      false,
    );
    expect(
      r.setExceptionRange("a", { from: "2026-05-01", to: "2026-05-02", working: "yes" as unknown as boolean }),
    ).toBe(false);
    expect(
      r.setExceptionRange("missing", { from: "2026-05-01", to: "2026-05-02", working: false }),
    ).toBe(false);
    expect(r.find("a")?.exceptions).toBeUndefined();
  });

  it("removes a whole special period, keeping the exceptions outside it", () => {
    const r = createCalendarRegistry();
    r.define({ id: "a", workingDays: [1] });
    r.setExceptionRange("a", { from: "2026-05-01", to: "2026-05-03", working: false });
    r.setException("a", { date: "2026-06-01", working: false });

    expect(r.removeExceptionRange("a", "2026-05-02", "2026-05-31")).toBe(true);
    expect(r.find("a")?.exceptions?.map((e) => e.date)).toEqual(["2026-05-01", "2026-06-01"]);
    expect(r.removeExceptionRange("a", "2026-07-01", "2026-07-31")).toBe(false);
    expect(r.removeExceptionRange("a", "2026-05-31", "2026-05-01")).toBe(false);
    expect(r.removeExceptionRange("missing", "2026-05-01", "2026-05-02")).toBe(false);

    expect(r.removeExceptionRange("a", "2026-01-01", "2026-12-31")).toBe(true);
    expect(r.find("a")?.exceptions).toBeUndefined();
  });

  it("keeps exceptions sorted by date", () => {
    const r = createCalendarRegistry();
    r.define({ id: "a", workingDays: [1] });
    r.setException("a", { date: "2026-06-01", working: false });
    r.setException("a", { date: "2026-01-01", working: false });
    expect(r.find("a")?.exceptions?.map((e) => e.date)).toEqual(["2026-01-01", "2026-06-01"]);
  });
});

describe("CalendarRegistry aliasing", () => {
  it("copies exception hours on define, decoupling later caller-array mutation", () => {
    const hours: [number, number][] = [[32400000, 61200000]];
    const r = createCalendarRegistry();
    r.define({
      id: "a",
      workingDays: [1, 2, 3, 4, 5],
      exceptions: [{ date: "2026-01-05", working: true, hours }],
    });
    hours[0]![0] = 0;
    hours.push([0, 1]);
    expect(r.find("a")?.exceptions?.[0]?.hours).toEqual([[32400000, 61200000]]);
  });

  it("copies exception hours on setException and drops misshapen windows", () => {
    const hours = [[32400000, 61200000], ["x", 1]] as unknown as [number, number][];
    const r = createCalendarRegistry();
    r.define({ id: "a", workingDays: [1] });
    expect(r.setException("a", { date: "2026-01-05", working: true, hours })).toBe(true);
    hours[0]![1] = 0;
    expect(r.find("a")?.exceptions?.[0]?.hours).toEqual([[32400000, 61200000]]);
  });

  it("validates and copies workingHours on define", () => {
    const hours = [[32400000, 61200000], "junk"] as unknown as [number, number][];
    const r = createCalendarRegistry();
    r.define({ id: "a", workingDays: [1], workingHours: hours });
    hours[0]![0] = 0;
    expect(r.find("a")?.workingHours).toEqual([[32400000, 61200000]]);
  });
});

/* ------------------------------------------------------------------ *
 * Acceptance: one store commit per gesture (§1.2)
 * ------------------------------------------------------------------ */

/** Counts every `state.set()` commit — reused by the shade-resolution suite below too. */
function counter(r: ReturnType<typeof createCalendarRegistry>): { n: number } {
  const c = { n: 0 };
  r.state.subscribe(() => void (c.n += 1));
  return c;
}

describe("one `state.set()` per gesture", () => {
  it("define / remove commit exactly once each, and never on a no-op", () => {
    const r = createCalendarRegistry();
    const c = counter(r);
    r.define({ id: "a", workingDays: [1] });
    expect(c.n).toBe(1);
    r.define("junk"); // unusable — no commit
    expect(c.n).toBe(1);
    r.remove("a");
    expect(c.n).toBe(2);
    r.remove("a"); // already gone — no commit
    expect(c.n).toBe(2);
  });

  it("setWorkingDays / setWorkingHours / setException / removeException commit once each", () => {
    const r = createCalendarRegistry();
    r.define({ id: "a", workingDays: [1, 2, 3] });
    const c = counter(r);
    r.setWorkingDays("a", [4, 5]);
    expect(c.n).toBe(1);
    r.setWorkingDays("missing", [1]); // no-op
    expect(c.n).toBe(1);
    r.setWorkingHours("a", [[0, 1000]]);
    expect(c.n).toBe(2);
    r.setException("a", { date: "2026-01-01", working: false });
    expect(c.n).toBe(3);
    r.removeException("a", "2026-01-01");
    expect(c.n).toBe(4);
    r.removeException("a", "2026-01-01"); // already gone — no commit
    expect(c.n).toBe(4);
  });

  it("setExceptionRange is ONE commit however many days the period covers", () => {
    const r = createCalendarRegistry();
    r.define({ id: "a", workingDays: [1, 2, 3, 4, 5] });
    const c = counter(r);
    // A whole month, one gesture.
    r.setExceptionRange("a", { from: "2026-01-01", to: "2026-01-31", working: false });
    expect(c.n).toBe(1);
    expect(r.find("a")?.exceptions).toHaveLength(31);
    r.setExceptionRange("a", { from: "junk", to: "2026-01-31", working: false }); // refused whole
    expect(c.n).toBe(1);
  });

  it("removeExceptionRange commits exactly once", () => {
    const r = createCalendarRegistry();
    r.define({ id: "a", workingDays: [1] });
    r.setExceptionRange("a", { from: "2026-01-01", to: "2026-01-05", working: false });
    const c = counter(r);
    r.removeExceptionRange("a", "2026-01-01", "2026-01-05");
    expect(c.n).toBe(1);
    r.removeExceptionRange("a", "2026-01-01", "2026-01-05"); // nothing left to remove
    expect(c.n).toBe(1);
  });
});

/* ------------------------------------------------------------------ *
 * The shade-choice bookkeeping — a live "explicit or default" resolution, folded into
 * `CalendarsState.shadeCalendar` (module doc, registry.ts).
 * ------------------------------------------------------------------ */

describe("shade-calendar resolution", () => {
  it("follows the registry default live until an explicit choice is made", () => {
    const r = createCalendarRegistry();
    expect(r.state.get().shadeCalendar).toBeUndefined();
    r.define({ id: "a", workingDays: [1], isDefault: true });
    expect(r.state.get().shadeCalendar).toBe("a"); // follows the default with no explicit call
    r.define({ id: "b", workingDays: [2], isDefault: true });
    r.remove("a"); // "a" was first-registered-default; removing it promotes "b"
    expect(r.state.get().shadeCalendar).toBe("b");
  });

  it("setShadeCalendar is sticky and stops following the default", () => {
    const r = createCalendarRegistry();
    r.define({ id: "a", workingDays: [1], isDefault: true });
    r.define({ id: "b", workingDays: [2] });
    expect(r.setShadeCalendar("b")).toBe(true);
    expect(r.state.get().shadeCalendar).toBe("b");
    // A later registry edit that changes the default does not move the explicit choice.
    r.remove("a");
    expect(r.state.get().shadeCalendar).toBe("b");
  });

  it("an explicit `undefined` turns shading off rather than falling back to the default", () => {
    const r = createCalendarRegistry();
    r.define({ id: "a", workingDays: [1], isDefault: true });
    expect(r.state.get().shadeCalendar).toBe("a");
    expect(r.setShadeCalendar(undefined)).toBe(true);
    expect(r.state.get().shadeCalendar).toBeUndefined();
    // Still off even though "a" is still the default.
    r.define({ id: "b", workingDays: [2] });
    expect(r.state.get().shadeCalendar).toBeUndefined();
  });

  it("rejects an unusable id and changes nothing", () => {
    const r = createCalendarRegistry();
    r.define({ id: "a", workingDays: [1], isDefault: true });
    const c = counter(r);
    expect(r.setShadeCalendar({} as never)).toBe(false);
    expect(c.n).toBe(0);
    expect(r.state.get().shadeCalendar).toBe("a");
  });

  it("setShadeCalendar itself commits exactly once", () => {
    const r = createCalendarRegistry();
    r.define({ id: "a", workingDays: [1] });
    const c = counter(r);
    r.setShadeCalendar("a");
    expect(c.n).toBe(1);
  });

  // Minor fix (P4 review ruling) — repeating the SAME already-explicit choice used to commit again
  // every time, over-notifying a repaint and an open editor's refresh for a value that did not
  // change.
  it("repeating the same explicit choice does NOT commit again", () => {
    const r = createCalendarRegistry();
    r.define({ id: "a", workingDays: [1] });
    r.define({ id: "b", workingDays: [2] });
    r.setShadeCalendar("a");
    const c = counter(r);
    expect(r.setShadeCalendar("a")).toBe(true); // still reports "usable"
    expect(c.n).toBe(0);
    // A genuinely different explicit choice still commits.
    expect(r.setShadeCalendar("b")).toBe(true);
    expect(c.n).toBe(1);
    // Repeating THAT one is a no-op too.
    expect(r.setShadeCalendar("b")).toBe(true);
    expect(c.n).toBe(1);
  });

  it("repeating the same explicit undefined (shading off) does NOT commit again", () => {
    const r = createCalendarRegistry();
    r.define({ id: "a", workingDays: [1], isDefault: true });
    r.setShadeCalendar(undefined);
    const c = counter(r);
    expect(r.setShadeCalendar(undefined)).toBe(true);
    expect(c.n).toBe(0);
  });

  it("the FIRST explicit call still commits even when it happens to match the live default", () => {
    const r = createCalendarRegistry();
    r.define({ id: "a", workingDays: [1], isDefault: true });
    const c = counter(r);
    // "a" is already the published shadeCalendar via the live-default path — pinning it explicitly
    // is still a real transition (a later default change must no longer move the shade), so it
    // commits despite the published value staying "a".
    expect(r.setShadeCalendar("a")).toBe(true);
    expect(c.n).toBe(1);
    r.define({ id: "b", workingDays: [2], isDefault: true });
    // Proof the pin took: promoting "b" to `isDefault` does NOT move the (now pinned) shade to it.
    expect(r.state.get().shadeCalendar).toBe("a");
  });
});

/* ------------------------------------------------------------------ *
 * Config-seeded calendars go through the same normalization `define()` applies (minor fix, P4
 * review ruling) — a malformed `calendars.calendars` entry is skipped rather than stored verbatim,
 * exactly like an unusable `define()` call.
 * ------------------------------------------------------------------ */

describe("registry seeding (§11.3) normalizes exactly like define()", () => {
  it("drops out-of-range weekdays and malformed exceptions in a seeded calendar", () => {
    const r = createCalendarRegistry([
      {
        id: "a",
        workingDays: [1, 2, 9, -1, 2.5, 3] as unknown as number[],
        exceptions: [
          { date: "2026-01-01", working: false },
          { date: "bogus", working: false },
        ] as never,
      },
    ]);
    const clean = r.find("a");
    expect(clean?.workingDays).toEqual([1, 2, 3]);
    expect(clean?.exceptions).toEqual([{ date: "2026-01-01", working: false }]);
  });

  it("skips an unusable seed entry instead of storing it verbatim", () => {
    const r = createCalendarRegistry([
      { id: "a", workingDays: [1] },
      { workingDays: [2] } as never, // no id — unusable, mirrors define()'s own rejection
    ]);
    expect(r.state.get().calendars).toHaveLength(1);
    expect(r.find("a")).toBeDefined();
  });

  it("a later seed entry with a repeated id replaces the earlier one, keeping its position", () => {
    const r = createCalendarRegistry([
      { id: "a", workingDays: [1], name: "first" },
      { id: "b", workingDays: [2] },
      { id: "a", workingDays: [3], name: "second" },
    ]);
    const list = r.state.get().calendars;
    expect(list.map((c) => c.id)).toEqual(["a", "b"]); // "a" keeps its original slot
    expect(r.find("a")?.name).toBe("second");
    expect(r.find("a")?.workingDays).toEqual([3]);
  });

  it("the seeded default's isDefault is already reflected in the very first published state", () => {
    const r = createCalendarRegistry([{ id: "a", workingDays: [1], isDefault: true }]);
    expect(r.state.get().shadeCalendar).toBe("a");
  });
});
