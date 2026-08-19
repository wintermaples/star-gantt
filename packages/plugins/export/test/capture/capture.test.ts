import { describe, expect, it } from "vitest";
import { fills } from "./_boot";
import type { Viewport } from "@stargantt/plugin-view";
import {
  captureLayers,
  captureLayersSVG,
  captureSurface,
  layerFilter,
  layout,
  surfaceSVG,
} from "../../src/internal/capture/capture";
import type { Band, CaptureDeps } from "../../src/internal/capture/capture";
import { planRange } from "../../src/internal/capture/range";
import type { ScaleLike } from "../../src/internal/capture/range";
import type { AuxiliarySurfaceContribution, ExportTile } from "../../src/index";
import { FakeCanvas, FakeContext2D, FakeDocument, asContext, asDocument } from "./_boot";

const scale: ScaleLike = { tToX: (t) => t / 10, xToT: (x) => x * 10 };

function viewport(over: Partial<Viewport> = {}): Viewport {
  return { scrollTop: 0, scrollLeft: 0, width: 400, height: 200, ...over };
}

type LayerDraw = (g: CanvasRenderingContext2D, vp: Readonly<Viewport>) => void;

interface Harness {
  deps: CaptureDeps;
  doc: FakeDocument;
  /** Every virtual viewport `renderTo` was handed, in order. */
  renders: Viewport[];
  vp: Viewport;
}

/** A `renderTo` stand-in that brackets each layer in its own save/restore pair. */
function harness(
  ratio = 1,
  vp: Viewport = viewport(),
  draws: readonly LayerDraw[] = [(g, v) => g.fillRect(0, 0, v.width, v.height)],
): Harness {
  const doc = new FakeDocument();
  const renders: Viewport[] = [];
  const renderTo = (g: CanvasRenderingContext2D, target: Readonly<Viewport>): void => {
    renders.push({ ...target });
    for (const draw of draws) {
      g.save();
      try {
        draw(g, target);
      } catch {
        // Fault isolation, like the real render module's own composite.
      }
      g.restore();
    }
  };
  return {
    doc,
    renders,
    vp,
    deps: { doc: asDocument(doc), renderTo, ratio, aborted: () => false },
  };
}

// docs/specs/plugins/export.md §1.1 "Auxiliary surfaces"
describe("layout: auxiliary bands around the drawing layers", () => {
  const plan = planRange(undefined, { viewport: viewport() });

  function surface(side: "top" | "bottom", height: number): AuxiliarySurfaceContribution {
    return { side, height, drawTile: () => undefined };
  }

  it("reserves nothing when no surface is registered", () => {
    const l = layout(plan, 200, []);
    expect(l).toMatchObject({ width: 400, height: 200, layersTop: 0, layersHeight: 200 });
    expect(l.bands).toEqual([]);
  });

  it("stacks top surfaces above and bottom surfaces below, growing the image", () => {
    const header = surface("top", 40);
    const load = surface("bottom", 60);
    const l = layout(plan, 200, [header, load]);
    expect(l).toMatchObject({ height: 300, layersTop: 40, layersHeight: 200 });
    expect(l.bands).toEqual([
      { surface: header, y: 0, height: 40 },
      { surface: load, y: 240, height: 60 },
    ]);
  });

  it("stacks same-side surfaces in contribution order", () => {
    const a = surface("bottom", 10);
    const b = surface("bottom", 20);
    const l = layout(plan, 100, [a, b]);
    expect(l.bands.map((x) => x.y)).toEqual([100, 110]);
    expect(l.height).toBe(130);
  });

  it("drops a surface whose height is not a positive finite number", () => {
    const l = layout(plan, 100, [surface("top", 0), surface("bottom", Number.NaN)]);
    expect(l.bands).toEqual([]);
    expect(l.height).toBe(100);
  });
});

// docs/specs/plugins/export.md §1.1 "Tiled composition" / "Row coverage"
describe("captureLayers", () => {
  it("renders the visible viewport once for a viewport-only plan", () => {
    const h = harness();
    const plan = planRange(undefined, { viewport: h.vp });

    const out = captureLayers(h.deps, plan) as unknown as FakeCanvas;

    expect(h.renders).toEqual([{ scrollLeft: 0, scrollTop: 0, width: 400, height: 200 }]);
    expect([out.width, out.height]).toEqual([400, 200]);
    expect(out.context?.drawn).toHaveLength(1);
    expect(out.context?.drawn[0]).toMatchObject({ dx: 0, dy: 0, dw: 400, dh: 200 });
  });

  it("walks a wide range column by column, nothing on screen scrolling", () => {
    const h = harness();
    const plan = planRange("full", {
      viewport: h.vp,
      scale,
      extent: { start: 0, end: 10_000 }, // 1000 px
      tileWidth: 400,
    });

    const out = captureLayers(h.deps, plan) as unknown as FakeCanvas;

    expect(h.renders.map((v) => v.scrollLeft)).toEqual([0, 400, 800]);
    expect(h.renders.map((v) => v.width)).toEqual([400, 400, 200]);
    expect(h.vp).toEqual(viewport());
    expect(out.width).toBe(1000);
    expect(out.context?.drawn.map((d) => d.dx)).toEqual([0, 400, 800]);
    expect(out.context?.drawn.map((d) => d.dw)).toEqual([400, 400, 200]);
  });

  it("walks all rows band by band when the plan covers them (§1.1)", () => {
    const h = harness();
    const plan = planRange("full", {
      viewport: h.vp,
      scale,
      extent: { start: 0, end: 4_000 }, // 400 px: one column
      contentHeight: 500,
      tileHeight: 200,
    });

    const out = captureLayers(h.deps, plan) as unknown as FakeCanvas;

    expect(h.renders.map((v) => v.scrollTop)).toEqual([0, 200, 400]);
    expect(h.renders.map((v) => v.height)).toEqual([200, 200, 100]);
    expect([out.width, out.height]).toEqual([400, 500]);
    expect(out.context?.drawn.map((d) => d.dy)).toEqual([0, 200, 400]);
    expect(out.context?.drawn.map((d) => d.dh)).toEqual([200, 200, 100]);
  });

  it("covers a two-dimensional grid row-major", () => {
    const h = harness();
    const plan = planRange("full", {
      viewport: h.vp,
      scale,
      extent: { start: 0, end: 8_000 }, // 800 px
      contentHeight: 300,
      tileWidth: 400,
      tileHeight: 200,
    });

    const out = captureLayers(h.deps, plan) as unknown as FakeCanvas;

    expect(h.renders.map((v) => [v.scrollLeft, v.scrollTop])).toEqual([
      [0, 0],
      [400, 0],
      [0, 200],
      [400, 200],
    ]);
    expect(out.context?.drawn.map((d) => [d.dx, d.dy])).toEqual([
      [0, 0],
      [400, 0],
      [0, 200],
      [400, 200],
    ]);
  });

  it("renders ranges outside the scrollable content as asked, with no clamping", () => {
    const h = harness();
    // -300 px … +500 px of content-x, and the row band starts above the content origin.
    const plan = planRange({ start: -3_000, end: 5_000 }, {
      viewport: viewport({ scrollTop: -50 }),
      scale,
      tileWidth: 400,
    });

    const out = captureLayers(h.deps, plan) as unknown as FakeCanvas;

    expect(h.renders.map((v) => v.scrollLeft)).toEqual([-300, 100]);
    expect(h.renders.every((v) => v.scrollTop === -50)).toBe(true);
    // Both tiles contribute their full width: nothing was clipped away by a clamp.
    expect(out.context?.drawn.map((d) => d.dw)).toEqual([400, 400]);
  });

  it("sizes the tile canvases by the export ratio and scales their contexts", () => {
    const h = harness(2);
    const plan = planRange(undefined, { viewport: h.vp });

    const out = captureLayers(h.deps, plan) as unknown as FakeCanvas;

    expect([out.width, out.height]).toEqual([800, 400]);
    const tile = h.doc.createdCanvases()[1] as FakeCanvas;
    expect([tile.width, tile.height]).toEqual([800, 400]);
    expect(tile.context?.scaleX).toBe(2);
    // Drawn at device size into the composite.
    expect(out.context?.drawn[0]).toMatchObject({ dx: 0, dy: 0, dw: 800, dh: 400 });
  });

  it("stops when the plugin is disposed mid-export", () => {
    const h = harness();
    const plan = planRange({ start: 0, end: 10_000 }, { viewport: h.vp, scale });
    const deps: CaptureDeps = { ...h.deps, aborted: () => true };
    expect(() => captureLayers(deps, plan)).toThrow(/aborted/);
  });

  it("rejects a plan whose device-pixel width would exceed the per-side canvas ceiling", () => {
    const h = harness(1, viewport({ width: 20_000, height: 200 }));
    const plan = planRange(undefined, { viewport: h.vp });

    expect(() => captureLayers(h.deps, plan)).toThrow(/20000x200/);
  });

  it("accepts a plan right at the ceiling", () => {
    const h = harness(1, viewport({ width: 16_384, height: 16_384 }));
    const plan = planRange(undefined, { viewport: h.vp });

    expect(() => captureLayers(h.deps, plan)).not.toThrow();
  });

  it("accounts for the export ratio when checking the size ceiling", () => {
    const h = harness(10, viewport({ width: 2000, height: 200 }));
    const plan = planRange(undefined, { viewport: h.vp });

    // 2000 CSS px * ratio 10 = 20000 device px, over the per-side ceiling.
    expect(() => captureLayers(h.deps, plan)).toThrow(/20000x2000/);
  });
});

// §1.1 "True-vector SVG" — the vector path: the recording proxy driven through `renderTo`.
describe("captureLayersSVG", () => {
  const bar: LayerDraw = (g, vp) => {
    g.fillStyle = "#abc";
    g.fillRect(0, 0, vp.width, 10);
  };
  const label: LayerDraw = (g) => {
    g.fillStyle = "#123";
    g.fillRect(0, 20, 30, 5);
  };
  const exotic: LayerDraw = (g, vp) => {
    g.fillStyle = "#f00";
    g.clip();
    g.fillRect(0, 40, vp.width, 5);
  };

  it("transcribes every layer to vector elements, one group per tile", () => {
    const h = harness(1, viewport(), [bar, label]);
    const plan = planRange({ start: 0, end: 6_000 }, { viewport: h.vp, scale, tileWidth: 400 });

    const body = captureLayersSVG(h.deps, plan, 0);

    expect(body).toHaveLength(4); // two layers × two columns
    expect(body[0]?.startsWith(`<g transform="translate(0 0)">`)).toBe(true);
    expect(body[1]?.startsWith(`<g transform="translate(400 0)">`)).toBe(true);
    expect(body[0]).toContain(`fill="#abc"`);
    expect(body[2]).toContain(`fill="#123"`);
    expect(body.join("")).not.toContain("<image ");
  });

  it("offsets the groups by the auxiliary band above and by the row band", () => {
    const h = harness(1, viewport(), [bar]);
    const plan = planRange("full", {
      viewport: h.vp,
      scale,
      extent: { start: 0, end: 4_000 },
      contentHeight: 400,
      tileHeight: 200,
    });

    const body = captureLayersSVG(h.deps, plan, 30);

    expect(body[0]?.startsWith(`<g transform="translate(0 30)">`)).toBe(true);
    expect(body[1]?.startsWith(`<g transform="translate(0 230)">`)).toBe(true);
    expect(h.renders.map((v) => v.scrollTop)).toEqual([0, 200]);
  });

  it("rasterizes only the layer that leaves the subset, keeping the others vector and in order", () => {
    const h = harness(1, viewport(), [bar, exotic, label]);
    const plan = planRange(undefined, { viewport: h.vp });

    const body = captureLayersSVG(h.deps, plan, 0);

    expect(body).toHaveLength(3);
    expect(body[0]).toContain(`fill="#abc"`);
    expect(body[1]?.startsWith("<image ")).toBe(true);
    expect(body[2]).toContain(`fill="#123"`);
  });

  it("replays only the failing layer into the raster fallback", () => {
    const h = harness(1, viewport(), [bar, exotic, label]);
    const plan = planRange(undefined, { viewport: h.vp });

    captureLayersSVG(h.deps, plan, 0);

    // The one canvas created is the fallback for the middle layer: it holds that layer's ink only.
    const fallback = h.doc.createdCanvases()[0] as FakeCanvas;
    expect(fills(fallback.context!).map((f) => f.style)).toEqual(["#f00"]);
    expect(fallback.context?.opNames()).toContain("clip");
  });

  it("rasterizes a layer in every tile once it fails in one of them", () => {
    let call = 0;
    const flaky: LayerDraw = (g) => {
      call += 1;
      g.fillStyle = "#0f0";
      if (call === 2) g.clip();
      g.fillRect(0, 0, 10, 10);
    };
    const h = harness(1, viewport(), [flaky]);
    const plan = planRange({ start: 0, end: 6_000 }, { viewport: h.vp, scale, tileWidth: 400 });

    const body = captureLayersSVG(h.deps, plan, 0);

    expect(body).toHaveLength(2);
    expect(body.every((part) => part.startsWith("<image "))).toBe(true);
    expect(body[1]).toContain('x="400"');
  });

  it("emits nothing for a layer that draws nothing", () => {
    const h = harness(1, viewport(), [() => undefined]);
    const plan = planRange(undefined, { viewport: h.vp });
    expect(captureLayersSVG(h.deps, plan, 0)).toEqual([]);
  });
});

// The per-layer replay mechanism the raster fallback relies on.
describe("layerFilter", () => {
  function target(): { g: FakeContext2D; ctx: CanvasRenderingContext2D } {
    const g = new FakeContext2D();
    return { g, ctx: asContext(g) };
  }

  it("forwards only the requested save/restore block", () => {
    const { g, ctx } = target();
    const filtered = layerFilter(ctx, 1);
    for (const style of ["#a", "#b", "#c"]) {
      filtered.save();
      filtered.fillStyle = style;
      filtered.fillRect(0, 0, 1, 1);
      filtered.restore();
    }
    expect(fills(g).map((f) => f.style)).toEqual(["#b"]);
    expect(g.opNames()).toEqual(["save", "fillRect", "restore"]);
  });

  it("counts nested save/restore inside a block as part of that block", () => {
    const { g, ctx } = target();
    const filtered = layerFilter(ctx, 0);
    filtered.save();
    filtered.save();
    filtered.fillRect(0, 0, 1, 1);
    filtered.restore();
    filtered.restore();
    filtered.save(); // second block: suppressed
    filtered.fillRect(0, 0, 2, 2);
    filtered.restore();
    expect(fills(g)).toHaveLength(1);
  });

  it("keeps reading members live for suppressed layers", () => {
    const g = new FakeContext2D();
    const measured: number[] = [];
    const ctx = asContext(
      Object.assign(g, { measureText: (t: string) => ({ width: t.length }) }),
    ) as CanvasRenderingContext2D & { measureText(t: string): { width: number } };
    const filtered = layerFilter(ctx, 5) as unknown as typeof ctx;
    filtered.save();
    measured.push(filtered.measureText("abcd").width);
    filtered.restore();
    expect(measured).toEqual([4]);
  });
});

// §1.1 "Auxiliary surfaces" — the compose pass.
describe("captureSurface / surfaceSVG", () => {
  function band(over: Partial<AuxiliarySurfaceContribution> = {}): Band {
    const surface: AuxiliarySurfaceContribution = {
      side: "bottom",
      height: 50,
      drawTile: () => undefined,
      ...over,
    };
    return { surface, y: 200, height: surface.height };
  }

  it("draws every column into one band canvas, ratio-scaled and column-translated", () => {
    const h = harness(2);
    const plan = planRange({ start: 0, end: 6_000 }, { viewport: h.vp, scale, tileWidth: 400 });
    const seen: { tile: ExportTile; scaleX: number; tx: number }[] = [];
    const b = band({
      drawTile: (g, tile) => {
        const fake = g as unknown as FakeContext2D;
        seen.push({ tile, scaleX: fake.scaleX, tx: fake.tx });
      },
    });

    const canvas = captureSurface(h.deps, plan, b) as unknown as FakeCanvas;

    expect([canvas.width, canvas.height]).toEqual([1200, 100]);
    expect(seen.map((s) => s.tile.width)).toEqual([400, 200]);
    expect(seen.map((s) => s.tile.start)).toEqual([0, 4000]);
    expect(seen.map((s) => s.tile.end)).toEqual([4000, 6000]);
    // The context arrives pre-scaled by the export ratio, so the callback paints in CSS px.
    expect(seen.every((s) => s.scaleX === 2)).toBe(true);
    expect(seen.map((s) => s.tx)).toEqual([0, 800]);
    expect(seen.every((s) => s.tile.pixelRatio === 2)).toBe(true);
    expect(seen.every((s) => s.tile.height === 50)).toBe(true);
  });

  it("walks columns only, however many row bands the plan has", () => {
    const h = harness();
    const plan = planRange("full", {
      viewport: h.vp,
      scale,
      extent: { start: 0, end: 4_000 },
      contentHeight: 600,
      tileHeight: 200,
    });
    const tiles: ExportTile[] = [];
    const b = band({ drawTile: (_g, tile) => void tiles.push(tile) });

    captureSurface(h.deps, plan, b);

    expect(plan.rows).toHaveLength(3);
    expect(tiles).toHaveLength(1);
  });

  it("isolates a faulting surface: the export survives its exception", () => {
    const h = harness();
    const plan = planRange(undefined, { viewport: h.vp });
    const b = band({
      drawTile: () => {
        throw new Error("surface blew up");
      },
    });
    expect(() => captureSurface(h.deps, plan, b)).not.toThrow();
  });

  it("maps to SVG through the surface's own drawTileSVG, one group per column", () => {
    const h = harness();
    const plan = planRange({ start: 0, end: 6_000 }, { viewport: h.vp, scale, tileWidth: 400 });
    const b = band({
      drawTileSVG: (tile) => `<rect width="${tile.width}" height="${tile.height}"/>`,
    });
    const svg = surfaceSVG(plan, b, 1);
    expect(svg).toBe(
      `<g transform="translate(0 200)"><rect width="400" height="50"/></g>` +
        `<g transform="translate(400 200)"><rect width="200" height="50"/></g>`,
    );
  });

  it("reports no markup when the surface offers no drawTileSVG (the caller rasterizes)", () => {
    const h = harness();
    const plan = planRange(undefined, { viewport: h.vp });
    expect(surfaceSVG(plan, band(), 1)).toBeUndefined();
  });
});
