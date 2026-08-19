// docs/specs/plugins/resource.md §3.6 — the shared projections and paint helpers of the two strips.
/**
 * The load band's histogram geometry and one resource lane's box geometry — pure projections from
 * bucket results to shapes, plus the two paint primitives (pixel snapping, the non-color overload
 * hatch) both the live canvases and the export writers share.
 *
 * Every renderer of the band (the live strip and the `export/auxiliarySurfaces` tile writers) draws
 * the SAME histogram, so all of them read their boxes from `projectHistogram`; the lanes read
 * `projectLane`. Carrying a second copy of the y-scale is what let the screen and export disagree
 * as soon as `valueLabels` was on.
 *
 * Coordinates are CSS pixels local to the box being drawn — the strip's own box on screen, one
 * export tile's box on export — with `y = 0` at its top edge. Time is epoch milliseconds UTC.
 */
// The displayed magnitude comes from the shared duration ladder, the very one `formatDurationMs`
// prints in, so the step search and the tick text can never disagree about a value's unit.
import { createStripToggle, durationUnitMs } from "@stargantt/sdk";
import type { StripHeightTracker, StripToggle } from "@stargantt/sdk";
import { computeAxisScale } from "./axis";
import type { BucketResult } from "./band";

/** Fixed width, in CSS px, of the in-plot y-axis label column when `axisLabels` is enabled. */
export const AXIS_WIDTH = 40;

/** Height, in CSS px, of the top label gutter reserved when `valueLabels` is enabled. */
export const VALUE_LABEL_HEIGHT = 12;

/** Thickness, in CSS px, of the capacity line. */
export const CAPACITY_LINE_THICKNESS = 1;

/** CSS px reserved above a lane's plot, so a full-height box never touches the lane above. */
export const LANE_PAD_TOP = 2;

/** CSS px reserved below a lane's plot, keeping boxes off the lane's own bottom boundary. */
export const LANE_PAD_BOTTOM = 1;

/** Spacing, in CSS px, between the overload hatch's diagonal strokes. */
export const HATCH_STEP = 4;

/**
 * Formats a bar's numeric label: integers plain, fractions to at most two decimal places with
 * trailing zeros trimmed (`3.5`, never `3.50`).
 */
export function formatTick(value: number): string {
  if (Number.isInteger(value)) return String(value);
  return value.toFixed(2).replace(/0+$/, "").replace(/\.$/, "");
}

/** Clamps `n` into `[min, max]`. */
function clamp(n: number, min: number, max: number): number {
  return Math.min(Math.max(n, min), max);
}

/**
 * The one omit-if-too-wide test every value label runs: a label fits when its
 * rendered text, rounded UP to the whole CSS pixel a renderer would actually emit, is no wider than
 * the clamped extent it must sit in. Shared by the band's per-bar labels and the lanes' per-run
 * labels, so the two rules cannot drift.
 */
export function fitsLabel(text: string, extent: number, measure: (text: string) => number): boolean {
  return extent > 0 && Math.ceil(measure(text)) <= extent;
}

/* ------------------------------------------------------------------ *
 * The aggregate band's histogram
 * ------------------------------------------------------------------ */

export interface HistogramInput {
  /** The buckets to draw, already restricted to the range being drawn. */
  results: readonly BucketResult[];
  /** Width of the drawn box in CSS px; value labels are clamped into it. */
  width: number;
  /** Height of the drawn box in CSS px — the band's full height, gutter included. */
  height: number;
  /** Maps an epoch-ms instant to an x offset local to the drawn box (0 at its left edge). */
  xOf(t: number): number;
  /** Whether the top label gutter is reserved — a band-wide rule, not a per-medium one. */
  valueLabels: boolean;
  /**
   * The peak the y-scale is fitted to, when it must not be derived from `results` alone. A
   * multi-tile export passes the peak of the WHOLE exported span here, so every tile shares one
   * y-scale and the bars stay continuous across tile seams.
   */
  scaleMax?: number;
  /** Rendered width of a value label's text. Supplied only by renderers that draw value labels. */
  measure?: (text: string) => number;
  /**
   * When `true`, the y scale is the step-first "nice" scale. The aggregate band and the export
   * writers pass `true`; the resource lanes fit their raw ceilings and pass nothing.
   */
  nice?: boolean;
  /**
   * When `true`, the values are milliseconds of working time: the step-first search runs in the
   * magnitude the shared duration formatter would print the peak in. Only meaningful with `nice`.
   */
  durationScale?: boolean;
  /** Renders a bar's value as its label text. Omitted, the plain numeric form is used. */
  formatValue?: (value: number) => string;
}

/** One bucket's bar. `over` is the segment above the capacity line, in the same coordinates. */
export interface BarShape {
  x: number;
  width: number;
  /** Top edge of the bar; the bar is anchored to the box's bottom edge. */
  top: number;
  height: number;
  /** Present only on an overloaded bucket. Its top always equals the bar's own top. */
  over?: { top: number; height: number };
  /** The bucket's numeric label, when `valueLabels` is on and the text fits its clamped extent. */
  label?: ValueLabelShape;
}

/** One capacity-line segment: a contiguous run of buckets sharing a line value. */
export interface CapacityShape {
  x: number;
  width: number;
  /** The line's centre y. */
  y: number;
  /** Top edge of a `CAPACITY_LINE_THICKNESS`-tall box centred on `y`, clamped inside the box. */
  top: number;
}

/** One per-bar numeric label, already clamped into the drawn box and filtered for fit. */
export interface ValueLabelShape {
  x: number;
  width: number;
  top: number;
  height: number;
  text: string;
}

export interface HistogramProjection {
  /** The value the top of the plot area represents; `0` when there is nothing to draw. */
  max: number;
  /** The round tick step behind `max` under the step-first scale, or `null` when `nice` was off. */
  step: number | null;
  /** The step-first scale's tick values ascending (`0, step, …, max`); empty when `step` is null. */
  ticks: readonly number[];
  /** Height of the reserved top label gutter, in CSS px. */
  gutter: number;
  /** Height the y-scale is fitted to: `height - gutter`. */
  plotHeight: number;
  /** The y of a value under this projection. Only meaningful when `max > 0`. */
  yOf(value: number): number;
  bars: BarShape[];
  capacity: CapacityShape[];
}

/**
 * The y-scale's top value and the tick step it implies: the band and the export fit
 * `[0, ceiling]` where the ceiling is the smallest round-step multiple at or above the peak, so
 * every axis tick is a round value by construction. The lanes keep their raw ceilings.
 */
function resolveCeiling(
  o: HistogramInput,
  plotHeight: number,
): { max: number; step: number | null; ticks: readonly number[] } {
  let max = 0;
  for (const r of o.results) {
    if (r.value > max) max = r.value;
    if (r.capacity !== null && r.capacity > max) max = r.capacity;
  }
  if (o.scaleMax !== undefined && Number.isFinite(o.scaleMax) && o.scaleMax > max) max = o.scaleMax;
  if (o.nice !== true || max <= 0) return { max, step: null, ticks: [] };
  // The magnitude goes in as the QUERY, not as one answer about the peak: the ceiling is what gets
  // labelled, and a scale chosen in the peak's magnitude can overshoot into the next one.
  const scale = computeAxisScale(max, plotHeight, o.durationScale === true ? durationUnitMs : 1);
  return scale === null
    ? { max, step: null, ticks: [] }
    : { max: scale.ceiling, step: scale.step, ticks: scale.ticks };
}

/**
 * The value label above one bar, or `undefined` when it would not fit: the label is
 * clamped horizontally into the BAND's box, so a bucket that starts left of, or ends right of, the
 * drawn range still shows its label; a label wider than that clamped extent is omitted entirely
 * rather than clipped.
 */
function valueLabelOf(
  o: HistogramInput,
  value: number,
  x0: number,
  x1: number,
  top: number,
): ValueLabelShape | undefined {
  const measure = o.measure;
  if (!o.valueLabels || measure === undefined) return undefined;
  const left = Math.max(0, x0);
  const right = Math.min(o.width, x1);
  const text = (o.formatValue ?? formatTick)(value);
  if (!fitsLabel(text, right - left, measure)) return undefined;
  return {
    x: left,
    width: right - left,
    top: Math.max(0, top - VALUE_LABEL_HEIGHT),
    height: VALUE_LABEL_HEIGHT,
    text,
  };
}

function buildBars(o: HistogramInput, yOf: (value: number) => number): BarShape[] {
  const bars: BarShape[] = [];
  for (const r of o.results) {
    if (r.value <= 0) continue;
    const x0 = o.xOf(r.bucket.start);
    const x1 = o.xOf(r.bucket.end);
    const width = x1 - x0;
    if (width <= 0) continue;

    const top = yOf(r.value);
    const bar: BarShape = { x: x0, width, top, height: o.height - top };
    if (r.capacity !== null && r.value > r.capacity) {
      bar.over = { top, height: yOf(r.capacity) - top };
    }
    const label = valueLabelOf(o, r.value, x0, x1, top);
    if (label !== undefined) bar.label = label;
    bars.push(bar);
  }
  return bars;
}

/** One segment per contiguous run of buckets sharing the same (non-null) capacity value. */
function buildCapacitySegments(o: HistogramInput, yOf: (value: number) => number): CapacityShape[] {
  const capacity: CapacityShape[] = [];
  let runStart: { bucket: BucketResult["bucket"]; capacity: number } | null = null;
  let runLast: BucketResult["bucket"] | null = null;
  const flushRun = (): void => {
    if (runStart === null || runLast === null) return;
    const x0 = o.xOf(runStart.bucket.start);
    const x1 = o.xOf(runLast.end);
    const width = x1 - x0;
    if (width > 0) {
      const y = yOf(runStart.capacity);
      capacity.push({
        x: x0,
        width,
        y,
        // Centred on the value and clamped so both extremes (capacity at the y-scale max, or 0)
        // stay fully inside the band's clip box instead of being half-clipped.
        top: clamp(
          y - CAPACITY_LINE_THICKNESS / 2,
          0,
          Math.max(0, o.height - CAPACITY_LINE_THICKNESS),
        ),
      });
    }
    runStart = null;
    runLast = null;
  };
  for (const r of o.results) {
    if (r.capacity === null) {
      flushRun();
      continue;
    }
    if (runStart !== null && runStart.capacity === r.capacity) {
      runLast = r.bucket;
      continue;
    }
    flushRun();
    runStart = { bucket: r.bucket, capacity: r.capacity };
    runLast = r.bucket;
  }
  flushRun();
  return capacity;
}

/**
 * Projects bucket results onto the band's boxes.
 *
 * The y-scale fits `[0, ceiling]` to the PLOT AREA: the band height less a top label gutter
 * reserved when `valueLabels` is enabled, the full band height otherwise. Bars and the capacity
 * line stay anchored to the bottom edge; only the top of the tallest element moves. A bar's own box
 * covers the bucket's FULL value and the overload segment is the top portion of it, so a renderer
 * that clips or fills the bar box never loses the overload portion.
 */
export function projectHistogram(o: HistogramInput): HistogramProjection {
  const gutter = o.valueLabels ? VALUE_LABEL_HEIGHT : 0;
  const plotHeight = Math.max(0, o.height - gutter);
  const { max, step, ticks } = resolveCeiling(o, plotHeight);

  const yOf = (value: number): number =>
    max > 0 ? o.height - (value / max) * plotHeight : o.height;

  if (max <= 0) {
    return { max, step, ticks, gutter, plotHeight, yOf, bars: [], capacity: [] };
  }
  return {
    max,
    step,
    ticks,
    gutter,
    plotHeight,
    yOf,
    bars: buildBars(o, yOf),
    capacity: buildCapacitySegments(o, yOf),
  };
}

/* ------------------------------------------------------------------ *
 * One resource lane
 * ------------------------------------------------------------------ */

/** One merged run of equal-value buckets, as a drawable box. Coordinates are lane-local CSS px. */
export interface LaneBox {
  x: number;
  width: number;
  top: number;
  height: number;
  /** The segment above the run's own capacity; present only when the run's value exceeds it. */
  over?: { top: number; height: number };
  /** The run's numeric value label, when lane value labels are on and the text fits. */
  label?: { x: number; width: number; text: string };
}

/** What the lane value labels need: the text, its rendered width, and the clamp box. */
export interface LaneValueLabelOptions {
  format(value: number): string;
  measure(text: string): number;
  /** The lane plot's width in CSS px; a label is clamped into `[0, plotWidth]`. */
  plotWidth: number;
}

export interface LaneProjectionInput {
  /** The lane's buckets, ascending and contiguous on the shared bucket grid. */
  results: readonly BucketResult[];
  /** The reference-line value: the resource's capacity, or 1 under the ratio scale. */
  threshold: number;
  /** Height available to the lane's boxes: the lane height less the lane padding. */
  plotHeight: number;
  /** Maps an epoch-ms instant to a lane-local x, before pixel snapping. */
  xOf(t: number): number;
  /** The shared y ceiling under `"ratio"` / `"shared"`; absent, the lane fits its own peak. */
  scaleMax?: number;
  /** Produces one numeric label per merged run. Absent, no box carries a label. */
  valueLabels?: LaneValueLabelOptions;
}

/**
 * One horizontal segment of the lane's stepped reference line: a run of adjacent buckets with equal
 * capacity, at the height that capacity sits under the lane's scale.
 */
export interface ReferenceSegment {
  x: number;
  width: number;
  top: number;
}

export interface LaneProjection {
  /** The value the top of the lane's plot represents; `0` when there is nothing to draw. */
  max: number;
  /** The merged, pixel-snapped boxes, left to right. */
  boxes: LaneBox[];
  /**
   * The dashed reference line as a STEP line following the lane's capacity runs: one
   * segment per run of adjacent buckets with equal capacity, at that capacity's height — the same
   * per-bucket granularity the over-fill segment is judged against.
   */
  referenceSegments: ReferenceSegment[];
}

/** y of `value` within the lane plot, measured from the plot's top (`LANE_PAD_TOP` not applied). */
function yWithin(value: number, max: number, plotHeight: number): number {
  return plotHeight - (value / max) * plotHeight;
}

/**
 * Projects one lane's buckets onto merged, snapped boxes plus the reference line.
 *
 * Adjacent buckets of equal value AND equal capacity merge into one box (two buckets that agree on
 * the bar but not on their own capacity may differ in overload); every box edge is rounded to whole
 * CSS pixels before it is written, so the run ending at time T and the run starting at T share the
 * identical rounded edge. The vertical coordinates returned are already offset by `LANE_PAD_TOP`.
 */
export function projectLane(input: LaneProjectionInput): LaneProjection {
  const plotHeight = Math.max(0, input.plotHeight);
  let max = Math.max(0, input.threshold);
  for (const r of input.results) {
    if (r.value > max) max = r.value;
  }
  if (input.scaleMax !== undefined && Number.isFinite(input.scaleMax) && input.scaleMax > max) {
    max = input.scaleMax;
  }

  if (max <= 0 || plotHeight <= 0 || input.results.length === 0) {
    return { max: 0, boxes: [], referenceSegments: [] };
  }

  const boxes: LaneBox[] = [];

  let runStart: number | null = null; // run's first bucket start (epoch ms)
  let runEnd = 0; // run's last bucket end (epoch ms)
  let runValue = 0;
  let runCapacity: number | null = null;

  const flush = (): void => {
    if (runStart === null || runValue <= 0) {
      runStart = null;
      return;
    }
    const x0 = Math.round(input.xOf(runStart));
    const x1 = Math.round(input.xOf(runEnd));
    runStart = null;
    if (x1 - x0 <= 0) return;
    const top = yWithin(runValue, max, plotHeight);
    const box: LaneBox = {
      x: x0,
      width: x1 - x0,
      top: LANE_PAD_TOP + top,
      height: plotHeight - top,
    };
    // Overload is per run, against the run's OWN capacity: under the absolute lane scales the
    // capacity varies per bucket, so a bucket below the lane's peak line can still be over budget.
    if (runCapacity !== null && runCapacity >= 0 && runValue > runCapacity) {
      box.over = { top: box.top, height: yWithin(runCapacity, max, plotHeight) - top };
    }
    const labels = input.valueLabels;
    if (labels !== undefined) {
      const left = Math.max(0, x0);
      const right = Math.min(labels.plotWidth, x1);
      const extent = right - left;
      if (extent > 0) {
        const text = labels.format(runValue);
        const width = Math.ceil(labels.measure(text));
        if (fitsLabel(text, extent, labels.measure)) {
          const center = (left + right) / 2;
          const x = Math.round(Math.min(Math.max(center - width / 2, left), right - width));
          box.label = { x, width, text };
        }
      }
    }
    boxes.push(box);
  };

  for (const r of input.results) {
    if (runStart !== null && r.value === runValue && r.capacity === runCapacity) {
      runEnd = r.bucket.end;
      continue;
    }
    flush();
    runStart = r.bucket.start;
    runEnd = r.bucket.end;
    runValue = r.value;
    runCapacity = r.capacity;
  }
  flush();

  const referenceSegments: ReferenceSegment[] = [];
  const clampTop = (value: number): number =>
    LANE_PAD_TOP +
    Math.min(
      Math.max(yWithin(value, max, plotHeight) - CAPACITY_LINE_THICKNESS / 2, 0),
      Math.max(0, plotHeight - CAPACITY_LINE_THICKNESS),
    );
  let refStart: number | null = null;
  let refEnd = 0;
  let refCapacity: number | null = null;
  const flushRef = (): void => {
    if (refStart === null) return;
    const x0 = Math.round(input.xOf(refStart));
    const x1 = Math.round(input.xOf(refEnd));
    const capacity = refCapacity;
    refStart = null;
    if (x1 - x0 <= 0 || capacity === null || capacity < 0) return;
    referenceSegments.push({ x: x0, width: x1 - x0, top: clampTop(capacity) });
  };
  for (const r of input.results) {
    if (refStart !== null && r.capacity === refCapacity) {
      refEnd = r.bucket.end;
      continue;
    }
    flushRef();
    refStart = r.bucket.start;
    refEnd = r.bucket.end;
    refCapacity = r.capacity;
  }
  flushRef();

  return { max, boxes, referenceSegments };
}

/* ------------------------------------------------------------------ *
 * Shared paint primitives
 * ------------------------------------------------------------------ */

/**
 * Draws the overload hatch: thin bottom-left→top-right diagonals clipped arithmetically to the
 * segment's box. The NON-COLOR half of the overload signal (WCAG 1.4.1) — an overloaded segment is
 * never distinguished by its fill colour alone.
 *
 * Plain path strokes rather than `createPattern`, so it needs no second canvas and no document
 * access — the same primitives the rest of the paint already uses.
 */
export function paintHatch(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  width: number,
  height: number,
  stroke: string,
): void {
  if (!(width > 0) || !(height > 0)) return;
  ctx.save();
  ctx.strokeStyle = stroke;
  ctx.lineWidth = 1;
  ctx.beginPath();
  // Each stroke runs at 45° from the bottom edge up-right; its endpoints are clamped to the
  // segment's box arithmetically, so no `clip()` is needed. Starting `height` short of the left
  // edge covers the bottom-left corner.
  for (let d = -height; d < width; d += HATCH_STEP) {
    const x0 = Math.max(x, x + d);
    const x1 = Math.min(x + width, x + d + height);
    if (x1 <= x0) continue;
    // On the line, the y at horizontal position px is `y + height - (px - (x + d))`.
    ctx.moveTo(x0, y + height - (x0 - (x + d)));
    ctx.lineTo(x1, y + height - (x1 - (x + d)));
  }
  ctx.stroke();
  ctx.restore();
}

/** Escapes a string for use inside a double-quoted XML attribute value. */
export function escapeAttr(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/* ------------------------------------------------------------------ *
 * Strip height control
 * ------------------------------------------------------------------ */

/** One strip's visibility toggle plus the "open at exactly this height" path. */
export interface StripControl {
  toggle: StripToggle;
  /** Opens a hidden strip AT `height` in one dispatch. */
  openAt(height: number): void;
}

export interface StripControlDeps {
  tracker: StripHeightTracker;
  /** Whether the strip starts shown — the config value. */
  initial: boolean;
  /** The height to show a strip at whose height nobody chose (the band token, the roster formula). */
  defaultHeight(): number;
  /** Applies a height through the layout — a `view/setBottomPaneHeight` dispatch of the plugin's. */
  dispatch(height: number): void;
  /** Runs after an actual change, so the caller can repaint. */
  onChange(): void;
}

/**
 * One strip's release/restore path over `sdk/dom`'s toggle and height tracker.
 *
 * A dispatch the toggle itself makes is a SELF-REQUEST, so the height report it produces never
 * counts as the reader sizing the strip — while `openAt`'s dispatch deliberately falls
 * outside that bracket, so a host height setter on a hidden strip does mark it reader-sized.
 */
export function createStripControl(deps: StripControlDeps): StripControl {
  /** While set, an opening `apply` dispatches this height instead of the toggle's restore height. */
  let openHeightOverride: number | undefined;
  const toggle = createStripToggle({
    initial: deps.initial,
    currentHeight: () => deps.tracker.height(),
    // A height change the plugin did not itself request is the reader's, and it is the only kind
    // worth carrying across a hide.
    readerSized: () => deps.tracker.isManual(),
    defaultHeight: deps.defaultHeight,
    apply: (height) => {
      if (height > 0 && openHeightOverride !== undefined) {
        deps.dispatch(openHeightOverride);
        return;
      }
      deps.tracker.selfRequest(() => deps.dispatch(height));
    },
    onChange: deps.onChange,
  });
  return {
    toggle,
    openAt: (height) => {
      openHeightOverride = height;
      try {
        toggle.set(true);
      } finally {
        openHeightOverride = undefined;
      }
    },
  };
}

/** The SVG counterpart of {@link paintHatch}: the same diagonals, clipped by the `<pattern>` tile. */
export function hatchPatternSVG(id: string, stroke: string): string {
  return (
    `<pattern id="${id}" patternUnits="userSpaceOnUse" width="${String(HATCH_STEP)}" height="${String(HATCH_STEP)}">` +
    `<path d="M0 ${String(HATCH_STEP)}L${String(HATCH_STEP)} 0M-1 1L1 -1M${String(HATCH_STEP - 1)} ${String(HATCH_STEP + 1)}L${String(HATCH_STEP + 1)} ${String(HATCH_STEP - 1)}" ` +
    `stroke="${escapeAttr(stroke)}" stroke-width="1"/></pattern>`
  );
}
