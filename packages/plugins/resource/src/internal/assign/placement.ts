// docs/specs/plugins/resource.md §3.3 "Editor" — the assignment editor's clamped,
// flip-aware position and height cap. Pure geometry, no DOM: the editor's box is always kept fully
// inside the gantt root's box, flipping above the anchor cell when the space below cannot fit it.

/** A box in the coordinate space every input shares (e.g. straight from `getBoundingClientRect()`,
 * which already reports every element in the same viewport-relative space). */
export interface Box {
  readonly left: number;
  readonly top: number;
  readonly width: number;
  readonly height: number;
}

/**
 * The root's box plus the two offsets `getBoundingClientRect()` alone doesn't carry. The editor is
 * appended as a `position: absolute` child of the root, so it scrolls with the root's own content
 * (an absolutely positioned descendant of the element that establishes its containing block moves
 * with that element's scroll, it does not stay pinned to the viewport) and its `left`/`top` are
 * measured from the root's *padding* edge, not the border-box edge `getBoundingClientRect()`
 * reports. Both default to `0` — a root that is not itself scrolled, or has no border, needs no
 * caller-side change.
 */
export interface RootBox extends Box {
  /** `root.scrollLeft` / `root.scrollTop`: how far the root's own content is scrolled. */
  readonly scrollLeft?: number;
  readonly scrollTop?: number;
  /** `root.clientLeft` / `root.clientTop`: the root's own border width on each axis. */
  readonly clientLeft?: number;
  readonly clientTop?: number;
}

/** The editor's own measured footprint. It has no position of its own yet, hence no `left`/`top`. */
export interface Size {
  readonly width: number;
  readonly height: number;
}

export interface EditorPlacement {
  /** `left` in px, relative to the root's own box — what `dialog.style.left` should be set to. */
  readonly left: number;
  /** `top` in px, relative to the root's own box. */
  readonly top: number;
  /** CSS `max-height` in px: the root's height minus a small margin, so a choice list taller than
   * this scrolls internally instead of pushing the editor's box outside the root. */
  readonly maxHeight: number;
}

/** Total vertical margin (top + bottom together) the editor's `max-height` budget leaves against
 * the root's own edges once the editor is capped and has to scroll its choice list. */
const ROOT_MARGIN = 16;

/** Clamps `value` into `[min, max]`. When the editor cannot fit on this axis at all (`max < min` —
 * the editor is wider or taller than the root), `min` wins: the editor's box must stay clamped
 * into the root's box on both axes, and pinning it to the root's near edge is the only way to
 * satisfy that once the editor itself no longer fits. */
function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), Math.max(min, max));
}

/**
 * Computes where the assignment editor should render, from the anchor cell's box, the gantt root's
 * box, and the editor's own measured size.
 *
 * The editor opens directly below the anchor cell when it fits there. When the space below cannot
 * fit it **and the space above is larger**, it flips above the cell instead — its bottom edge
 * lands on the cell's top edge; a case whose above-space is no better keeps the editor below,
 * clamped over the cell (the side showing more of the editor wins). Either way, the final position
 * is clamped fully inside the root's box on both axes, and `maxHeight` bounds the editor to the
 * root's own height minus a fixed 16px margin, so a choice list longer than that scrolls
 * internally instead of overflowing the root. An editor that already fit below its cell keeps the
 * exact position it always had.
 *
 * `root.scrollLeft`/`scrollTop`/`clientLeft`/`clientTop` (all default `0`) fold the root's own
 * scroll offset and border width into the returned `left`/`top`, so the editor still lands
 * directly under the anchor cell when the root itself is scrolled.
 */
export function placeEditor(anchor: Box, root: RootBox, size: Size): EditorPlacement {
  const scrollLeft = root.scrollLeft ?? 0;
  const scrollTop = root.scrollTop ?? 0;
  const clientLeft = root.clientLeft ?? 0;
  const clientTop = root.clientTop ?? 0;

  // Visual on-screen offset between anchor and root first (both rects already reflect the current
  // scroll, being `getBoundingClientRect()`-shaped), then converted into the root's own CSS
  // coordinate system: add back the scroll the browser will subtract on screen, and shift past the
  // border into the padding edge that `left`/`top: 0` actually means.
  const anchorLeft = anchor.left - root.left - clientLeft + scrollLeft;
  const anchorTop = anchor.top - root.top - clientTop + scrollTop;
  const anchorBottom = anchorTop + anchor.height;

  const spaceBelow = root.height - (anchorBottom - scrollTop);
  const spaceAbove = anchorTop - scrollTop;
  const flips = size.height > spaceBelow && spaceAbove > spaceBelow;
  const top = flips ? anchorTop - size.height : anchorBottom;

  return {
    left: clamp(anchorLeft, scrollLeft - clientLeft, scrollLeft - clientLeft + root.width - size.width),
    top: clamp(top, scrollTop - clientTop, scrollTop - clientTop + root.height - size.height),
    maxHeight: Math.max(0, root.height - ROOT_MARGIN),
  };
}
