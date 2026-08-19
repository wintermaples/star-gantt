/**
 * The timeline module of `stargantt.view` end-to-end through the real core and the real render
 * module: plugin shape, service surface, the `timeline/zoomLevels` point, date↔x mapping, anchored
 * zoom, the §3.5 header canvas, the fault barrier and disposal.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import type { PluginContext } from "@stargantt/core";
import { view } from "../../src/index";
import type { TimelineService, ZoomLevel } from "../../src/internal/timeline/index";
import { MS_DAY } from "../../src/internal/timeline/scale";
import { DEFAULT_HEADER_HEIGHT } from "../../src/internal/timeline/header";

// The header's two default scale rows split the token height equally.
const ROW_HEIGHT = DEFAULT_HEADER_HEIGHT / 2;
import { boot, probe, watchZoom } from "./_boot";
import type { Booted } from "./_boot";
import { wheelEvent } from "../_utils/index";
import type { FakeElement } from "../_utils/index";

let booted: Booted | null = null;

function start(...args: Parameters<typeof boot>): Booted {
  booted = boot(...args);
  return booted;
}

afterEach(() => {
  booted?.dom.restore();
  booted = null;
});

function scale(b: Booted): TimelineService {
  return b.gantt.service("stargantt.timeline");
}

/** Boots, runs the `lifecycle/ready` frame, and clears the recorded canvas calls. */
function settle(b: Booted): Booted {
  b.dom.flushFrames();
  b.header.context.reset();
  for (const name of ["background", "main", "overlay"] as const) b.layer(name).context.reset();
  return b;
}

function level(id: string, pxPerDay: number, unit: ZoomLevel["scales"][number]["unit"]): ZoomLevel {
  return { id, pxPerDay, scales: [{ unit, format: (t) => String(t) }] };
}

/* ------------------------------------------------------------------ */

// The `timelineScale()` factory is gone: the time axis is a module of `stargantt.view`, so the
// plugin identity it used to carry is the merged plugin's. What survives verbatim is the *service*
// identity — `stargantt.timeline` is still published under its own key, which is what a consumer
// depends on — and that is asserted in "service registration" below.
describe("factory and plugin identity", () => {
  it("exports a factory, not a plugin const", () => {
    expect(typeof view).toBe("function");
    expect(typeof view().setup).toBe("function");
  });

  it("carries the merged plugin's id, since the timeline is one of its modules", () => {
    expect(view().meta.id).toBe("stargantt.view");
  });

  it("accepts an optional config and yields an independent plugin per call", () => {
    const a = view();
    const b = view({});
    expect(a).not.toBe(b);
    expect(b.meta.id).toBe(a.meta.id);
  });
});

describe("initialZoom", () => {
  it("omitted, the first entry of the composed list is active — today\'s behavior verbatim", () => {
    const b = start([], {}, { origin: 0 });
    expect(scale(b).zoomLevel.get().id).toBe("day");
    expect(scale(b).pxPerMs).toBe(40 / MS_DAY);
  });

  it("selects the named built-in level before the first paint", () => {
    const b = start([], {}, { origin: 0, initialZoom: "week" });
    expect(scale(b).zoomLevel.get().id).toBe("week");
    expect(scale(b).pxPerMs).toBe(12 / MS_DAY);
  });

  it("leaves `origin` fixing content x = 0 — no anchor time is involved", () => {
    const b = start([], {}, { origin: 0, initialZoom: "week" });
    expect(scale(b).tToX(0)).toBe(0);
    expect(scale(b).tToX(MS_DAY)).toBe(12);
  });

  it("can name a level another plugin contributes", () => {
    const level: ZoomLevel = { id: "hour", pxPerDay: 480, scales: [] };
    const b = start(
      [probe((ctx) => ctx.contribute("timeline/zoomLevels", level), "test.levels", [])],
      {},
      { origin: 0, initialZoom: "hour" },
    );
    expect(scale(b).zoomLevel.get().id).toBe("hour");
  });

  it("falls back to the first entry silently when no level carries the id", () => {
    const errors: unknown[] = [];
    const b = start(
      [probe((ctx) => ctx.on("core/pluginError", (e) => errors.push(e)), "test.errors", [])],
      {},
      { origin: 0, initialZoom: "no-such-level" },
    );
    expect(scale(b).zoomLevel.get().id).toBe("day");
    expect(errors).toEqual([]);
  });

  it("does not block a later `setZoomLevel`", () => {
    const b = start([], {}, { origin: 0, initialZoom: "week" });
    scale(b).setZoomLevel("day");
    expect(scale(b).zoomLevel.get().id).toBe("day");
  });

  it("is resolved once at the first read, so a level contributed afterwards does not take over", () => {
    let contributeLate: (() => void) | undefined;
    const b = start(
      [
        probe(
          (ctx) => {
            contributeLate = () =>
              ctx.contribute("timeline/zoomLevels", { id: "late", pxPerDay: 480, scales: [] });
          },
          "test.late",
          [],
        ),
      ],
      {},
      { origin: 0, initialZoom: "late" },
    );
    // The list as first read carries no "late" level, so the first entry wins — and the decision
    // is not revisited when the level finally shows up.
    expect(scale(b).zoomLevel.get().id).toBe("day");
    contributeLate?.();
    expect(scale(b).zoomLevel.get().id).toBe("day");
  });
});

describe("service registration", () => {
  it("provides `stargantt.timeline` with the declared members", () => {
    const s = scale(start());
    expect(typeof s.tToX).toBe("function");
    expect(typeof s.xToT).toBe("function");
    expect(typeof s.pxPerMs).toBe("number");
    // `zoomLevel()` is a store: a read plus a subscription, which is what replaces the abolished
    // `timeline/zoomChanged` event.
    expect(typeof s.zoomLevel.get).toBe("function");
    expect(typeof s.zoomLevel.subscribe).toBe("function");
    expect(typeof s.setZoomLevel).toBe("function");
    expect(typeof s.firstDayOfWeek).toBe("function");
    expect(typeof s.unitBoundaries).toBe("function");
  });

  it("is reachable by a dependent plugin through `ctx.use`", () => {
    const seen: TimelineService[] = [];
    start([probe((ctx: PluginContext) => void seen.push(ctx.use("stargantt.timeline")))]);
    expect(seen).toHaveLength(1);
    expect(seen[0]?.zoomLevel.get().id).toBe("day");
  });
});

// The public boundary enumeration: the one calendar the header ticks and any consumer's grid
// both come from.
describe("unitBoundaries", () => {
  const T = (iso: string): number => Date.parse(iso);

  it("enumerates the boundaries inside the half-open span, in ascending order", () => {
    const s = scale(start());
    expect(s.unitBoundaries("day", T("2026-08-06T13:00:00Z"), T("2026-08-09T00:00:00Z"))).toEqual([
      T("2026-08-07T00:00:00Z"),
      T("2026-08-08T00:00:00Z"),
    ]);
    expect(s.unitBoundaries("month", T("2026-02-10T00:00:00Z"), T("2026-04-02T00:00:00Z"))).toEqual([
      T("2026-03-01T00:00:00Z"),
      T("2026-04-01T00:00:00Z"),
    ]);
  });

  it("steps on the calendar: a 3-month enumeration breaks at Jan/Apr/Jul/Oct", () => {
    const s = scale(start());
    expect(
      s.unitBoundaries("month", T("2026-02-15T00:00:00Z"), T("2027-01-01T00:00:00Z"), 3),
    ).toEqual([
      T("2026-04-01T00:00:00Z"),
      T("2026-07-01T00:00:00Z"),
      T("2026-10-01T00:00:00Z"),
    ]);
    // An unusable step enumerates every boundary instead.
    for (const step of [0, -3, Number.NaN]) {
      expect(
        s.unitBoundaries("day", T("2026-08-06T00:00:00Z"), T("2026-08-09T00:00:00Z"), step),
      ).toEqual(s.unitBoundaries("day", T("2026-08-06T00:00:00Z"), T("2026-08-09T00:00:00Z")));
    }
  });

  it("starts weeks on the weekday the instance reports as its week start", () => {
    const monday = scale(start());
    expect(monday.firstDayOfWeek()).toBe(1);
    expect(
      monday.unitBoundaries("week", T("2026-08-03T00:00:00Z"), T("2026-08-17T00:00:00Z")),
    ).toEqual([T("2026-08-03T00:00:00Z"), T("2026-08-10T00:00:00Z")]);

    booted?.dom.restore();
    const sunday = scale(start([], {}, { origin: 0, firstDayOfWeek: 0 }));
    expect(sunday.firstDayOfWeek()).toBe(0);
    expect(
      sunday.unitBoundaries("week", T("2026-08-03T00:00:00Z"), T("2026-08-17T00:00:00Z")),
    ).toEqual([T("2026-08-09T00:00:00Z"), T("2026-08-16T00:00:00Z")]);
  });

  it("yields an empty array for an empty or inverted span, and caps a degenerate one", () => {
    const s = scale(start());
    const t = T("2026-08-06T00:00:00Z");
    expect(s.unitBoundaries("day", t, t)).toEqual([]);
    expect(s.unitBoundaries("day", t, t - MS_DAY)).toEqual([]);
    expect(s.unitBoundaries("hour", t, t + 1000 * 365 * MS_DAY)).toHaveLength(4096);
  });

  it("hands out a fresh array the caller cannot use to reach plugin state", () => {
    const s = scale(start());
    const from = T("2026-08-06T00:00:00Z");
    const first = s.unitBoundaries("day", from, from + 3 * MS_DAY);
    expect(s.unitBoundaries("day", from, from + 3 * MS_DAY)).not.toBe(first);
    expect(s.unitBoundaries("day", from, from + 3 * MS_DAY)).toEqual(first);
  });
});

describe("`timeline/zoomLevels` extension point (collect, §3.5)", () => {
  it("ships the two spec-named default levels", () => {
    const b = start();
    // The point is read through the service: `zoomLevel()` resolves to the first registered level.
    expect(scale(b).zoomLevel.get().id).toBe("day");
    scale(b).setZoomLevel("week");
    expect(scale(b).zoomLevel.get().id).toBe("week");
  });

  it("day is a month row over a day row (§3.5 worked example)", () => {
    const day = scale(start()).zoomLevel.get();
    expect(day.scales.map((s) => s.unit)).toEqual(["month", "day"]);
    expect(day.pxPerDay).toBeGreaterThan(0);
  });

  it("accepts third-party levels contributed to the point", () => {
    const custom = level("quarter-hour", 4000, "hour");
    const b = start([probe((ctx) => ctx.contribute("timeline/zoomLevels", custom), "test.custom")]);
    scale(b).setZoomLevel("quarter-hour");
    expect(scale(b).zoomLevel.get()).toBe(custom);
    expect(scale(b).pxPerMs).toBeCloseTo(4000 / MS_DAY, 12);
  });
});

describe("initial axis origin", () => {
  afterEach(() => void vi.useRealTimers());

  it("puts the start of the current UTC day at x = 0 when no origin is configured", () => {
    // Mid-afternoon, so a naive `Date.now()` origin would be visibly off the day boundary.
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(Date.parse("2026-08-06T15:47:31.250Z"));

    const s = scale(start([], {}, {}));
    expect(s.xToT(0)).toBe(Date.parse("2026-08-06T00:00:00Z"));
    // Day-aligned, so the next day boundary still lands on a whole `pxPerDay` multiple.
    expect(s.tToX(Date.parse("2026-08-07T00:00:00Z"))).toBeCloseTo(40, 9);
  });

  it("opens on data placed around today, which is what the default is for", () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(Date.parse("2026-08-06T09:00:00Z"));

    const b = start([], { width: 800 }, {});
    const s = scale(b);
    // A task starting today and running a week: the whole bar is inside the 800px-wide viewport
    // at scrollLeft 0, so the first paint shows it without any scrolling.
    const taskStart = Date.parse("2026-08-06T00:00:00Z");
    const taskEnd = taskStart + 7 * MS_DAY;
    expect(s.tToX(taskStart)).toBe(0);
    expect(s.tToX(taskEnd)).toBeLessThan(800);
    // …and the header agrees.
    b.dom.flushFrames();
    expect(b.header.context.texts.map((t) => t.text)).toContain("August 2026");
  });

  it("maps a configured origin to x = 0", () => {
    const origin = Date.parse("2026-09-01T00:00:00Z");
    const s = scale(start([], {}, { origin }));
    expect(s.tToX(origin)).toBe(0);
    expect(s.xToT(0)).toBe(origin);
    expect(s.tToX(origin + MS_DAY)).toBeCloseTo(40, 9);
  });

  it("ignores a non-finite origin and falls back to the default", () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(Date.parse("2026-08-06T15:47:31.250Z"));

    const s = scale(start([], {}, { origin: Number.NaN }));
    expect(s.xToT(0)).toBe(Date.parse("2026-08-06T00:00:00Z"));
  });
});

describe("date ↔ x mapping", () => {
  it("derives `pxPerMs` from the current level's `pxPerDay`", () => {
    const b = start();
    expect(scale(b).pxPerMs).toBeCloseTo(40 / MS_DAY, 15);
    scale(b).setZoomLevel("week");
    // The getter is live: it follows the level, it is not a snapshot taken at setup.
    expect(scale(b).pxPerMs).toBeCloseTo(12 / MS_DAY, 15);
  });

  it("maps one day to `pxPerDay` content pixels", () => {
    const s = scale(start());
    const t = Date.parse("2026-08-06T00:00:00Z");
    expect(s.tToX(t + MS_DAY) - s.tToX(t)).toBeCloseTo(40, 9);
  });

  it("`xToT` inverts `tToX`", () => {
    const s = scale(start());
    const t = Date.parse("2026-08-06T09:30:00Z");
    expect(s.xToT(s.tToX(t))).toBeCloseTo(t, 3);
    expect(s.tToX(s.xToT(1234))).toBeCloseTo(1234, 9);
  });

  it("is affine, so equal time spans map to equal widths anywhere on the axis", () => {
    const s = scale(start());
    const a = Date.parse("1999-01-01T00:00:00Z");
    const b = Date.parse("2031-06-15T00:00:00Z");
    expect(s.tToX(a + MS_DAY) - s.tToX(a)).toBeCloseTo(s.tToX(b + MS_DAY) - s.tToX(b), 9);
  });
});

describe("`setZoomLevel`", () => {
  // A level change publishes a level object with a *different* id, which is how a subscriber tells
  // it from the origin move that re-publishes the unchanged one.
  it("publishes the new level on the `zoomLevel` store", () => {
    const b = start();
    const seen = watchZoom(b);
    scale(b).setZoomLevel("week");
    expect(seen).toEqual([{ level: 1, cause: "zoom" }]);
    expect(scale(b).zoomLevel.get().id).toBe("week");
  });

  it("is a no-op when the level is already current", () => {
    const b = start();
    const seen = watchZoom(b);
    scale(b).setZoomLevel("day");
    expect(seen).toEqual([]);
  });

  it("throws on an unknown level id", () => {
    const b = start();
    expect(() => scale(b).setZoomLevel("nope")).toThrow(/unknown zoom level "nope"/);
  });

  // The anchor is held on the *viewport*, by the scroll: the origin does not take part, so the
  // anchor's content x is expected to change.
  it("keeps the anchor time under the same point of the chart area", () => {
    const b = start();
    const s = scale(b);
    const renderer = b.gantt.service("stargantt.view");
    // Away from the left edge, so the scroll can follow the anchor without meeting the clamp.
    renderer.scrollTo({ scrollLeft: 40 * 40 });
    const vp = renderer.viewport.get();
    const anchor = s.xToT(vp.scrollLeft + 120);
    const originBefore = s.xToT(0);

    s.setZoomLevel("week", anchor);

    expect(s.pxPerMs).toBeCloseTo(12 / MS_DAY, 15);
    expect(s.tToX(anchor) - renderer.viewport.get().scrollLeft).toBeCloseTo(120, 6);
    expect(s.xToT(0)).toBe(originBefore);
  });

  it("stops at the axis's left edge when a zoom-out anchor cannot be held", () => {
    const b = start();
    const s = scale(b);
    const renderer = b.gantt.service("stargantt.view");
    const originBefore = s.xToT(0);
    // At `scrollLeft` 0 there is nothing to give back: holding the anchor would need a negative
    // scroll, so the clamp wins and the view stays at the start of the axis rather than the origin
    // moving to invent content before it.
    s.setZoomLevel("week", s.xToT(200));
    expect(renderer.viewport.get().scrollLeft).toBe(0);
    expect(s.xToT(0)).toBe(originBefore);
  });

  it("leaves the axis origin alone when no anchor is given", () => {
    const b = start();
    const s = scale(b);
    const originBefore = s.xToT(0);
    s.setZoomLevel("week");
    expect(s.xToT(0)).toBeCloseTo(originBefore, 6);
  });

  it("invalidates every renderer canvas, since zoom re-lays out the whole chart", () => {
    const b = settle(start());
    scale(b).setZoomLevel("week");
    b.dom.flushFrames();
    for (const name of ["background", "main", "overlay"] as const) {
      expect(b.layer(name).context.argsOf("clearRect").length).toBeGreaterThan(0);
    }
  });
});

describe("header canvas", () => {
  it("is a dedicated canvas on the gantt root, not a `renderer/layers` contribution", () => {
    const b = start();
    expect(b.header.tagName).toBe("CANVAS");
    expect(b.header.className).toBe("sg-header");
    expect(b.header.parentNode).toBe(b.root);
    // It is not one of the renderer's three layers.
    expect(b.header.getAttribute("data-layer")).toBeNull();
  });

  it("paints one row per scale definition on `lifecycle/ready`", () => {
    const b = start();
    b.dom.flushFrames();
    const g = b.header.context;
    expect(g.argsOf("clearRect").length).toBeGreaterThan(0);
    expect(g.texts.length).toBeGreaterThan(0);
    // Month row over day row: the month label sits in the upper band, day labels below it.
    expect(g.texts.some((t) => t.y < ROW_HEIGHT)).toBe(true);
    expect(g.texts.some((t) => t.y > ROW_HEIGHT)).toBe(true);
  });

  it("formats boundaries in UTC through `ScaleRow.format`", () => {
    const b = start();
    b.dom.flushFrames();
    // `boot` pins the origin at epoch 0, so the initial window opens on 1970-01-01 UTC.
    expect(b.header.context.texts.map((t) => t.text)).toContain("January 1970");
  });

  it("places day boundaries `pxPerDay` apart", () => {
    const b = start();
    b.dom.flushFrames();
    const xs = b.header.context.verticalXs().filter((x) => x >= 0);
    expect(xs).toContain(0);
    expect(xs).toContain(40);
  });

  it("sizes its backing store by devicePixelRatio (§3.2-4)", () => {
    const b = start([], { width: 800, dpr: 2 });
    b.dom.flushFrames();
    expect(b.header.width).toBe(1600);
    expect(b.header.height).toBe(DEFAULT_HEADER_HEIGHT * 2);
    expect(b.header.context.argsOf("scale")).toContainEqual([2, 2]);
  });

  it("follows horizontal scroll", () => {
    const b = settle(start());
    b.pane.fire("wheel", wheelEvent({ deltaX: 200 }));
    b.dom.flushFrames();
    const xs = b.header.context.verticalXs().filter((x) => x >= 0);
    // scrollLeft 200 = 5 days at 40px/day, so the day-5 boundary lands on x = 0.
    expect(xs).toContain(0);
    expect(b.header.context.texts.map((t) => t.text)).toContain("6");
  });

  // The header canvas is not a renderer layer, so the theme module's `invalidate` sweep cannot
  // repaint it. Its repaint signal is the theme's token store: `refresh()` re-reads the tokens
  // and sets the store, which is exactly what a runtime theme change does.
  it("repaints when the theme's token store announces a runtime theme change", () => {
    const b = settle(start());
    expect(b.header.context.argsOf("clearRect")).toEqual([]);

    b.gantt.service("stargantt.theme").refresh();
    b.dom.flushFrames();
    expect(b.header.context.argsOf("clearRect").length).toBeGreaterThan(0);
    expect(b.header.context.texts.length).toBeGreaterThan(0);
  });

  it("is not vertically scroll-linked", () => {
    const b = settle(start());
    b.pane.fire("wheel", wheelEvent({ deltaY: 120 }));
    b.dom.flushFrames();
    expect(b.header.context.texts).toEqual([]);
    // The chart itself did repaint — only the header stayed put.
    expect(b.layer("main").context.argsOf("clearRect").length).toBeGreaterThan(0);
  });

  it("batches repaints into one frame (§3.2-2)", () => {
    const b = settle(start());
    b.pane.fire("wheel", wheelEvent({ deltaX: 40 }));
    b.pane.fire("wheel", wheelEvent({ deltaX: 40 }));
    b.pane.fire("wheel", wheelEvent({ deltaX: 40 }));
    b.dom.flushFrames();
    // Three scroll events, one header paint.
    expect(b.header.context.argsOf("clearRect")).toHaveLength(1);
  });

  it("spans the chart pane, not the whole root", () => {
    const b = settle(start());
    // The tree grid takes the left of the root, so the chart pane starts well inside it.
    b.root.rect = { left: 20, top: 0, width: 862, height: 600 };
    b.pane.rect = { left: 345, top: 0, width: 517, height: 600 };
    b.dom.triggerResizeObservers();
    b.dom.flushFrames();
    // Offsets are root-relative: the canvas is absolutely positioned inside the root.
    expect(b.header.style["left"]).toBe("325px");
    expect(b.header.style["width"]).toBe("517px");
    expect(b.header.width).toBe(517);
  });

  it("keeps its labels on the chart body's x coordinates when the panes are offset", () => {
    const b = settle(start());
    b.root.rect = { left: 20, top: 0, width: 862, height: 600 };
    b.pane.rect = { left: 345, top: 0, width: 517, height: 600 };
    b.dom.triggerResizeObservers();
    b.dom.flushFrames();
    // A day boundary is drawn at content x 0, which is the pane's left edge and hence the
    // canvas's own x 0 — the same column the chart body draws that day in.
    expect(b.header.context.verticalXs()).toContain(0);
    // Nothing is shifted by the grid pane's width.
    expect(b.header.context.verticalXs()).not.toContain(-325);
  });

  it("observes the chart pane, whose width changes without the root's", () => {
    const b = settle(start());
    expect(b.dom.resizeObserverTargets()).toContain(b.pane);
    // Dragging the pane boundary narrows the chart alone; the header must resize with it.
    b.pane.rect = { left: 500, top: 0, width: 300, height: 600 };
    b.dom.triggerResizeObservers();
    b.dom.flushFrames();
    expect(b.header.style["left"]).toBe("500px");
    expect(b.header.style["width"]).toBe("300px");
  });

  it("observes the chart pane by element identity, never by a class lookup", () => {
    // Regression: the pane was once resolved by a `.sg-pane--chart` class lookup, which could miss
    // a pane whose class was not yet in place and left the header observing the root alone. It now
    // comes from the render module's own accessor by element identity, so this test hides the class
    // for the chart's whole lifetime: a lookup-based resolution would find nothing at all, while
    // identity is unaffected.
    const b = settle(start());
    const pane: FakeElement = b.pane;
    pane.className = pane.className.replace("sg-pane--chart", "sg-pane--pending");

    // The render module installs its own observer on the pane, so "the pane is observed by someone"
    // proves nothing: it has to be observed by the *header's* observer — the one watching the
    // root — or the header stops tracking the pane's width.
    const groups = b.dom.resizeObserverGroups().filter((g) => g.includes(b.root));
    expect(groups.length).toBeGreaterThan(0);
    expect(groups.some((g) => g.includes(pane))).toBe(true);

    // And the header actually follows the pane's box: the root keeps its size, so only an observer
    // on the pane can trigger the repaint that resizes the header.
    pane.rect = { left: 500, top: 0, width: 300, height: 600 };
    b.dom.triggerResizeObservers();
    b.dom.flushFrames();
    expect(b.header.style["left"]).toBe("500px");
    expect(b.header.style["width"]).toBe("300px");
  });

  it("repaints when the root is resized", () => {
    const b = settle(start());
    expect(b.dom.resizeObserverCount()).toBeGreaterThan(0);
    b.dom.triggerResizeObservers();
    b.dom.flushFrames();
    expect(b.header.context.texts.length).toBeGreaterThan(0);
  });

  it("falls back to a timer when the host has no requestAnimationFrame", async () => {
    const b = start([], { raf: false });
    await new Promise((resolve) => setTimeout(resolve, 40));
    expect(b.header.context.texts.length).toBeGreaterThan(0);
  });
});

describe("Ctrl+wheel anchored zoom", () => {
  it("ignores a wheel without the Ctrl modifier", () => {
    const b = start();
    const e = wheelEvent({ deltaY: -120 });
    b.root.fire("wheel", e);
    expect(scale(b).zoomLevel.get().id).toBe("day");
    expect(e.defaultPrevented).toBe(false);
  });

  it("zooms out on Ctrl+wheel-down and swallows the event so the pane does not scroll", () => {
    const b = start();
    const e = wheelEvent({ deltaY: 120, ctrlKey: true, clientX: 200 });
    b.root.fire("wheel", e);
    expect(scale(b).zoomLevel.get().id).toBe("week");
    expect(e.defaultPrevented).toBe(true);
    expect(e.propagationStopped).toBe(true);
  });

  it("zooms in on Ctrl+wheel-up towards the denser level", () => {
    const b = start();
    scale(b).setZoomLevel("week");
    b.root.fire("wheel", wheelEvent({ deltaY: -120, ctrlKey: true, clientX: 100 }));
    expect(scale(b).zoomLevel.get().id).toBe("day");
  });

  // Pinned on the viewport, by scrolling. Zooming in is the direction that always has room for
  // it; the zoom-out clamp has its own test above.
  it("pins the time under the pointer (§1.18 anchor)", () => {
    const b = start();
    const s = scale(b);
    s.setZoomLevel("week");
    const renderer = b.gantt.service("stargantt.view");
    const anchor = s.xToT(renderer.viewport.get().scrollLeft + 200);
    const originBefore = s.xToT(0);
    b.root.fire("wheel", wheelEvent({ deltaY: -120, ctrlKey: true, clientX: 200 }));
    expect(s.zoomLevel.get().id).toBe("day");
    expect(s.tToX(anchor) - renderer.viewport.get().scrollLeft).toBeCloseTo(200, 6);
    expect(s.xToT(0)).toBe(originBefore);
  });

  // `hour` is the densest built-in level and `year` the coarsest, so those are the two ends of
  // the default range.
  it("does nothing at the dense end of the level range", () => {
    const b = start();
    scale(b).setZoomLevel("hour");
    b.root.fire("wheel", wheelEvent({ deltaY: -120, ctrlKey: true }));
    expect(scale(b).zoomLevel.get().id).toBe("hour");
  });

  it("does nothing at the coarse end of the level range", () => {
    const b = start();
    scale(b).setZoomLevel("year");
    b.root.fire("wheel", wheelEvent({ deltaY: 120, ctrlKey: true }));
    expect(scale(b).zoomLevel.get().id).toBe("year");
  });

  it("steps by density, not by contribution order", () => {
    // Contributed last but denser than every built-in: a zoom-in from `hour` must reach it.
    const dense = level("hourly", 2000, "hour");
    const b = start([probe((ctx) => ctx.contribute("timeline/zoomLevels", dense), "test.dense")]);
    scale(b).setZoomLevel("hour");
    b.root.fire("wheel", wheelEvent({ deltaY: -120, ctrlKey: true }));
    expect(scale(b).zoomLevel.get().id).toBe("hourly");
  });
});

describe("fault barrier for contributed functions", () => {
  it("reports a throwing `ScaleRow.format` as `core/pluginError` and keeps painting", () => {
    const boom: ZoomLevel = {
      id: "boom",
      pxPerDay: 40,
      scales: [
        { unit: "day", format: () => "ok" },
        {
          unit: "month",
          format: () => {
            throw new Error("format exploded");
          },
        },
      ],
    };
    const b = start([probe((ctx) => ctx.contribute("timeline/zoomLevels", boom), "test.boom")]);
    const faults: { pluginId: string; error: unknown }[] = [];
    b.gantt.on("core/pluginError", (e) => void faults.push(e));

    settle(b);
    scale(b).setZoomLevel("boom");
    b.dom.flushFrames();

    expect(faults.length).toBeGreaterThan(0);
    expect(faults[0]?.pluginId).toBe("stargantt.view");
    expect(String((faults[0]?.error as Error).message)).toContain("format exploded");
    // The other row still rendered.
    expect(b.header.context.texts.map((t) => t.text)).toContain("ok");
  });
});

describe("disposal (CLAUDE.md constraint, §1.3)", () => {
  it("removes the header canvas and the wheel listener", () => {
    const b = start();
    expect(b.root.children).toContain(b.header);
    const wheelListeners = b.root.listenerCount("wheel");
    expect(wheelListeners).toBeGreaterThan(0);

    b.gantt.dispose();
    expect(b.root.children).not.toContain(b.header);
    expect(b.header.parentNode).toBeNull();
    expect(b.root.listenerCount("wheel")).toBe(0);
    expect(b.dom.resizeObserverCount()).toBe(0);
  });

  it("cancels a queued header frame", () => {
    const b = settle(start());
    b.pane.fire("wheel", wheelEvent({ deltaX: 80 }));
    expect(b.dom.pendingFrames()).toBeGreaterThan(0);
    b.gantt.dispose();
    expect(b.dom.pendingFrames()).toBe(0);
  });
});
