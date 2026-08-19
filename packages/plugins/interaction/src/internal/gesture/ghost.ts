// docs/specs/plugins/interaction.md §3 — the `renderer/layers` contribution claimed at order 100:
// the drag preview (ghost band, commit target, dependency-preview outlines, insertion line).
/**
 * The drag ghost: the outline that shows where a dragged bar would land.
 *
 * It is a translucent band with an outline, covering the row the task sits in over the dates the
 * drag proposes — and, when the committed dates would be rounded somewhere else, a second dashed
 * outline marking where the release would actually land.
 *
 * Both the geometry and the painting live here, free of canvas state beyond the 2d context a layer
 * is handed, so the arithmetic can be unit-tested on its own.
 */
import type { TimeRange } from "../drag/gesture";
import { sameRange } from "../drag/gesture";
import type { BarPlacement, DateGesture } from "../drag/pointer-gesture";

/** CSS custom property that gives the ghost band its fill. */
export const GHOST_FILL_TOKEN = "--sg-drag-ghost-fill";

/** CSS custom property that gives the ghost band its outline colour. */
export const GHOST_STROKE_TOKEN = "--sg-drag-ghost-stroke";

/** Fill used when the chart defines no fill for the ghost band. */
export const GHOST_FILL = "rgba(15, 118, 110, 0.28)";

/** Outline colour used when the chart defines no outline colour for the ghost band. */
export const GHOST_STROKE = "rgba(15, 118, 110, 0.9)";

/** Outline width, in CSS pixels. */
export const GHOST_LINE_WIDTH = 1;

/** Narrowest ghost, so a milestone or a zero-length task still shows one. */
export const MIN_GHOST_WIDTH = 2;

/** A rectangle in viewport-local CSS pixels — the space a layer contribution paints in. */
export interface GhostRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** The pixel↔time conversion the ghost's geometry needs, as this module needs it. */
export interface Projection {
  tToX(t: number): number;
}

/** The part of the viewport a layer's `draw` is handed, as the ghost needs it. */
export interface GhostViewport {
  scrollLeft: number;
  scrollTop: number;
  width: number;
}

/** What one ghost paint consists of: either band may be absent when it is off screen. */
export interface GhostRects {
  /** The band at the unsnapped dates the pointer describes, or `undefined` when off screen. */
  band: GhostRect | undefined;
  /** The outline at the dates a release would commit, or `undefined` when it adds nothing. */
  target: GhostRect | undefined;
}

/**
 * The band a range occupies, in viewport-local pixels.
 *
 * The ghost is the bar itself, displaced: each edge moves by however far its time moved, so a move
 * slides the bar rigidly and a resize drags one edge. Working from the drawn box rather than from
 * the dates keeps milestones and minimum-width bars the size they look — which is what the box's
 * two offsets carry.
 *
 * Those offsets, rather than the box's captured content x, are what the band is placed against:
 * every content x moves when the origin moves, and a drag can move the origin, so anchoring on the
 * captured x would drift the whole band left by the extension.
 */
export function ghostRectFor(
  bar: Readonly<BarPlacement>,
  range: Readonly<TimeRange>,
  projection: Projection,
  vp: Readonly<GhostViewport>,
): GhostRect {
  const left = projection.tToX(range.start) + bar.startOffset;
  const right = projection.tToX(range.end) + bar.endOffset;
  return {
    x: Math.min(left, right) - vp.scrollLeft,
    y: bar.top - vp.scrollTop,
    width: Math.max(MIN_GHOST_WIDTH, Math.abs(right - left)),
    height: bar.height,
  };
}

/** Whether a band overlaps the visible strip at all. */
export function onScreen(rect: Readonly<GhostRect>, vp: Readonly<GhostViewport>): boolean {
  return rect.x <= vp.width && rect.x + rect.width >= 0;
}

// The band is drawn at the *unsnapped* dates, so it tracks the cursor pixel for pixel instead of
// jumping a whole unit at a time; the rounded dates a release would commit are shown separately,
// and only when they land somewhere else.
/** What a gesture's ghost paints this frame, with anything off screen left out. */
export function ghostRectsFor(
  active: DateGesture,
  projection: Projection,
  vp: Readonly<GhostViewport>,
): GhostRects {
  const band = ghostRectFor(active.bar, active.range, projection, vp);
  const target =
    active.rounded && !sameRange(active.commit, active.range)
      ? ghostRectFor(active.bar, active.commit, projection, vp)
      : undefined;
  return {
    band: onScreen(band, vp) ? band : undefined,
    target: target !== undefined && onScreen(target, vp) ? target : undefined,
  };
}

/**
 * Draws the ghost, in the given colours or in the built-in ones where a colour is omitted.
 *
 * The caller is responsible for saving and restoring the canvas state around this call; the view
 * already does so around every layer contribution.
 */
export function drawGhost(
  g: CanvasRenderingContext2D,
  rect: Readonly<GhostRect>,
  fill: string = GHOST_FILL,
  stroke: string = GHOST_STROKE,
): void {
  g.fillStyle = fill;
  g.fillRect(rect.x, rect.y, rect.width, rect.height);
  g.strokeStyle = stroke;
  g.lineWidth = GHOST_LINE_WIDTH;
  g.strokeRect(rect.x, rect.y, rect.width, rect.height);
}

/** Dash pattern of the commit-target outline, in CSS pixels: 4 on, 3 off. */
export const TARGET_LINE_DASH: readonly number[] = [4, 3];

/** Stroke width of the commit-target outline, in CSS pixels. */
export const TARGET_LINE_WIDTH = 1;

/**
 * Draws the commit-target outline: where the drag would land once its dates are rounded.
 *
 * It has no fill, so the ghost band stays readable underneath it. The dash pattern is reset
 * afterwards, so the rest of the paint is unaffected.
 */
export function drawCommitTarget(
  g: CanvasRenderingContext2D,
  rect: Readonly<GhostRect>,
  stroke: string = GHOST_STROKE,
): void {
  g.strokeStyle = stroke;
  g.lineWidth = TARGET_LINE_WIDTH;
  g.setLineDash([...TARGET_LINE_DASH]);
  g.strokeRect(rect.x, rect.y, rect.width, rect.height);
  g.setLineDash([]);
}

/** Stroke width of the row-drop insertion line, in CSS pixels. */
export const INSERTION_LINE_WIDTH = 2;

/**
 * Draws the row-drop insertion line across the viewport at `y` (viewport-local).
 *
 * The line's left edge is the indent of the depth the drop would commit, the same signifier the
 * grid pane's own indent carries, so the gesture shows *where* and *how deep* at once.
 */
export function drawInsertionLine(
  g: CanvasRenderingContext2D,
  y: number,
  width: number,
  stroke: string = GHOST_STROKE,
  indent = 0,
): void {
  g.strokeStyle = stroke;
  g.lineWidth = INSERTION_LINE_WIDTH;
  g.beginPath();
  g.moveTo(Math.min(indent, width), y);
  g.lineTo(width, y);
  g.stroke();
}
