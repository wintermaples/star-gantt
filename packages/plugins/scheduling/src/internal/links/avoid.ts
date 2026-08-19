// docs/specs/plugins/scheduling.md §5.3 (`avoidBars`)
/**
 * Obstacle avoidance for elbow-routed dependency lines: nudging the interior segments of an
 * orthogonal polyline off any task bar they would otherwise cross.
 *
 * Best-effort and bounded: each pass moves every colliding interior segment to just past the
 * nearest side of the bar it crosses, and the adjustment stops after a fixed number of passes, so
 * a pathological layout degrades to the unadjusted route rather than looping. The route's two
 * anchor points never move, so the arrowhead's approach is untouched.
 *
 * Pure arithmetic — no canvas, no services — so the detour rules are unit-testable without a host.
 */
import type { Point, Rect } from "./geometry";

/** Clearance kept between a detoured segment and the bar it avoids, in CSS px. */
export const AVOID_MARGIN = 4;

/** Upper bound on adjustment passes, so intersecting obstacles cannot make this loop. */
export const MAX_PASSES = 3;

function overlaps(lo: number, hi: number, rLo: number, rHi: number): boolean {
  return hi > rLo && lo < rHi;
}

/** One coordinate of a rectangle: its low edge (`x`/`y`) and its high edge (plus width/height). */
type Coord = "x" | "y";

function rectLow(r: Rect, axis: Coord): number {
  return axis === "x" ? r.x : r.y;
}

function rectHigh(r: Rect, axis: Coord): number {
  return axis === "x" ? r.x + r.width : r.y + r.height;
}

/**
 * A copy-on-write view of a route: reads fall through to the original points until the first
 * write, which clones them. A route with no collision therefore comes back with its identity
 * intact.
 */
interface RouteBuffer {
  at(i: number): Point;
  move(i: number, axis: Coord, value: number): void;
  result(): Point[];
}

function routeBuffer(points: readonly Point[]): RouteBuffer {
  let out: Point[] | null = null;
  return {
    at: (i) => (out ?? (points as Point[]))[i] as Point,
    move(i, axis, value) {
      out ??= points.map((p) => ({ ...p }));
      (out[i] as Point)[axis] = value;
    },
    result: () => out ?? (points as Point[]),
  };
}

/**
 * Shifts segment `(i, i+1)` off every obstacle it crosses, along `shift` — the coordinate both its
 * endpoints share — while `span` is the coordinate it runs along. The span range is fixed for the
 * whole scan; the shift coordinate is re-read per obstacle because an earlier one may have moved
 * it. Returns whether the segment moved.
 */
function nudgeSegment(
  route: RouteBuffer,
  i: number,
  obstacles: readonly Rect[],
  shift: Coord,
  span: Coord,
): boolean {
  const lo = Math.min(route.at(i)[span], route.at(i + 1)[span]);
  const hi = Math.max(route.at(i)[span], route.at(i + 1)[span]);
  let moved = false;
  for (const r of obstacles) {
    if (!overlaps(lo, hi, rectLow(r, span), rectHigh(r, span))) continue;
    const current = route.at(i)[shift];
    const before = rectLow(r, shift) - AVOID_MARGIN;
    const after = rectHigh(r, shift) + AVOID_MARGIN;
    if (current <= before || current >= after) continue;
    const to = Math.abs(current - before) <= Math.abs(current - after) ? before : after;
    route.move(i, shift, to);
    route.move(i + 1, shift, to);
    moved = true;
  }
  return moved;
}

/**
 * Returns a copy of an orthogonal route whose interior segments have been nudged off the given
 * obstacle rectangles, where possible.
 *
 * Only segments whose endpoints are both interior (neither the first nor the last route point) are
 * moved: a horizontal segment crossing a bar is shifted above or below it, whichever is nearer,
 * and a vertical segment is shifted left or right likewise, each by `AVOID_MARGIN` past the bar's
 * edge. Segments touching an anchor stay put, so the line still meets both bars where the ports
 * expect it. Routes with no collision are returned as-is (same array identity).
 */
export function adjustRoute(points: readonly Point[], obstacles: readonly Rect[]): Point[] {
  if (points.length < 4 || obstacles.length === 0) return points as Point[];
  const route = routeBuffer(points);

  for (let pass = 0; pass < MAX_PASSES; pass += 1) {
    let moved = false;
    // Segment (i, i+1) is movable when both endpoints are interior points.
    for (let i = 1; i + 1 <= points.length - 2; i += 1) {
      const a = route.at(i);
      const b = route.at(i + 1);
      // A horizontal segment shifts its y off the bar it crosses, a vertical one its x.
      if (a.y === b.y) moved = nudgeSegment(route, i, obstacles, "y", "x") || moved;
      else if (a.x === b.x) moved = nudgeSegment(route, i, obstacles, "x", "y") || moved;
    }
    if (!moved) break;
  }
  return route.result();
}
