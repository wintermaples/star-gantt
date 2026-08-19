// docs/specs/plugins/export.md §9 — internal module: not part of the published surface.
// §1.1 "range" / "Tiled composition" / "Row coverage".
/**
 * Resolution of `ImageCaptureConfig.range` into an exported area and the tile grid that covers it.
 *
 * Pure geometry: no DOM, no view service, no data store — the callers hand in the viewport, the
 * time/pixel mapping, the task extent and the content height, which makes every branch of §1.1's
 * range and row-coverage rules unit-testable.
 *
 * Not part of the package's published surface.
 */
// Type-only: brings `Viewport` into the program without a runtime dependency on `@stargantt/plugin-view`.
import type { Viewport } from "@stargantt/plugin-view";
import type { ExportRange } from "../../types";

/**
 * The tile size used to walk an export, in CSS px.
 *
 * Internal constants, deliberately **not** public API (§1.1 "the tile size is an internal
 * constant, not public API"). Nothing caps them to the viewport: every tile is rendered through
 * `ViewService.renderTo` into an offscreen canvas of the tile's own size, so the on-screen canvases'
 * dimensions are irrelevant.
 */
export const TILE_WIDTH = 1024;
export const TILE_HEIGHT = 1024;

/** The part of `TimelineService` the export needs: the time ↔ content-x mapping. */
export interface ScaleLike {
  tToX(t: number): number;
  xToT(x: number): number;
}

/** One vertical slice of the exported area: a column of the tile grid. */
export interface Column {
  /** Offset of this column's left edge within the exported image, in CSS px. */
  x: number;
  /** Column width in CSS px. */
  width: number;
  /** The virtual viewport's `scrollLeft` for this column (content-x of its left edge). */
  scrollLeft: number;
  /** The column's time span in epoch ms; `0` for both when no time scale is available. */
  start: number;
  end: number;
}

/** One horizontal slice of the exported area: a row band of the tile grid. */
export interface Row {
  /** Offset of this band's top edge within the drawing layers' band, in CSS px. */
  y: number;
  /** Band height in CSS px. */
  height: number;
  /** The virtual viewport's `scrollTop` for this band (content-y of its top edge). */
  scrollTop: number;
}

/**
 * Why `span()` fell back to the viewport, or why it did not resolve at all — `planRange` stays
 * pure and never throws, so this is the signal the facade's `begin()` (`src/index.ts`) reacts to.
 *
 * §1.1 — `"degenerate"` is reachable **only** through the explicit `{ start, end }` object form (a
 * non-finite bound, or a span under one exported pixel); it is the one reason that is a caller error
 * rather than an environment condition, so it is the only one the facade turns into a rejection
 * instead of a silent viewport export. `"requested"` (range omitted / `"viewport"`) and `"no-extent"`
 * (`"full"` over a store with no dated task at all) stay silent fallbacks.
 *
 * `"no-scale"` is kept for this module's own hostless testability but is **unreachable** in a real
 * composition: the "missing timeline-scale service" degradation (§1.1) cannot occur because
 * `stargantt.timeline` is co-provided by the hard `view` dependency, so the t↔x mapping always
 * exists. `planRange` stays a pure function whose `scale` parameter is still optional, so its
 * own unit tests exercise the branch directly; nothing in the plugin's real wiring can produce it.
 *
 * A zero-width task extent (a milestone-only schedule) is **not** a `"no-extent"` fallback — §1.1
 * reads it as a valid `"full"` extent, given a minimal one-content-px width (see `span()`), so
 * `"full"` renders instead of degrading.
 */
export type FallbackReason = "requested" | "no-scale" | "no-extent" | "degenerate";

export interface RangePlan {
  /** Content-x of the exported area's left edge, in CSS px. */
  x: number;
  /** Exported width in CSS px. */
  width: number;
  /** Content-y of the exported area's top edge, in CSS px. */
  y: number;
  /** Exported height of the drawing layers' band in CSS px. */
  height: number;
  /** Columns left to right; the last one is clipped to the exported area's right edge. */
  columns: Column[];
  /** Row bands top to bottom; the last one is clipped to the exported area's bottom edge. */
  rows: Row[];
  /**
   * `true` when the requested range could not be resolved and the export fell back to the
   * currently visible viewport — which also pins the row coverage to the visible rows (§1.1 "Row
   * coverage").
   */
  viewportOnly: boolean;
  /** Set alongside `viewportOnly: true`; see `FallbackReason`. Absent when not a fallback. */
  fallbackReason?: FallbackReason;
}

export interface PlanInput {
  viewport: Readonly<Viewport>;
  /** Absent when the chart has no timeline scale, which pins the export to the viewport. */
  scale?: ScaleLike | undefined;
  /** The task extent in epoch ms; absent when the store holds no dated task. */
  extent?: { start: number; end: number } | undefined;
  /**
   * Total height of all rows in CSS px, for §1.1's all-rows coverage. Absent when no row geometry
   * is reachable, in which case the export keeps the viewport's own row window.
   */
  contentHeight?: number | undefined;
  /** Overrides `TILE_WIDTH` / `TILE_HEIGHT`; tests use them to exercise multi-tile grids. */
  tileWidth?: number;
  tileHeight?: number;
  /**
   * The export's resolution ratio (device px per content-x CSS px). §1.1's sub-pixel test for an
   * explicit range is defined "at the export's resolution", so the span is judged in exported
   * pixels, not CSS pixels. Defaults to 1.
   */
  pixelRatio?: number | undefined;
}

function usable(v: number): boolean {
  return Number.isFinite(v);
}

/**
 * The exported span for `range`, as content-x pixels, plus whether — and why — it fell back to
 * the viewport (`FallbackReason`).
 *
 * Every wider-than-viewport form needs the time scale to map instants to pixels, so any form that
 * cannot be resolved falls back to the viewport, which is also the default. Only the explicit
 * `{ start, end }` object form's non-finite bounds or sub-pixel span are tagged `"degenerate"` —
 * the facade's `begin()` turns that one reason into a rejection; every other reason here stays a
 * silent fallback.
 */
function span(
  range: ExportRange | undefined,
  input: PlanInput,
): { x: number; width: number; viewportOnly: boolean; fallbackReason?: FallbackReason } {
  const vp = input.viewport;
  const fallback = (
    fallbackReason: FallbackReason,
  ): { x: number; width: number; viewportOnly: boolean; fallbackReason: FallbackReason } => ({
    x: vp.scrollLeft,
    width: Math.max(1, vp.width),
    viewportOnly: true,
    fallbackReason,
  });
  if (range === undefined || range === "viewport") return fallback("requested");

  const scale = input.scale;
  if (scale === undefined) return fallback("no-scale");

  let from: number;
  let to: number;
  let explicit = false;
  if (range === "full") {
    const extent = input.extent;
    if (extent === undefined) return fallback("no-extent");
    from = extent.start;
    to = extent.end;
  } else if (typeof range === "object" && range !== null) {
    from = range.start;
    to = range.end;
    explicit = true;
  } else {
    return fallback("requested");
  }
  if (!usable(from) || !usable(to)) return fallback(explicit ? "degenerate" : "no-extent");

  const x0 = scale.tToX(Math.min(from, to));
  let x1 = scale.tToX(Math.max(from, to));
  if (!usable(x0) || !usable(x1)) return fallback(explicit ? "degenerate" : "no-extent");
  // §1.1 — a zero-width extent (a milestone-only schedule, "full" range) is a valid extent, not a
  // fallback trigger: it gets a minimal sensible width (one content-x px around the instant),
  // matching the print pipeline's own `contentX1 = max(tToX(end), contentX0 + 1)` resolution.
  // Only the *explicit* `{ start, end }` form's sub-pixel span stays a caller-error rejection;
  // "full" never rejects.
  if (!explicit && x1 <= x0) x1 = x0 + 1;
  // §1.1 — the sub-pixel judgement happens at the export's resolution: a span narrower than one
  // CSS px can still cover a full exported pixel at a HiDPI ratio, and must then be accepted.
  const ratio = usable(input.pixelRatio ?? NaN) && (input.pixelRatio as number) > 0 ? (input.pixelRatio as number) : 1;
  if (explicit && (x1 - x0) * ratio < 1) {
    return fallback("degenerate");
  }
  return { x: x0, width: x1 - x0, viewportOnly: false };
}

/**
 * The exported band on the row axis, as content-y pixels.
 *
 * §1.1 "Row coverage" — `"viewport"` (and any form that fell back to it) exports the rows
 * currently on screen; `"full"` and the explicit `{ start, end }` form export every row, which
 * needs the total content height. Without a reachable content height the band stays the
 * viewport's, so the export degrades to today's row window instead of guessing.
 */
function band(input: PlanInput, viewportOnly: boolean): { y: number; height: number } {
  const vp = input.viewport;
  const visible = { y: vp.scrollTop, height: Math.max(1, vp.height) };
  if (viewportOnly) return visible;
  const total = input.contentHeight;
  if (total === undefined || !usable(total) || total <= 0) return visible;
  return { y: 0, height: total };
}

function slice(total: number, step: number): { offset: number; size: number }[] {
  const out: { offset: number; size: number }[] = [];
  for (let offset = 0; offset < total; offset += step) {
    out.push({ offset, size: Math.min(step, total - offset) });
  }
  return out;
}

/**
 * Resolves `range` into the exported area and the tile grid that covers it.
 *
 * Columns walk left to right and row bands top to bottom; the last tile on each axis is clipped to
 * the exported area's edge, so tiles never overlap and never overshoot. Every tile is a virtual
 * viewport for `ViewService.renderTo` (§1.1 "Tiled composition"): its `scrollLeft` / `scrollTop`
 * may sit outside the chart's scrollable range, which renders correctly instead of being clamped.
 */
export function planRange(range: ExportRange | undefined, input: PlanInput): RangePlan {
  const horizontal = span(range, input);
  const vertical = band(input, horizontal.viewportOnly);

  const x = Math.round(horizontal.x);
  const width = Math.max(1, Math.round(horizontal.width));
  const y = Math.round(vertical.y);
  const height = Math.max(1, Math.round(vertical.height));

  const stepX = Math.max(1, Math.floor(input.tileWidth ?? TILE_WIDTH));
  const stepY = Math.max(1, Math.floor(input.tileHeight ?? TILE_HEIGHT));
  const scale = input.scale;

  const columns: Column[] = slice(width, stepX).map((s) => {
    const scrollLeft = x + s.offset;
    return {
      x: s.offset,
      width: s.size,
      scrollLeft,
      start: scale === undefined ? 0 : scale.xToT(scrollLeft),
      end: scale === undefined ? 0 : scale.xToT(scrollLeft + s.size),
    };
  });

  const rows: Row[] = slice(height, stepY).map((s) => ({
    y: s.offset,
    height: s.size,
    scrollTop: y + s.offset,
  }));

  return {
    x,
    width,
    y,
    height,
    columns,
    rows,
    viewportOnly: horizontal.viewportOnly,
    ...(horizontal.fallbackReason === undefined ? {} : { fallbackReason: horizontal.fallbackReason }),
  };
}

/** The earliest `start` and latest `end` among tasks, or `undefined` when none is usable. */
export function taskExtent(
  tasks: Iterable<{ start: number; end: number }>,
): { start: number; end: number } | undefined {
  let start = Number.POSITIVE_INFINITY;
  let end = Number.NEGATIVE_INFINITY;
  for (const t of tasks) {
    if (usable(t.start) && t.start < start) start = t.start;
    if (usable(t.end) && t.end > end) end = t.end;
    // A milestone-like task whose end is missing still contributes its start.
    if (usable(t.start) && t.start > end) end = Math.max(end, t.start);
  }
  // §1.1 — a zero-width extent (milestone-only schedule, `start === end`) is a valid extent, not
  // "no extent"; only reject when nothing usable was ever seen (`end < start` after the loop only
  // happens then, since a lone start also raises `end` to match it above).
  if (!usable(start) || !usable(end) || end < start) return undefined;
  return { start, end };
}
