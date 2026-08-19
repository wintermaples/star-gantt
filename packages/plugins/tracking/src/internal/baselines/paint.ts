// docs/specs/plugins/tracking.md §2.3/§2.4/§3.2 — the two `renderer/layers` draws (order 50
// baseline bars, order 62 actual bars + baseline critical-path rings) and the `taskbars/overlays`
// slip-indicator contribution. The drawing primitives keep their geometry unchanged; the per-pass
// assembly follows this package's `TaskBarsService`-first discipline (§2.7's "read from
// `TaskBarsService.visibleBoxes()` — never re-derived" rule):
//
//   - order-50 baseline underlay: needs the row BAND geometry (top/height) the "under" style's
//     thin bottom-of-row bar is measured against — data `TaskBarsService.barRect`'s already-inset
//     bar box cannot supply (task-bars insets a bar a fixed padding inside its row). This is
//     exactly the pass §8 names `stargantt.rows` as an optional late lookup for ("visible-row walks
//     for the baseline underlay"), so it walks visible rows via `sdk/frame`'s `forEachVisibleRow`
//     over the (optional) rows service, mirroring
//     `@stargantt/plugin-scheduling`'s critical-path float layer (`internal/critical-path/paint.ts`,
///    `createFloatLayer`). Inert (draws nothing) when `rows` is not composed, per §8: "absent, that
//     pass is inert".
//   - order-62 actuals + CP rings: paints entirely within each task's OWN current bar band, which
//     `TaskBarsService.visibleBoxes()` already reports pre-computed and viewport-local (in
//     top-to-bottom row order, visible rows only) — no row walk, no `barRect` call needed here.
//   - `taskbars/overlays` slip indicator: receives its bar box directly per call (the extension
//     point's own contract), needing no geometry service at all.
import { forEachVisibleRow } from "@stargantt/sdk";
import type { Task, TaskId } from "@stargantt/plugin-data-store";
import type { BarBox, BarOverlayRenderer, TaskBarsService } from "@stargantt/plugin-task-bars";
import type { RowsService } from "@stargantt/plugin-tree-grid";
import type { ThemeService, TimelineService, Viewport } from "@stargantt/plugin-view";
import type { Baseline, BaselineId, CriticalPathDelta } from "../../types";
import { actualDatesOf } from "./set";

/* ==================================================================== *
 * Drawing primitives (§3.2–§3.4, §3.6 geometry)
 * ==================================================================== */

/** The geometry a per-bar helper receives: the bar's box in viewport-local CSS px. */
interface Box {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** Thickness of the thin "under" baseline bar: 15% of the row band, clamped to 2–4 px. */
export function underBarHeight(rowHeight: number): number {
  return Math.max(2, Math.min(4, Math.floor(rowHeight * 0.15)));
}

/**
 * The viewport-local span a baseline bar occupies, clamped one pixel past each edge so a partly
 * visible bar still paints its edge. `undefined` when the span lies entirely outside the viewport
 * or is degenerate.
 */
export function visibleSpan(
  from: number,
  to: number,
  viewWidth: number,
): { x1: number; x2: number } | undefined {
  const x1 = Math.max(-1, from);
  const x2 = Math.min(viewWidth + 1, to);
  if (x2 <= 0 || x1 >= viewWidth || x2 <= x1) return undefined;
  return { x1, x2 };
}

/**
 * The thin baseline bar of the default `"under"` style, along the bottom edge of the row band.
 * `x1`/`x2` may lie outside the viewport; the caller clips horizontally, this helper only guards
 * degenerate spans.
 */
export function drawUnderBar(
  g: CanvasRenderingContext2D,
  x1: number,
  x2: number,
  rowTop: number,
  rowHeight: number,
  color: string,
): void {
  if (!(x2 > x1) || !(rowHeight > 0)) return;
  const h = underBarHeight(rowHeight);
  g.fillStyle = color;
  g.fillRect(x1, rowTop + rowHeight - h - 1, x2 - x1, h);
}

/** The translucent baseline rect of the `"overlay"` style, over the task's current bar band. */
export function drawOverlayBar(
  g: CanvasRenderingContext2D,
  x1: number,
  x2: number,
  barY: number,
  barHeight: number,
  fill: string,
  stroke: string,
): void {
  if (!(x2 > x1) || !(barHeight > 0)) return;
  g.fillStyle = fill;
  g.fillRect(x1, barY, x2 - x1, barHeight);
  g.strokeStyle = stroke;
  g.lineWidth = 1;
  g.strokeRect(x1 + 0.5, barY + 0.5, x2 - x1 - 1, barHeight - 1);
}

/** A small diamond marking a milestone position; outlined for baselines, filled for actuals. */
export function drawDiamond(
  g: CanvasRenderingContext2D,
  cx: number,
  cy: number,
  radius: number,
  color: string,
  filled: boolean,
): void {
  if (!(radius > 0)) return;
  g.beginPath();
  g.moveTo(cx, cy - radius);
  g.lineTo(cx + radius, cy);
  g.lineTo(cx, cy + radius);
  g.lineTo(cx - radius, cy);
  g.closePath();
  if (filled) {
    g.fillStyle = color;
    g.fill();
  } else {
    g.strokeStyle = color;
    g.lineWidth = 1;
    g.stroke();
  }
}

/** The actual bar: a centered stripe (30% of the bar height, minimum 2 px) inside the bar band. */
export function drawActualBar(
  g: CanvasRenderingContext2D,
  x1: number,
  x2: number,
  barY: number,
  barHeight: number,
  color: string,
): void {
  if (!(x2 > x1) || !(barHeight > 0)) return;
  const h = Math.max(2, Math.round(barHeight * 0.3));
  const y = barY + (barHeight - h) / 2;
  g.fillStyle = color;
  g.fillRect(x1, y, x2 - x1, h);
}

/** A 2 px ring around a bar box: solid for CP-added tasks, dashed for CP-removed ones. */
export function drawCpRing(
  g: CanvasRenderingContext2D,
  box: Readonly<Box>,
  color: string,
  dashed: boolean,
): void {
  g.save();
  g.strokeStyle = color;
  g.lineWidth = 2;
  if (dashed) g.setLineDash([4, 3]);
  g.strokeRect(box.x - 2, box.y - 2, box.width + 4, box.height + 4);
  g.restore();
}

/** The colors and font of one slip indicator. */
export interface SlipStyle {
  late: string;
  early: string;
  font: string;
}

/**
 * The slip indicator beside a bar: a triangle pointing right for late (positive slip), left for
 * early (negative slip), plus the catalog's signed label — direction and text keep the meaning off
 * color alone. Draws nothing for a zero slip.
 *
 * `gutterEnd` is the bar's resolved end-gutter clearance (`BarBox.gutterEnd`) — the indicator
 * paints outside it so it never collides with clearance another plugin has reserved beyond the
 * bar's right edge.
 */
export function drawSlipIndicator(
  g: CanvasRenderingContext2D,
  bar: Readonly<Box>,
  gutterEnd: number,
  slipMs: number,
  label: string,
  style: Readonly<SlipStyle>,
): void {
  if (slipMs === 0) return;
  const color = slipMs > 0 ? style.late : style.early;
  const size = 4;
  const cx = bar.x + bar.width + gutterEnd + 4 + size;
  const cy = bar.y + bar.height / 2;
  g.save();
  g.fillStyle = color;
  g.beginPath();
  if (slipMs > 0) {
    g.moveTo(cx - size, cy - size);
    g.lineTo(cx + size, cy);
    g.lineTo(cx - size, cy + size);
  } else {
    g.moveTo(cx + size, cy - size);
    g.lineTo(cx - size, cy);
    g.lineTo(cx + size, cy + size);
  }
  g.closePath();
  g.fill();
  g.font = style.font;
  g.textAlign = "left";
  g.textBaseline = "middle";
  g.fillText(label, cx + size + 3, cy);
  g.restore();
}

/* ==================================================================== *
 * Theme tokens (§2.3/§2.4 — the `theme.get(token) || FALLBACK` consumer pattern)
 * ==================================================================== */

export type ThemeReader = Pick<ThemeService, "get">;

const TOKEN_BASELINE_BAR = "--sg-baseline-bar";
const FALLBACK_BASELINE_BAR = "#9aa5b1";
const TOKEN_OVERLAY_FILL = "--sg-baseline-overlay-fill";
const FALLBACK_OVERLAY_FILL = "rgba(154, 165, 177, 0.28)";
const TOKEN_OVERLAY_STROKE = "--sg-baseline-overlay-stroke";
const FALLBACK_OVERLAY_STROKE = "#7b8794";
const TOKEN_ACTUAL_BAR = "--sg-actual-bar";
const FALLBACK_ACTUAL_BAR = "#334e68";
const TOKEN_SLIP_LATE = "--sg-baseline-slip-late";
const FALLBACK_SLIP_LATE = "#b3261e";
const TOKEN_SLIP_EARLY = "--sg-baseline-slip-early";
const FALLBACK_SLIP_EARLY = "#1b6e53";
const TOKEN_SLIP_FONT = "--sg-baseline-slip-font";
const FALLBACK_SLIP_FONT = "10px sans-serif";
const TOKEN_CP_ADDED = "--sg-baseline-cp-added";
const FALLBACK_CP_ADDED = "#b3261e";
const TOKEN_CP_REMOVED = "--sg-baseline-cp-removed";
const FALLBACK_CP_REMOVED = "#52606d";

function tokenOr(theme: ThemeReader | undefined, token: string, fallback: string): string {
  return (theme === undefined ? "" : theme.get(token)) || fallback;
}

export interface BaselineUnderlayColors {
  bar: string;
  overlayFill: string;
  overlayStroke: string;
}

export function resolveUnderlayColors(theme: ThemeReader | undefined): BaselineUnderlayColors {
  return {
    bar: tokenOr(theme, TOKEN_BASELINE_BAR, FALLBACK_BASELINE_BAR),
    overlayFill: tokenOr(theme, TOKEN_OVERLAY_FILL, FALLBACK_OVERLAY_FILL),
    overlayStroke: tokenOr(theme, TOKEN_OVERLAY_STROKE, FALLBACK_OVERLAY_STROKE),
  };
}

export interface ActualsColors {
  actual: string;
  cpAdded: string;
  cpRemoved: string;
}

export function resolveActualsColors(theme: ThemeReader | undefined): ActualsColors {
  return {
    actual: tokenOr(theme, TOKEN_ACTUAL_BAR, FALLBACK_ACTUAL_BAR),
    cpAdded: tokenOr(theme, TOKEN_CP_ADDED, FALLBACK_CP_ADDED),
    cpRemoved: tokenOr(theme, TOKEN_CP_REMOVED, FALLBACK_CP_REMOVED),
  };
}

export function resolveSlipColors(theme: ThemeReader | undefined): SlipStyle {
  return {
    late: tokenOr(theme, TOKEN_SLIP_LATE, FALLBACK_SLIP_LATE),
    early: tokenOr(theme, TOKEN_SLIP_EARLY, FALLBACK_SLIP_EARLY),
    font: tokenOr(theme, TOKEN_SLIP_FONT, FALLBACK_SLIP_FONT),
  };
}

/* ==================================================================== *
 * Order-50 baseline underlay (§2.3)
 * ==================================================================== */

type RowsReader = Pick<RowsService, "rowCount" | "rowAtY" | "yOf" | "rowHeight" | "taskIdAt">;
type TimelineReader = Pick<TimelineService, "tToX">;
type BarRectReader = Pick<TaskBarsService, "barRect">;
type VisibleBoxesReader = Pick<TaskBarsService, "visibleBoxes">;

export interface BaselineUnderlayDeps {
  bars: boolean;
  barStyle: "under" | "overlay";
  activeBaseline(): Readonly<Baseline> | undefined;
  rows(): RowsReader | undefined;
  timeline(): TimelineReader | undefined;
  taskBars(): BarRectReader | undefined;
  colors(): BaselineUnderlayColors;
}

/**
 * `renderer/layers` draw (order 50, §2.3): only while a baseline is active and `bars` is on, and
 * only over the visible rows the (optional) `rows` service reports.
 */
export function createBaselineUnderlayLayer(
  deps: BaselineUnderlayDeps,
): (g: CanvasRenderingContext2D, vp: Readonly<Viewport>) => void {
  return (g, vp) => {
    if (!deps.bars) return;
    const baseline = deps.activeBaseline();
    if (baseline === undefined) return;
    const rows = deps.rows();
    const timeline = deps.timeline();
    const taskBars = deps.taskBars();
    if (rows === undefined || timeline === undefined || taskBars === undefined) return;
    const colors = deps.colors();
    const overlayStyle = deps.barStyle === "overlay";

    g.save();
    forEachVisibleRow(rows, vp, (row, top, rowHeight) => {
      const id = rows.taskIdAt(row);
      if (id === undefined) return;
      const snap = baseline.tasks.get(id);
      if (snap === undefined) return;
      const rowTop = top - vp.scrollTop;
      if (snap.type === "milestone") {
        const cx = timeline.tToX(snap.start) - vp.scrollLeft;
        if (cx < -8 || cx > vp.width + 8) return;
        drawDiamond(g, cx, rowTop + rowHeight - underBarHeight(rowHeight), 3, colors.bar, false);
        return;
      }
      const span = visibleSpan(
        timeline.tToX(snap.start) - vp.scrollLeft,
        timeline.tToX(snap.end) - vp.scrollLeft,
        vp.width,
      );
      if (span === undefined) return;
      if (!overlayStyle) {
        drawUnderBar(g, span.x1, span.x2, rowTop, rowHeight, colors.bar);
        return;
      }
      // The overlay style bands the live bar itself, so it needs that bar's own (content-space) box.
      const box = taskBars.barRect(id);
      if (box === undefined) return;
      drawOverlayBar(
        g,
        span.x1,
        span.x2,
        box.y - vp.scrollTop,
        box.height,
        colors.overlayFill,
        colors.overlayStroke,
      );
    });
    g.restore();
  };
}

/* ==================================================================== *
 * Order-62 actual bars + baseline critical-path rings (§2.3/§2.4)
 * ==================================================================== */

function paintActualDates(
  g: CanvasRenderingContext2D,
  vp: Readonly<Viewport>,
  task: Readonly<Task>,
  box: Readonly<BarBox>,
  timeline: TimelineReader,
  color: string,
): void {
  const actual = actualDatesOf(task);
  if (actual?.start === undefined) return;
  const from = timeline.tToX(actual.start) - vp.scrollLeft;
  if (task.type === "milestone") {
    drawDiamond(g, from, box.y + box.height / 2, Math.max(3, box.height * 0.25), color, true);
    return;
  }
  const until = timeline.tToX(actual.end ?? task.end) - vp.scrollLeft;
  drawActualBar(
    g,
    Math.max(0, Math.min(from, until)),
    Math.min(vp.width, Math.max(from, until)),
    box.y,
    box.height,
    color,
  );
}

export interface CriticalPathSets {
  added: ReadonlySet<TaskId>;
  removed: ReadonlySet<TaskId>;
}

export interface ActualsLayerDeps {
  actualBars: boolean;
  taskBars(): VisibleBoxesReader | undefined;
  timeline(): TimelineReader | undefined;
  getTask(id: TaskId): Readonly<Task> | undefined;
  criticalPathSets(): CriticalPathSets | undefined;
  colors(): ActualsColors;
}

/**
 * `renderer/layers` draw (order 62, §2.3/§2.4): actual bars for tasks carrying actual dates plus
 * the active baseline's critical-path change rings, over the boxes `TaskBarsService.visibleBoxes()`
 * reports — already viewport-local and visible-rows-only, so no row walk is needed here.
 */
export function createActualsLayer(
  deps: ActualsLayerDeps,
): (g: CanvasRenderingContext2D, vp: Readonly<Viewport>) => void {
  return (g, vp) => {
    const taskBars = deps.taskBars();
    if (taskBars === undefined) return;
    const cp = deps.criticalPathSets();
    // Nothing this layer can paint: actual bars are off and no CP highlight is active.
    if (!deps.actualBars && cp === undefined) return;
    const timeline = deps.timeline();
    const colors = deps.colors();

    g.save();
    for (const box of taskBars.visibleBoxes()) {
      const task = deps.getTask(box.id);
      if (task === undefined) continue;

      if (deps.actualBars && timeline !== undefined) {
        paintActualDates(g, vp, task, box, timeline, colors.actual);
      }

      if (cp?.added.has(box.id)) drawCpRing(g, box, colors.cpAdded, false);
      else if (cp?.removed.has(box.id)) drawCpRing(g, box, colors.cpRemoved, true);
    }
    g.restore();
  };
}

/* ==================================================================== *
 * `taskbars/overlays` slip indicator (§2.3)
 * ==================================================================== */

export interface SlipOverlayDeps {
  slipIndicators: boolean;
  slipThresholdMs: number;
  activeBaseline(): Readonly<Baseline> | undefined;
  getTask(id: TaskId): Readonly<Task> | undefined;
  slipLabel(slipMs: number): string;
  colors(): SlipStyle;
}

/** `taskbars/overlays` contribution (§2.3): a directional slip glyph + signed label per bar. */
export function createSlipOverlay(deps: SlipOverlayDeps): BarOverlayRenderer {
  return (g, bar) => {
    if (!deps.slipIndicators) return;
    const baseline = deps.activeBaseline();
    if (baseline === undefined) return;
    const snap = baseline.tasks.get(bar.id);
    if (snap === undefined) return;
    const task = deps.getTask(bar.id);
    if (task === undefined || !Number.isFinite(task.end)) return;
    // The exact ms slip, no rounding to whole days: the visibility test compares the exact
    // magnitude against the threshold, not a round-then-compare rule.
    const slipMs = task.end - snap.end;
    if (slipMs === 0 || Math.abs(slipMs) < deps.slipThresholdMs) return;
    drawSlipIndicator(g, bar, bar.gutterEnd, slipMs, deps.slipLabel(slipMs), deps.colors());
  };
}

/* ==================================================================== *
 * Baseline-vs-current critical-path set resolution (paint-time cache)
 * ==================================================================== */

export interface CriticalPathSetsDeps {
  enabled: boolean;
  activeBaseline(): Readonly<Baseline> | undefined;
  criticalPath(): readonly TaskId[];
  criticalPathDelta(baselineId?: BaselineId): CriticalPathDelta | undefined;
}

/**
 * Memoizes the §2.3 critical-path added/removed sets per (baseline object, current-path identity)
 * — `criticalPath()` returns a fresh array only after a data change (`cpm.ts`'s own memoization),
 * and a baseline is re-inserted as a fresh object on every define, so identity equality on both is
 * exactly "nothing relevant changed", avoiding a per-frame Set/array rebuild.
 */
export function createCriticalPathSetsResolver(
  deps: CriticalPathSetsDeps,
): () => CriticalPathSets | undefined {
  let cache:
    | { baseline: object; current: readonly TaskId[]; sets: { added: Set<TaskId>; removed: Set<TaskId> } }
    | undefined;
  return () => {
    if (!deps.enabled) return undefined;
    const baseline = deps.activeBaseline();
    if (baseline === undefined) return undefined;
    const current = deps.criticalPath();
    if (cache !== undefined && cache.baseline === baseline && cache.current === current) {
      return cache.sets;
    }
    const delta = deps.criticalPathDelta(baseline.id);
    const sets = { added: new Set(delta?.added ?? []), removed: new Set(delta?.removed ?? []) };
    cache = { baseline, current, sets };
    return sets;
  };
}
