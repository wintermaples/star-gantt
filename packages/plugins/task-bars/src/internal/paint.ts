/**
 * Canvas painting for `stargantt.task-bars`: the plain bar with its progress fill, the summary
 * glyph and the milestone marker, plus the theme token names every painted colour goes through.
 *
 * Geometry is decided by `./geometry`; this module only issues drawing calls. The text-shaped
 * painting — labels, backdrops, end icons and the avatar badge — lives in `./paint-text`.
 */
import type { Task } from "@stargantt/plugin-data-store";
import type { BarPattern, MilestoneShape } from "../types";
import type { Rect } from "./geometry";
import { clampProgress, isMilestone, isSummary } from "./geometry";

// docs/specs/plugins/task-bars.md "Config" — colours are not config: CSS custom properties are the
// single source of truth, read through `stargantt.theme` at paint time with the
// `theme.get(token) || FALLBACK` consumer pattern. The literals below are only the fallback for a
// token that resolves to the empty string (no computed style, token removed by the host).
// `task.meta.color` and the `taskbars/style` point remain the supported overrides.

/** Fill of an ordinary task bar when the `--sg-bar-fill` token is unavailable. */
export const DEFAULT_BAR_COLOR = "#0f766e";

/** Fill of a summary glyph when the `--sg-summary-fill` token is unavailable. */
export const DEFAULT_SUMMARY_COLOR = "#44403c";

/** Fill of a milestone diamond when the `--sg-milestone-fill` token is unavailable. */
export const DEFAULT_MILESTONE_COLOR = "#292524";

/** The theme token holding a task's built-in fill, chosen by its type. */
export function tokenFor(task: Readonly<Task>): string {
  if (isMilestone(task)) return "--sg-milestone-fill";
  if (isSummary(task)) return "--sg-summary-fill";
  return "--sg-bar-fill";
}

// Progress is a difference in opacity of one colour, not a second colour laid on top. It has no
// per-task override: it applies to whatever fill the bar resolved to, so the alpha is read from its
// token unconditionally and a recoloured bar gets a matching track for free.

/** CSS custom property holding the opacity of a bar's uncompleted part. */
export const TRACK_ALPHA_TOKEN = "--sg-bar-track-alpha";

/**
 * How opaque the uncompleted part of a bar is painted, as a fraction of the bar's own fill, when
 * the `--sg-bar-track-alpha` token is unavailable.
 *
 * Deliberately an opacity rather than a colour of its own: the uncompleted remainder is the same
 * colour as the completed part, just fainter, so it reads correctly on any bar colour without a
 * second styling field. The value is the highest that keeps the boundary between the two at or
 * above 3:1 (measured 4.00:1 against the light chart background).
 */
export const DEFAULT_TRACK_ALPHA = 0.22;

/** The track alpha to actually paint with: a finite fraction in (0, 1], else the built-in one. */
function resolveAlpha(alpha: number): number {
  if (!Number.isFinite(alpha) || alpha <= 0) return DEFAULT_TRACK_ALPHA;
  return Math.min(1, alpha);
}

// The bar label's colour is a token of its own rather than `--sg-fg`, so restyling labels never
// disturbs the grid's and the panel's body text. It is read only when a label feature is on.

/** CSS custom property holding the colour of a bar label. */
export const LABEL_TOKEN = "--sg-bar-label-fg";

/** Colour of a bar label when the `--sg-bar-label-fg` token is unavailable. */
export const LABEL_COLOR = "#1c1917";

// The label font is a non-colour token: the value is a CSS font shorthand assigned verbatim to the
// 2d context's `font`; a value the context cannot parse leaves `font` unchanged, which is the
// context's own assignment semantics rather than anything checked here. The fallback is the canvas
// default, so a theme that does not set the token paints what this plugin painted without it.

/** CSS custom property holding the font of a bar label. */
export const LABEL_FONT_TOKEN = "--sg-bar-label-font";

/** Font of a bar label when the `--sg-bar-label-font` token is unavailable. */
export const LABEL_FONT = "12px system-ui, sans-serif";

// The inside-placement label paints on the bar's own fill rather than on the chart background, so
// it carries a token of its own.

/** CSS custom property holding the colour of an inside-placement bar label. */
export const INSIDE_LABEL_TOKEN = "--sg-bar-inside-label-fg";

/** Colour of an inside-placement label when its token is unavailable. */
export const INSIDE_LABEL_COLOR = "#ffffff";

// Corner rounding is a per-instance option or a non-colour theme token, byte-identical to the
// square look when both are absent.

/** CSS custom property holding the corner radius of ordinary task bars, in CSS px. */
export const RADIUS_TOKEN = "--sg-bar-radius";

// The two decorations beyond the radius. Both default to "off", so a composition that sets neither
// paints byte-identically to a chart without them.

/** CSS custom property holding the colour of a bar's outline. */
export const STROKE_TOKEN = "--sg-bar-stroke";

/** CSS custom property holding the width of a bar's outline, in CSS px. `0px` paints none. */
export const STROKE_WIDTH_TOKEN = "--sg-bar-stroke-width";

/** CSS custom property holding the strength of a bar's bevel overlay, unitless. `0` is flat. */
export const BEVEL_TOKEN = "--sg-bar-fill-bevel";

/** Height of a summary glyph's body, as a fraction of the bar box height. */
export const SUMMARY_BODY_RATIO = 0.45;

/** Height of a summary glyph's end caps, as a fraction of the bar box height. */
export const SUMMARY_CAP_RATIO = 0.55;

/** The built-in fill for a task, chosen by its type. */
export function defaultColorFor(task: Readonly<Task>): string {
  if (isMilestone(task)) return DEFAULT_MILESTONE_COLOR;
  if (isSummary(task)) return DEFAULT_SUMMARY_COLOR;
  return DEFAULT_BAR_COLOR;
}

function traceDiamond(g: CanvasRenderingContext2D, box: Rect): void {
  const cx = box.x + box.width / 2;
  const cy = box.y + box.height / 2;
  g.beginPath();
  g.moveTo(cx, box.y);
  g.lineTo(box.x + box.width, cy);
  g.lineTo(cx, box.y + box.height);
  g.lineTo(box.x, cy);
  g.closePath();
}

/**
 * Traces the outline of a summary glyph as one closed polygon: the body strip across the top, then
 * down the right cap's outer edge, along the underside between the two caps, and down/up the left
 * cap. It is the union of the three shapes `fillSummary` paints, so an outline or a bevel drawn on
 * it traces the glyph's silhouette rather than the seams between its parts.
 */
function traceSummary(g: CanvasRenderingContext2D, box: Rect): void {
  const body = Math.max(1, box.height * SUMMARY_BODY_RATIO);
  const cap = Math.min(box.height * SUMMARY_CAP_RATIO, box.width / 2);
  const top = box.y + body;
  const bottom = box.y + box.height;
  const right = box.x + box.width;
  g.beginPath();
  g.moveTo(box.x, box.y);
  g.lineTo(right, box.y);
  if (cap > 0) {
    g.lineTo(right, bottom);
    g.lineTo(right - cap, top);
    g.lineTo(box.x + cap, top);
    g.lineTo(box.x, bottom);
  } else {
    g.lineTo(right, top);
    g.lineTo(box.x, top);
  }
  g.closePath();
}

function fillSummary(g: CanvasRenderingContext2D, box: Rect): void {
  const body = Math.max(1, box.height * SUMMARY_BODY_RATIO);
  g.fillRect(box.x, box.y, box.width, body);
  // End caps taper down from the body; they are clamped so a narrow summary cannot grow caps
  // that overlap in the middle.
  const cap = Math.min(box.height * SUMMARY_CAP_RATIO, box.width / 2);
  if (cap <= 0) return;
  const top = box.y + body;
  const bottom = box.y + box.height;
  g.beginPath();
  g.moveTo(box.x, top);
  g.lineTo(box.x + cap, top);
  g.lineTo(box.x, bottom);
  g.closePath();
  g.fill();
  const right = box.x + box.width;
  g.beginPath();
  g.moveTo(right, top);
  g.lineTo(right - cap, top);
  g.lineTo(right, bottom);
  g.closePath();
  g.fill();
}

// The non-default milestone shapes. All fill the same square box the diamond is inscribed in, so
// nothing else changes with the choice.

function traceMilestone(g: CanvasRenderingContext2D, box: Rect, shape: MilestoneShape): void {
  const cx = box.x + box.width / 2;
  const cy = box.y + box.height / 2;
  g.beginPath();
  if (shape === "square") {
    g.rect(box.x, box.y, box.width, box.height);
  } else if (shape === "triangle") {
    g.moveTo(cx, box.y);
    g.lineTo(box.x + box.width, box.y + box.height);
    g.lineTo(box.x, box.y + box.height);
  } else if (shape === "star") {
    // A five-point star inscribed in the box, tip up; the inner radius is a conventional 0.4 of
    // the outer, which keeps the points readable at bar-height sizes.
    const outer = Math.min(box.width, box.height) / 2;
    const inner = outer * 0.4;
    for (let i = 0; i < 10; i += 1) {
      const r = i % 2 === 0 ? outer : inner;
      const angle = -Math.PI / 2 + (i * Math.PI) / 5;
      const px = cx + r * Math.cos(angle);
      const py = cy + r * Math.sin(angle);
      if (i === 0) g.moveTo(px, py);
      else g.lineTo(px, py);
    }
  } else {
    g.moveTo(cx, box.y);
    g.lineTo(box.x + box.width, cy);
    g.lineTo(cx, box.y + box.height);
    g.lineTo(box.x, cy);
  }
  g.closePath();
}

/** Which ends of a rounded rectangle actually get rounded. */
type RoundedEnds = "both" | "leading";

// Arc-based rounded-rectangle path; `roundRect` is avoided so the recording test context (and older
// canvas implementations) stay covered by the same code path. `ends` exists for the progress fill,
// whose trailing edge is the progress boundary — a straight cut, not the bar's own corner — until
// it reaches far enough right that the bar's trailing curve is what bounds it.
function traceRoundedRect(
  g: CanvasRenderingContext2D,
  box: Rect,
  radius: number,
  ends: RoundedEnds = "both",
): void {
  const r = Math.min(radius, box.width / 2, box.height / 2);
  const { x, y, width: w, height: h } = box;
  const tr = ends === "both" ? r : 0;
  g.beginPath();
  g.moveTo(x + r, y);
  g.lineTo(x + w - tr, y);
  if (tr > 0) g.arc(x + w - tr, y + tr, tr, -Math.PI / 2, 0);
  g.lineTo(x + w, y + h - tr);
  if (tr > 0) g.arc(x + w - tr, y + h - tr, tr, 0, Math.PI / 2);
  g.lineTo(x + r, y + h);
  g.arc(x + r, y + h - r, r, Math.PI / 2, Math.PI);
  g.lineTo(x, y + r);
  g.arc(x + r, y + r, r, Math.PI, Math.PI * 1.5);
  g.closePath();
}

// The pattern strokes are a translucent white over the fill, which reads on any bar colour without
// a second styling channel; the caller has already clipped the context to the bar's shape.
const PATTERN_STROKE = "rgba(255, 255, 255, 0.55)";
const PATTERN_SPACING = 6;

function strokePattern(g: CanvasRenderingContext2D, box: Rect, pattern: BarPattern): void {
  if (pattern === "none") return;
  if (pattern === "dots") {
    g.fillStyle = PATTERN_STROKE;
    for (let y = box.y + PATTERN_SPACING / 2; y < box.y + box.height; y += PATTERN_SPACING) {
      for (let x = box.x + PATTERN_SPACING / 2; x < box.x + box.width; x += PATTERN_SPACING) {
        g.beginPath();
        g.arc(x, y, 1, 0, Math.PI * 2);
        g.fill();
      }
    }
    return;
  }
  g.strokeStyle = PATTERN_STROKE;
  g.lineWidth = 1;
  g.beginPath();
  const reach = box.height;
  for (let x = box.x - reach; x < box.x + box.width; x += PATTERN_SPACING) {
    g.moveTo(x, box.y + box.height);
    g.lineTo(x + reach, box.y);
    if (pattern === "cross") {
      g.moveTo(x, box.y);
      g.lineTo(x + reach, box.y + box.height);
    }
  }
  g.stroke();
}

/** Per-call painting options of `paintBar`; every member optional, the default the classic look. */
export interface PaintBarOptions {
  /** Corner radius of an ordinary bar in CSS px; 0 or absent paints the classic square bar. */
  radius?: number | undefined;
  /** Overlay pattern; absent or `"none"` paints no pattern. */
  pattern?: BarPattern | undefined;
  /** Milestone marker shape; absent paints the classic diamond. */
  milestoneShape?: MilestoneShape | undefined;
  /** Outline colour; painted only when `strokeWidth` is positive. */
  stroke?: string | undefined;
  /** Outline width in CSS px; 0 or absent paints no outline. */
  strokeWidth?: number | undefined;
  /** Bevel strength, 0…1; 0 or absent paints no bevel. */
  bevel?: number | undefined;
}

// The outline and the bevel are painted on the *same path the fill used*, so a rounded bar gets a
// rounded outline and a milestone an outlined marker. Both take the shape as a tracing callback
// rather than re-deriving it, which is what keeps the three painters (fill, bevel, outline) from
// ever disagreeing about the silhouette.

/** Traces the shape a task's fill occupies, leaving it as the context's current path. */
type TraceShape = () => void;

/**
 * Overlays the bevel: a vertical white-to-black wash across the shape's own height, transparent
 * through the middle so the fill's own colour still reads. The gradient is built from constants,
 * never from the fill colour read back off the context, so a recoloured bar bevels identically.
 */
function overlayBevel(
  g: CanvasRenderingContext2D,
  box: Rect,
  bevel: number,
  trace: TraceShape,
): void {
  const strength = Math.min(1, bevel);
  // A recording proxy that reports gradients as untranscribable falls back to a raster tile; an
  // environment without the member at all simply paints no bevel.
  if (typeof g.createLinearGradient !== "function") return;
  const gradient = g.createLinearGradient(0, box.y, 0, box.y + box.height);
  gradient.addColorStop(0, `rgba(255, 255, 255, ${String(strength)})`);
  gradient.addColorStop(0.5, "rgba(255, 255, 255, 0)");
  gradient.addColorStop(1, `rgba(0, 0, 0, ${String(strength)})`);
  const entryFill = g.fillStyle;
  g.fillStyle = gradient;
  trace();
  g.fill();
  g.fillStyle = entryFill;
}

/** Strokes the shape's outline, centred on the path, and restores the entry stroke state. */
function outlineShape(
  g: CanvasRenderingContext2D,
  stroke: string,
  width: number,
  trace: TraceShape,
): void {
  const entryStroke = g.strokeStyle;
  const entryWidth = g.lineWidth;
  g.strokeStyle = stroke;
  g.lineWidth = width;
  trace();
  g.stroke();
  g.strokeStyle = entryStroke;
  g.lineWidth = entryWidth;
}

/** Paints the bevel then the outline over a shape already filled, in that order. */
function decorateShape(
  g: CanvasRenderingContext2D,
  box: Rect,
  options: PaintBarOptions | undefined,
  trace: TraceShape,
): void {
  const bevel = options?.bevel ?? 0;
  if (Number.isFinite(bevel) && bevel > 0) overlayBevel(g, box, bevel, trace);
  const width = options?.strokeWidth ?? 0;
  const stroke = options?.stroke ?? "";
  if (Number.isFinite(width) && width > 0 && stroke !== "") outlineShape(g, stroke, width, trace);
}

/**
 * Draws one task into its box, in the given fill colour.
 *
 * Milestones are drawn as a marker (a diamond unless another shape is chosen) and summaries as a
 * capped bar; an ordinary task is drawn as a rectangle — optionally rounded — in which the
 * completed fraction is painted at full opacity and the remainder at `trackAlpha` (the built-in
 * fraction when omitted), so progress reads as more of the same colour. A task with no progress is
 * all track and one that is fully complete is all solid. Milestones carry no duration and a
 * summary's dates are rolled up from its children, so neither shows progress at all. An overlay
 * pattern, when requested, is stroked clipped to the shape.
 *
 * The caller is responsible for saving and restoring the canvas state around this call; this
 * function leaves `globalAlpha` as it found it regardless.
 */
export function paintBar(
  g: CanvasRenderingContext2D,
  box: Rect,
  task: Readonly<Task>,
  color: string,
  trackAlpha: number = DEFAULT_TRACK_ALPHA,
  options?: PaintBarOptions,
): void {
  const pattern = options?.pattern ?? "none";
  g.fillStyle = color;
  if (isMilestone(task)) {
    const shape = options?.milestoneShape ?? "diamond";
    const trace: TraceShape =
      shape === "diamond" ? () => traceDiamond(g, box) : () => traceMilestone(g, box, shape);
    trace();
    g.fill();
    decorateShape(g, box, options, trace);
    if (pattern !== "none") {
      g.save();
      traceMilestone(g, box, shape);
      g.clip();
      strokePattern(g, box, pattern);
      g.restore();
    }
    return;
  }
  if (isSummary(task)) {
    fillSummary(g, box);
    decorateShape(g, box, options, () => traceSummary(g, box));
    if (pattern !== "none") {
      // The summary body strip is the part wide enough to carry a readable pattern.
      const body = { ...box, height: Math.max(1, box.height * SUMMARY_BODY_RATIO) };
      g.save();
      g.beginPath();
      g.rect(body.x, body.y, body.width, body.height);
      g.clip();
      strokePattern(g, body, pattern);
      g.restore();
    }
    return;
  }
  const radius = options?.radius ?? 0;
  const progress = clampProgress(task.progress);
  // The remainder is the same fill at a lower opacity. A fully complete bar has no remainder, so it
  // skips the track and paints one opaque body — byte-identical to a plain bar.
  if (progress < 1) {
    const entryAlpha = g.globalAlpha;
    g.globalAlpha = entryAlpha * resolveAlpha(trackAlpha);
    if (radius > 0) {
      traceRoundedRect(g, box, radius);
      g.fill();
    } else {
      g.fillRect(box.x, box.y, box.width, box.height);
    }
    g.globalAlpha = entryAlpha;
  }
  if (progress > 0) {
    const filled = box.width * progress;
    if (radius > 0) {
      // The completed part traces its own path rather than being clipped to the bar's: `clip()` is
      // one of the canvas members a vector export's recording proxy cannot transcribe, so clipping
      // here would silently drop the whole bar layer to a raster image in every vector export. Its
      // leading corners follow the bar's rounding; its trailing corners are square unless the fill
      // reaches far enough right to meet the bar's own trailing curve.
      traceRoundedRect(
        g,
        { ...box, width: filled },
        radius,
        filled >= box.width - radius ? "both" : "leading",
      );
      g.fill();
    } else {
      g.fillRect(box.x, box.y, filled, box.height);
    }
  }
  // The decorations trace the *bar's* shape, not the completed part's, so a half-finished bar wears
  // one continuous outline and one continuous bevel across both opacities.
  decorateShape(g, box, options, () => {
    if (radius > 0) {
      traceRoundedRect(g, box, radius);
      return;
    }
    g.beginPath();
    g.rect(box.x, box.y, box.width, box.height);
  });
  if (pattern !== "none") {
    g.save();
    if (radius > 0) traceRoundedRect(g, box, radius);
    else {
      g.beginPath();
      g.rect(box.x, box.y, box.width, box.height);
    }
    g.clip();
    strokePattern(g, box, pattern);
    g.restore();
  }
}
