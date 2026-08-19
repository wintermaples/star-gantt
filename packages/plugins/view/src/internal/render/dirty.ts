// docs/specs/plugins/view.md — internal; not part of the published surface.
/**
 * Dirty-region accumulation: per layer, the union rectangle of the invalidated areas since the
 * last paint, or "full" when anything invalidated without a rectangle.
 *
 * Consumed by the paint pass to clip a repaint to what actually changed. Disabled, every layer is
 * always "full", which is the pre-existing behavior.
 */
import type { CanvasLayer } from "./index";

/** A rectangle in viewport-local CSS px. */
export interface DirtyRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface DirtyRegions {
  /**
   * Notes an invalidation of `layer`. With a usable rect it is unioned into the layer's pending
   * region; without one (or with a non-finite / non-positive one) the layer becomes fully dirty.
   */
  add(layer: CanvasLayer, rect?: DirtyRect): void;
  /**
   * The pending region for `layer`, consumed: `null` means "repaint everything" (also the answer
   * whenever the feature is disabled), a rect means "clip the repaint to this".
   */
  take(layer: CanvasLayer): DirtyRect | null;
}

export function createDirtyRegions(enabled: boolean): DirtyRegions {
  /** Per layer: absent = nothing recorded yet (treated as full), `null` = full, rect = partial. */
  const pending = new Map<CanvasLayer, DirtyRect | null>();

  if (!enabled) return { add: () => {}, take: () => null };

  return {
    add(layer, rect) {
      if (!usable(rect)) {
        pending.set(layer, null);
        return;
      }
      const current = pending.get(layer);
      if (current === null) return; // already fully dirty
      pending.set(layer, current === undefined ? { ...rect } : union(current, rect));
    },
    take(layer) {
      const region = pending.get(layer) ?? null;
      pending.delete(layer);
      return region;
    },
  };
}

function usable(rect: DirtyRect | undefined): rect is DirtyRect {
  return (
    rect !== undefined &&
    typeof rect === "object" &&
    Number.isFinite(rect.x) &&
    Number.isFinite(rect.y) &&
    Number.isFinite(rect.width) &&
    Number.isFinite(rect.height) &&
    rect.width > 0 &&
    rect.height > 0
  );
}

function union(a: DirtyRect, b: DirtyRect): DirtyRect {
  const x = Math.min(a.x, b.x);
  const y = Math.min(a.y, b.y);
  return {
    x,
    y,
    width: Math.max(a.x + a.width, b.x + b.width) - x,
    height: Math.max(a.y + a.height, b.y + b.height) - y,
  };
}
