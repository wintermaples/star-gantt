/**
 * The six built-in zoom levels.
 *
 *
 * `day` and `week` keep their densities and their contribution order, so an omitted `initialZoom`
 * still resolves to `day` and the committed screenshot baselines are untouched. The four new
 * levels use the same two-row treatment: the coarser unit on top, both rows formatted through
 * `Intl` in UTC.
 */
import { afterEach, describe, expect, it } from "vitest";
import type { ZoomLevel } from "../../src/internal/timeline/index";
import { defaultZoomLevels } from "../../src/internal/timeline/levels";
import { boot } from "./_boot";
import type { Booted } from "./_boot";

let booted: Booted | null = null;

afterEach(() => {
  booted?.dom.restore();
  booted = null;
});

function byId(id: string): ZoomLevel {
  const level = defaultZoomLevels().find((l) => l.id === id);
  if (level === undefined) throw new Error(`no built-in level "${id}"`);
  return level;
}

describe("contribution order and identity", () => {
  it("ships exactly the six specified ids, in the specified order", () => {
    expect(defaultZoomLevels().map((l) => l.id)).toEqual([
      "day",
      "week",
      "hour",
      "month",
      "quarter",
      "year",
    ]);
  });

  it("leaves `day` the active startup level", () => {
    booted = boot();
    expect(booted.gantt.service("stargantt.timeline").zoomLevel.get().id).toBe("day");
  });

  it("keeps the pre-existing densities of `day` and `week`", () => {
    expect(byId("day").pxPerDay).toBe(40);
    expect(byId("week").pxPerDay).toBe(12);
  });

  it("returns fresh objects per call so one instance cannot reach another's", () => {
    expect(defaultZoomLevels()[0]).not.toBe(defaultZoomLevels()[0]);
  });
});

describe("density ordering", () => {
  it("orders hour > day > week > month > quarter > year", () => {
    const density = ["hour", "day", "week", "month", "quarter", "year"].map(
      (id) => byId(id).pxPerDay,
    );
    for (let i = 1; i < density.length; i++) {
      expect(density[i - 1]).toBeGreaterThan(density[i] as number);
    }
  });

  it("gives every level a finite positive density", () => {
    for (const level of defaultZoomLevels()) {
      expect(Number.isFinite(level.pxPerDay)).toBe(true);
      expect(level.pxPerDay).toBeGreaterThan(0);
    }
  });
});

describe("two-row header treatment", () => {
  it("gives every built-in level exactly two rows", () => {
    for (const level of defaultZoomLevels()) expect(level.scales).toHaveLength(2);
  });

  it("puts the specified unit pair on each level, coarser on top", () => {
    const units = (id: string): string[] => byId(id).scales.map((s) => s.unit);
    expect(units("day")).toEqual(["month", "day"]);
    expect(units("week")).toEqual(["month", "week"]);
    expect(units("hour")).toEqual(["day", "hour"]);
    expect(units("month")).toEqual(["year", "month"]);
    expect(units("quarter")).toEqual(["year", "month"]);
    expect(units("year")).toEqual(["year", "year"]);
  });

  it("makes the quarter row a three-month step", () => {
    expect(byId("quarter").scales[1]?.step).toBe(3);
    expect(byId("quarter").scales[0]?.step).toBeUndefined();
  });

  it("makes the `year` level a coarser step over a finer one", () => {
    const [top, bottom] = byId("year").scales;
    expect(top?.step).toBe(10);
    expect(bottom?.step).toBeUndefined();
  });
});

describe("formatting", () => {
  it("formats every row in UTC, so an epoch boundary never slips a day", () => {
    for (const level of defaultZoomLevels()) {
      for (const row of level.scales) expect(row.format(0, "en-US")).not.toContain("1969");
    }
  });

  it("labels the new levels' rows through Intl in the chart's locale", () => {
    expect(byId("hour").scales[0]?.format(0, "en")).toBe("January 1, 1970");
    expect(byId("month").scales[0]?.format(0, "en")).toBe("1970");
    expect(byId("month").scales[1]?.format(0, "en")).toBe("Jan");
    expect(byId("quarter").scales[1]?.format(0, "en")).toBe("Jan");
    expect(byId("year").scales[1]?.format(0, "en")).toBe("1970");
    expect(byId("month").scales[1]?.format(0, "ja-JP")).toBe("1月");
  });
});

// a cell that spans several years
// is labelled with the range it covers. The `year` level's coarse row steps ten years, so labelling
// it with its first year alone read as a bug.
describe("multi-year cell labels", () => {
  const decade = (t: number, locale = "en"): string => {
    const row = byId("year").scales[0];
    if (row === undefined) throw new Error("the year level has no coarse row");
    return row.format(t, locale);
  };

  it("labels the decade row with its first and last year, joined by an en dash", () => {
    expect(decade(Date.UTC(2020, 0, 1))).toBe("2020–2029");
    expect(decade(Date.UTC(1970, 0, 1))).toBe("1970–1979");
  });

  it("keeps a single-year row on one year", () => {
    // The fine row of the same level, and the year row of `month` / `quarter`, are unstepped.
    expect(byId("year").scales[1]?.format(Date.UTC(2020, 0, 1), "en")).toBe("2020");
    expect(byId("month").scales[0]?.format(Date.UTC(2020, 0, 1), "en")).toBe("2020");
  });

  it("formats both bounds through the same Intl formatter, so locale and calendar still apply", () => {
    // Arabic-Indic digits: both bounds are formatted, not just the first.
    expect(decade(Date.UTC(2020, 0, 1), "ar-EG")).toBe("٢٠٢٠–٢٠٢٩");
    const wareki = defaultZoomLevels({ calendar: "japanese" }).find((l) => l.id === "year");
    // Reiwa 2 (2020) through Reiwa 11 (2029), worded by the era calendar at both ends.
    expect(wareki?.scales[0]?.format(Date.UTC(2020, 0, 1), "ja-JP")).toBe("令和2年–令和11年");
  });

  it("paints the range on the real header, so thinning does not swallow the wider label", () => {
    booted = boot([], {}, { origin: Date.UTC(2026, 0, 1), initialZoom: "year" });
    booted.dom.flushFrames();
    const texts = booted.header.context.texts.map((t) => t.text);
    expect(texts).toContain("2020–2029");
  });

  it("honours the display time zone at both bounds", () => {
    // A zone east of UTC starts its decade before the UTC instant does; both bounds convert.
    const tokyo = defaultZoomLevels({ timeZone: "Asia/Tokyo" }).find((l) => l.id === "year");
    expect(tokyo?.scales[0]?.format(Date.UTC(2019, 11, 31, 15), "en")).toBe("2020–2029");
  });
});

describe("each level paints a header", () => {
  const ids = ["day", "week", "hour", "month", "quarter", "year"];

  for (const id of ids) {
    it(`paints labels and boundaries at the \`${id}\` level`, () => {
      const b = boot();
      booted = b;
      b.dom.flushFrames();
      const scale = b.gantt.service("stargantt.timeline");
      // `setZoomLevel` to the already-active level is a no-op, so step away first to make the
      // switch onto `id` the thing that schedules the paint under test.
      scale.setZoomLevel(id === "year" ? "day" : "year");
      scale.setZoomLevel(id);
      b.header.context.reset();
      b.dom.flushFrames();
      expect(b.header.context.texts.length).toBeGreaterThan(0);
      expect(b.header.context.verticalXs().length).toBeGreaterThan(0);
    });
  }

  it("is addressable by id regardless of contribution order", () => {
    const b = boot();
    booted = b;
    const scale = b.gantt.service("stargantt.timeline");
    scale.setZoomLevel("year");
    expect(scale.zoomLevel.get().id).toBe("year");
    scale.setZoomLevel("hour");
    expect(scale.zoomLevel.get().id).toBe("hour");
  });
});
