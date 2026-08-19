// docs/specs/plugins/scheduling.md §5.1 / §5.3
/**
 * Link geometry: where a dependency line attaches to a bar, the right-angled route it takes
 * between two bars, the connector ports beside a bar's ends, and what a point lands on.
 *
 * Pure arithmetic — no canvas, no DOM, no core imports — so every routing rule is unit-testable on
 * its own.
 */
import type { LinkType } from "@stargantt/plugin-data-store";
import { linkAnchors } from "@stargantt/sdk";

/** A rectangle in whatever coordinate space the caller is working in. */
export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** A point in whatever coordinate space the caller is working in. */
export interface Point {
  x: number;
  y: number;
}

/** Which end of a bar a link is attached to. */
export type BarEnd = "start" | "end";

/** How a dependency line is routed between the two bars it connects (§5.3). */
export type RoutingStyle = "elbow" | "straight";

// §5.8 — bar metrics belong to `stargantt.task-bars` and reach this area through
// `TaskBarsService.barRect(id)`. This module therefore owns the link furniture only: routing
// stubs, detours, port discs and hit tolerances; it restates no bar-geometry constant.

/** Horizontal clearance kept between a bar's edge and the first turn of its link line. */
export const STUB = 10;

/** Vertical clearance used when a link has to double back within a single row. */
export const SAME_ROW_DETOUR = 12;

/** How far from the centre line of a link a point still counts as being on it. */
export const LINK_HIT_TOLERANCE = 4;

/** Radius of a connector port disc drawn beside a bar end — the disc is 8 CSS px across. */
export const PORT_RADIUS = 4;

// §5.1 — the gap is 9 CSS px so the 8 px disc (2 × `PORT_RADIUS`) lands wholly outside the bar
// edge, at edge + 9 … edge + 17, clear of the resize handle's hit band inside the bar.
// `PORT_CLEARANCE` is derived from this and `PORT_RADIUS`, never restated, so the two numbers
// cannot drift apart.
/** Gap between a bar's edge and the near side of its connector port. */
export const PORT_GAP = 9;

/**
 * How far outward from a bar's edge the connector port's clearance extends: the gap plus the full
 * disc diameter — 17 CSS px (§5.1).
 *
 * A link's anchors are inset outward by this amount while ports are painted, so a routed line
 * stops tangent to the outer edge of the disc instead of running underneath it: the whole
 * arrowhead then lands outside the disc, where it stays visible even when the line and the port
 * tokens resolve to the same colour. Separation, not z-order, preserves the direction cue.
 */
export const PORT_CLEARANCE = PORT_GAP + PORT_RADIUS * 2;

// §5.1 — the port's hit target is 24×24 CSS px (WCAG 2.5.8), centred on the painted disc;
// `PORT_HIT_SLACK` is the extra reach past the disc's own radius needed to reach a 12 px hit
// radius. It is transparent and may overlap the bar and its label band, but never reaches far
// enough inward to overlap the resize handle's hit band, which lives entirely inside the bar (the
// geometry unit tests assert the two bands stay disjoint).
/** Extra slack around a port disc, so the small target meets the 24×24 CSS px minimum. */
export const PORT_HIT_SLACK = 8;

/** The 24×24 CSS px hit target the two constants above resolve to — asserted, never restated. */
export const PORT_HIT_SIZE = (PORT_RADIUS + PORT_HIT_SLACK) * 2;

/** CSS cursor reported while hovering a dependency line that nothing can do anything with. */
export const LINK_CURSOR = "default";

/** CSS cursor reported while hovering a selectable dependency line (`linkEditing`, §5.4). */
export const LINK_EDIT_CURSOR = "pointer";

/** CSS cursor reported while hovering a connector port. */
export const PORT_CURSOR = "crosshair";

/** The end of the source bar a link of this type leaves from. */
export function sourceEndOf(type: LinkType): BarEnd {
  // §5.2 — the FS/SS/FF/SF end selection is `sdk/cpm`'s shared constraint algebra: "FS"/"FF"
  // leave the source's finish, "SS"/"SF" its start.
  return linkAnchors(type).source;
}

/** The end of the target bar a link of this type arrives at. */
export function targetEndOf(type: LinkType): BarEnd {
  // "FS"/"SS" arrive at the target's start; "FF"/"SF" at its finish.
  return linkAnchors(type).target;
}

/** The link type produced by connecting these two bar ends, source first. */
export function linkTypeFor(source: BarEnd, target: BarEnd): LinkType {
  const s = source === "end" ? "F" : "S";
  const t = target === "start" ? "S" : "F";
  return `${s}${t}` as LinkType;
}

/** The x coordinate at which a link attaches to one end of a bar. */
export function anchorX(box: Rect, end: BarEnd): number {
  return end === "start" ? box.x : box.x + box.width;
}

/** The vertical centre of a bar, where its links attach. */
export function centreY(box: Rect): number {
  return box.y + box.height / 2;
}

/** Drops points that repeat the previous one, so the route has no zero-length segments. */
function compact(points: readonly Point[]): Point[] {
  const out: Point[] = [];
  for (const p of points) {
    const last = out[out.length - 1];
    if (last !== undefined && last.x === p.x && last.y === p.y) continue;
    out.push(p);
  }
  return out;
}

/** The direction a link travels as it leaves its source, `1` rightward and `-1` leftward. */
function outDirection(type: LinkType): 1 | -1 {
  return sourceEndOf(type) === "end" ? 1 : -1;
}

/** The direction a link travels as it arrives at its target, `1` rightward and `-1` leftward. */
function intoDirection(type: LinkType): 1 | -1 {
  return targetEndOf(type) === "start" ? 1 : -1;
}

// §5.3 — the invariant the single-step elbow is built to satisfy, restated as a check over a
// finished polyline so an *adjusted* route can be tested against it too.
/**
 * Whether a route still approaches both of its anchors from the side their stubs name.
 *
 * The first segment must leave the source in the direction that end faces, and the last segment
 * must reach the target travelling in the direction that end faces. A detour that overshoots an
 * anchor breaks this: the closing segment doubles back, crossing the target's own bar, and the
 * arrowhead arrives from the wrong side.
 */
export function approachHolds(points: readonly Point[], type: LinkType): boolean {
  if (points.length < 2) return true;
  const first = points[0];
  const second = points[1];
  const last = points[points.length - 1];
  const beforeLast = points[points.length - 2];
  if (
    first === undefined ||
    second === undefined ||
    last === undefined ||
    beforeLast === undefined
  ) {
    return true;
  }
  const leaves = (second.x - first.x) * outDirection(type) >= 0;
  const arrives = (last.x - beforeLast.x) * intoDirection(type) >= 0;
  return leaves && arrives;
}

// §5.3 — the elbow variant used when the target sits behind the source, and the fallback a broken
// detour is rebuilt as: its middle horizontal runs in the gap between the two rows and is an
// interior segment, so bar avoidance can move it like any other.
/**
 * The six-point "between rows" elbow between two bars: step out of the source, cross over in the
 * gap between the two rows, step back in to the target.
 *
 * `anchorInset` moves both anchors further outward before any other arithmetic, exactly as
 * {@link routeLink} does.
 */
export function betweenRowsRoute(
  source: Rect,
  target: Rect,
  type: LinkType,
  anchorInset = 0,
): Point[] {
  const out = outDirection(type);
  const into = intoDirection(type);
  const sx = anchorX(source, sourceEndOf(type)) + out * anchorInset;
  const sy = centreY(source);
  const tx = anchorX(target, targetEndOf(type)) - into * anchorInset;
  const ty = centreY(target);
  const outX = sx + out * STUB;
  const inX = tx - into * STUB;
  const midY = sy === ty ? sy + SAME_ROW_DETOUR : (sy + ty) / 2;
  return compact([
    { x: sx, y: sy },
    { x: outX, y: sy },
    { x: outX, y: midY },
    { x: inX, y: midY },
    { x: inX, y: ty },
    { x: tx, y: ty },
  ]);
}

/**
 * Builds the route a dependency line takes between two bars, in the given routing style (§5.3).
 *
 * `"elbow"` (the default) produces the right-angled polyline described below. `"straight"` instead
 * returns the two-point segment directly joining the same two anchors — the ports a drag would
 * have connected — with no stub or detour.
 *
 * The returned polyline starts on the source bar's edge and ends on the target bar's edge, each
 * moved further outward by `anchorInset` CSS px first (§5.1) — pass `PORT_CLEARANCE` while
 * connector ports are painted so the route stops clear of the disc, or `0` for the plain bar-edge
 * anchors. In the elbow style every segment is either horizontal or vertical: when the two bars
 * leave enough room the line makes a single step; when the target sits behind the source it
 * detours through the gap between the two rows instead of cutting back across either bar.
 */
export function routeLink(
  source: Rect,
  target: Rect,
  type: LinkType,
  style: RoutingStyle = "elbow",
  anchorInset = 0,
): Point[] {
  const sourceEnd = sourceEndOf(type);
  const targetEnd = targetEndOf(type);
  // Direction the line travels as it leaves the source, and as it arrives at the target — needed
  // up front so the anchors themselves can move outward before any other arithmetic runs.
  const out = outDirection(type);
  const into = intoDirection(type);
  const sx = anchorX(source, sourceEnd) + out * anchorInset;
  const sy = centreY(source);
  const tx = anchorX(target, targetEnd) - into * anchorInset;
  const ty = centreY(target);

  if (style === "straight") {
    return compact([
      { x: sx, y: sy },
      { x: tx, y: ty },
    ]);
  }

  const outX = sx + out * STUB;
  const inX = tx - into * STUB;

  const start: Point = { x: sx, y: sy };
  const finish: Point = { x: tx, y: ty };

  if (out === into) {
    // Both ends face the same way (finish-to-start and start-to-finish links). One vertical run
    // placed past the far anchor keeps the line clear of both bars.
    const channel = out === 1 ? Math.max(outX, inX) : Math.min(outX, inX);
    if ((channel - outX) * out >= 0 && (inX - channel) * into >= 0) {
      return compact([start, { x: channel, y: sy }, { x: channel, y: ty }, finish]);
    }
  } else {
    // The ends face away from each other (start-to-start and finish-to-finish links). The vertical
    // run goes outside both anchors.
    const channel = out === 1 ? Math.max(outX, inX) : Math.min(outX, inX);
    return compact([start, { x: channel, y: sy }, { x: channel, y: ty }, finish]);
  }

  // The target lies behind the source: step out, cross over between the two rows, step back in.
  return betweenRowsRoute(source, target, type, anchorInset);
}

/** The centre of the connector port sitting just outside one end of a bar. */
export function portCentre(box: Rect, end: BarEnd): Point {
  const offset = PORT_GAP + PORT_RADIUS;
  return {
    x: end === "start" ? box.x - offset : box.x + box.width + offset,
    y: centreY(box),
  };
}

/**
 * Which of a bar's two connector ports a point lands on, if either.
 *
 * The target is a circle of diameter `2 * (PORT_RADIUS + PORT_HIT_SLACK)` — 24 CSS px with the
 * published constants (§5.1) — centred on the painted disc, transparent, and free to overlap the
 * bar and its label without either being reserved space.
 */
export function hitPort(box: Rect, x: number, y: number): BarEnd | undefined {
  const reach = PORT_RADIUS + PORT_HIT_SLACK;
  for (const end of ["start", "end"] as const) {
    const c = portCentre(box, end);
    const dx = x - c.x;
    const dy = y - c.y;
    if (dx * dx + dy * dy <= reach * reach) return end;
  }
  return undefined;
}

/** Shortest distance from a point to a line segment. */
function distanceToSegment(a: Point, b: Point, x: number, y: number): number {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const lengthSquared = dx * dx + dy * dy;
  let t = 0;
  if (lengthSquared > 0) {
    t = ((x - a.x) * dx + (y - a.y) * dy) / lengthSquared;
    t = t < 0 ? 0 : t > 1 ? 1 : t;
  }
  const px = a.x + t * dx;
  const py = a.y + t * dy;
  return Math.hypot(x - px, y - py);
}

/** Whether a point is close enough to a routed link to count as being on it. */
export function hitLink(
  points: readonly Point[],
  x: number,
  y: number,
  tolerance = LINK_HIT_TOLERANCE,
): boolean {
  for (let i = 1; i < points.length; i += 1) {
    const a = points[i - 1];
    const b = points[i];
    if (a === undefined || b === undefined) continue;
    if (distanceToSegment(a, b, x, y) <= tolerance) return true;
  }
  return false;
}
