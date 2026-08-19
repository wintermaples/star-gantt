// docs/specs/plugins/scheduling.md §5.3 (theme tokens) / §5.5 (drop ring)
/**
 * Canvas painting for the links area: the dependency line with its arrowhead, the connector ports
 * beside each bar end, the drop-candidate ring, and the rubber band shown while a new link is
 * being drawn.
 *
 * Geometry is decided by `./geometry`; this module only issues drawing calls.
 */
import type { Point } from "./geometry";
import { PORT_RADIUS } from "./geometry";

// §5.3 — CSS custom properties are the single source of truth for colour. Every token is read at
// paint time with `theme.get(token) || FALLBACK`, so the fallback applies both when the token
// resolves to the empty string and when no theme is reachable. Line width and arrowhead geometry
// stay plain constants: the token layer covers colour only.

/** CSS custom property holding the colour of a dependency line and its arrowhead. */
export const LINK_LINE_TOKEN = "--sg-link-line";

/** CSS custom property holding the fill of a connector port disc. */
export const LINK_PORT_TOKEN = "--sg-link-port";

/** CSS custom property holding the colour of the link-creation rubber band and drop ring. */
export const LINK_BAND_TOKEN = "--sg-link-band";

/** CSS custom property holding the colour of a hovered or path-highlighted dependency line. */
export const LINK_EMPHASIS_TOKEN = "--sg-link-emphasis";

/** CSS custom property holding the colour of a driving dependency line. */
export const LINK_DRIVING_TOKEN = "--sg-link-driving";

/** Stroke of a dependency line and its arrowhead when `--sg-link-line` is unavailable. */
export const LINK_COLOR = "#78716c";

/** Stroke width of a dependency line, in CSS pixels. */
export const LINK_WIDTH = 1.5;

/** Fill of a connector port disc when `--sg-link-port` is unavailable. */
export const PORT_COLOR = "#78716c";

/** Stroke of the link-drag rubber band, and of the selected line, when `--sg-link-band` is unset. */
export const BAND_COLOR = "#0f766e";

// §5.3 — the emphasis and driving fallbacks are deliberately distinct from the band colour, so an
// emphasized line never reads as a selected one. The line and port tokens stay separate even
// though their fallbacks coincide: a host may tint the interactive ports without restyling the
// arrows.
/** Stroke of an emphasized dependency line when `--sg-link-emphasis` is unavailable. */
export const EMPHASIS_COLOR = "#1d4ed8";

/** Stroke of a driving dependency line when `--sg-link-driving` is unavailable. */
export const DRIVING_COLOR = "#44403c";

/** Length of the arrowhead along the line's direction of travel, in CSS pixels. */
export const ARROW_LENGTH = 7;

/** Half-width of the arrowhead across the line's direction of travel, in CSS pixels. */
export const ARROW_HALF_WIDTH = 4;

/** Draws the filled arrowhead that terminates a dependency line. */
function drawArrowHead(g: CanvasRenderingContext2D, from: Point, tip: Point): void {
  const dx = tip.x - from.x;
  const dy = tip.y - from.y;
  const length = Math.hypot(dx, dy);
  if (length === 0) return;
  const ux = dx / length;
  const uy = dy / length;
  const baseX = tip.x - ux * ARROW_LENGTH;
  const baseY = tip.y - uy * ARROW_LENGTH;
  g.beginPath();
  g.moveTo(tip.x, tip.y);
  g.lineTo(baseX - uy * ARROW_HALF_WIDTH, baseY + ux * ARROW_HALF_WIDTH);
  g.lineTo(baseX + uy * ARROW_HALF_WIDTH, baseY - ux * ARROW_HALF_WIDTH);
  g.closePath();
  g.fill();
}

/** Draws the open (stroked, unfilled) variant of the arrowhead. */
function drawOpenArrowHead(g: CanvasRenderingContext2D, from: Point, tip: Point): void {
  const dx = tip.x - from.x;
  const dy = tip.y - from.y;
  const length = Math.hypot(dx, dy);
  if (length === 0) return;
  const ux = dx / length;
  const uy = dy / length;
  const baseX = tip.x - ux * ARROW_LENGTH;
  const baseY = tip.y - uy * ARROW_LENGTH;
  g.beginPath();
  g.moveTo(baseX - uy * ARROW_HALF_WIDTH, baseY + ux * ARROW_HALF_WIDTH);
  g.lineTo(tip.x, tip.y);
  g.lineTo(baseX + uy * ARROW_HALF_WIDTH, baseY - ux * ARROW_HALF_WIDTH);
  g.stroke();
}

/** How one dependency line is stroked; omitted fields keep the built-in look. */
export interface LinkStrokeOptions {
  /** Stroke width in CSS px; defaults to `LINK_WIDTH`. */
  width?: number;
  /** Canvas dash pattern; defaults to solid. */
  dash?: readonly number[] | undefined;
  /** Arrowhead shape; defaults to `"filled"`. */
  arrowHead?: "filled" | "open" | "none";
}

/**
 * Draws one routed dependency line: the polyline itself, then an arrowhead pointing into the
 * target bar, in `color`. Line and arrowhead are one visual object and share the one colour —
 * `--sg-link-line` covers the whole arrow, head included (§5.3). Routes with fewer than two points
 * are ignored. `options` restyles the stroke; every omitted field keeps the built-in look.
 */
export function drawLink(
  g: CanvasRenderingContext2D,
  points: readonly Point[],
  color: string = LINK_COLOR,
  options: LinkStrokeOptions = {},
): void {
  if (points.length < 2) return;
  const first = points[0];
  const tip = points[points.length - 1];
  const before = points[points.length - 2];
  if (first === undefined || tip === undefined || before === undefined) return;
  const dash = options.dash ?? [];
  g.strokeStyle = color;
  g.lineWidth = options.width ?? LINK_WIDTH;
  if (dash.length > 0) g.setLineDash(dash as number[]);
  g.beginPath();
  g.moveTo(first.x, first.y);
  for (let i = 1; i < points.length; i += 1) {
    const p = points[i];
    if (p === undefined) continue;
    g.lineTo(p.x, p.y);
  }
  g.stroke();
  const arrowHead = options.arrowHead ?? "filled";
  if (arrowHead === "filled") {
    if (dash.length > 0) g.setLineDash([]);
    g.fillStyle = color;
    drawArrowHead(g, before, tip);
  } else if (arrowHead === "open") {
    if (dash.length > 0) g.setLineDash([]);
    drawOpenArrowHead(g, before, tip);
  } else if (dash.length > 0) {
    g.setLineDash([]);
  }
}

/** Draws one connector port disc, in `color` or in the built-in colour when that is omitted. */
export function drawPort(
  g: CanvasRenderingContext2D,
  centre: Point,
  color: string = PORT_COLOR,
): void {
  g.fillStyle = color;
  g.beginPath();
  g.arc(centre.x, centre.y, PORT_RADIUS, 0, Math.PI * 2);
  g.closePath();
  g.fill();
}

/** Radius of the drop-candidate highlight ring: 3 CSS px outside the disc (§5.5). */
export const PORT_RING_RADIUS = PORT_RADIUS + 3;

/** Stroke width of the drop-candidate highlight ring, in CSS px. */
export const PORT_RING_WIDTH = 2;

// §5.5 — the drop-candidate ring: stroked, wider than the disc, drawn in the rubber-band colour so
// the guided end reads as part of the in-flight gesture. The extra radius is a shape change, not
// just a colour one, so the cue stays visible when the band and port colours coincide.
/** Draws the highlight ring around the connector port a drag could drop onto. */
export function drawPortRing(g: CanvasRenderingContext2D, centre: Point, color: string): void {
  g.strokeStyle = color;
  g.lineWidth = PORT_RING_WIDTH;
  g.beginPath();
  g.arc(centre.x, centre.y, PORT_RING_RADIUS, 0, Math.PI * 2);
  g.stroke();
}

/**
 * Draws the straight rubber band that follows the pointer while a new link is being drawn, in
 * `color` or in the built-in colour when that is omitted. The band carries the same arrowhead the
 * finished line will, so the direction of the pending link is legible mid-gesture.
 */
export function drawBand(
  g: CanvasRenderingContext2D,
  from: Point,
  to: Point,
  color: string = BAND_COLOR,
): void {
  g.strokeStyle = color;
  g.lineWidth = LINK_WIDTH;
  g.beginPath();
  g.moveTo(from.x, from.y);
  g.lineTo(to.x, to.y);
  g.stroke();
  g.fillStyle = color;
  drawArrowHead(g, from, to);
}
