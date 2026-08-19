/**
 * The `export/auxiliarySurfaces` contribution: the header band, redrawn per export tile.
 *
 * docs/specs/plugins/export.md §4 "Official contributors (dovetail)" — one top surface, sized by
 * the same `--sg-header-height` total the on-screen canvas uses. Both tile paths go through the
 * very same paint routines the chart uses (`drawHeader` / `drawHeaderSVG`), with paint inputs read
 * live at call time, so labels and ticks for a given span are identical whether the chart shows
 * them or an export composes them; because the callbacks close over this plugin's own state, the
 * export plugin never reads timeline internals.
 *
 * The contribution types (`ExportTile`, `AuxiliarySurfaceContribution`) are declared structurally
 * in `../upward` rather than imported from `@stargantt/plugin-export` — see that file's header
 * comment for why.
 *
 * Internal: not part of the published surface.
 */
import { drawHeader, drawHeaderSVG } from "./header";
import type { HeaderDrawOptions, HeaderPaintInputs } from "./header-options";
import type { AuxiliarySurfaceContribution, ExportTile } from "../upward";

/** What the surface needs from the plugin, resolved at each `drawTile` / `drawTileSVG` call. */
export interface HeaderSurfaceDeps {
  /** Band height: the `--sg-header-height` total the on-screen header is sized by. */
  height: number;
  /** Everything a paint reads live — the same snapshot the on-screen paint takes. */
  paintInputs(): HeaderPaintInputs;
  /** Content x of an instant, i.e. the axis's `tToX`; a tile's `scrollLeft` is derived from it. */
  tToX(t: number): number;
}

/** The contribution object, shaped as `export/auxiliarySurfaces` expects. */
export type HeaderAuxiliarySurface = AuxiliarySurfaceContribution & {
  side: "top";
  drawTileSVG(tile: ExportTile): string;
};

/**
 * The draw options for one export tile: the live paint inputs plus the tile's own box, the
 * `scrollLeft` that puts content x = `tile.start` at the tile's left edge, and the two rules an
 * export reads differently from the screen.
 */
function tileOptions(tile: ExportTile, deps: HeaderSurfaceDeps): HeaderDrawOptions {
  return {
    ...deps.paintInputs(),
    height: tile.height,
    width: tile.width,
    // The header's `scrollLeft` for the tile is `tToX(tile.start)`, so the tile's left edge lines
    // up with content x = `tile.start` — i.e. local x = 0 — exactly as the on-screen header lines
    // up with the viewport's own `scrollLeft`.
    scrollLeft: deps.tToX(tile.start),
    // docs/specs/plugins/view.md (header.ts `HeaderDrawOptions.sticky`) — export tiles never apply
    // the sticky leading label: a pinned caption at every tile seam would duplicate the month name
    // mid-month.
    sticky: false,
    // Thinning is computed over the whole exported span, so every tile of one export agrees on
    // which boundaries carry a label and a straddling caption's halves compose. Defensive: a
    // hand-built tile missing the span fields degrades to the tile's own slice.
    thinningRange: {
      from: Number.isFinite(tile.rangeStart) ? tile.rangeStart : tile.start,
      to: Number.isFinite(tile.rangeEnd) ? tile.rangeEnd : tile.end,
    },
  };
}

/**
 * Builds the header band's auxiliary-surface contribution.
 *
 * `drawTile` redraws the header for the tile's own span through the same routine the on-screen
 * canvas uses; `drawTileSVG` emits the same tile as vector markup, giving SVG exports a true-vector
 * header rather than an embedded raster image.
 */
export function headerAuxiliarySurface(deps: HeaderSurfaceDeps): HeaderAuxiliarySurface {
  return {
    side: "top",
    height: deps.height,
    drawTile: (g, tile) => drawHeader(g, tileOptions(tile, deps)),
    drawTileSVG: (tile) => drawHeaderSVG(tileOptions(tile, deps)),
  };
}
