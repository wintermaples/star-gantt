// docs/specs/plugins/a11y.md § Extension points — the contributed focus box.
/**
 * The focus box: this plugin's own `renderer/layers` contribution, a stroke-only rectangle drawn
 * just outside the focused task's bar.
 *
 * Nothing here touches the host — the layer reads the focus state and the bar geometry through the
 * callbacks it is built with, so the paint decision is unit-testable without a composed chart.
 */
import type { TaskId } from "@stargantt/plugin-data-store";
import type { BarBox } from "@stargantt/plugin-task-bars";
import type { LayerContribution } from "@stargantt/plugin-view";

// docs/specs/render-order.md — bars 60 → selection frame 70 → **focus box 75** → bar decorations
// 80 → drag preview 100. The box paints over the bars and the selection frame it is deliberately
// distinguished from, under the decoration band, and stays on the same canvas (below the 100
// threshold that moves a contribution to the overlay canvas).
/** The `renderer/layers` order key this plugin claims. */
export const FOCUS_LAYER_ID = "stargantt.a11y:focus";
/** Paint order of the focus box among all `renderer/layers` contributions (main canvas). */
export const FOCUS_LAYER_Z_INDEX = 75;

// CSS custom properties are the single source of truth for colour; the built-in fallback is the
// theme registry's own light-mode default for the token, kept in sync by hand, so a chart whose
// theme layer resolves the token to "" still paints a visible box.
export const FOCUS_STROKE_TOKEN = "--sg-focus-stroke";
export const FOCUS_STROKE_FALLBACK = "#0f766e";
const FOCUS_LINE_WIDTH = 2;
const FOCUS_OUTSET = 2;

/** Draws the stroke-only focus box around `box`, outside its edges so the bar's own fill shows. */
export function strokeFocusBox(
  g: CanvasRenderingContext2D,
  box: Readonly<BarBox>,
  stroke: string,
): void {
  g.lineWidth = FOCUS_LINE_WIDTH;
  g.strokeStyle = stroke;
  g.strokeRect(
    box.x - FOCUS_OUTSET,
    box.y - FOCUS_OUTSET,
    box.width + FOCUS_OUTSET * 2,
    box.height + FOCUS_OUTSET * 2,
  );
}

export interface FocusLayerDeps {
  /** Whether the roving focus has been placed by real interaction. */
  focusPlaced(): boolean;
  /** Whether the DOM focus currently rests on a mirrored row. */
  focusVisible(): boolean;
  /** The focused task, or `undefined` while no row holds the focus. */
  focusedId(): TaskId | undefined;
  /** The bar geometry of the latest composite, or `undefined` when that bar is not drawn. */
  barBoxOf(id: TaskId): Readonly<BarBox> | undefined;
  /** The stroke colour: the theme token when it resolves, the built-in fallback otherwise. */
  stroke(): string;
}

/** Builds the `renderer/layers` contribution that paints the focus box. */
export function createFocusLayer(deps: FocusLayerDeps): LayerContribution {
  return {
    id: FOCUS_LAYER_ID,
    zIndex: FOCUS_LAYER_Z_INDEX,
    draw(g): void {
      // The box paints only once the focus has actually been placed by real interaction (keyboard
      // movement or an explicit `FocusService.focus` call) — never for the row-0 fallback the
      // mirror keeps internally so the roving tabindex always has somewhere to land. Gating on
      // `focusedId()` alone would stroke a box around row 0 on the very first composite of any
      // default-configured chart. DOM focus resting on a mirror row is a placement for visual
      // purposes, so tabbing into the widget paints the box even before any effective placement.
      if (!deps.focusPlaced() && !deps.focusVisible()) return;
      const id = deps.focusedId();
      if (id === undefined) return;
      // The geometry service reports only visible bars from the latest composite; a focused task
      // whose bar is not currently drawn (collapsed ancestor, scrolled away, unknown id) yields
      // `undefined` and the box paints nothing.
      const box = deps.barBoxOf(id);
      if (box === undefined) return;
      strokeFocusBox(g, box, deps.stroke());
    },
  };
}
