/**
 * `TimelineConfig.firstDayOfWeek`.
 *
 *
 * The option is the single source of the week-boundary computation and drives date arithmetic
 * only: label wording stays locale-driven. The default, 1 (Monday), reproduces the previous fixed
 * ISO-8601 behaviour exactly.
 */
import { afterEach, describe, expect, it } from "vitest";
import type { TimelineConfig } from "../../src/config";
import { MS_DAY, floorTo, normalizeFirstDayOfWeek, ticks } from "../../src/internal/timeline/scale";
import { boot } from "./_boot";
import type { Booted } from "./_boot";

let booted: Booted | null = null;

afterEach(() => {
  booted?.dom.restore();
  booted = null;
});

/** 1970-01-01 is a Thursday, so every week start below is a distinct offset from the epoch. */
const THURSDAY = 0;

describe("floorTo", () => {
  it("defaults to Monday, i.e. the previous ISO-8601 behaviour", () => {
    // The Monday before Thursday 1970-01-01 is 1969-12-29, three days earlier.
    expect(floorTo(THURSDAY, "week")).toBe(-3 * MS_DAY);
    expect(floorTo(THURSDAY, "week", 1)).toBe(-3 * MS_DAY);
  });

  it("moves the boundary to the configured weekday", () => {
    expect(floorTo(THURSDAY, "week", 0)).toBe(-4 * MS_DAY); // Sunday 1969-12-28
    expect(floorTo(THURSDAY, "week", 4)).toBe(THURSDAY); // Thursday itself
    expect(floorTo(THURSDAY, "week", 6)).toBe(-5 * MS_DAY); // Saturday 1969-12-27
  });

  it("always lands on the requested weekday, for every weekday", () => {
    for (let start = 0; start <= 6; start++) {
      const t = floorTo(THURSDAY + 3 * MS_DAY, "week", start);
      expect(new Date(t).getUTCDay()).toBe(start);
      expect(t).toBeLessThanOrEqual(THURSDAY + 3 * MS_DAY);
      expect(THURSDAY + 3 * MS_DAY - t).toBeLessThan(7 * MS_DAY);
    }
  });

  it("leaves every other unit untouched", () => {
    for (const unit of ["year", "month", "day", "hour"] as const) {
      expect(floorTo(THURSDAY + 5 * MS_DAY, unit, 0)).toBe(floorTo(THURSDAY + 5 * MS_DAY, unit, 3));
    }
  });
});

describe("ticks", () => {
  it("threads the week start through to the boundary series", () => {
    const sunday = ticks(0, 21 * MS_DAY, "week", 1, 0);
    expect(sunday.map((t) => t / MS_DAY)).toEqual([-4, 3, 10, 17]);
    const monday = ticks(0, 21 * MS_DAY, "week", 1);
    expect(monday.map((t) => t / MS_DAY)).toEqual([-3, 4, 11, 18]);
  });
});

describe("normalizeFirstDayOfWeek", () => {
  it("accepts every integer 0..6", () => {
    for (let n = 0; n <= 6; n++) expect(normalizeFirstDayOfWeek(n)).toBe(n);
  });

  it("falls back to Monday for anything else", () => {
    for (const bad of [-1, 7, 1.5, Number.NaN, Number.POSITIVE_INFINITY, "1", null, undefined, {}]) {
      expect(normalizeFirstDayOfWeek(bad)).toBe(1);
    }
  });
});

/**
 * Header boundary xs at the `week` level, with `origin` pinned at the epoch.
 *
 * Each call tears its own fake DOM down again, so a single test may compare two configurations
 * without leaving a stubbed global behind.
 */
function weekBoundaryXs(config: TimelineConfig): number[] {
  const b = boot([], {}, { origin: 0, ...config });
  try {
    b.dom.flushFrames();
    b.gantt.service("stargantt.timeline").setZoomLevel("week");
    b.header.context.reset();
    b.dom.flushFrames();
    return b.header.context.verticalXs();
  } finally {
    b.dom.restore();
  }
}

describe("the header draws week boundaries on the configured weekday", () => {
  // `week` is 12 px per day, so the boundary three days after the epoch sits at x = 36 and the one
  // four days after it at x = 48.
  it("defaults to Monday", () => {
    const xs = weekBoundaryXs({});
    expect(xs).toContain(48);
    expect(xs).not.toContain(36);
  });

  it("honours an explicit Monday identically", () => {
    expect(weekBoundaryXs({ firstDayOfWeek: 1 })).toEqual(weekBoundaryXs({}));
  });

  it("moves the boundaries for a Sunday-start week", () => {
    const xs = weekBoundaryXs({ firstDayOfWeek: 0 });
    expect(xs).toContain(36);
    expect(xs).not.toContain(48);
  });

  it("ignores an unusable value and draws the default week", () => {
    const bad = { firstDayOfWeek: 9 } as unknown as TimelineConfig;
    expect(weekBoundaryXs(bad)).toEqual(weekBoundaryXs({}));
  });
});

describe("formatting stays locale-driven", () => {
  it("changes only which instants are labelled, never how they are worded", () => {
    const b = boot([], {}, { origin: 0, firstDayOfWeek: 0 }, "en");
    booted = b;
    b.dom.flushFrames();
    b.gantt.service("stargantt.timeline").setZoomLevel("week");
    b.header.context.reset();
    b.dom.flushFrames();
    // The Sunday-start week beginning 1970-01-04, formatted by the same `{month, day}` formatter.
    expect(b.header.context.texts.map((t) => t.text)).toContain("1/4");
  });
});
