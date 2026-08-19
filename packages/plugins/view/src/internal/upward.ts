// docs/specs/plugins/export.md §4 "Official contributors (dovetail)" — the timeline header band
// contributes to `export/auxiliarySurfaces`, a Layer-8 point owned by `@stargantt/plugin-export`.
// Contributing upward is the sanctioned direction (architecture.md §5); export.md §4 offers two
// typing routes: a type-only import of `@stargantt/plugin-export` (devDependency), or a structural
// declaration.
//
// This file takes the structural route, and PERMANENTLY so, by the same reasoning the tree-grid
// `internal/upward.ts` precedent (`packages/plugins/tree-grid/src/internal/upward.ts`) records for
// `sidepanel/fields`: `@stargantt/plugin-export`'s own `package.json` already carries
// `@stargantt/plugin-view` as a `devDependency` (export.md §4 — the view contribution types are the
// same shapes export was written against; several of export's own modules type-import `ViewService`
// etc. from this package). Adding the reverse edge here — `@stargantt/plugin-view` devDepending on
// `@stargantt/plugin-export` — would close a fresh 2-cycle in the pnpm workspace's devDependency
// graph, the exact shape of the known `task-bars`⇄`tree-grid` cycle that makes
// `vite build`/`tsc` race under concurrent
// workspace builds, and the interaction plugin explicitly avoided doing this a
// second time ("structural mirror, NO a11y devDep — cycle avoidance per task-bars⇄tree-grid
// precedent"). (Note: this is a *workspace build-graph* concern, not a `lint:arch` one —
// `tools/lint-deps.mjs` exempts type-only imports from its layer check entirely, so the two are not
// in tension; the risk is purely the pnpm build-order race.) Until the cycle is broken,
// this file's own declaration is the interface.
//
// Manual-sync obligation: keep `ExportTile` / `AuxiliarySurfaceContribution` below byte-identical
// (modulo comments) to their canonical definitions in `packages/plugins/export/src/types.ts`. A
// change to either side without the other silently drifts the two packages' notion of an auxiliary
// export surface apart.
//
// The core buffers a contribution whose point has no owner yet (docs/specs/architecture.md §5), so
// a composition without the export plugin simply never sees this — the contribution below is
// registered unconditionally.
import type { PluginContext } from "@stargantt/core";

/** One horizontal slice of the exported area, handed to auxiliary-surface draw callbacks. */
export interface ExportTile {
  /** Slice time span, epoch ms. */
  start: number;
  end: number;
  /** Slice CSS-pixel box (height = the surface's own band height). */
  width: number;
  height: number;
  /** The export's ratio; the raster callback's context is pre-scaled by it. */
  pixelRatio: number;
  /**
   * Start of the WHOLE exported span this tile slices. Decisions that need to agree across every
   * tile of one export (e.g. header label thinning) are computed from this span, not the tile's
   * own slice, so tiles compose without seams.
   */
  rangeStart: number;
  /** End of the whole exported span. See `rangeStart`. */
  rangeEnd: number;
}

/** A non-layer surface that appears in exported images. */
export interface AuxiliarySurfaceContribution {
  side: "top" | "bottom";
  /** Band height, CSS px. */
  height: number;
  drawTile(ctx: CanvasRenderingContext2D, tile: ExportTile): void;
  /** Vector form of the same slice; absent, SVG exports embed the rasterized `drawTile`. */
  drawTileSVG?(tile: ExportTile): string;
}

/** The upward points whose owner is not composed in this package's type program yet. */
export interface UpwardContributions {
  "export/auxiliarySurfaces": AuxiliarySurfaceContribution;
}

/**
 * Contributes to an extension point whose owning plugin does not exist in this package's type
 * program.
 *
 * The value is type-checked against the shape declared above; only the key is passed through
 * unchecked. Retire this together with the structural declarations above when the owner's types
 * can be imported without closing a devDependency cycle (see the note above).
 */
export function contributeUpward<K extends keyof UpwardContributions>(
  ctx: PluginContext,
  point: K,
  value: UpwardContributions[K],
): void {
  // Called as a method so the context keeps its receiver; only the two arguments are widened.
  ctx.contribute(point as never, value as never);
}
