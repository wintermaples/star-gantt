// docs/specs/plugins/export.md §9 — internal module: not part of the published surface.
// §1.1 "Tiled composition" / "True-vector SVG" / "Auxiliary surfaces" / "Row coverage".
/**
 * The capture passes: the drawing layers (tiled through `ViewService.renderTo` virtual viewports)
 * and the auxiliary surfaces (drawn tile by tile by their own contributions).
 *
 * Not part of the package's published surface.
 */
// Type-only: brings `Viewport` into the program without a runtime dependency on `@stargantt/plugin-view`.
import type { Viewport } from "@stargantt/plugin-view";
import type { AuxiliarySurfaceContribution, ExportTile } from "../../types";
import { context2d, offscreen, svgImage } from "./compose";
import { recordComposite } from "./recorder";
import type { CompositeRecording } from "./recorder";
import type { Column, RangePlan, Row } from "./range";
import { planVectorization } from "./vectorization";

/**
 * Everything the capture passes need from the outside world, injected so they stay testable.
 *
 * `renderTo` is the view plugin's own member (`ViewService.renderTo`), injected as a bare function
 * rather than the whole service so the capture passes stay hostless.
 */
export interface CaptureDeps {
  doc: Document;
  /** The view plugin's `renderTo`, injected so the passes stay hostless. */
  renderTo(g: CanvasRenderingContext2D, viewport: Readonly<Viewport>): void;
  /** Image pixels per CSS pixel for this export. */
  ratio: number;
  /** `true` once the plugin has been disposed: the capture stops instead of finishing the export. */
  aborted: () => boolean;
}

/* ------------------------------------------------------------------ *
 * Layout (§1.1 "Auxiliary surfaces"): bands above and below the drawing layers
 * ------------------------------------------------------------------ */

/** One auxiliary surface placed in the exported image. */
export interface Band {
  surface: AuxiliarySurfaceContribution;
  /** Top edge of the band within the exported image, in CSS px. */
  y: number;
  height: number;
}

export interface ExportLayout {
  /** CSS-pixel size of the whole exported image, auxiliary bands included. */
  width: number;
  height: number;
  /** Top edge of the drawing layers' band within the exported image, in CSS px. */
  layersTop: number;
  layersHeight: number;
  bands: Band[];
}

function usableHeight(h: number): boolean {
  return Number.isFinite(h) && h > 0;
}

/**
 * Stacks the auxiliary surfaces around the drawing layers.
 *
 * `side: "top"` surfaces are stacked downward from the image's top edge in contribution order (so
 * the first contribution is the outermost band), `side: "bottom"` surfaces downward from the
 * layers' bottom edge (so the first contribution is the innermost band). A surface whose height is
 * not a positive finite number reserves nothing and is dropped.
 */
export function layout(
  plan: RangePlan,
  layersHeight: number,
  surfaces: readonly AuxiliarySurfaceContribution[],
): ExportLayout {
  const top = surfaces.filter((s) => s.side === "top" && usableHeight(s.height));
  const bottom = surfaces.filter((s) => s.side !== "top" && usableHeight(s.height));

  const bands: Band[] = [];
  let y = 0;
  for (const surface of top) {
    bands.push({ surface, y, height: surface.height });
    y += surface.height;
  }
  const layersTop = y;
  y += layersHeight;
  for (const surface of bottom) {
    bands.push({ surface, y, height: surface.height });
    y += surface.height;
  }

  return { width: plan.width, height: y, layersTop, layersHeight, bands };
}

/* ------------------------------------------------------------------ *
 * Drawing layers (§1.1 "Tiled composition" / "Row coverage"): tiled capture through `renderTo`
 * ------------------------------------------------------------------ */

/** The virtual viewport one tile of the grid stands for. */
function tileViewport(column: Column, row: Row): Viewport {
  return {
    scrollLeft: column.scrollLeft,
    scrollTop: row.scrollTop,
    width: column.width,
    height: row.height,
  };
}

function abortIfDisposed(deps: CaptureDeps): void {
  if (deps.aborted()) throw new Error("stargantt.export: export aborted");
}

/**
 * A common real browser ceiling on a single canvas side, in device pixels.
 *
 * Chromium and Firefox both refuse (or silently clear) a canvas past roughly this size on one
 * side; validating against it here turns a would-be blank/broken PNG into a clear rejection.
 */
const MAX_CANVAS_DIMENSION = 16384;

/** A conservative ceiling on total device pixels, chosen well under `2**32` to stay memory-sane. */
const MAX_CANVAS_PIXELS = 2 ** 28;

/**
 * Rejects a planned output canvas that would exceed the real-browser canvas size ceilings, before
 * anything is allocated for it.
 *
 * `cssWidth` / `cssHeight` are in CSS px; `ratio` is the export's device-pixels-per-CSS-pixel
 * factor. Without this check an oversized plan silently produces a blank or truncated image
 * instead of failing loudly (the same "reject the caller error instead of degrading" stance as the
 * degenerate-range check in `./range.ts`, §1.1).
 */
function assertCanvasSizeWithinLimits(cssWidth: number, cssHeight: number, ratio: number): void {
  const width = Math.max(1, Math.round(cssWidth * ratio));
  const height = Math.max(1, Math.round(cssHeight * ratio));
  const pixels = width * height;
  if (width > MAX_CANVAS_DIMENSION || height > MAX_CANVAS_DIMENSION || pixels > MAX_CANVAS_PIXELS) {
    throw new Error(
      `stargantt.export: exported image ${width}x${height} exceeds the supported canvas ` +
        `size (max ${MAX_CANVAS_DIMENSION}px per side, ${MAX_CANVAS_PIXELS} px total)`,
    );
  }
}

/**
 * Renders one tile's layer composite into its own offscreen canvas.
 *
 * The canvas is the tile's size, so a layer that paints beyond the tile's window is clipped by the
 * surface itself and cannot bleed into the neighbouring tile.
 */
function renderTile(deps: CaptureDeps, column: Column, row: Row): HTMLCanvasElement {
  const canvas = offscreen(deps.doc, column.width, row.height, deps.ratio);
  const g = context2d(canvas);
  g.scale(deps.ratio, deps.ratio);
  deps.renderTo(g, tileViewport(column, row));
  return canvas;
}

/**
 * Renders the drawing layers over the whole exported area into a single offscreen canvas.
 *
 * The area is walked tile by tile — columns across, row bands down — and each tile is drawn by
 * `ViewService.renderTo` for that tile's virtual viewport, reusing every layer's `draw` unchanged.
 * Nothing on screen is scrolled, repainted or otherwise touched, and a tile whose viewport sits
 * outside the chart's scrollable content renders exactly as asked instead of being clamped back
 * into range.
 */
export function captureLayers(deps: CaptureDeps, plan: RangePlan): HTMLCanvasElement {
  assertCanvasSizeWithinLimits(plan.width, plan.height, deps.ratio);
  const out = offscreen(deps.doc, plan.width, plan.height, deps.ratio);
  const g = context2d(out);
  for (const row of plan.rows) {
    for (const column of plan.columns) {
      abortIfDisposed(deps);
      const tile = renderTile(deps, column, row);
      g.drawImage(tile, column.x * deps.ratio, row.y * deps.ratio, tile.width, tile.height);
    }
  }
  return out;
}

/* ------------------------------------------------------------------ *
 * Drawing layers, vector path (§1.1 "True-vector SVG")
 * ------------------------------------------------------------------ */

/**
 * Members that only read from the context; they stay live for every layer so a suppressed layer's
 * measurements and factory calls keep behaving, and none of them puts ink on the canvas.
 */
const READING_MEMBERS = new Set([
  "measureText",
  "getLineDash",
  "getTransform",
  "getImageData",
  "isPointInPath",
  "isPointInStroke",
  "createLinearGradient",
  "createRadialGradient",
  "createConicGradient",
  "createPattern",
  "createImageData",
]);

/**
 * A context wrapper that forwards only the `index`-th top-level `save()` / `restore()` block.
 *
 * `ViewService.renderTo` brackets each layer contribution in one such block, so this is how a
 * single layer is replayed on its own out of a composite the renderer never splits: every other
 * layer's drawing calls are swallowed, while reading members stay live so a suppressed layer still
 * measures text and never observes a broken context.
 */
export function layerFilter(
  target: CanvasRenderingContext2D,
  index: number,
): CanvasRenderingContext2D {
  let depth = 0;
  let block = -1;
  const active = (): boolean => block === index;

  const handler: ProxyHandler<CanvasRenderingContext2D> = {
    get(_t, prop): unknown {
      if (prop === "save") {
        return (): void => {
          if (depth === 0) block += 1;
          depth += 1;
          if (active()) target.save();
        };
      }
      if (prop === "restore") {
        return (): void => {
          if (depth === 0) return;
          if (active()) target.restore();
          depth -= 1;
        };
      }
      const value = Reflect.get(target, prop, target) as unknown;
      if (typeof value !== "function") return value;
      const fn = value as (...args: unknown[]) => unknown;
      if (READING_MEMBERS.has(String(prop))) return fn.bind(target);
      return (...args: unknown[]): unknown => (active() ? fn.apply(target, args) : undefined);
    },
    set(_t, prop, value): boolean {
      if (active()) Reflect.set(target, prop, value, target);
      return true;
    },
  };
  return new Proxy(target, handler);
}

/** One tile of the SVG pass: its place in the grid plus the recording taken for it. */
interface Cell {
  column: Column;
  row: Row;
  recording: CompositeRecording;
}

/**
 * Records every tile's layer composite once, in grid order (columns across, row bands down).
 *
 * One recording per tile is all the pass ever needs: it is split per layer, so both the eligibility
 * decision and the vector output are read back out of it rather than re-rendering.
 */
function recordCells(deps: CaptureDeps, plan: RangePlan): Cell[] {
  const cells: Cell[] = [];
  for (const row of plan.rows) {
    for (const column of plan.columns) {
      abortIfDisposed(deps);
      const vp = tileViewport(column, row);
      cells.push({
        column,
        row,
        recording: recordComposite((g) => deps.renderTo(g, vp), column.width, row.height),
      });
    }
  }
  return cells;
}

/**
 * Transcribes the drawing layers to SVG, tile by tile and layer by layer.
 *
 * Each tile's composite is recorded once through the proxy, which splits the pass at the
 * `save()` / `restore()` blocks `renderTo` wraps every layer in. A layer whose recording stays
 * inside the proxy's subset in **all** tiles contributes vector elements; any other layer is
 * replayed through `layerFilter` into an offscreen canvas and embedded as a raster image on its
 * own, so third-party layers degrade alone and z order is preserved either way (§1.1).
 *
 * Returns the body fragments in back-to-front order, positioned within the exported image.
 */
export function captureLayersSVG(deps: CaptureDeps, plan: RangePlan, layersTop: number): string[] {
  const cells = recordCells(deps, plan);

  const rasterCell = (cell: Cell, draw: (g: CanvasRenderingContext2D) => void): string => {
    const canvas = offscreen(deps.doc, cell.column.width, cell.row.height, deps.ratio);
    const g = context2d(canvas);
    g.scale(deps.ratio, deps.ratio);
    draw(g);
    return svgImage(
      cell.column.x,
      layersTop + cell.row.y,
      cell.column.width,
      cell.row.height,
      canvas.toDataURL("image/png"),
    );
  };
  // The eligibility rule itself lives in `./vectorization.ts` as a pure function of the recordings.
  const decision = planVectorization(cells.map((c) => c.recording));
  if (decision.rasterizeComposite) {
    return cells.map((cell) =>
      rasterCell(cell, (g) => deps.renderTo(g, tileViewport(cell.column, cell.row))),
    );
  }

  const body: string[] = [];
  decision.layers.forEach((mode, layer) => {
    for (const cell of cells) {
      abortIfDisposed(deps);
      if (mode === "vector") {
        const svg = cell.recording.blocks[layer]?.svg ?? "";
        if (svg === "") continue;
        body.push(`<g transform="translate(${cell.column.x} ${layersTop + cell.row.y})">${svg}</g>`);
        continue;
      }
      if (mode === "raster") {
        const vp = tileViewport(cell.column, cell.row);
        body.push(rasterCell(cell, (g) => deps.renderTo(layerFilter(g, layer), vp)));
        continue;
      }
      // `LayerMode` is closed: a new variant must be handled above, not fall through silently.
      const unreachable: never = mode;
      throw new Error(`stargantt.export: unhandled layer mode ${String(unreachable)}`);
    }
  });
  return body;
}

/* ------------------------------------------------------------------ *
 * Auxiliary surfaces (§1.1 "Auxiliary surfaces"): the compose pass
 * ------------------------------------------------------------------ */

/** The whole exported span, in content time — the same for every column of `plan`. */
interface ExportSpan {
  rangeStart: number;
  rangeEnd: number;
}

/**
 * The exported span's own start/end, computed once per plan rather than on every `tileFor` call:
 * every column of the same plan shares the same first/last column, so it is loop-invariant.
 */
function exportedSpan(plan: RangePlan): ExportSpan {
  const first = plan.columns[0];
  const last = plan.columns[plan.columns.length - 1];
  return {
    rangeStart: first?.start ?? 0,
    rangeEnd: last?.end ?? 0,
  };
}

function tileFor(
  column: Column,
  height: number,
  ratio: number,
  range: ExportSpan,
): ExportTile {
  return {
    start: column.start,
    end: column.end,
    width: column.width,
    height,
    pixelRatio: ratio,
    // The whole exported span, so per-tile paints can make export-wide decisions (e.g. the
    // header's label thinning) that agree across tile seams (§4).
    rangeStart: range.rangeStart,
    rangeEnd: range.rangeEnd,
  };
}

/**
 * Rasterizes one auxiliary surface across the exported span into a single offscreen canvas.
 *
 * Auxiliary surfaces are bands spanning the exported time range, so they are walked by column
 * only: each column gets its own context translation and is handed to the contribution's
 * `drawTile` with the context already scaled by the export's pixel ratio, so the callback paints
 * in CSS pixels. Surfaces render at the same ratio as the drawing layers; no per-surface ratio is
 * recomputed (§1.1 / §4).
 */
export function captureSurface(
  deps: CaptureDeps,
  plan: RangePlan,
  band: Band,
): HTMLCanvasElement {
  const canvas = offscreen(deps.doc, plan.width, band.height, deps.ratio);
  const g = context2d(canvas);
  const range = exportedSpan(plan);
  for (const column of plan.columns) {
    g.save();
    g.scale(deps.ratio, deps.ratio);
    g.translate(column.x, 0);
    try {
      band.surface.drawTile(g, tileFor(column, band.height, deps.ratio, range));
    } catch {
      // Fault isolation: a faulting surface loses its tile, the rest of the export survives.
    }
    g.restore();
  }
  return canvas;
}

/**
 * Maps one auxiliary surface to SVG elements through its own `drawTileSVG`, column by column.
 *
 * Returns `undefined` when the contribution has no `drawTileSVG`, in which case the caller embeds
 * the rasterized `drawTile` output as an image instead (§1 `AuxiliarySurfaceContribution`).
 */
export function surfaceSVG(plan: RangePlan, band: Band, ratio: number): string | undefined {
  const draw = band.surface.drawTileSVG;
  if (draw === undefined) return undefined;
  const parts: string[] = [];
  const range = exportedSpan(plan);
  for (const column of plan.columns) {
    let markup: string;
    try {
      markup = draw.call(band.surface, tileFor(column, band.height, ratio, range));
    } catch {
      // Fault isolation, as in the raster pass.
      continue;
    }
    parts.push(`<g transform="translate(${column.x} ${band.y})">${markup}</g>`);
  }
  return parts.join("");
}
