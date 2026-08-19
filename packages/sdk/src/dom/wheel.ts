// Wheel-delta unit normalization (docs/specs/sdk.md, Module: sdk/dom): one normalization for every
// wheel-scrolling pane, so line- and page-mode wheels (Firefox with certain OS settings, above
// all) scroll by pixels like everything else.

/** The parts of a `WheelEvent` the normalization reads. */
export interface WheelDeltaInput {
  readonly deltaX: number;
  readonly deltaY: number;
  /** 0 = pixels, 1 = lines, 2 = pages (the `WheelEvent.DOM_DELTA_*` constants). */
  readonly deltaMode: number;
}

/** A wheel notch resolved to CSS pixels per axis. */
export interface NormalizedWheelDelta {
  readonly dx: number;
  readonly dy: number;
}

/** CSS px per line-mode wheel unit: the nominal line height at the default 16px font size. */
const LINE_PX = 16;

/** CSS px per page-mode wheel unit when the caller supplies no viewport height. */
const DEFAULT_PAGE_PX = 800;

/**
 * Resolves a `WheelEvent`'s deltas to CSS pixels regardless of its `deltaMode`.
 *
 * Pixel-mode deltas pass through unchanged. Line mode multiplies by a nominal 16 px line; page
 * mode multiplies by `pageSizePx` — pass the scrolling viewport's height for an exact page — or by
 * a nominal 800 px when it is omitted or not positive (a pane measured before its first layout
 * reports height 0, and a 0 page must not swallow the notch). An unknown mode is treated as
 * pixels. Axis semantics (shift-swap conventions, sign) are the caller's business; only the unit
 * is normalized here.
 */
export function normalizeWheelDelta(e: WheelDeltaInput, pageSizePx?: number): NormalizedWheelDelta {
  const scale =
    e.deltaMode === 1
      ? LINE_PX
      : e.deltaMode === 2
        ? pageSizePx !== undefined && pageSizePx > 0
          ? pageSizePx
          : DEFAULT_PAGE_PX
        : 1;
  return { dx: e.deltaX * scale, dy: e.deltaY * scale };
}
