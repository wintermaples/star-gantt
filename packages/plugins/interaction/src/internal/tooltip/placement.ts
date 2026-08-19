// docs/specs/plugins/interaction.md §6.4a — the offset / flip / clamp arithmetic that keeps the
// tooltip panel off its anchor and inside the anchor's visible area.
/**
 * Where the tooltip panel goes.
 *
 * The panel is offset below-right of the anchor so it never occludes the bar it describes; near an
 * edge of the visible area it flips to above-left, and where flipping is not enough it is clamped so
 * it stays fully visible. All of it is plain arithmetic over numbers plus one read-only walk up the
 * element tree, kept free of the plugin's DOM writes so the rules can be unit-tested on their own.
 */

/** The fixed gap, in CSS pixels, between the anchor point and the nearest corner of the panel — one
 *  value per axis, applied below-right and mirrored above-left when the placement flips. */
export const OFFSET_X = 12;
export const OFFSET_Y = 16;

/**
 * A window-relative rectangle, in CSS pixels.
 *
 * As the region the panel has to stay inside, this is the browser window narrowed by every ancestor
 * that clips its overflow. The renderer's DOM overlay lives in an `overflow: hidden` chart pane, so
 * a panel that merely fits the window can still be clipped away; the pane edge, not the window
 * edge, is then the boundary the flip and the clamp answer to.
 */
export interface Bounds {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

/** The panel's own size, in CSS pixels. */
export interface PanelSize {
  width: number;
  height: number;
}

/** A window-relative position for the panel's top-left corner, in CSS pixels. */
export interface PanelPosition {
  left: number;
  top: number;
}

/** The part of an element the clip walk reads: its box, and the element above it. */
export interface ClipNode {
  readonly parentElement: ClipNode | null;
  getBoundingClientRect(): { left: number; top: number; right: number; bottom: number };
}

/** The part of a window the clip walk reads: the viewport size, and computed overflow. */
export interface ClipView {
  readonly innerWidth: number;
  readonly innerHeight: number;
  getComputedStyle(node: ClipNode): { overflowX: string; overflowY: string };
}

/**
 * The window rect intersected with the clip rect of every overflow-clipping element from `from`
 * upwards.
 *
 * Pass the panel's parent: the panel is absolutely positioned, so its containing block is the
 * nearest positioned ancestor and every element from there upwards contains that containing block —
 * which means all of them clip it. Walking the whole chain is therefore correct, not merely
 * conservative.
 */
export function visibleBounds(from: ClipNode | null, view: ClipView): Bounds {
  const bounds: Bounds = { left: 0, top: 0, right: view.innerWidth, bottom: view.innerHeight };
  for (let node = from; node != null; node = node.parentElement) {
    const style = view.getComputedStyle(node);
    const clipsX = style.overflowX !== "visible";
    const clipsY = style.overflowY !== "visible";
    if (!clipsX && !clipsY) continue;
    const rect = node.getBoundingClientRect();
    if (clipsX) {
      bounds.left = Math.max(bounds.left, rect.left);
      bounds.right = Math.min(bounds.right, rect.right);
    }
    if (clipsY) {
      bounds.top = Math.max(bounds.top, rect.top);
      bounds.bottom = Math.min(bounds.bottom, rect.bottom);
    }
  }
  return bounds;
}

/**
 * One axis of the placement: the offset position, flipped to the other side of the anchor when it
 * would overflow `max`, and clamped into `min..max` when even the flipped side does not fit.
 *
 * A panel larger than the whole span ends up at `min`, i.e. its far edge overflows rather than its
 * near one, so its beginning is always the part that stays readable.
 */
export function placeAxis(
  anchor: number,
  offset: number,
  size: number,
  min: number,
  max: number,
): number {
  let position = anchor + offset;
  if (position + size > max) {
    const flipped = anchor - offset - size;
    position = flipped >= min ? flipped : Math.max(min, max - size);
  }
  return position < min ? min : position;
}

/**
 * The panel's window-relative position for an anchor at window position `anchorX`/`anchorY`.
 *
 * The two axes are decided independently, so a panel near one edge flips on that axis alone. With
 * `bounds` of `null` — no window is known, as in a headless environment — the offset still applies
 * but there is nothing to flip or clamp against.
 */
export function placePanel(
  anchorX: number,
  anchorY: number,
  size: Readonly<PanelSize>,
  bounds: Readonly<Bounds> | null,
): PanelPosition {
  if (bounds === null) return { left: anchorX + OFFSET_X, top: anchorY + OFFSET_Y };
  return {
    left: placeAxis(anchorX, OFFSET_X, size.width, bounds.left, bounds.right),
    top: placeAxis(anchorY, OFFSET_Y, size.height, bounds.top, bounds.bottom),
  };
}
