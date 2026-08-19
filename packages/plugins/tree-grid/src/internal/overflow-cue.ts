/**
 * The horizontal-overflow cue: marks the grid body with `data-overflow` whenever its native
 * horizontal scroll (`.sg-grid-body { overflow-x: auto }`) is currently hiding column content off
 * one edge or the other, so a consuming stylesheet can paint an edge shadow there.
 *
 * The grid body already scrolls horizontally on its own — nothing here adds a scroll mechanism —
 * this only keeps a DOM signal of *whether* (and which side) content is hidden, since nothing
 * before this told a sighted user a too-wide column track was clipped rather than simply short.
 */
// docs/specs/plugins/tree-grid.md § Internal modules — "horizontal overflow cue".

/**
 * Sub-pixel geometry noise (fractional layout rounding) a body sitting exactly at rest must not
 * flicker the attribute over.
 */
const OVERFLOW_EPSILON = 1;

/** The geometry the cue reads and the one attribute it writes; `HTMLElement` satisfies this. */
export interface OverflowCueElement {
  readonly scrollLeft: number;
  readonly scrollWidth: number;
  readonly clientWidth: number;
  setAttribute(name: string, value: string): void;
  removeAttribute(name: string): void;
}

/**
 * Re-derives the grid body's `data-overflow` attribute from its current scroll geometry.
 *
 * `"start"` when column content is hidden to the left of the visible box, `"end"` when content is
 * hidden to the right, `"both"` when it is hidden on both sides at once. The attribute is removed
 * entirely — never set to an empty or "none" value — once the body's own content fits without any
 * horizontal scrolling.
 */
export function updateOverflowCue(body: OverflowCueElement): void {
  const overflowing = body.scrollWidth - body.clientWidth > OVERFLOW_EPSILON;
  if (!overflowing) {
    body.removeAttribute("data-overflow");
    return;
  }
  const hiddenStart = body.scrollLeft > OVERFLOW_EPSILON;
  const hiddenEnd = body.scrollLeft + body.clientWidth < body.scrollWidth - OVERFLOW_EPSILON;
  if (hiddenStart && hiddenEnd) body.setAttribute("data-overflow", "both");
  else if (hiddenStart) body.setAttribute("data-overflow", "start");
  else if (hiddenEnd) body.setAttribute("data-overflow", "end");
  else body.removeAttribute("data-overflow");
}
