/**
 * Module-level tests for the opt-in background passes: non-working-day shading (weekend fallback
 * and calendar-driven), the off-hours hatch, highlight zones and the row-hover fill.
 *
 * Same shape as `grid-lines.test.ts`: the `renderer/layers` contribution is captured via
 * {@link mountGridLinesModule} and driven with a recording 2d context (`FakeContext2D`, which
 * records fills). The data source is {@link calendarSource}, a plain in-memory `CalendarDef` map —
 * the same shape `DataService.query().calendars` has, so an interface change over there is a
 * compile error here, not silent drift.
 */
import { createStore } from "@stargantt/core";
import type { Disposable } from "@stargantt/core";
import type { CalendarDef } from "@stargantt/plugin-data-store";
import type { LayerContribution, RowGeometryProvider, Viewport } from "../../src/internal/render/index";
import type { ThemeService } from "../../src/internal/theme/index";
import type { TimelineService, ZoomLevel } from "../../src/internal/timeline/index";
import { MS_DAY } from "@stargantt/sdk";
import { FakeContext2D, FakeElement, FakeDocument, asContext, asElement } from "../_utils/index";
import { describe, expect, it } from "vitest";
import {
  calendar,
  calendarSource,
  makeRenderStub,
  makeRowGeometry,
  mountGridLinesModule,
} from "./_boot";

/* ------------------------------------------------------------------ *
 * Doubles
 * ------------------------------------------------------------------ */

const NONWORK = "rgb(10, 10, 10)";
const OFFH = "rgb(20, 20, 20)";
const ZONE = "rgb(30, 30, 30)";
const HOVER = "rgb(40, 40, 40)";
const STRIPE = "rgb(50, 50, 50)";

// Only `get` is consumed by this module, so the stub carries only that member.
const THEME: Pick<ThemeService, "get"> = {
  get: (token) =>
    token === "--sg-grid-nonworking"
      ? NONWORK
      : token === "--sg-grid-offhours"
        ? OFFH
        : token === "--sg-grid-zone"
          ? ZONE
          : token === "--sg-row-hover-bg"
            ? HOVER
            : token === "--sg-row-stripe-bg"
              ? STRIPE
              : "",
};

const DAY_LEVEL: ZoomLevel = {
  id: "day",
  pxPerDay: 24,
  scales: [
    { unit: "month", step: 1, format: () => "m" },
    { unit: "day", step: 1, format: () => "d" },
  ],
};

/** A synthetic axis: `pxPerDay` px per day, content x = 0 at the epoch. */
function makeScale(pxPerDay: number, level: ZoomLevel = DAY_LEVEL): TimelineService {
  const pxPerMs = pxPerDay / MS_DAY;
  return {
    tToX: (t) => t * pxPerMs,
    xToT: (x) => x / pxPerMs,
    pxPerMs,
    zoomLevel: createStore(level),
    setZoomLevel: () => {},
    setOrigin: () => {},
    requestOriginExtension: () => {},
    releaseOriginExtension: () => {},
    firstDayOfWeek: () => 1,
    unitBoundaries: calendar(1),
    // Not consumed by this module; present only to satisfy the (wider) service interface.
    levelMetrics: () => [{ id: level.id, pxPerDay }],
    formatDate: () => "",
    gridCellAt: () => undefined,
  };
}

interface Harness {
  layer: LayerContribution;
  owned: Disposable[];
  pane: FakeElement;
  invalidated: string[];
}

function mount(
  factoryConfig: Parameters<typeof mountGridLinesModule>[0],
  services: {
    scale?: TimelineService;
    rows?: RowGeometryProvider;
    calendars?: readonly CalendarDef[];
    viewport?: Viewport;
  } = {},
): Harness {
  const scale = services.scale ?? makeScale(24);
  const pane = new FakeElement("div", new FakeDocument());
  const invalidated: string[] = [];
  const render = makeRenderStub({
    chartPaneElement: () => asElement(pane),
    viewport: services.viewport ?? VIEWPORT,
    invalidate: (layer) => void invalidated.push(layer),
    rowGeometry: () => services.rows,
  });

  // This suite isolates one shading pass at a time, so the two passes that default to on are off
  // unless the case asks for them. The defaults themselves are asserted in "shipped defaults"
  // below, which mounts with no config at all.
  const { layer, owned } = mountGridLinesModule(
    { rowStripes: false, nonWorkingDays: false, ...factoryConfig },
    render,
    THEME,
    scale,
    calendarSource(services.calendars ?? []),
  );
  if (layer === undefined) throw new Error("no renderer/layers contribution");
  return { layer, owned, pane, invalidated };
}

const VIEWPORT: Readonly<Viewport> = { scrollTop: 0, scrollLeft: 0, width: 240, height: 120 };

function paint(layer: LayerContribution, vp: Readonly<Viewport> = VIEWPORT): FakeContext2D {
  const g = new FakeContext2D();
  layer.draw(asContext(g), vp);
  return g;
}

/** `[x, y, w, h, fillStyle]` of every recorded `fillRect`. */
function fills(g: FakeContext2D): [number, number, number, number, string][] {
  return g.calls("fillRect").map((op) => {
    const [x = 0, y = 0, w = 0, h = 0] = op.args;
    return [x, y, w, h, op.fill];
  });
}

/* ------------------------------------------------------------------ *
 * Tests
 * ------------------------------------------------------------------ */

describe("with every optional pass switched off", () => {
  it("fills nothing, hatches nothing and attaches no listeners", () => {
    const { layer, owned, pane } = mount(undefined, { rows: makeRowGeometry(4) });
    const g = paint(layer);
    expect(g.count("fillRect")).toBe(0);
    expect(g.count("clip")).toBe(0);
    expect(owned).toHaveLength(0);
    expect(pane.listenerCount()).toBe(0);
  });
});

// Weekend shading ships on: a chart with no temporal landmark at all reads as a flat field of
// bars. It still costs nothing in a composition with no calendar named, which falls back to the
// built-in Sat/Sun pattern.
describe("shipped defaults", () => {
  /** Mounts with the real defaults, bypassing `mount`'s isolation overrides. */
  function mountDefaults(rows: RowGeometryProvider): LayerContribution {
    const scale = makeScale(24);
    const render = makeRenderStub({
      chartPaneElement: () => asElement(new FakeElement("div", new FakeDocument())),
      rowGeometry: () => rows,
    });
    const { layer } = mountGridLinesModule(undefined, render, THEME, scale, calendarSource());
    if (layer === undefined) throw new Error("no renderer/layers contribution");
    return layer;
  }

  it("shades weekends and stripes alternate rows out of the box", () => {
    const g = paint(mountDefaults(makeRowGeometry(4)));
    const fills = g.calls("fillRect");
    expect(fills.some((op) => op.fill === NONWORK)).toBe(true);
    expect(fills.some((op) => op.fill === STRIPE)).toBe(true);
  });
});

describe("nonWorkingDays — weekend fallback (no calendar named)", () => {
  it("shades merged Sat+Sun columns at 24 px/day", () => {
    const { layer } = mount({ vertical: false, horizontal: false, nonWorkingDays: true });
    const g = paint(layer);
    // Jan 1970: Sat 3rd + Sun 4th = days 2–3 (x 48..96); Sat 10th = day 9 (x 216, clipped at 240).
    expect(fills(g)).toEqual([
      [48, 0, 48, 120, NONWORK],
      [216, 0, 24, 120, NONWORK],
    ]);
  });

  it("honors a custom weekend list", () => {
    const { layer } = mount({
      vertical: false,
      horizontal: false,
      nonWorkingDays: { weekend: [5] }, // Fridays: Jan 2 (day 1) and Jan 9 (day 8)
    });
    expect(fills(paint(layer))).toEqual([
      [24, 0, 24, 120, NONWORK],
      [192, 0, 24, 120, NONWORK],
    ]);
  });

  it("skips itself below the minimum day width (coarse zoom)", () => {
    const { layer } = mount(
      { vertical: false, horizontal: false, nonWorkingDays: true },
      { scale: makeScale(2) },
    );
    expect(paint(layer).count("fillRect")).toBe(0);
  });
});

describe("nonWorkingDays — calendar-driven", () => {
  /** Mon–Fri, working 09:00–18:00 (milliseconds from UTC midnight). */
  const NINE_TO_SIX: CalendarDef = {
    id: "std",
    workingDays: [1, 2, 3, 4, 5],
    workingHours: [[9 * 3_600_000, 18 * 3_600_000]],
  };

  // docs/specs/plugins/view.md, "Calendar source resolution" — an **accepted, specified**
  // behaviour: with `nonWorkingDays.calendar` left unset, the module always
  // falls back to the built-in weekend pattern. Preferring a registry's `isDefault`-marked
  // calendar in this situation is not a concept this layer has — there is no implicit "the
  // composition's default calendar", only an explicit id or the fallback. A calendar that would shade *nothing* (every weekday
  // marked working) is registered here so that, were it ever consulted, the fills below would come
  // back empty instead of the fallback's two weekend bands — proving the registration is ignored.
  it("ignores a registered calendar when none is named, and always falls back to the weekend pattern", () => {
    const everyDayWorking: CalendarDef = { id: "std", workingDays: [0, 1, 2, 3, 4, 5, 6] };
    const { layer } = mount(
      { vertical: false, horizontal: false, nonWorkingDays: true },
      { calendars: [everyDayWorking] },
    );
    expect(fills(paint(layer))).toEqual([
      [48, 0, 48, 120, NONWORK],
      [216, 0, 24, 120, NONWORK],
    ]);
  });

  // §4.1 — normative: for a calendar that declares **no** intra-day windows, `nonWorkingIntervals`
  // returns whole-day spans and this pass renders byte-identically to the day-granular weekend
  // fallback. Asserted against the fallback's own output rather than by eye, because a drift here
  // is exactly what would move a committed screenshot baseline.
  it("renders a day-granular named calendar byte-identically to the weekend fallback", () => {
    const withCalendar = mount(
      { vertical: false, horizontal: false, nonWorkingDays: { calendar: "std" } },
      { calendars: [{ id: "std", workingDays: [1, 2, 3, 4, 5] }] },
    );
    const fallback = mount({ vertical: false, horizontal: false, nonWorkingDays: true });
    // Jan 1970 from the epoch: Sat 3rd + Sun 4th = days 2–3 (x 48..96); Sat 10th = day 9 (x 216,
    // clipped at the 240 px viewport).
    const expected: [number, number, number, number, string][] = [
      [48, 0, 48, 120, NONWORK],
      [216, 0, 24, 120, NONWORK],
    ];
    expect(fills(paint(withCalendar.layer))).toEqual(expected);
    expect(fills(paint(fallback.layer))).toEqual(expected);
  });

  // §4.1 — intra-day reflection is default-on: the same call returns finer spans, with no new
  // config field and no opt-in flag beyond naming the calendar.
  it("shades the sub-day gaps of a working day with no extra configuration", () => {
    const { layer } = mount(
      { vertical: false, horizontal: false, nonWorkingDays: { calendar: "std" } },
      { scale: makeScale(480), calendars: [NINE_TO_SIX] },
    );
    // 480 px/day → 20 px/hour; one visible day (Thu Jan 1 1970, a working day). The engine's
    // complement of its 09:00–18:00 window is midnight–09:00 and 18:00–midnight.
    const g = paint(layer, { scrollTop: 0, scrollLeft: 0, width: 480, height: 120 });
    expect(fills(g)).toEqual([
      [0, 0, 180, 120, NONWORK],
      [360, 0, 120, 120, NONWORK],
    ]);
  });

  // §4.1 guard, gate 2 + gate 3 — an intra-day band under 3 CSS px is omitted **entirely**: not
  // widened to a minimum width, not merged into a neighbour. Bands that carry a whole non-working
  // day are wider than a day column and therefore survive, which is the day-granular degrade.
  it("omits sub-day bands under the minimum width and keeps the day-scale ones", () => {
    const scale = makeScale(4); // 4 px per day column, so one hour is 1/6 px
    const vp: Viewport = { scrollTop: 0, scrollLeft: 0, width: 40, height: 120 };
    const { layer } = mount(
      { vertical: false, horizontal: false, nonWorkingDays: { calendar: "std" } },
      { scale, calendars: [NINE_TO_SIX], viewport: vp },
    );
    // Ten day columns are visible. The engine lists eight bands; the six purely intra-day ones
    // (a 9 h morning gap = 1.5 px, five 15 h overnight gaps = 2.5 px each) are all under 3 px and
    // drop out. What remains: Fri 18:00 → Mon 09:00 across the weekend (63 h = 10.5 px) and
    // Fri 18:00 → the query's end across the second Saturday (30 h = 5 px).
    expect(fills(paint(layer, vp))).toEqual([
      [7, 0, 11, 120, NONWORK],
      [35, 0, 5, 120, NONWORK],
    ]);
  });

  // §4.1 clipped-edge exemption — the engine clips the first and last band to the query, so a
  // partially visible non-working day arrives without its midnight alignment. Suppressing it would
  // blank a sliver the day-granular picture painted, so the gate treats it as whole-day.
  it("keeps a viewport-edge sliver narrower than the minimum band width", () => {
    // The viewport's left edge sits one hour before the Monday midnight that ends a weekend, so
    // the first band is 1 h wide — 1 px at 24 px/day, a third of the 3 px minimum.
    const vp: Viewport = { scrollTop: 0, scrollLeft: 95, width: 240, height: 120 };
    const { layer } = mount(
      { vertical: false, horizontal: false, nonWorkingDays: { calendar: "std" } },
      { calendars: [{ id: "std", workingDays: [1, 2, 3, 4, 5] }], viewport: vp },
    );
    expect(fills(paint(layer, vp))).toEqual([
      [0, 0, 1, 120, NONWORK],
      [121, 0, 48, 120, NONWORK],
    ]);
  });

  it("falls back to the weekend pattern when the named calendar does not resolve", () => {
    const { layer } = mount(
      { vertical: false, horizontal: false, nonWorkingDays: { calendar: "missing" } },
      { calendars: [{ id: "std", workingDays: [1, 2, 3, 4, 5] }] },
    );
    expect(fills(paint(layer))).toEqual([
      [48, 0, 48, 120, NONWORK],
      [216, 0, 24, 120, NONWORK],
    ]);
  });
});

describe("nonWorkingHours", () => {
  /** Mon–Fri, working 09:00–18:00 (milliseconds from UTC midnight). */
  const WORK_HOURS: [number, number][] = [[9 * 3_600_000, 18 * 3_600_000]];
  const WIDE: Viewport = { scrollTop: 0, scrollLeft: 0, width: 480, height: 120 };

  // docs/specs/plugins/view.md — the hatch needs intra-day working windows, and (per the "Calendar
  // source resolution" note above) those are only ever reachable through an explicit
  // `nonWorkingDays.calendar`; every case below names "std" for that reason, rather than relying
  // on a registry default resolving implicitly.

  it("hatches the off-hours stretches of each visible working day", () => {
    // 480 px/day → 20 px/hour; one visible day (Thu Jan 1, a working day).
    const cal: CalendarDef = { id: "std", workingDays: [1, 2, 3, 4, 5], workingHours: WORK_HOURS };
    const { layer } = mount(
      { vertical: false, horizontal: false, nonWorkingDays: { calendar: "std" }, nonWorkingHours: true },
      { scale: makeScale(480), calendars: [cal] },
    );
    const g = paint(layer, WIDE);
    // Two clipped hatch bands: midnight–09:00 (x 0..180) and 18:00–midnight (x 360..480).
    const rects = g.calls("rect").map((op) => op.args);
    expect(rects).toEqual([
      [0, 0, 180, 120],
      [360, 0, 120, 120],
    ]);
    expect(g.count("clip")).toBe(2);
    // The hatch is stroked diagonals in the off-hours color.
    const strokes = g.calls("stroke");
    expect(strokes.length).toBeGreaterThan(0);
    expect(strokes.every((op) => op.stroke === OFFH)).toBe(true);
    expect(g.count("moveTo")).toBeGreaterThan(2);
  });

  // §4.2 — "the hatched bands are **the sub-day spans of the same non-working listing §4.1
  // shades**", so one engine listing feeds both passes and the two can never disagree about what
  // is non-working.
  it("hatches exactly the bands the tint fills, on top of them", () => {
    const cal: CalendarDef = { id: "std", workingDays: [1, 2, 3, 4, 5], workingHours: WORK_HOURS };
    const { layer } = mount(
      { vertical: false, horizontal: false, nonWorkingDays: { calendar: "std" }, nonWorkingHours: true },
      { scale: makeScale(480), calendars: [cal] },
    );
    const g = paint(layer, WIDE);
    const tinted = fills(g).map(([x, , w]) => [x, w]);
    const hatched = g.calls("rect").map((op) => [op.args[0], op.args[2]]);
    expect(tinted).toEqual([
      [0, 180],
      [360, 120],
    ]);
    expect(hatched).toEqual(tinted);
    // Every fill precedes every hatch clip: the pattern goes on top of the tint, not beside it.
    const ops = g.ops.map((op) => op.op);
    expect(ops.indexOf("clip")).toBeGreaterThan(ops.lastIndexOf("fillRect"));
  });

  // §4.2 — whole-day-aligned spans stay §4.1's job, so a whole non-working day is tinted but
  // never hatched.
  it("leaves whole non-working days to the tint", () => {
    const cal: CalendarDef = { id: "std", workingDays: [1, 2, 3, 4, 5] };
    const { layer } = mount(
      { vertical: false, horizontal: false, nonWorkingDays: { calendar: "std" }, nonWorkingHours: true },
      { calendars: [cal] }, // 24 px/day, ten days visible, two weekend bands
    );
    expect(paint(layer).count("clip")).toBe(0);
  });

  // docs/specs/plugins/view.md — the engine merges adjacent non-working ranges, so a calendar with
  // intra-day windows hands back **one** band running from Friday's last working instant across
  // the whole weekend to Monday's first. That band is not whole-day-aligned, yet it is mostly
  // whole non-working days: hatching it would smear the off-hours pattern over two full days the
  // tint already conveys. Only a band contained within a single UTC day is hatched.
  it("never hatches a band merged across a weekend, however wide it is", () => {
    const cal: CalendarDef = {
      id: "std",
      workingDays: [1, 2, 3, 4, 5],
      workingHours: [[9 * 3_600_000, 17 * 3_600_000]],
    };
    // 96 px/day → 4 px/hour. The window opens at Fri 1970-01-02 00:00 UTC (x = 96) and spans four
    // day columns, so Friday, the weekend and Monday are all visible.
    const vp: Viewport = { scrollTop: 0, scrollLeft: 96, width: 4 * 96, height: 120 };
    const { layer } = mount(
      { vertical: false, horizontal: false, nonWorkingDays: { calendar: "std" }, nonWorkingHours: true },
      { scale: makeScale(96), calendars: [cal], viewport: vp },
    );
    const g = paint(layer, vp);
    // The tint carries all three non-working stretches, the 256 px merged weekend band included:
    // Fri 00:00–09:00, Fri 17:00 → Mon 09:00, and Mon 17:00 to the window's end.
    expect(fills(g).map(([x, , w]) => [x, w])).toEqual([
      [0, 36],
      [68, 256],
      [356, 28],
    ]);
    // The hatch marks only Friday's morning gap and Monday's evening gap. The weekend band dwarfs
    // the 3 px guard, so nothing but the single-UTC-day rule can be keeping it out.
    expect(g.calls("rect").map((op) => op.args)).toEqual([
      [0, 0, 36, 120],
      [356, 0, 28, 120],
    ]);
  });

  // §4.2 — "a day-granular calendar carrying a working exception that declares its own `hours`
  // does, on that day, have usable windows". Those gaps are intra-day, so they are hatched: no
  // contradiction with the windowless calendar that draws nothing, which speaks of a calendar with
  // no usable window anywhere.
  it("hatches the gaps of a working exception that declares its own hours", () => {
    // Mon–Fri, no `workingHours` at all — day-granular everywhere except Sat 1970-01-03, which the
    // exception turns into a 09:00–17:00 working day.
    const cal: CalendarDef = {
      id: "std",
      workingDays: [1, 2, 3, 4, 5],
      exceptions: [
        { date: "1970-01-03", working: true, hours: [[9 * 3_600_000, 17 * 3_600_000]] },
      ],
    };
    // 480 px/day → 20 px/hour, scrolled to that Saturday alone.
    const vp: Viewport = { scrollTop: 0, scrollLeft: 2 * 480, width: 480, height: 120 };
    const { layer } = mount(
      { vertical: false, horizontal: false, nonWorkingDays: { calendar: "std" }, nonWorkingHours: true },
      { scale: makeScale(480), calendars: [cal], viewport: vp },
    );
    expect(paint(layer, vp).calls("rect").map((op) => op.args)).toEqual([
      [0, 0, 180, 120],
      [340, 0, 140, 120],
    ]);
  });

  it("draws nothing without a named calendar or without usable windows", () => {
    const noCalendar = mount(
      { vertical: false, horizontal: false, nonWorkingHours: true },
      { scale: makeScale(480) },
    );
    expect(paint(noCalendar.layer, WIDE).count("clip")).toBe(0);

    // A calendar whose only window is unusable is day-granular to the engine (its windows are
    // dropped one by one), so it yields no sub-day span and marks nothing — an undefined pattern
    // marks nothing rather than everything.
    const junkHours: CalendarDef = {
      id: "std",
      workingDays: [1, 2, 3, 4, 5],
      workingHours: [[18 * 3_600_000, 9 * 3_600_000]],
    };
    const withJunk = mount(
      { vertical: false, horizontal: false, nonWorkingDays: { calendar: "std" }, nonWorkingHours: true },
      { scale: makeScale(480), calendars: [junkHours] },
    );
    expect(paint(withJunk.layer, WIDE).count("clip")).toBe(0);
  });

  // §4.2 — the guard is §4.1's per-band 3 CSS px rule on the same spans, replacing the former
  // 2-px-per-hour gate: tint and hatch appear and disappear together, on one threshold.
  it("stops hatching once the intra-day bands fall under the shared minimum width", () => {
    // A seven-day calendar with a lunch break, so the only hatchable band is that one-hour gap:
    // the overnight 18:00 → 09:00 stretches merge across midnight and belong to the tint. Both
    // viewports open and close at 10:00, inside a working window, so no clipped edge band can
    // stand in for the gap under test.
    const cal: CalendarDef = {
      id: "always",
      workingDays: [0, 1, 2, 3, 4, 5, 6],
      workingHours: [
        [9 * 3_600_000, 12 * 3_600_000],
        [13 * 3_600_000, 18 * 3_600_000],
      ],
    };
    // 96 px/day → the lunch hour is 4 px, over the 3 px minimum: the two visible lunches hatch,
    // and nothing else does.
    const fine: Viewport = { scrollTop: 0, scrollLeft: 40, width: 2 * 96, height: 120 };
    const fineMount = mount(
      { vertical: false, horizontal: false, nonWorkingDays: { calendar: "always" }, nonWorkingHours: true },
      { scale: makeScale(96), calendars: [cal], viewport: fine },
    );
    expect(paint(fineMount.layer, fine).calls("rect").map((op) => op.args)).toEqual([
      [8, 0, 4, 120],
      [104, 0, 4, 120],
    ]);
    // 48 px/day puts the same gap at 2 px, under the 3 px minimum: it drops out entirely.
    const coarse: Viewport = { scrollTop: 0, scrollLeft: 20, width: 96, height: 120 };
    const coarseMount = mount(
      { vertical: false, horizontal: false, nonWorkingDays: { calendar: "always" }, nonWorkingHours: true },
      { scale: makeScale(48), calendars: [cal], viewport: coarse },
    );
    expect(paint(coarseMount.layer, coarse).count("clip")).toBe(0);
    // And below the pass gate the whole shading stops, hatch included.
    const tooCoarse = mount(
      { vertical: false, horizontal: false, nonWorkingDays: { calendar: "always" }, nonWorkingHours: true },
      { scale: makeScale(2), calendars: [cal], viewport: coarse },
    );
    expect(paint(tooCoarse.layer, coarse).count("clip")).toBe(0);
  });
});

describe("zones", () => {
  it("fills valid zones with the token color or the per-zone override and drops junk", () => {
    const { layer } = mount({
      vertical: false,
      horizontal: false,
      zones: [
        { start: 1 * MS_DAY, end: 2 * MS_DAY },
        { start: 2 * MS_DAY, end: 3 * MS_DAY, color: "red" },
        { start: 5, end: 5 },
        { start: Number.NaN, end: 9 },
      ],
    });
    expect(fills(paint(layer))).toEqual([
      [24, 0, 24, 120, ZONE],
      [48, 0, 24, 120, "red"],
    ]);
  });

  it("clamps a zone to the viewport and skips off-screen zones", () => {
    const { layer } = mount({
      vertical: false,
      horizontal: false,
      zones: [
        { start: -MS_DAY, end: 1 * MS_DAY },
        { start: 30 * MS_DAY, end: 31 * MS_DAY },
      ],
    });
    expect(fills(paint(layer))).toEqual([[0, 0, 24, 120, ZONE]]);
  });

  it("resolves a color starting with '--' through the theme service", () => {
    const { layer } = mount({
      vertical: false,
      horizontal: false,
      zones: [{ start: 1 * MS_DAY, end: 2 * MS_DAY, color: "--sg-grid-offhours" }],
    });
    expect(fills(paint(layer))).toEqual([[24, 0, 24, 120, OFFH]]);
  });

  it("falls back to the zone token when a named custom property is unset", () => {
    const { layer } = mount({
      vertical: false,
      horizontal: false,
      zones: [{ start: 1 * MS_DAY, end: 2 * MS_DAY, color: "--sg-not-a-real-token" }],
    });
    expect(fills(paint(layer))).toEqual([[24, 0, 24, 120, ZONE]]);
  });

  it("keeps a color that does not start with '--' as a verbatim canvas color", () => {
    const { layer } = mount({
      vertical: false,
      horizontal: false,
      zones: [{ start: 1 * MS_DAY, end: 2 * MS_DAY, color: "rebeccapurple" }],
    });
    expect(fills(paint(layer))).toEqual([[24, 0, 24, 120, "rebeccapurple"]]);
  });

  // A verbatim color bypasses the theme registry's forced-colors mapping, so the module itself
  // must neutralize it: while `(forced-colors: active)` matches, verbatim-colored zones are
  // skipped and token-colored zones still paint (their neutralization is the theme module's job).
  it("skips verbatim-colored zones while (forced-colors: active) matches", () => {
    const saved = globalThis.matchMedia;
    (globalThis as { matchMedia?: unknown }).matchMedia = (query: string) => ({
      matches: query === "(forced-colors: active)",
    });
    try {
      const { layer } = mount({
        vertical: false,
        horizontal: false,
        zones: [
          { start: 1 * MS_DAY, end: 2 * MS_DAY, color: "rebeccapurple" },
          { start: 2 * MS_DAY, end: 3 * MS_DAY },
          { start: 3 * MS_DAY, end: 4 * MS_DAY, color: "--sg-grid-offhours" },
        ],
      });
      expect(fills(paint(layer))).toEqual([
        [48, 0, 24, 120, ZONE],
        [72, 0, 24, 120, OFFH],
      ]);
    } finally {
      if (saved === undefined) delete (globalThis as { matchMedia?: unknown }).matchMedia;
      else globalThis.matchMedia = saved;
    }
  });

  // The verbatim zone color is the opt-in for the forced-colors code path: a live flip of the
  // query state must repaint the background layer (change listener owned via ctx.own), and
  // without a verbatim zone the module must not touch matchMedia at all, so the default
  // composition takes no forced-colors code path.
  it("repaints on a live forced-colors flip, and only queries matchMedia for verbatim zones", () => {
    const saved = globalThis.matchMedia;
    let queried = 0;
    const listeners: ((e: unknown) => void)[] = [];
    const mql = {
      matches: false,
      addEventListener: (type: string, fn: (e: unknown) => void): void => {
        expect(type).toBe("change");
        listeners.push(fn);
      },
      removeEventListener: (_type: string, fn: (e: unknown) => void): void => {
        const i = listeners.indexOf(fn);
        if (i >= 0) listeners.splice(i, 1);
      },
    };
    (globalThis as { matchMedia?: unknown }).matchMedia = (query: string) => {
      expect(query).toBe("(forced-colors: active)");
      queried += 1;
      return mql;
    };
    try {
      // Token-only zones: no matchMedia call, no listener, nothing owned.
      const tokenOnly = mount({
        vertical: false,
        horizontal: false,
        zones: [{ start: 1 * MS_DAY, end: 2 * MS_DAY }],
      });
      expect(queried).toBe(0);
      expect(tokenOnly.owned).toHaveLength(0);

      // A verbatim zone opts in: the query is created and a change flip repaints.
      const { layer, owned, invalidated } = mount({
        vertical: false,
        horizontal: false,
        zones: [{ start: 1 * MS_DAY, end: 2 * MS_DAY, color: "rebeccapurple" }],
      });
      expect(queried).toBe(1);
      expect(listeners).toHaveLength(1);
      expect(fills(paint(layer))).toEqual([[24, 0, 24, 120, "rebeccapurple"]]);

      mql.matches = true;
      listeners[0]?.({ matches: true });
      expect(invalidated).toEqual(["background"]);
      expect(paint(layer).count("fillRect")).toBe(0); // neutralized on the repaint

      mql.matches = false;
      listeners[0]?.({ matches: false });
      expect(invalidated).toEqual(["background", "background"]);
      expect(fills(paint(layer))).toEqual([[24, 0, 24, 120, "rebeccapurple"]]);

      // Disposal removes the listener (ctx.own ownership).
      expect(owned).toHaveLength(1);
      for (const d of owned) d.dispose();
      expect(listeners).toHaveLength(0);
    } finally {
      if (saved === undefined) delete (globalThis as { matchMedia?: unknown }).matchMedia;
      else globalThis.matchMedia = saved;
    }
  });
});

describe("rowHover", () => {
  it("fills the hovered row, repaints only on row change, and clears on pointerleave", () => {
    const { layer, pane, owned, invalidated } = mount(
      { vertical: false, horizontal: false, rowHover: true },
      { rows: makeRowGeometry(4) },
    );
    expect(owned).toHaveLength(2); // one owned removal per listener

    pane.fire("pointermove", { type: "pointermove", clientY: 40 });
    expect(invalidated).toEqual(["background"]);
    expect(fills(paint(layer))).toEqual([[0, 30, 240, 30, HOVER]]);

    // Same row again: no extra repaint.
    pane.fire("pointermove", { type: "pointermove", clientY: 45 });
    expect(invalidated).toEqual(["background"]);

    pane.fire("pointerleave", { type: "pointerleave" });
    expect(invalidated).toEqual(["background", "background"]);
    expect(paint(layer).count("fillRect")).toBe(0);
  });

  it("accounts for the scroll offset when resolving and painting the row", () => {
    const vp: Viewport = { scrollTop: 35, scrollLeft: 0, width: 240, height: 120 };
    const { layer, pane } = mount(
      { vertical: false, horizontal: false, rowHover: true },
      { rows: makeRowGeometry(6), viewport: vp },
    );
    pane.fire("pointermove", { type: "pointermove", clientY: 40 }); // content y 75 → row 2
    expect(fills(paint(layer, vp))).toEqual([[0, 25, 240, 30, HOVER]]);
  });

  it("draws nothing below the last row and without a row-geometry provider", () => {
    const withRows = mount(
      { vertical: false, horizontal: false, rowHover: true },
      { rows: makeRowGeometry(2) },
    );
    withRows.pane.fire("pointermove", { type: "pointermove", clientY: 100 }); // past 60 px total
    expect(withRows.invalidated).toEqual([]);
    expect(paint(withRows.layer).count("fillRect")).toBe(0);

    const noRows = mount({ vertical: false, horizontal: false, rowHover: true });
    noRows.pane.fire("pointermove", { type: "pointermove", clientY: 10 });
    expect(paint(noRows.layer).count("fillRect")).toBe(0);
  });
});

describe("shading sits under the lines", () => {
  it("records every fill before the first line stroke of the same paint", () => {
    const { layer } = mount(
      { nonWorkingDays: true, zones: [{ start: 0, end: MS_DAY }] },
      { rows: makeRowGeometry(3) },
    );
    const g = paint(layer);
    const ops = g.ops.map((op) => op.op);
    const lastFill = ops.lastIndexOf("fillRect");
    const firstStroke = ops.indexOf("stroke");
    expect(lastFill).toBeGreaterThanOrEqual(0);
    expect(firstStroke).toBeGreaterThan(lastFill);
  });
});
