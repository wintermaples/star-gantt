// docs/specs/plugins/export.md §9 — internal module: not part of the published surface.
// §1.1 "True-vector SVG via a partial recording proxy" — detection is per layer; `renderTo`
// composites every layer into one surface, tile by tile.
/**
 * The vector-versus-raster eligibility decision of an SVG export, as a pure function of the tiles'
 * recordings.
 *
 * Deciding *what* to emit is separated from *emitting* it so the rule can be tested on its own:
 * hand it the `ok` flags of a grid of recordings and it answers which layers survive as vector and
 * which have to be replayed into a raster image.
 *
 * Not part of the package's published surface.
 */
import type { CompositeRecording } from "./recorder";

/** The single field of a recorded block this decision reads. */
export interface RecordingOutcome {
  ok: boolean;
}

/** A recorded tile, reduced to the outcomes the decision reads. */
export interface TileRecording {
  blocks: readonly (RecordingOutcome | undefined)[];
  loose: RecordingOutcome;
}

type Assert<T extends true> = T;
// A real recording must stay usable as this decision's input; a shape change over in the recorder
// therefore breaks the build here rather than silently bypassing the rule.
export type RecordingIsTileRecording = Assert<
  CompositeRecording extends TileRecording ? true : never
>;

/** How one layer is emitted: transcribed as SVG elements, or replayed into a raster image. */
export type LayerMode = "vector" | "raster";

export interface VectorizationPlan {
  /**
   * `true` when the whole composite of every tile must be rasterized, so no per-layer split is
   * possible at all; `layers` is then empty.
   */
  rasterizeComposite: boolean;
  /** How each layer is emitted, indexed by the layer's block index (its z order). */
  layers: readonly LayerMode[];
}

/**
 * Decides how each layer of a tiled SVG export is emitted.
 *
 * `ViewService.renderTo` draws nothing outside a layer's own `save()` / `restore()` block, but a
 * renderer that did and reached outside the recorded subset would leave output an SVG fragment
 * cannot express — so any tile with unusable loose output forces the whole composite to raster.
 *
 * Otherwise the decision is per layer (§1.1) and taken across *all* tiles: a layer stays vector only
 * when its block is usable in every tile, since one export must not mix a vector transcription of a
 * layer in one tile with a raster replay of it in the next. The plan covers as many layers as the
 * tile with the most blocks recorded; a tile that recorded no block at that index contributes
 * nothing there and does not by itself force a raster replay.
 */
export function planVectorization(tiles: readonly TileRecording[]): VectorizationPlan {
  if (tiles.some((t) => !t.loose.ok)) return { rasterizeComposite: true, layers: [] };

  const layerCount = tiles.reduce((max, t) => Math.max(max, t.blocks.length), 0);
  const layers: LayerMode[] = [];
  for (let layer = 0; layer < layerCount; layer += 1) {
    layers.push(tiles.every((t) => t.blocks[layer]?.ok !== false) ? "vector" : "raster");
  }
  return { rasterizeComposite: false, layers };
}
