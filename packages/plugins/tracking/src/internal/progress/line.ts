// docs/specs/plugins/tracking.md §2.7 — the order-65 zigzag progress line: pure polyline geometry
// (hostless, unit-testable) plus the `draw(g, viewport)` factory the order-65 `renderer/layers`
// contribution uses. The layer claim itself is registered unconditionally at `wire.ts` (see the
// module doc there); this file only builds the callback, which early-returns while hidden or while
// `view`/`task-bars` do not resolve.
//
// Built on `internal/shared/numbers.ts`'s `clamp`.
import { clamp } from "../shared/numbers";
import { progressPointOf } from "./report";

/** One visible bar the line deflects to, in viewport-local pixels (already the space
 *  `TaskBarsService.visibleBoxes()` reports — never re-derived, per §2.7). */
export interface LineBar {
  /** Bar left edge. */
  x: number;
  /** Bar width. */
  width: number;
  /** Vertical center of the bar's row. */
  cy: number;
  /** The task's dates and progress. */
  start: number;
  end: number;
  progress: number | undefined;
}

export interface LinePoint {
  x: number;
  y: number;
}

/**
 * Computes the progress-line polyline: from the status-date x at the top of the viewport, a
 * horizontal deflection to each bar's progress point (clamped into the bar's horizontal extent),
 * back to the status-date x at the bottom. `tToX` maps time to viewport-local x (content x minus
 * `scrollLeft`, applied by the caller). Bars must be in top-to-bottom order.
 */
export function progressLinePoints(
  bars: readonly LineBar[],
  statusX: number,
  height: number,
  tToX: (t: number) => number,
): LinePoint[] {
  const points: LinePoint[] = [{ x: statusX, y: 0 }];
  for (const bar of bars) {
    const point = progressPointOf(bar.start, bar.end, bar.progress);
    const px = clamp(tToX(point), bar.x, bar.x + bar.width);
    points.push({ x: px, y: bar.cy });
  }
  points.push({ x: statusX, y: height });
  return points;
}

/** Strokes the polyline; the caller owns save/restore and style. */
export function strokePolyline(g: CanvasRenderingContext2D, points: readonly LinePoint[]): void {
  if (points.length < 2) return;
  g.beginPath();
  const head = points[0] as LinePoint;
  g.moveTo(head.x, head.y);
  for (let i = 1; i < points.length; i += 1) {
    const p = points[i] as LinePoint;
    g.lineTo(p.x, p.y);
  }
  g.stroke();
}

/** The theme token this line paints with, and its documented fallback (§2.7). */
export const PROGRESS_LINE_TOKEN = "--sg-progress-line";
export const PROGRESS_LINE_FALLBACK = "#d81b60";

/** The narrow read surfaces this layer needs from `stargantt.task-bars` / `stargantt.timeline`. */
export interface LineBarsReader {
  visibleBoxes(): ReadonlyArray<Readonly<{ id: unknown; x: number; y: number; width: number; height: number }>>;
}
export interface LineTimelineReader {
  tToX(t: number): number;
}

/** What `createProgressLineDraw` needs, all read fresh on every call (never latched — §2.7's
 *  "toggling on/off" and "tracks the current UTC day" both demand it). */
export interface ProgressLineDeps {
  /** Whether the line is currently visible (the live state store, not the static config). */
  visible(): boolean;
  /** The effective status date, tracked live. */
  statusDate(): number;
  bars(): LineBarsReader | undefined;
  timeline(): LineTimelineReader | undefined;
  /** Resolves a task's `start`/`end`/`progress` by the bar box's id. `undefined` skips the bar. */
  taskOf(id: unknown): { start: number; end: number; progress: number | undefined } | undefined;
  /** Theme lookup, `undefined` without `stargantt.theme` composed. */
  themeGet: (() => ((token: string) => string) | undefined) | undefined;
}

/** Builds the order-65 layer's `draw` callback (§2.7). */
export function createProgressLineDraw(deps: ProgressLineDeps): (g: CanvasRenderingContext2D, vp: { scrollLeft: number; height: number }) => void {
  return (g, vp) => {
    if (!deps.visible()) return;
    const bars = deps.bars();
    const timeline = deps.timeline();
    if (bars === undefined || timeline === undefined) return;
    const tToX = (t: number): number => timeline.tToX(t) - vp.scrollLeft;
    const lineBars: LineBar[] = [];
    for (const box of bars.visibleBoxes()) {
      const task = deps.taskOf(box.id);
      if (task === undefined) continue;
      lineBars.push({
        x: box.x,
        width: box.width,
        cy: box.y + box.height / 2,
        start: task.start,
        end: task.end,
        progress: task.progress,
      });
    }
    const points = progressLinePoints(lineBars, tToX(deps.statusDate()), vp.height, tToX);
    g.save();
    const get = deps.themeGet?.();
    g.strokeStyle = (get?.(PROGRESS_LINE_TOKEN) ?? "") || PROGRESS_LINE_FALLBACK;
    g.lineWidth = 1.5;
    strokePolyline(g, points);
    g.restore();
  };
}
