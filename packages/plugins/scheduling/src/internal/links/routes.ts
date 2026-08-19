// docs/specs/plugins/scheduling.md §5.3 / §5.8
/**
 * Which dependency lines are on screen, and where each of them runs.
 *
 * This module owns the whole chain from "what does the viewport cover" to "here is the routed
 * polyline of every visible link", including the memo that keeps the answer stable while nothing
 * moves. It reads the chart through narrow, structurally-typed slices of the real services, so the
 * routing can be exercised without booting a host: pass plain objects with the few methods below.
 *
 * Coordinates are *content* coordinates throughout (scroll-independent, x = 0 at the timeline
 * origin, y = 0 at the top of the first row) — the space `TaskBarsService.barRect` answers in. The
 * viewport offsets are subtracted once, at paint and hit time, by `toViewport`.
 */
import type { DataService, Link, LinkId, Task, TaskId } from "@stargantt/plugin-data-store";
// Type-only: the row-geometry service and the viewport shape, so the slices below cannot drift
// from the real service signatures (never a hand-copied restatement).
import type { RowsService } from "@stargantt/plugin-tree-grid";
import type { Viewport } from "@stargantt/plugin-view";
import { AVOID_MARGIN, adjustRoute } from "./avoid";
import type { Point, Rect, RoutingStyle } from "./geometry";
import { approachHolds, betweenRowsRoute, routeLink } from "./geometry";

// §5.8 — a bar's box is computed in exactly one place, task-bars' geometry service. This module
// never re-derives it; it asks for it.
/** Looks up a task's bar box in content coordinates, as `TaskBarsService.barRect` does. */
export type BarRectLookup = (id: TaskId) => Rect | undefined;

/** The row geometry this module reads: the visible row band, and which task each row carries. */
export type RowSlice = Pick<RowsService, "rowCount" | "rowAtY" | "yOf" | "rowHeight" | "taskIdAt">;

/** The store reads this module makes: the link table, and the task behind a row. */
export type DataSlice = Pick<DataService, "query" | "getTask">;

/** The viewport fields a route list depends on. */
export type ViewportSlice = Pick<Viewport, "scrollLeft" | "scrollTop" | "height">;

/** A visible link together with its routed polyline, in content coordinates. */
export interface RoutedLink {
  link: Link;
  route: Point[];
  /**
   * The route's horizontal extent in content coordinates, so a paint pass can skip a line that
   * lies wholly outside the viewport's horizontal window (§5.3, `cullLines`) without walking its
   * points again.
   */
  minX: number;
  maxX: number;
}

// §5.3 — horizontal paint culling: a route wholly outside the viewport's horizontal window, padded
// by the arrowhead reach, paints nothing visible and is skipped. Purely an optimization; it can
// never change a pixel.
/** Padding added to the horizontal cull window, covering arrowhead and stroke overhang. */
export const CULL_PAD = 8;

/**
 * Whether any part of a routed link's horizontal extent falls inside the viewport window.
 *
 * A non-positive viewport width means the width is not (yet) known — e.g. before the first layout
 * — and culling against it would hide everything, so such a viewport culls nothing.
 */
export function inHorizontalView(
  entry: Pick<RoutedLink, "minX" | "maxX">,
  vp: Pick<Viewport, "scrollLeft" | "width">,
): boolean {
  if (!(vp.width > 0)) return true;
  return entry.maxX >= vp.scrollLeft - CULL_PAD && entry.minX <= vp.scrollLeft + vp.width + CULL_PAD;
}

/** The task whose row band contains a content-space y, together with its bar box. */
export interface TaskAtY {
  task: Readonly<Task>;
  box: Rect;
}

/** How a route index measures the chart it indexes. */
export interface RouteIndexOptions {
  rows: RowSlice;
  data: DataSlice;
  barRect: BarRectLookup;
  /** How each link is routed between its two bars (§5.3). */
  routingStyle: RoutingStyle;
  /**
   * How far outward from each bar edge a route's anchors are moved before routing (§5.1): the port
   * clearance while connector ports are painted, `0` otherwise.
   */
  anchorInset: number;
  /**
   * Whether elbow routes detour around task bars that lie between a link's two ends (§5.3).
   * `false` keeps every route exactly as `routeLink` builds it.
   */
  avoidBars?: boolean;
}

// §5.3 — the between-rows rebuild needs somewhere to put its middle horizontal; when the two bar
// boxes are closer than twice the avoid margin there is no such place, so the route degrades
// instead.
/**
 * Vertical distance between two bar boxes: from the bottom edge of the upper one to the top edge
 * of the lower one. Negative when the two overlap vertically.
 */
export function rowGap(a: Rect, b: Rect): number {
  return a.y <= b.y ? b.y - (a.y + a.height) : a.y - (b.y + b.height);
}

/** Content coordinates to the viewport-local space the layers paint in. */
export function toViewport(p: Point, vp: ViewportSlice): Point {
  return { x: p.x - vp.scrollLeft, y: p.y - vp.scrollTop };
}

/**
 * The inputs a routed-link list is a function of.
 *
 * `revision` counts every change that can move a line: the tasks' dates, which row each task
 * occupies and how tall it is, and the time axis' scale and origin — the three store subscriptions
 * of §5.8. `scrollTop` and `height` select *which* rows are visible. Horizontal scrolling is
 * deliberately absent: routes are content coordinates, so `scrollLeft` cannot change them.
 */
interface RouteKey {
  revision: number;
  scrollTop: number;
  height: number;
}

function sameKey(a: RouteKey, b: RouteKey): boolean {
  // Plain `===` on each field, so a NaN viewport measurement never counts as a hit.
  return a.revision === b.revision && a.scrollTop === b.scrollTop && a.height === b.height;
}

/** The visible-link geometry of one chart, with its routes memoized against what can move them. */
export interface RouteIndex {
  /** The row range the viewport covers, as an inclusive `[first, last]` pair of row indexes. */
  visibleRows(vp: ViewportSlice): { first: number; last: number } | undefined;
  /** The task whose row band contains a content-space y, together with its bar box. */
  taskAtY(contentY: number): TaskAtY | undefined;
  /**
   * Every visible link with its routed polyline, reusing the previous result when nothing has
   * moved.
   *
   * Both the line layer and the hit test need exactly this list, and the hit test runs on frames
   * where nothing repaints, so without the memo a pointer resting over the chart would rebuild
   * every visible route on every frame.
   */
  routedLinks(vp: ViewportSlice): readonly RoutedLink[];
  /**
   * Expires the memo: something that fixes a route has changed. Called for a data change, a row
   * change and a zoom change — the three things that move a line (§5.8).
   */
  invalidate(): void;
}

// §5.3 — the obstacles a detouring route steers around: the bars of the rows its vertical span
// crosses, excluding its own two ends. A span crossing more than this many rows ABORTS the
// collection (the route falls back to the plain, unadjusted output) rather than truncating the
// obstacle set, so one link spanning the whole chart cannot make routing O(rows).
/** Row-span cap of the obstacle walk; a wider span collects nothing at all. */
export const OBSTACLE_ROW_CAP = 64;

/** Builds the route index for one chart. */
export function createRouteIndex(options: RouteIndexOptions): RouteIndex {
  const { rows, data, barRect, routingStyle, anchorInset } = options;
  const avoidBars = options.avoidBars === true;

  function obstaclesFor(route: readonly Point[], link: Link): Rect[] {
    let minY = Infinity;
    let maxY = -Infinity;
    for (const p of route) {
      if (p.y < minY) minY = p.y;
      if (p.y > maxY) maxY = p.y;
    }
    if (!(minY <= maxY)) return [];
    const first = rows.rowAtY(Math.max(0, minY));
    const last = rows.rowAtY(maxY);
    if (last - first > OBSTACLE_ROW_CAP) return [];
    const out: Rect[] = [];
    for (let row = first; row <= last; row += 1) {
      const id = rows.taskIdAt(row);
      if (id === undefined || id === link.sourceId || id === link.targetId) continue;
      const box = barRect(id);
      if (box !== undefined) out.push(box);
    }
    return out;
  }

  let revision = 0;
  let memo: { key: RouteKey; value: readonly RoutedLink[] } | null = null;

  function visibleRows(vp: ViewportSlice): { first: number; last: number } | undefined {
    const count = rows.rowCount();
    if (count === 0 || vp.height <= 0) return undefined;
    const first = rows.rowAtY(vp.scrollTop);
    const last = Math.min(count - 1, rows.rowAtY(vp.scrollTop + vp.height));
    return first > last ? undefined : { first, last };
  }

  function taskAtY(contentY: number): TaskAtY | undefined {
    const count = rows.rowCount();
    if (count === 0) return undefined;
    if (!(contentY >= 0)) return undefined; // also catches NaN
    const row = rows.rowAtY(contentY);
    const top = rows.yOf(row);
    const height = rows.rowHeight(row);
    // `rowAtY` clamps to the last row, so a point past the end of the content would otherwise be
    // attributed to it.
    if (contentY < top || contentY >= top + height) return undefined;
    const id = rows.taskIdAt(row);
    if (id === undefined) return undefined;
    const task = data.getTask(id);
    if (task === undefined) return undefined;
    const box = barRect(id);
    if (box === undefined) return undefined;
    return { task, box };
  }

  /**
   * Every link with at least one end on a visible row, each listed once.
   *
   * Walking the visible rows rather than the whole link table keeps the cost proportional to what
   * is on screen, which is what the row-direction division buys everywhere else.
   */
  function visibleLinks(vp: ViewportSlice): Link[] {
    const range = visibleRows(vp);
    if (range === undefined) return [];
    const view = data.query();
    const seen = new Set<LinkId>();
    const out: Link[] = [];
    for (let row = range.first; row <= range.last; row += 1) {
      const id = rows.taskIdAt(row);
      if (id === undefined) continue;
      const entry = view.linksByTask.get(id);
      if (entry === undefined) continue;
      for (const link of entry.out) {
        if (seen.has(link.id)) continue;
        seen.add(link.id);
        out.push(link);
      }
      for (const link of entry.in) {
        if (seen.has(link.id)) continue;
        seen.add(link.id);
        out.push(link);
      }
    }
    return out;
  }

  /** The routed polyline of a link, in content coordinates, if both its ends have a bar box. */
  function routeOf(link: Link): Point[] | undefined {
    const source = barRect(link.sourceId);
    if (source === undefined) return undefined;
    const target = barRect(link.targetId);
    if (target === undefined) return undefined;
    // §5.1 — the inset applies whenever `allowLinkCreate` is on, regardless of which rows actually
    // paint their discs, so a route never shifts as a row scrolls in or out. Only an
    // `allowLinkCreate: false` composition drops the inset.
    const route = routeLink(source, target, link.type, routingStyle, anchorInset);
    // §5.3 — bar avoidance applies to elbow routes only: a straight route has no interior segments
    // an orthogonal detour could move.
    if (!avoidBars || routingStyle !== "elbow") return route;
    const obstacles = obstaclesFor(route, link);
    const adjusted = adjustRoute(route, obstacles);
    // §5.3 — a detour that overshoots an anchor makes the closing segment double back across the
    // target's own bar, with the arrowhead arriving from the wrong side. Rebuild such a route as
    // the between-rows form and adjust that instead; degrade to the plain route when even that
    // does not hold, or when the row gap is too narrow (under twice the margin) to hold the
    // rebuild's middle horizontal.
    if (approachHolds(adjusted, link.type)) return adjusted;
    if (rowGap(source, target) < 2 * AVOID_MARGIN) return route;
    const rebuilt = betweenRowsRoute(source, target, link.type, anchorInset);
    // The same obstacle set, deliberately: the rebuild answers the same question about the same
    // bars, and re-collecting it against the new vertical span would let the fallback steer around
    // rows the first attempt was allowed to cross.
    const readjusted = adjustRoute(rebuilt, obstacles);
    return approachHolds(readjusted, link.type) ? readjusted : route;
  }

  return {
    visibleRows,
    taskAtY,
    routedLinks(vp: ViewportSlice): readonly RoutedLink[] {
      const key: RouteKey = { revision, scrollTop: vp.scrollTop, height: vp.height };
      if (memo !== null && sameKey(memo.key, key)) return memo.value;
      const out: RoutedLink[] = [];
      for (const link of visibleLinks(vp)) {
        const route = routeOf(link);
        if (route === undefined) continue;
        let minX = Infinity;
        let maxX = -Infinity;
        for (const p of route) {
          if (p.x < minX) minX = p.x;
          if (p.x > maxX) maxX = p.x;
        }
        out.push({ link, route, minX, maxX });
      }
      memo = { key, value: out };
      return out;
    },
    invalidate(): void {
      revision += 1;
    },
  };
}

/**
 * The row slice used when no row model is composed (`stargantt.rows` is an optional edge, §14):
 * zero rows, so every visible-row walk and every `taskAtY` answers empty and the port pass, the
 * line pass and the drop resolution all stay inert without a branch anywhere else.
 */
export const NO_ROWS: RowSlice = {
  rowCount: () => 0,
  taskIdAt: () => undefined,
  rowHeight: () => 0,
  yOf: () => 0,
  rowAtY: () => 0,
};
