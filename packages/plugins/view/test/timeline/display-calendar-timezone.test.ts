/**
 * Display calendar (wareki and friends) and display time zone.
 *
 * `calendar` changes only
 * how the built-in labels and `formatDate` word an instant; `displayTimeZone` moves the boundary
 * arithmetic and the labels to the zone's wall clock while the data stays UTC epoch ms.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { normalizeCalendar } from "../../src/internal/timeline/levels";
import { floorTo, ticks } from "../../src/internal/timeline/scale";
import {
  clearZoneOffsetMemo,
  retainZone,
  zoneOffsetMemoSize,
  fromWall,
  normalizeTimeZone,
  toWall,
  zoneOffset,
} from "../../src/internal/timeline/zone";
import { boot } from "./_boot";
import type { Booted } from "./_boot";

let booted: Booted | null = null;

afterEach(() => {
  // Dispose the instance so its zone retention is released along with the DOM.
  booted?.gantt.dispose();
  booted?.dom.restore();
  booted = null;
});

const MS_HOUR = 3_600_000;
const MS_DAY = 86_400_000;

describe("normalization", () => {
  it("accepts real identifiers and rejects the unusable, including plain UTC", () => {
    expect(normalizeTimeZone("Asia/Tokyo")).toBe("Asia/Tokyo");
    expect(normalizeTimeZone("UTC")).toBeUndefined();
    expect(normalizeTimeZone("Not/AZone")).toBeUndefined();
    expect(normalizeTimeZone(9)).toBeUndefined();
    expect(normalizeTimeZone(undefined)).toBeUndefined();
    expect(normalizeCalendar("japanese")).toBe("japanese");
    expect(normalizeCalendar("not-a-calendar!")).toBeUndefined();
    expect(normalizeCalendar(42)).toBeUndefined();
  });
});

describe("zone arithmetic", () => {
  it("reads Tokyo as UTC+9 with an exact wall round-trip", () => {
    const t = Date.UTC(2026, 0, 15, 12);
    expect(zoneOffset("Asia/Tokyo", t)).toBe(9 * MS_HOUR);
    expect(fromWall("Asia/Tokyo", toWall("Asia/Tokyo", t))).toBe(t);
  });

  it("tracks daylight-saving offsets", () => {
    expect(zoneOffset("America/New_York", Date.UTC(2026, 0, 15))).toBe(-5 * MS_HOUR);
    expect(zoneOffset("America/New_York", Date.UTC(2026, 6, 15))).toBe(-4 * MS_HOUR);
  });
});

describe("display time zone in the calendar arithmetic", () => {
  it("floors a day to the zone's local midnight", () => {
    const t = Date.UTC(2026, 0, 15, 20); // 05:00 Jan 16 in Tokyo
    expect(floorTo(t, "day", 1, "Asia/Tokyo")).toBe(Date.UTC(2026, 0, 15, 15));
    expect(floorTo(t, "day", 1)).toBe(Date.UTC(2026, 0, 15));
  });

  it("enumerates day boundaries at the zone's midnights across a DST change", () => {
    // US DST began 2026-03-08 02:00 local: the boundary before is 05:00 UTC, after is 04:00 UTC.
    const out = ticks(
      Date.UTC(2026, 2, 7, 12),
      Date.UTC(2026, 2, 10, 12),
      "day",
      1,
      1,
      "America/New_York",
    );
    expect(out).toEqual([
      Date.UTC(2026, 2, 7, 5),
      Date.UTC(2026, 2, 8, 5),
      Date.UTC(2026, 2, 9, 4),
      Date.UTC(2026, 2, 10, 4),
    ]);
  });

  it("unitBoundaries reports the zone's wall-clock boundaries through the service", () => {
    booted = boot([], {}, { origin: 0, displayTimeZone: "Asia/Tokyo" });
    const s = booted.gantt.service("stargantt.timeline");
    const out = s.unitBoundaries("day", Date.UTC(2026, 0, 10), Date.UTC(2026, 0, 12));
    expect(out.length).toBeGreaterThan(0);
    for (const t of out) expect((t + 9 * MS_HOUR) % MS_DAY).toBe(0);
  });

  it("degrades an unknown zone to plain UTC display", () => {
    booted = boot([], {}, { origin: 0, displayTimeZone: "Not/AZone" });
    const s = booted.gantt.service("stargantt.timeline");
    const out = s.unitBoundaries("day", 0, 2 * MS_DAY);
    expect(out).toEqual([0, MS_DAY]);
  });

  it("draws day cells on the zone's local day boundaries", () => {
    // Epoch 0 is 09:00 Jan 1 in Tokyo, so the next Tokyo day starts at 15:00 UTC: the "2" day
    // label paints at x = 15h * (40px/24h) + padding = 29, where UTC display would paint it at 44.
    booted = boot([], {}, { origin: 0, displayTimeZone: "Asia/Tokyo" });
    booted.dom.flushFrames();
    const two = booted.header.context.texts.find((t) => t.text === "2");
    expect(two).toBeDefined();
    expect(two?.x).toBeCloseTo((15 / 24) * 40 + 4, 6);
  });
});

describe("display calendar", () => {
  it("words formatDate in the configured calendar", () => {
    booted = boot([], {}, { origin: 0, calendar: "japanese" });
    const s = booted.gantt.service("stargantt.timeline");
    const text = s.formatDate(Date.UTC(2026, 0, 1), { era: "long", year: "numeric" });
    expect(text).toContain("Reiwa");
    expect(text).toContain("8");
  });

  it("keeps boundaries Gregorian while only the wording changes", () => {
    booted = boot([], {}, { origin: 0, calendar: "japanese" });
    const s = booted.gantt.service("stargantt.timeline");
    // The half-open span starts on a boundary, so it and the next Gregorian month come back.
    expect(s.unitBoundaries("month", 0, 40 * MS_DAY)).toEqual([0, Date.UTC(1970, 1, 1)]);
  });

  it("ignores an unknown calendar and defaults formatDate to a plain date", () => {
    booted = boot([], {}, { origin: 0, calendar: "not-a-calendar!" });
    const s = booted.gantt.service("stargantt.timeline");
    expect(s.formatDate(Date.UTC(2026, 0, 15))).toBe("Jan 15, 2026");
  });

  it("formats formatDate in the display time zone", () => {
    booted = boot([], {}, { origin: 0, displayTimeZone: "Asia/Tokyo" });
    const s = booted.gantt.service("stargantt.timeline");
    // 20:00 UTC Dec 31 is already Jan 1 in Tokyo.
    expect(s.formatDate(Date.UTC(2025, 11, 31, 20))).toBe("Jan 1, 2026");
  });
});

// the bounded per-zone conversion memo. Boundary
// arithmetic re-derives the same instants on every paint, so a resolved instant must cost no
// further platform zone lookup.
describe("zone conversion memo", () => {
  const OFFSET_MEMO_LIMIT = 8192;
  /** Counts platform zone lookups: every uncached conversion issues exactly one `formatToParts`. */
  const spyOnZoneLookups = (): ReturnType<typeof vi.spyOn> =>
    vi.spyOn(Intl.DateTimeFormat.prototype, "formatToParts") as ReturnType<typeof vi.spyOn>;
  let parts: ReturnType<typeof spyOnZoneLookups>;

  beforeEach(() => {
    clearZoneOffsetMemo();
    parts = spyOnZoneLookups();
  });

  afterEach(() => {
    parts.mockRestore();
    clearZoneOffsetMemo();
  });

  it("resolves a repeated instant without a further platform lookup", () => {
    const t = Date.UTC(2026, 0, 15, 12);
    const first = zoneOffset("Asia/Tokyo", t);
    expect(parts).toHaveBeenCalledTimes(1);
    expect(zoneOffset("Asia/Tokyo", t)).toBe(first);
    expect(zoneOffset("Asia/Tokyo", t)).toBe(first);
    expect(parts).toHaveBeenCalledTimes(1);
  });

  it("repaints the same header boundaries for free", () => {
    const from = Date.UTC(2026, 2, 1);
    const to = Date.UTC(2026, 3, 1);
    const first = ticks(from, to, "day", 1, 1, "America/New_York");
    const afterFirstPaint = parts.mock.calls.length;
    expect(afterFirstPaint).toBeGreaterThan(0);
    expect(ticks(from, to, "day", 1, 1, "America/New_York")).toEqual(first);
    expect(parts).toHaveBeenCalledTimes(afterFirstPaint);
  });

  it("keys the memo by zone, so two zones never share an entry", () => {
    const t = Date.UTC(2026, 0, 15, 12);
    expect(zoneOffset("Asia/Tokyo", t)).toBe(9 * MS_HOUR);
    expect(zoneOffset("America/New_York", t)).toBe(-5 * MS_HOUR);
  });

  it("bounds the memo: past the limit the zone's entries are dropped and recomputed", () => {
    const t = Date.UTC(2026, 0, 15, 12);
    const expected = zoneOffset("Asia/Tokyo", t);
    // Fill past the bound with distinct instants; the first entry is evicted with the rest.
    for (let i = 1; i <= OFFSET_MEMO_LIMIT; i += 1) zoneOffset("Asia/Tokyo", t + i * MS_HOUR);
    const before = parts.mock.calls.length;
    // Same answer as ever — the memo is an optimisation, never a source of truth.
    expect(zoneOffset("Asia/Tokyo", t)).toBe(expected);
    expect(parts.mock.calls.length).toBe(before + 1);
  });

  // "cleared on zone change": the zone is fixed
  // per instance, so the memo is dropped when the last retention of the zone is released.
  it("drops a zone's memo when its last retention is released", () => {
    const t = Date.UTC(2026, 0, 15, 12);
    const releaseA = retainZone("Asia/Tokyo");
    const releaseB = retainZone("Asia/Tokyo");
    zoneOffset("Asia/Tokyo", t);
    expect(zoneOffsetMemoSize("Asia/Tokyo")).toBe(1);
    releaseA();
    releaseA(); // A double release must not steal the remaining retention.
    expect(zoneOffsetMemoSize("Asia/Tokyo")).toBe(1);
    releaseB();
    expect(zoneOffsetMemoSize("Asia/Tokyo")).toBe(0);
  });

  it("evicts the instance's zone memo on dispose", () => {
    // Assigned to the file-level `booted` so the afterEach restores the boot harness's DOM stub;
    // the in-test dispose is the behaviour under test (host dispose is idempotent, so the
    // afterEach's second dispose is a no-op).
    booted = boot([], {}, { origin: 0, displayTimeZone: "Asia/Tokyo" });
    const s = booted.gantt.service("stargantt.timeline");
    s.formatDate(Date.UTC(2026, 0, 15, 12));
    zoneOffset("Asia/Tokyo", Date.UTC(2026, 0, 15, 12));
    expect(zoneOffsetMemoSize("Asia/Tokyo")).toBeGreaterThan(0);
    booted.gantt.dispose();
    expect(zoneOffsetMemoSize("Asia/Tokyo")).toBe(0);
  });
});
