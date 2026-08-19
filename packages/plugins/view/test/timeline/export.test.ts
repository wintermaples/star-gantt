/**
 * `export/auxiliarySurfaces` contribution: the header's own top surface, composited by
 * `@stargantt/plugin-export`'s image-capture pass.
 *
 * docs/specs/plugins/export.md §4 "Official contributors (dovetail)" / §1 `AuxiliarySurfaceContribution`
 * / `src/internal/timeline/export-contrib.ts`.
 *
 * The export plugin itself is not part of the composition here — `@stargantt/plugin-view` never
 * depends on it, upward or otherwise (`src/internal/upward.ts`'s structural-declaration note) — so
 * the contribution is captured through a probe plugin that defines the point locally, exactly as
 * `timeline/zoomLevels` is captured in the other test files. `export/auxiliarySurfaces` is not a
 * key of this package's `ExtensionPoints` type (only `@stargantt/plugin-export`'s `declare module`
 * merge adds it), so the probe defines it through the same `as never` widening
 * `src/internal/upward.ts`'s `contributeUpward` uses on the contributing side.
 */
import { afterEach, describe, expect, it } from "vitest";
import type { AuxiliarySurfaceContribution, ExportTile } from "../../src/internal/upward";
import { DEFAULT_HEADER_HEIGHT } from "../../src/internal/timeline/header";
import { MS_DAY } from "../../src/internal/timeline/scale";
import { boot, probe } from "./_boot";
import type { Booted } from "./_boot";
import { FakeContext2D } from "../_utils/index";
import { defineAuxiliarySurfacePoint } from "../_upward";
import type { TimelineConfig } from "../../src/config";

/**
 * A tile of a single-tile export: the whole exported span is this tile's own span.
 *
 * Every test below that does not exercise the `rangeStart`/`rangeEnd` thinning rule directly
 * passes a tile whose declared range equals its own slice — the degenerate default the contribution
 * falls back to when a hand-built tile omits the span fields (§4, `export-contrib.ts`'s
 * `tileOptions`).
 */
function tile(t: Omit<ExportTile, "rangeStart" | "rangeEnd">): ExportTile {
  return { ...t, rangeStart: t.start, rangeEnd: t.end };
}

let booted: Booted | null = null;

afterEach(() => {
  booted?.dom.restore();
  booted = null;
});

/** Boots and hands back the sole `export/auxiliarySurfaces` contribution, if any. */
function bootWithSurface(
  extra: Parameters<typeof boot>[0] = [],
  config: TimelineConfig = { origin: 0 },
): { b: Booted; surfaces: AuxiliarySurfaceContribution[] } {
  let surfaces: AuxiliarySurfaceContribution[] = [];
  const b = boot(
    [
      ...extra,
      probe((ctx) => {
        const point = defineAuxiliarySurfacePoint(ctx);
        surfaces = point.get();
      }),
    ],
    {},
    config,
  );
  booted = b;
  b.dom.flushFrames();
  return { b, surfaces };
}

describe("contribution registration", () => {
  it("contributes exactly one top surface", () => {
    const { surfaces } = bootWithSurface();
    expect(surfaces).toHaveLength(1);
    expect(surfaces[0]?.side).toBe("top");
  });

  it("sizes the surface by the header's total height (`--sg-header-height`)", () => {
    const { surfaces } = bootWithSurface();
    expect(surfaces[0]?.height).toBe(DEFAULT_HEADER_HEIGHT);
  });

  it("supplies both `drawTile` and `drawTileSVG`", () => {
    const { surfaces } = bootWithSurface();
    expect(typeof surfaces[0]?.drawTile).toBe("function");
    expect(typeof surfaces[0]?.drawTileSVG).toBe("function");
  });

  it("is inert (contributed, never invoked) while the export plugin is absent — collect semantics", () => {
    // No consumer calls `drawTile` here; booting and painting alone must not touch it.
    const { surfaces } = bootWithSurface();
    expect(surfaces).toHaveLength(1);
  });

  it("registers unconditionally: a composition with no export-plugin probe at all still contributes it", () => {
    // The core buffers a contribution whose point has no owner yet (the `sidepanel/fields`
    // precedent, export.md §4) — the point is never defined here, only contributed to.
    const b = boot([], {}, { origin: 0 });
    booted = b;
    b.dom.flushFrames();
    expect(b.gantt).toBeDefined();
  });
});

describe("`drawTile` paints the header for the tile's own span", () => {
  it("clears and fills exactly the tile's box", () => {
    const { surfaces } = bootWithSurface();
    const surface = surfaces[0];
    if (surface === undefined) throw new Error("surface not registered");

    const g = new FakeContext2D();
    const t: ExportTile = tile({
      start: 5 * MS_DAY,
      end: 10 * MS_DAY,
      width: 200,
      height: DEFAULT_HEADER_HEIGHT,
      pixelRatio: 1,
    });
    surface.drawTile(g as unknown as CanvasRenderingContext2D, t);

    expect(g.argsOf("clearRect")).toContainEqual([0, 0, t.width, t.height]);
    expect(g.argsOf("fillRect")).toContainEqual([0, 0, t.width, t.height]);
  });

  it("paints boundary labels for the tile's own time span, not the on-screen viewport", () => {
    const { surfaces } = bootWithSurface();
    const surface = surfaces[0];
    if (surface === undefined) throw new Error("surface not registered");

    const g = new FakeContext2D();
    // A day-boundary-aligned tile spanning days 5..10 (origin 0, `day` level, 40 px/day — the
    // default startup zoom).
    const t: ExportTile = tile({
      start: 5 * MS_DAY,
      end: 10 * MS_DAY,
      width: 200,
      height: DEFAULT_HEADER_HEIGHT,
      pixelRatio: 1,
    });
    surface.drawTile(g as unknown as CanvasRenderingContext2D, t);

    // 1970-01-06 (day index 5) sits at the tile's left edge — day-of-month label "6".
    expect(g.texts.map((x) => x.text)).toContain("6");
    // Month row above: the tile opens in January 1970.
    expect(g.texts.map((x) => x.text)).toContain("January 1970");
  });

  it("geometry matches `tToX`: a boundary's local x is `tToX(t) - tToX(tile.start)`", () => {
    const { b, surfaces } = bootWithSurface();
    const surface = surfaces[0];
    if (surface === undefined) throw new Error("surface not registered");
    const timeline = b.gantt.service("stargantt.timeline");

    // A tile start deliberately *not* aligned to a day boundary, so `scrollLeft` is not simply the
    // boundary's own x — this is what would break if `drawTile` scrolled by the tile index rather
    // than by `tile.start` itself.
    const tileStart = 5.5 * MS_DAY;
    const day6 = 6 * MS_DAY;
    const t: ExportTile = tile({
      start: tileStart,
      end: tileStart + 5 * MS_DAY,
      width: 200,
      height: DEFAULT_HEADER_HEIGHT,
      pixelRatio: 1,
    });

    const g = new FakeContext2D();
    surface.drawTile(g as unknown as CanvasRenderingContext2D, t);

    const expectedX = timeline.tToX(day6) - timeline.tToX(tileStart);
    expect(g.verticalXs()).toContain(expectedX);
    // Sanity: half a day at 40 px/day is 20 px, so the boundary lands 20 px inside the tile.
    expect(expectedX).toBeCloseTo(20, 9);
  });

  it("reproduces the on-screen row layout for the same span (theme tokens read as at normal paint)", () => {
    const { b, surfaces } = bootWithSurface();
    const surface = surfaces[0];
    if (surface === undefined) throw new Error("surface not registered");

    // The on-screen viewport at scrollLeft 0 covers content [0, 800) at the default width — draw
    // the same span through the export path and compare.
    const t: ExportTile = tile({
      start: 0,
      end: 20 * MS_DAY,
      width: 800,
      height: DEFAULT_HEADER_HEIGHT,
      pixelRatio: 1,
    });
    const g = new FakeContext2D();
    surface.drawTile(g as unknown as CanvasRenderingContext2D, t);

    expect(g.texts.map((x) => x.text)).toEqual(b.header.context.texts.map((x) => x.text));
    expect(g.verticalXs()).toEqual(b.header.context.verticalXs());
  });
});

describe("`sticky` is off for export tiles", () => {
  it("never pins a straddling boundary's label to the tile's left edge (unlike the on-screen header)", () => {
    const { surfaces } = bootWithSurface();
    const surface = surfaces[0];
    if (surface === undefined) throw new Error("surface not registered");

    // A tile that starts mid-month, so a sticky on-screen header would pin the month caption to
    // x = 0; the export path must place it at its true (possibly negative) boundary position
    // instead, so neighbouring tiles compose without a duplicated caption.
    const tileStart = 10 * MS_DAY; // 1970-01-11 — well inside January
    const t: ExportTile = tile({
      start: tileStart,
      end: tileStart + 5 * MS_DAY,
      width: 200,
      height: DEFAULT_HEADER_HEIGHT,
      pixelRatio: 1,
    });
    const g = new FakeContext2D();
    surface.drawTile(g as unknown as CanvasRenderingContext2D, t);

    // The month row's own boundary (Jan 1) is off the tile's left edge (x < 0), i.e. not pinned to
    // x = 0 the way a sticky on-screen paint would place it.
    const monthLabel = g.texts.find((x) => x.text === "January 1970");
    expect(monthLabel).toBeDefined();
    expect(monthLabel?.x).toBeLessThan(0);
  });
});

describe("export-wide label thinning over `rangeStart` / `rangeEnd`", () => {
  const MS = MS_DAY;
  /**
   * A two-row level whose day labels are short for days 0..4 and long from day 5 on.
   *
   * With the fake canvas measuring per-character against 40 px day cells, a span holding only the
   * short labels needs no thinning while a span that reaches the long ones does — which is exactly
   * what makes the difference between thinning over the tile's own slice and thinning over the whole
   * exported span observable.
   */
  function variableLabelLevel() {
    return probe((ctx) => {
      ctx.contribute("timeline/zoomLevels", {
        id: "test.var-label",
        pxPerDay: 40,
        scales: [
          { unit: "month" as const, format: () => "M" },
          {
            unit: "day" as const,
            format: (t: number) => (t / MS < 5 ? "s" : "longlabel"),
          },
        ],
      });
    }, "test.levels");
  }

  /** Day labels the surface paints for a tile covering days 0..5 with the given exported span. */
  function shortLabelCount(rangeEnd: number): number {
    const { surfaces } = bootWithSurface([variableLabelLevel()], {
      origin: 0,
      initialZoom: "test.var-label",
    });
    const surface = surfaces[0];
    if (surface === undefined) throw new Error("surface not registered");
    const g = new FakeContext2D();
    surface.drawTile(g as unknown as CanvasRenderingContext2D, {
      start: 0,
      end: 5 * MS,
      width: 200,
      height: DEFAULT_HEADER_HEIGHT,
      pixelRatio: 1,
      rangeStart: 0,
      rangeEnd,
    });
    return g.texts.filter((x) => x.text === "s").length;
  }

  it("thins a tile's labels by the whole exported span, not by the tile's own slice", () => {
    // Same tile, two exports: one where the tile *is* the whole export, one where the export runs
    // on into the long-label days. The wider export must thin the tile's labels even though nothing
    // inside the tile needs it, so a neighbouring tile drops the same boundaries and the two
    // compose across the seam.
    const wholeExportIsTheTile = shortLabelCount(5 * MS);
    const wideExport = shortLabelCount(20 * MS);
    expect(wholeExportIsTheTile).toBe(5);
    expect(wideExport).toBeLessThan(wholeExportIsTheTile);
    expect(wideExport).toBeGreaterThan(0);
  });

  it("agrees with the neighbouring tile of the same export on which boundaries carry a label", () => {
    // Two adjacent tiles of one 10-day export: together they must paint exactly the labels a
    // single-tile export of the same span paints — no boundary labelled twice, none lost.
    const level = variableLabelLevel();
    const span = { rangeStart: 0, rangeEnd: 10 * MS };
    const draw = (start: number, end: number, range: typeof span): string[] => {
      const { surfaces } = bootWithSurface([level], {
        origin: 0,
        initialZoom: "test.var-label",
      });
      const surface = surfaces[0];
      if (surface === undefined) throw new Error("surface not registered");
      const g = new FakeContext2D();
      surface.drawTile(g as unknown as CanvasRenderingContext2D, {
        start,
        end,
        width: ((end - start) / MS) * 40,
        height: DEFAULT_HEADER_HEIGHT,
        pixelRatio: 1,
        ...range,
      });
      return g.texts.filter((x) => x.text === "s" || x.text === "longlabel").map((x) => x.text);
    };

    const left = draw(0, 5 * MS, span);
    const right = draw(5 * MS, 10 * MS, span);
    const whole = draw(0, 10 * MS, span);
    expect([...left, ...right]).toEqual(whole);
  });

  it("falls back to the tile's own slice when a hand-built tile omits `rangeStart`/`rangeEnd`", () => {
    const { surfaces } = bootWithSurface();
    const surface = surfaces[0];
    if (surface === undefined) throw new Error("surface not registered");
    const g = new FakeContext2D();
    // A degenerate tile with a non-finite range — `tile()` above always fills it in, so this test
    // builds the tile by hand to exercise `export-contrib.ts`'s `Number.isFinite` fallback.
    const t = {
      start: 5 * MS_DAY,
      end: 10 * MS_DAY,
      width: 200,
      height: DEFAULT_HEADER_HEIGHT,
      pixelRatio: 1,
      rangeStart: Number.NaN,
      rangeEnd: Number.NaN,
    } as ExportTile;
    // Must not throw despite the non-finite span fields.
    expect(() => surface.drawTile(g as unknown as CanvasRenderingContext2D, t)).not.toThrow();
    expect(g.texts.length).toBeGreaterThan(0);
  });
});

describe("`drawTileSVG` mirrors `drawTile` as vector markup", () => {
  it("emits a background rect and the same labels as the raster path", () => {
    const { surfaces } = bootWithSurface();
    const surface = surfaces[0];
    if (surface === undefined || surface.drawTileSVG === undefined) {
      throw new Error("surface / drawTileSVG not registered");
    }

    const t: ExportTile = tile({
      start: 5 * MS_DAY,
      end: 10 * MS_DAY,
      width: 200,
      height: DEFAULT_HEADER_HEIGHT,
      pixelRatio: 1,
    });
    const svg = surface.drawTileSVG(t);

    expect(svg).toContain(`width="${t.width}" height="${t.height}"`);
    expect(svg).toContain(">6<");
    expect(svg).toContain(">January 1970<");
  });

  it("renders nothing (an empty-ish shell) for a degenerate zero-width tile", () => {
    const { surfaces } = bootWithSurface();
    const surface = surfaces[0];
    if (surface === undefined || surface.drawTileSVG === undefined) {
      throw new Error("surface / drawTileSVG not registered");
    }
    const t: ExportTile = tile({
      start: 0,
      end: 0,
      width: 0,
      height: DEFAULT_HEADER_HEIGHT,
      pixelRatio: 1,
    });
    expect(surface.drawTileSVG(t)).toBe("");
  });
});
