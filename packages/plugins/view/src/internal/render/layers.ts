// docs/specs/plugins/view.md — internal; not part of the published surface.
/**
 * The layer composite: z ordering, the guarded draw loop, and the per-layer dirty repaint.
 *
 * The whole drawing core lives here rather than in `setup()`, so it can be exercised against plain
 * recording contexts without booting a host.
 */
import { LAYER_ORDER, layerOf } from "./dom";
import type { CanvasLayer, LayerContribution, Viewport } from "./index";
import type { DirtyRect } from "./dirty";

/** Contributions in zIndex order; ties keep contribution order (`Array#sort` is stable). */
export function orderLayers(raw: readonly LayerContribution[]): LayerContribution[] {
  // docs/specs/plugins/view.md — zIndex orders the pass and selects the canvas.
  return raw.slice().sort((a, b) => a.zIndex - b.zIndex);
}

/**
 * A memoized view of the `renderer/layers` result.
 *
 * `ExtensionPoint.get()` is reference-stable while the contribution set is unchanged
 * (docs/specs/architecture.md), so the sorted copy is rebuilt only when a new
 * contribution arrives rather than once per frame.
 */
export function createLayerOrder(
  get: () => readonly LayerContribution[] | undefined,
): () => readonly LayerContribution[] {
  let source: readonly LayerContribution[] | null = null;
  let ordered: readonly LayerContribution[] = [];
  return () => {
    const raw = get() ?? [];
    if (raw !== source) {
      source = raw;
      ordered = orderLayers(raw);
    }
    return ordered;
  };
}

/**
 * The one drawing core both composites go through.
 *
 * Invokes the contributions in the already-sorted `list` that belong to `layer` — or every one of
 * them when `layer` is `null`, which is how a single-surface composite (`renderTo`) merges the three
 * canvases into one target — passing each the supplied context and viewport. Each `draw` is
 * bracketed with `save()` / `restore()` and guarded individually, so a throwing contribution leaves
 * the context state it was given restored and never aborts the pass.
 */
// docs/specs/plugins/view.md — (fault isolation) /
// docs/specs/plugins/view.md — (z order → layer) / (`renderTo` shares this core).
export function drawLayers(
  target: CanvasRenderingContext2D,
  viewport: Readonly<Viewport>,
  list: readonly LayerContribution[],
  layer: CanvasLayer | null,
  onFault: (error: unknown) => void,
): void {
  for (const contribution of list) {
    if (layer !== null && layerOf(contribution.zIndex) !== layer) continue;
    target.save();
    try {
      contribution.draw(target, viewport);
    } catch (error) {
      onFault(error);
    } finally {
      target.restore();
    }
  }
}

/**
 * Repaints the invalidated canvases, back to front.
 *
 * `claimDirty` both reports and clears a layer's dirty flag, so a contribution that invalidates a
 * later layer from inside its own `draw` is served by this same pass.
 */
export function paintLayers(
  contexts: Record<CanvasLayer, CanvasRenderingContext2D>,
  viewport: Readonly<Viewport>,
  list: readonly LayerContribution[],
  claimDirty: (layer: CanvasLayer) => boolean,
  onFault: (error: unknown) => void,
  // docs/specs/plugins/view.md — dirty-region repaint: when the region
  // tracker hands back a rect for the layer, the clear and the draws are clipped to it; `null`
  // (or no tracker at all) keeps the historical full-viewport repaint.
  regionOf?: (layer: CanvasLayer) => DirtyRect | null,
): void {
  for (const name of LAYER_ORDER) {
    if (!claimDirty(name)) continue;
    const target = contexts[name];
    const region = regionOf === undefined ? null : regionOf(name);
    if (region !== null) {
      target.save();
      target.beginPath();
      target.rect(region.x, region.y, region.width, region.height);
      target.clip();
      target.clearRect(region.x, region.y, region.width, region.height);
      drawLayers(target, viewport, list, name, onFault);
      target.restore();
      continue;
    }
    // The canvas is sized to the viewport only (§3.3), so the viewport clip is structural and the
    // "+2 screens" buffer of §3.2-3 cannot widen it.

    // docs/specs/plugins/view.md — repaint clipping is the viewport rectangle only. Row-granular
    // clipping would need row geometry, which reaches this plugin through `renderer/rowGeometry`
    // and is consulted by the background passes rather than by the composite.
    target.clearRect(0, 0, viewport.width, viewport.height);
    drawLayers(target, viewport, list, name, onFault);
  }
}

/**
 * A private, numeric copy of a caller-supplied viewport.
 *
 * The contributions must not see the caller mutate the viewport mid-pass, and a non-numeric member
 * from an untyped caller must not reach a `draw` as `NaN` geometry.
 */
// docs/specs/plugins/view.md
export function normalizeViewport(viewport: Readonly<Viewport> | undefined): Viewport {
  const number = (value: unknown): number =>
    typeof value === "number" && Number.isFinite(value) ? value : 0;
  return {
    scrollTop: number(viewport?.scrollTop),
    scrollLeft: number(viewport?.scrollLeft),
    width: number(viewport?.width),
    height: number(viewport?.height),
  };
}
