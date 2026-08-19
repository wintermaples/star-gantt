// docs/specs/plugins/interaction.md §3 — the `renderer/layers` contribution claimed at order 70:
// the frame drawn around a selected task bar, and the rubber-band rectangle.
/**
 * Canvas painting for the selection layer.
 *
 * Pure drawing calls against a supplied box, so the visual rule can be unit-tested without a view
 * service or a real canvas.
 */
import type { TaskId } from "@stargantt/plugin-data-store";
import type { TaskBarsService } from "@stargantt/plugin-task-bars";

/** A rectangle in the viewport-local CSS-pixel space a layer contribution paints in. */
export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** CSS custom property that gives the selection frame its colour. */
export const SELECTION_STROKE_TOKEN = "--sg-selection-stroke";

/** Stroke colour used when the theme defines no colour for the selection frame. */
export const SELECTION_STROKE = "#1c1917";

/** Stroke width of the selection frame, in CSS pixels. */
export const SELECTION_LINE_WIDTH = 2;

/** Gap left between the bar's own edge and the frame, in CSS pixels. */
export const SELECTION_OUTSET = 2;

/**
 * Draws the selection frame around one bar's box, in `stroke` or in the built-in colour when no
 * stroke is given.
 *
 * The frame is drawn outside the bar so it never hides the bar's own fill or its progress shading.
 * The caller is responsible for saving and restoring the canvas state around this call.
 */
export function strokeSelectionFrame(
  g: CanvasRenderingContext2D,
  box: Readonly<Rect>,
  stroke: string = SELECTION_STROKE,
): void {
  g.lineWidth = SELECTION_LINE_WIDTH;
  g.strokeStyle = stroke;
  g.strokeRect(
    box.x - SELECTION_OUTSET,
    box.y - SELECTION_OUTSET,
    box.width + SELECTION_OUTSET * 2,
    box.height + SELECTION_OUTSET * 2,
  );
}

/** The bar geometry the frame pass reads, named structurally so it is testable hostlessly. */
export type BarGeometry = Pick<TaskBarsService, "barBoxOf" | "visibleBoxes">;

/**
 * Selection sizes up to this are always painted through per-id geometry lookups.
 *
 * Below it the two strategies cost the same order of work, so the cheaper one — no visible-box
 * array materialized at all — wins; above it, comparing against the visible row count is worth the
 * one array read it takes.
 */
export const DIRECT_LOOKUP_MAX = 32;

/**
 * Draws the frame around every selected bar that is currently on screen.
 *
 * Two strategies: a per-id geometry lookup is O(1), so walking the selection costs O(selection) —
 * fine for a handful of bars, but a select-all over 100k tasks would repeat it 100k times *per
 * frame* while only a screenful can ever be drawn. Past a small threshold the pass walks the
 * visible boxes instead and keeps the ones the selection contains, which is O(visible) whatever the
 * selection size. The painted output is identical either way.
 */
export function paintSelectionFrames(
  g: CanvasRenderingContext2D,
  selected: ReadonlySet<TaskId>,
  geometry: BarGeometry,
  stroke: string = SELECTION_STROKE,
): void {
  if (selected.size === 0) return;
  if (selected.size > DIRECT_LOOKUP_MAX) {
    for (const box of geometry.visibleBoxes()) {
      if (selected.has(box.id)) strokeSelectionFrame(g, box, stroke);
    }
    return;
  }
  for (const id of selected) {
    const box = geometry.barBoxOf(id);
    if (box !== undefined) strokeSelectionFrame(g, box, stroke);
  }
}

/** CSS custom property that gives the rubber-band rectangle its fill colour. */
export const RUBBER_BAND_FILL_TOKEN = "--sg-rubber-band-fill";

/** CSS custom property that gives the rubber-band rectangle its stroke colour. */
export const RUBBER_BAND_STROKE_TOKEN = "--sg-rubber-band-stroke";

/** Fill colour used when the theme defines no colour for the rubber-band rectangle. */
export const RUBBER_BAND_FILL = "rgba(15, 118, 110, 0.12)";

/** Stroke colour used when the theme defines no colour for the rubber-band rectangle. */
export const RUBBER_BAND_STROKE = "#0f766e";

/** Stroke width of the rubber-band rectangle's outline, in CSS pixels. */
export const RUBBER_BAND_LINE_WIDTH = 1;

/**
 * Draws the rubber-band drag rectangle: a translucent fill under a thin outline, in `fill` /
 * `stroke` or in the built-in colours when none are given.
 *
 * The caller is responsible for saving and restoring the canvas state around this call.
 */
export function paintRubberBand(
  g: CanvasRenderingContext2D,
  rect: Readonly<Rect>,
  fill: string = RUBBER_BAND_FILL,
  stroke: string = RUBBER_BAND_STROKE,
): void {
  g.fillStyle = fill;
  g.fillRect(rect.x, rect.y, rect.width, rect.height);
  g.lineWidth = RUBBER_BAND_LINE_WIDTH;
  g.strokeStyle = stroke;
  g.strokeRect(rect.x, rect.y, rect.width, rect.height);
}
