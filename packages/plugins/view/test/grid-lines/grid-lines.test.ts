/**
 * Module-level tests: config normalization and what one `draw` pass puts on the canvas.
 *
 * The module's whole runtime surface is one `renderer/layers` contribution, so the tests capture
 * that contribution from a fake `PluginContext` (via {@link mountGridLinesModule}) and call its
 * `draw` with a recording 2d context. No DOM is involved.
 */
import { createStore } from "@stargantt/core";
import type { LayerContribution, RowGeometryProvider, Viewport } from "../../src/internal/render/index";
import type { ThemeService } from "../../src/internal/theme/index";
import type { TimelineService, ZoomLevel } from "../../src/internal/timeline/index";
import { describe, expect, it } from "vitest";
import { MS_DAY } from "@stargantt/sdk";
import { calendar, makeRenderStub, makeRowGeometry, mountGridLinesModule } from "./_boot";

/* ------------------------------------------------------------------ *
 * Doubles
 * ------------------------------------------------------------------ */

interface Segment {
  x1: number;
  y1: number;
  x2: number;
  y2: number;
  color: string;
}

/** One `fillRect` the module issued, with the fill in force at the time. */
interface Fill {
  x: number;
  y: number;
  width: number;
  height: number;
  color: string;
}

class RecordingContext2D {
  strokeStyle = "";
  fillStyle = "";
  lineWidth = 1;
  readonly segments: Segment[] = [];
  readonly fills: Fill[] = [];
  readonly calls: string[] = [];
  private pen: { x: number; y: number } | undefined;
  /** Segments of the path being built, flushed into `segments` by `stroke()`. */
  private pending: { x1: number; y1: number; x2: number; y2: number }[] = [];
  depth = 0;

  save(): void {
    this.depth += 1;
    this.calls.push("save");
  }
  restore(): void {
    this.depth -= 1;
    this.calls.push("restore");
  }
  beginPath(): void {
    this.pending = [];
    this.pen = undefined;
    this.calls.push("beginPath");
  }
  moveTo(x: number, y: number): void {
    this.pen = { x, y };
  }
  lineTo(x: number, y: number): void {
    const from = this.pen;
    if (from !== undefined) this.pending.push({ x1: from.x, y1: from.y, x2: x, y2: y });
    this.pen = { x, y };
  }
  stroke(): void {
    this.calls.push("stroke");
    for (const s of this.pending) this.segments.push({ ...s, color: this.strokeStyle });
    this.pending = [];
  }
  fillRect(x: number, y: number, width: number, height: number): void {
    this.calls.push("fillRect");
    this.fills.push({ x, y, width, height, color: this.fillStyle });
  }

  /* --- helpers --- */
  verticals(): Segment[] {
    return this.segments.filter((s) => s.x1 === s.x2);
  }
  horizontals(): Segment[] {
    return this.segments.filter((s) => s.y1 === s.y2);
  }
  get context(): CanvasRenderingContext2D {
    return this as unknown as CanvasRenderingContext2D;
  }
}

const MINOR = "rgb(1, 1, 1)";
const MAJOR = "rgb(2, 2, 2)";
const STRIPE = "rgb(3, 3, 3)";
const NONWORKING = "rgb(4, 4, 4)";

// Only `get` is consumed by this module, so the stub carries only that member.
const THEME: Pick<ThemeService, "get"> = {
  get: (token) =>
    token === "--sg-grid-line-minor"
      ? MINOR
      : token === "--sg-grid-line-major"
        ? MAJOR
        : token === "--sg-row-stripe-bg"
          ? STRIPE
          : token === "--sg-grid-nonworking"
            ? NONWORKING
            : "",
};

// The line suites are about lines, so they switch off the two passes that default to on and would
// otherwise add fills to every expectation. The defaults themselves are asserted in their own
// suite below.
const LINES_ONLY = { rowStripes: false, nonWorkingDays: false } as const;

const DAY_LEVEL: ZoomLevel = {
  id: "day",
  pxPerDay: 24,
  scales: [
    { unit: "month", step: 1, format: () => "m" },
    { unit: "day", step: 1, format: () => "d" },
  ],
};

/** 24 px per day, content x = 0 at the epoch — so `x / PX_PER_MS` is the instant at that x. */
const PX_PER_MS = 24 / MS_DAY;

// The axis mapping is synthetic (a round 24 px/day at the epoch keeps every expectation below
// readable), but the boundary enumeration is the *real* timeline module's one, captured by
// `calendar()`: this suite must not re-fork the calendar arithmetic.
function makeScale(level: ZoomLevel = DAY_LEVEL, firstDayOfWeek: 0 | 1 = 1): TimelineService {
  return {
    tToX: (t) => t * PX_PER_MS,
    xToT: (x) => x / PX_PER_MS,
    pxPerMs: PX_PER_MS,
    zoomLevel: createStore(level),
    setZoomLevel: () => {},
    setOrigin: () => {},
    requestOriginExtension: () => {},
    releaseOriginExtension: () => {},
    firstDayOfWeek: () => firstDayOfWeek,
    unitBoundaries: calendar(firstDayOfWeek),
    // Not consumed by this module; present only to satisfy the (wider) service interface.
    levelMetrics: () => [{ id: level.id, pxPerDay: PX_PER_MS * MS_DAY }],
    formatDate: () => "",
    gridCellAt: () => undefined,
  };
}

interface Harness {
  layer: LayerContribution;
  owned: unknown[];
  claims: { scope: string; key: string; order: number }[];
  /** The layers `render.invalidate` was called with, in order. */
  invalidations: string[];
  /** Everything the module reported through the render module's fault channel. */
  faults: unknown[];
}

function mount(
  factoryConfig: Parameters<typeof mountGridLinesModule>[0],
  services: {
    scale?: TimelineService;
    rows?: RowGeometryProvider;
    /** Pass to record faults instead of rethrowing them — only for the barrier's own tests. */
    faults?: unknown[];
  } = {},
): Harness {
  const scale = services.scale ?? makeScale();
  const invalidations: string[] = [];
  const faults = services.faults;
  const render = makeRenderStub({
    invalidate: (layer) => void invalidations.push(layer),
    rowGeometry: () => services.rows,
    ...(faults === undefined ? {} : { fault: (error: unknown): void => void faults.push(error) }),
  });
  const { layer, owned, claims } = mountGridLinesModule(factoryConfig, render, THEME, scale);
  if (layer === undefined) throw new Error("no renderer/layers contribution");
  return { layer, owned, claims, invalidations, faults: faults ?? [] };
}

/**
 * Like `mount`, but for the "every pass off" cases: with `anything` false the module now skips
 * `ctx.contribute` entirely (there is nothing worth an empty paint call every frame for), so "no
 * layer" is the expected, correct outcome here rather than a mounting failure.
 */
function mountNoLayer(
  factoryConfig: Parameters<typeof mountGridLinesModule>[0],
  services: { scale?: TimelineService; rows?: RowGeometryProvider } = {},
): void {
  const scale = services.scale ?? makeScale();
  const render = makeRenderStub({ rowGeometry: () => services.rows });
  const { layer } = mountGridLinesModule(factoryConfig, render, THEME, scale);
  expect(layer).toBeUndefined();
}

const VIEWPORT: Readonly<Viewport> = { scrollTop: 0, scrollLeft: 0, width: 240, height: 120 };

function paint(
  layer: LayerContribution,
  vp: Readonly<Viewport> = VIEWPORT,
): RecordingContext2D {
  const g = new RecordingContext2D();
  layer.draw(g.context, vp);
  return g;
}

/* ------------------------------------------------------------------ *
 * Tests
 * ------------------------------------------------------------------ */

describe("gridLines contribution", () => {
  it("contributes one background layer, claims its renderer/layers order and owns nothing", () => {
    const { layer, owned, claims } = mount(LINES_ONLY);
    expect(layer.id).toBe("view:grid-lines");
    expect(layer.zIndex).toBe(10);
    expect(owned).toHaveLength(0);
    // docs/specs/plugins/view.md — the module claims its own `renderer/layers` slot instead of
    // documenting the order in a table.
    expect(claims).toEqual([{ scope: "renderer/layers", key: "view:grid-lines", order: 10 }]);
  });

  // A standalone `gridLines(config)` was previously a `definePlugin` factory with its own
  // `meta.id`, `dependsOn` and `optional`, discoverable by inspecting the returned plugin before
  // `setup()` ran. Now the grid-lines module is `createGridLinesModule(ctx, opt, render, theme,
  // scale, data)`: its
  // dependencies arrive as plain constructor arguments (resolved once, by `internal/wiring.ts`,
  // at the composition's construction time) rather than through `ctx.use`/`ctx.useOptional`
  // declared against a `meta`, so there is no plugin metadata left at this layer to assert
  // against. The dependency graph this test used to pin is now expressed by `setupView`'s call
  // order in `src/internal/wiring.ts` instead.
  it.skip("declares the renderer/timeline-scale/theme dependencies and an optional tree-grid — no longer applicable: dependencies are constructor arguments, not a plugin meta", () => {});
});

describe("vertical lines", () => {
  it("draws one full-height minor line per day and a major line per month", () => {
    const { layer } = mount({ ...LINES_ONLY, vertical: "both" });
    // 240 px at 24 px/day = the first 10 days of 1970; the month boundary is the epoch itself.
    const g = paint(layer, { scrollTop: 0, scrollLeft: 0, width: 240, height: 120 });

    const minor = g.verticals().filter((s) => s.color === MINOR);
    const major = g.verticals().filter((s) => s.color === MAJOR);
    // The boundary at content x 240 is culled: half-pixel aligned it lands at 240.5, outside the
    // 240 px-wide viewport.
    expect(minor.map((s) => s.x1)).toEqual([0.5, 24.5, 48.5, 72.5, 96.5, 120.5, 144.5, 168.5, 192.5, 216.5]);
    expect(major.map((s) => s.x1)).toEqual([0.5]);
    for (const s of [...minor, ...major]) {
      expect(s.y1).toBe(0);
      expect(s.y2).toBe(120);
    }
  });

  it("paints the major pass after the minor one so a shared boundary reads as major", () => {
    const { layer } = mount({ ...LINES_ONLY, vertical: "both" });
    const g = paint(layer);
    const firstMajor = g.segments.findIndex((s) => s.color === MAJOR);
    const lastMinor = g.segments.map((s) => s.color).lastIndexOf(MINOR);
    expect(firstMajor).toBeGreaterThan(lastMinor);
  });

  it("batches each color into a single path and stroke", () => {
    const { layer } = mount({ ...LINES_ONLY, vertical: "both", horizontal: true }, { rows: makeRowGeometry(4) });
    const g = paint(layer);
    expect(g.calls.filter((c) => c === "beginPath")).toHaveLength(2);
    expect(g.calls.filter((c) => c === "stroke")).toHaveLength(2);
    expect(g.depth).toBe(0);
  });

  it("offsets by the horizontal scroll and skips lines outside the viewport", () => {
    const { layer } = mount({ ...LINES_ONLY, vertical: "both" });
    const g = paint(layer, { scrollTop: 0, scrollLeft: 100, width: 48, height: 60 });
    for (const s of g.verticals()) {
      expect(s.x1).toBeGreaterThanOrEqual(0);
      expect(s.x1).toBeLessThanOrEqual(48);
    }
    // Days 5 and 6 sit at content x 120 and 144, i.e. 20 and 44 after the scroll.
    expect(g.verticals().map((s) => s.x1)).toEqual([20.5, 44.5]);
  });

  it("follows the chart's first day of week for a week row", () => {
    const weekLevel: ZoomLevel = {
      id: "week",
      pxPerDay: 24,
      scales: [
        { unit: "month", step: 1, format: () => "m" },
        { unit: "week", step: 1, format: () => "w" },
      ],
    };
    const monday = mount({ ...LINES_ONLY, vertical: "both" }, { scale: makeScale(weekLevel, 1) });
    const sunday = mount({ ...LINES_ONLY, vertical: "both" }, { scale: makeScale(weekLevel, 0) });
    const vp: Readonly<Viewport> = { scrollTop: 0, scrollLeft: 0, width: 480, height: 60 };
    const mondayX = paint(monday.layer, vp)
      .verticals()
      .filter((s) => s.color === MINOR)
      .map((s) => s.x1);
    const sundayX = paint(sunday.layer, vp)
      .verticals()
      .filter((s) => s.color === MINOR)
      .map((s) => s.x1);
    // 1970-01-01 was a Thursday, so the two week starts land on different days.
    expect(mondayX).toEqual([96.5, 264.5, 432.5]);
    expect(sundayX).toEqual([72.5, 240.5, 408.5]);
    // Both sets step by exactly one week (7 × 24 px).
    for (const xs of [mondayX, sundayX]) {
      for (let i = 1; i < xs.length; i += 1) {
        expect((xs[i] as number) - (xs[i - 1] as number)).toBe(168);
      }
    }
  });

  it("treats a single-row zoom level as one major tier", () => {
    const single: ZoomLevel = {
      id: "solo",
      pxPerDay: 24,
      scales: [{ unit: "day", step: 1, format: () => "d" }],
    };
    const { layer } = mount({ ...LINES_ONLY, vertical: "both" }, { scale: makeScale(single) });
    const g = paint(layer);
    expect(g.verticals().every((s) => s.color === MAJOR)).toBe(true);
    expect(g.verticals().length).toBeGreaterThan(0);
  });

  it("uses the first and last row of a level with more than two rows", () => {
    const three: ZoomLevel = {
      id: "three",
      pxPerDay: 24,
      scales: [
        { unit: "month", step: 1, format: () => "m" },
        { unit: "week", step: 1, format: () => "w" },
        { unit: "day", step: 1, format: () => "d" },
      ],
    };
    const { layer } = mount({ ...LINES_ONLY, vertical: "both" }, { scale: makeScale(three) });
    const g = paint(layer, { scrollTop: 0, scrollLeft: 0, width: 240, height: 60 });
    // Minor = the day row (10 visible boundaries across 10 days), major = the month row (the epoch).
    expect(g.verticals().filter((s) => s.color === MINOR)).toHaveLength(10);
    expect(g.verticals().filter((s) => s.color === MAJOR)).toHaveLength(1);
  });
});

describe("horizontal lines", () => {
  it("draws a minor separator at the bottom edge of every visible row", () => {
    const { layer } = mount({ ...LINES_ONLY, vertical: false, horizontal: true }, { rows: makeRowGeometry(4) });
    const g = paint(layer, { scrollTop: 0, scrollLeft: 0, width: 240, height: 120 });
    const lines = g.horizontals();
    // The fourth row's bottom edge lands at 120.5, outside the 120 px-tall viewport, and is culled.
    expect(lines.map((s) => s.y1)).toEqual([30.5, 60.5, 90.5]);
    for (const s of lines) {
      expect(s.color).toBe(MINOR);
      expect(s.x1).toBe(0);
      expect(s.x2).toBe(240);
    }
  });

  it("draws nothing below the last row", () => {
    const { layer } = mount({ ...LINES_ONLY, vertical: false, horizontal: true }, { rows: makeRowGeometry(2) });
    const g = paint(layer, { scrollTop: 0, scrollLeft: 0, width: 240, height: 400 });
    expect(g.horizontals().map((s) => s.y1)).toEqual([30.5, 60.5]);
  });

  it("starts at the first visible row when scrolled", () => {
    const { layer } = mount({ ...LINES_ONLY, vertical: false, horizontal: true }, { rows: makeRowGeometry(20) });
    const g = paint(layer, { scrollTop: 100, scrollLeft: 0, width: 240, height: 90 });
    expect(g.horizontals().map((s) => s.y1)).toEqual([20.5, 50.5, 80.5]);
  });

  it("draws nothing when no row-geometry provider is present", () => {
    const { layer } = mount({ ...LINES_ONLY, horizontal: true });
    const g = paint(layer);
    expect(g.horizontals()).toHaveLength(0);
    expect(g.verticals().length).toBeGreaterThan(0);
  });

  // docs/specs/plugins/view.md — the row-geometry provider is foreign code called at draw time, so
  // a throw costs the pass that hit it its frame and nothing else. This pass is the sharp case:
  // it traces into a path the minor verticals have already contributed to, inside a `save()` the
  // rest of `draw()` depends on, so an escaping throw would both lose the verticals and leave the
  // context one level deep for every later pass on that canvas.
  describe("a throwing row-geometry provider", () => {
    /** A provider that answers `rowCount()` and then throws from the per-row geometry. */
    const throwsOnYOf = (): RowGeometryProvider => ({
      rowCount: () => 4,
      rowAtY: () => 0,
      yOf: (row) => {
        if (row === 2) throw new Error("row geometry exploded");
        return row * 30;
      },
      rowHeight: () => 30,
    });

    it("reports the fault and drops the separators whole, without a partial ladder", () => {
      const faults: unknown[] = [];
      const { layer } = mount(
        { ...LINES_ONLY, vertical: false, horizontal: true },
        { rows: throwsOnYOf(), faults },
      );
      const g = paint(layer);

      expect(faults).toHaveLength(1);
      expect((faults[0] as Error).message).toBe("row geometry exploded");
      // Not one line: the geometry is collected before anything is traced, so the rows resolved
      // before the throw do not reach the path either.
      expect(g.horizontals()).toHaveLength(0);
    });

    it("leaves the vertical passes and the save/restore balance untouched", () => {
      const faults: unknown[] = [];
      const { layer } = mount(
        { ...LINES_ONLY, vertical: "both", horizontal: true },
        { rows: throwsOnYOf(), faults },
      );
      const g = paint(layer);

      expect(faults).toHaveLength(1);
      // Both vertical tiers still paint: the minor ones share the separators' path and stroke,
      // and the major pass runs after them.
      expect(g.verticals().filter((seg) => seg.color === MINOR).length).toBeGreaterThan(0);
      expect(g.verticals().filter((seg) => seg.color === MAJOR).length).toBeGreaterThan(0);
      // The throw never escaped `draw()`, so every `save()` it took was paid back.
      expect(g.depth).toBe(0);
      expect(g.calls.filter((c) => c === "save")).toHaveLength(
        g.calls.filter((c) => c === "restore").length,
      );
    });

    it("keeps reporting on later frames rather than latching the pass off", () => {
      const faults: unknown[] = [];
      const { layer } = mount(
        { ...LINES_ONLY, vertical: false, horizontal: true },
        { rows: throwsOnYOf(), faults },
      );
      paint(layer);
      paint(layer);
      expect(faults).toHaveLength(2);
    });
  });
});

// §4.5 — the alternating row background. Parity is a property of the row, not of the paint pass,
// which is what keeps the chart pane's stripes aligned with the grid pane's under virtual
// scrolling.
describe("row stripes", () => {
  const stripes = (g: RecordingContext2D): Fill[] => g.fills.filter((f) => f.color === STRIPE);

  it("fills every odd row across the full viewport width", () => {
    const { layer } = mount({ vertical: false, nonWorkingDays: false }, { rows: makeRowGeometry(4) });
    const g = paint(layer, { scrollTop: 0, scrollLeft: 0, width: 240, height: 120 });
    expect(stripes(g).map((f) => [f.y, f.height])).toEqual([
      [30, 30],
      [90, 30],
    ]);
    for (const f of stripes(g)) {
      expect(f.x).toBe(0);
      expect(f.width).toBe(240);
    }
  });

  // The regression this guards: parity counted from the first *visible* row instead of the row's
  // own index makes every stripe jump by one row as soon as the viewport scrolls past a row.
  it("keeps a row's parity when the viewport scrolls", () => {
    const { layer } = mount({ vertical: false, nonWorkingDays: false }, { rows: makeRowGeometry(20) });
    // Scrolled by three rows: rows 3..5 are visible, so rows 3 and 5 are the striped ones and
    // their tops land at -10 and 50 in viewport coordinates.
    const g = paint(layer, { scrollTop: 100, scrollLeft: 0, width: 240, height: 90 });
    expect(stripes(g).map((f) => f.y)).toEqual([-10, 50]);
  });

  it("draws no stripe without a row-geometry provider, or when switched off", () => {
    const noRows = mount({ vertical: false, nonWorkingDays: false });
    expect(paint(noRows.layer).fills).toHaveLength(0);

    // Every pass off (rowStripes included) means `anything` is false, so the layer is not
    // contributed at all rather than contributed and painting nothing.
    mountNoLayer({ vertical: false, nonWorkingDays: false, rowStripes: false }, { rows: makeRowGeometry(4) });
  });

  // §4 paint order: the stripe is ground for the column shadings, so it goes down first.
  it("paints under the non-working column shading", () => {
    const { layer } = mount({ vertical: false }, { rows: makeRowGeometry(4) });
    const g = paint(layer);
    const lastStripe = g.fills.map((f) => f.color).lastIndexOf(STRIPE);
    const firstShade = g.fills.map((f) => f.color).indexOf(NONWORKING);
    expect(firstShade).toBeGreaterThan(lastStripe);
  });
});

// docs/specs/plugins/view.md — the row-dependent passes no longer own a subscription of their
// own: `renderer/rowGeometry`'s contributor is responsible for calling
// `ViewService.invalidate("background")` from its own row-model updates, because the layer dirty
// flags are per layer and nothing else marks `background` dirty when a task is added or removed.
// The module holds no reference to the provider between paints and cannot observe the change
// itself, so the `rows/changed` subscription this suite used to exercise is gone outright.
describe("row-set changes", () => {
  /** A row-geometry provider whose row count the test can change, as adding/removing a task does. */
  function mutableRows(initial: number): { rows: RowGeometryProvider; setCount(n: number): void } {
    let count = initial;
    const rowHeight = 30;
    const rows: RowGeometryProvider = {
      rowCount: () => count,
      rowAtY: (y) => Math.min(count - 1, Math.max(0, Math.floor(y / rowHeight))),
      yOf: (row) => row * rowHeight,
      rowHeight: () => rowHeight,
    };
    return { rows, setCount: (n) => void (count = n) };
  }

  // Not an event-driven repaint any more (the module subscribes to nothing): each `draw` call
  // simply re-resolves `render.rowGeometry()`, so a live-mutating provider is picked up on the
  // very next paint with no signal from the module at all.
  it("draws the new row count on the next paint", () => {
    const { rows, setCount } = mutableRows(2);
    const { layer } = mount({ vertical: false, nonWorkingDays: false }, { rows });
    const vp = { scrollTop: 0, scrollLeft: 0, width: 240, height: 300 };
    expect(paint(layer, vp).fills.filter((f) => f.color === STRIPE)).toHaveLength(1);

    setCount(6);
    expect(paint(layer, vp).fills.filter((f) => f.color === STRIPE)).toHaveLength(3);

    setCount(1);
    expect(paint(layer, vp).fills.filter((f) => f.color === STRIPE)).toHaveLength(0);
  });

  // These three asserted the former `rows/changed` subscription: a repaint fired without the module
  // itself repainting on that event. `createGridLinesModule` subscribes to nothing rows-related
  // any more (see the describe-level comment above), so there is nothing left to trigger and
  // nothing left to assert — skipped rather than deleted, so the removed behaviour stays visible
  // in the suite.
  it.skip("repaints the background layer when the rows change — removed: the module subscribes to nothing; the row-geometry contributor now owns this invalidation", () => {});
  it.skip("repaints for the horizontal lines too — removed: same reason as above", () => {});
  it.skip("does not subscribe when no pass depends on the rows — removed: there is no subscription to not make", () => {});
});

// docs/specs/plugins/view.md — the shipped defaults: coarse verticals and row stripes on, per-row
// separator lines off.
describe("config normalization", () => {
  it("defaults to coarse verticals, stripes on and row separators off", () => {
    const { layer } = mount(undefined, { rows: makeRowGeometry(4) });
    const g = paint(layer);
    // One major line at the month boundary, and none of the ten day boundaries.
    expect(g.verticals().map((s) => s.color)).toEqual([MAJOR]);
    expect(g.horizontals()).toHaveLength(0);
    expect(g.fills.filter((f) => f.color === STRIPE).length).toBeGreaterThan(0);
  });

  it("adds the fine tier with vertical: \"both\", and true means the same", () => {
    for (const vertical of ["both", true] as const) {
      const { layer } = mount({ ...LINES_ONLY, vertical }, { rows: makeRowGeometry(4) });
      const g = paint(layer);
      expect(g.verticals().filter((s) => s.color === MINOR).length).toBeGreaterThan(0);
      expect(g.verticals().filter((s) => s.color === MAJOR).length).toBeGreaterThan(0);
    }
  });

  it("honors vertical: false / \"none\" and horizontal: true independently", () => {
    for (const vertical of [false, "none"] as const) {
      const noVertical = mount({ ...LINES_ONLY, vertical, horizontal: true }, { rows: makeRowGeometry(4) });
      expect(paint(noVertical.layer).verticals()).toHaveLength(0);
      expect(paint(noVertical.layer).horizontals().length).toBeGreaterThan(0);
    }

    const noHorizontal = mount({ ...LINES_ONLY, vertical: "both" }, { rows: makeRowGeometry(4) });
    expect(paint(noHorizontal.layer).horizontals()).toHaveLength(0);
    expect(paint(noHorizontal.layer).verticals().length).toBeGreaterThan(0);
  });

  it("draws nothing at all with every pass off", () => {
    // With `anything` false the layer is not contributed at all — there is nothing left to paint.
    mountNoLayer(
      { vertical: false, horizontal: false, rowStripes: false, nonWorkingDays: false },
      { rows: makeRowGeometry(4) },
    );
  });

  it("ignores an unusable value and uses the default", () => {
    const bogus = {
      vertical: "no",
      horizontal: 0,
      rowStripes: "yes",
      nonWorkingDays: false,
    } as unknown as Parameters<typeof mountGridLinesModule>[0];
    const { layer } = mount(bogus, { rows: makeRowGeometry(4) });
    const g = paint(layer);
    expect(g.verticals().map((s) => s.color)).toEqual([MAJOR]);
    expect(g.horizontals()).toHaveLength(0);
    expect(g.fills.filter((f) => f.color === STRIPE).length).toBeGreaterThan(0);
  });

  // A standalone `gridLines(config)` previously snapshotted the caller's config object itself, at
  // factory-call time. Now that snapshotting happens one step earlier, in `normalizeViewConfig`
  // (`src/config.ts`):
  // it reads every field off the config once and produces a plain `GridLinesOptions` of primitive
  // values, which is what `createGridLinesModule` is actually built from. This still exercises the
  // same observable guarantee — mutating the config object after the fact cannot change what the
  // module draws — against the new seam.
  it("snapshots the config, so a later mutation cannot change the module", () => {
    const config = { vertical: true, horizontal: true };
    const { layer } = mount(config, { rows: makeRowGeometry(3) });
    config.horizontal = false;
    expect(paint(layer).horizontals().length).toBeGreaterThan(0);
  });
});
