/**
 * Painting the header band, from the geometry `header-layout.ts` computes: once onto the dedicated
 * header canvas (§3.5) and once as SVG markup for a vector export tile.
 *
 * The band is deliberately *not* a `renderer/layers` contribution — the header owns its own canvas,
 * and `timeline-scale` is not one of the plugins that contribute renderer layers.
 *
 * Internal: not part of the published surface.
 */
import { computeHeaderRows } from "./header-layout";
import type { HeaderDrawOptions } from "./header-options";

// docs/specs/plugins/view.md — the header's total height is the
// `--sg-header-height` theme token; this constant is only the fallback when the token resolves to
// nothing.
/** Total header height, in CSS pixels, used when the `--sg-header-height` token is unavailable. */
export const DEFAULT_HEADER_HEIGHT = 44;

// docs/specs/plugins/view.md — what used to be internal constants are now the
// `headerRowRatio` / `headerLabelPadding` options; these are their defaults, which reproduce the
// previous output byte-for-byte.
/** Left padding of a boundary label inside its cell, in CSS pixels, when none is configured. */
export const DEFAULT_LABEL_PADDING = 4;

/** The top row's share of the total header height when none is configured: an even split. */
export const DEFAULT_ROW_RATIO = 0.5;

/**
 * The configured top-row share, or the even-split default when the value is unusable.
 *
 * Host configuration, so anything that is not a finite number strictly between 0 and 1 degrades
 * to the default rather than collapsing a row.
 */
export function normalizeRowRatio(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 && value < 1
    ? value
    : DEFAULT_ROW_RATIO;
}

/** The configured label padding, or the default when the value is not a finite number ≥ 0. */
export function normalizeLabelPadding(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? value
    : DEFAULT_LABEL_PADDING;
}

// docs/specs/plugins/view.md
// the `--sg-header-font` token's documented default, which docs/specs/plugins/view.md invariant 1
// requires this constant to equal. lifted it off the canvas 2D default of `10px sans-serif`:
// day numbers and month captions are content, and 10px is below the legibility floor for content.
/** Header label font used when the `--sg-header-font` token resolves to nothing. */
export const FALLBACK_FONT = "12px system-ui, sans-serif";

// docs/specs/plugins/view.md — fallbacks for the header paint tokens, matching the
// light-mode defaults of `--sg-header-fg` / `--sg-header-bg` / `--sg-header-tick` in styles.css
// (fg/tick values).
const FALLBACK_FG = "#1c1917";
const FALLBACK_BG = "#ffffff";
const FALLBACK_BORDER = "#8a8580";
// the fine tier's cell separators are ground; this is `--sg-grid-line-major`'s light
// value, so the header's day ticks match the body's coarse gridlines in weight.
const FALLBACK_BORDER_MINOR = "#e7e5e4";

/** Resolved paint colours/fonts, falling back to the built-in light-mode defaults per token. */
interface ResolvedHeaderStyle {
  fg: string;
  bg: string;
  border: string;
  borderMinor: string;
  font: string;
  fontMajor: string;
}

// docs/specs/plugins/view.md
// CSS custom properties are the single source of truth for colour and font; the caller
// resolves them through `stargantt.theme` and an empty string (token unset, theme unavailable)
// falls back to the built-in light-mode defaults. Shared by the on-screen canvas paint and the
// export tile paths (raster and SVG) so both resolve tokens identically.
function resolveHeaderStyle(
  o: Pick<HeaderDrawOptions, "fg" | "bg" | "border" | "borderMinor" | "font" | "fontMajor">,
): ResolvedHeaderStyle {
  return {
    fg: o.fg !== "" ? o.fg : FALLBACK_FG,
    bg: o.bg !== "" ? o.bg : FALLBACK_BG,
    border: o.border !== "" ? o.border : FALLBACK_BORDER,
    borderMinor: o.borderMinor !== "" ? o.borderMinor : FALLBACK_BORDER_MINOR,
    font: resolveFont(o.font),
    fontMajor: resolveMajorFont(o.fontMajor, o.font),
  };
}

/**
 * The font a header paint actually uses: the `--sg-header-font` token value, or the built-in
 * default when the token is unavailable.
 *
 * Exported so the caller can key its text-measurement memo (§1.7.1/§1.7.2) on the
 * same resolved font the paint itself uses — measuring against an un-resolved empty string would
 * under-report every label's width.
 */
export function resolveFont(font: string): string {
  return font !== "" ? font : FALLBACK_FONT;
}

/**
 * The font the coarse header tier paints in: the `--sg-header-major-font` token value, or the fine
 * tier's own resolved font when that token is unavailable.
 *
 * Falling back to the fine tier rather than to a built-in heavier font keeps a theme that sets only
 * `--sg-header-font` painting both tiers alike, which is what a host overriding one token expects.
 * Exported alongside `resolveFont` so the measurement memo can be keyed on the same resolved value
 * the coarse tier actually paints with.
 */
export function resolveMajorFont(fontMajor: string, font: string): string {
  return fontMajor !== "" ? fontMajor : resolveFont(font);
}

export function drawHeader(g: CanvasRenderingContext2D, o: HeaderDrawOptions): void {
  const height = o.height;
  g.clearRect(0, 0, o.width, height);
  if (o.width <= 0 || height <= 0 || o.level.scales.length === 0) return;

  const { fg, bg, border, borderMinor, font, fontMajor } = resolveHeaderStyle(o);
  g.fillStyle = bg;
  g.fillRect(0, 0, o.width, height);
  g.textBaseline = "middle";

  // docs/specs/plugins/view.md — when this canvas is a shared,
  // per-tile export band, the previous tile's paint and this tile's paint are two calls
  // against the *same* canvas, offset by a translate. Without a clip, a label that overflows past
  // `o.width` bleeds into the next tile's region and is then overwritten by that tile's own
  // background fill — a boundary artifact that depends on paint order rather than tile content.
  // Clipping every tile to its own box makes each tile self-contained, matching `drawHeaderSVG`'s
  // clip (below) so both paths agree on what "the same tile" looks like at a seam.
  g.save();
  g.beginPath();
  g.rect(0, 0, o.width, height);
  g.clip();

  for (const row of computeHeaderRows(o)) {
    // the cell separators take their tier's weight — the coarse tier's month/week
    // boundaries stay figure, the fine tier's day ticks drop to ground — while the row rule under
    // each tier keeps the figure weight, since it is the band's own structural edge.
    g.strokeStyle = row.tier === "major" ? border : borderMinor;
    g.beginPath();
    for (const x of row.separators) {
      g.moveTo(x, row.top);
      g.lineTo(x, row.bottomY);
    }
    g.stroke();
    g.strokeStyle = border;
    g.beginPath();
    g.moveTo(0, row.bottomY);
    g.lineTo(o.width, row.bottomY);
    g.stroke();

    // each tier paints in its own font, and the same font its labels were measured in.
    g.font = row.tier === "major" ? fontMajor : font;
    g.fillStyle = fg;
    for (const label of row.labels) g.fillText(label.text, label.x, label.y);
  }

  g.restore();
}

function escapeSVGText(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

// Monotonic counter giving each `drawHeaderSVG` call's `<clipPath>` a document-unique id — several
// tiles' markup is concatenated into one SVG document by the export compose pass (§3 of
// docs/specs/plugins/view.md), so a fixed id would collide across
// tiles and an unreferenced/duplicate id is undefined behavior in SVG.
let svgClipIdCounter = 0;

// docs/specs/plugins/view.md — `AuxiliarySurfaceContribution.drawTileSVG` /
// §3 "Auxiliary-surface compose pass" / docs/specs/plugins/view.md — the SVG
// counterpart of `drawHeader`: same geometry (`computeHeaderRows`), emitted as vector markup
// instead of canvas calls, so an SVG export gets a true-vector header rather than an embedded
// raster image. The output is wrapped in its own `<clipPath>`-bounded `<g>`, matching `drawHeader`'s
// canvas clip, so a tile is self-contained the same way in both paths (docs/specs/plugins/view.md).
/**
 * Renders the header, for the geometry `o` describes, as SVG markup instead of canvas calls.
 *
 * Produces the same background, grid lines and labels `drawHeader` paints — same tokens, same
 * `ScaleRow.format` fault barrier — as `<rect>`, `<line>` and `<text>` elements, clipped to the
 * same box `drawHeader` clips its canvas painting to. Returns an empty string when there is
 * nothing to draw (zero-sized box or no scale rows), mirroring `drawHeader`'s early return.
 */
export function drawHeaderSVG(o: HeaderDrawOptions): string {
  if (o.width <= 0 || o.height <= 0 || o.level.scales.length === 0) return "";

  const { fg, bg, border, borderMinor, font, fontMajor } = resolveHeaderStyle(o);
  const clipId = `sg-header-clip-${svgClipIdCounter++}`;
  const parts: string[] = [
    `<clipPath id="${clipId}"><rect x="0" y="0" width="${o.width}" height="${o.height}"/></clipPath>`,
    `<rect x="0" y="0" width="${o.width}" height="${o.height}" fill="${escapeSVGText(bg)}"/>`,
  ];

  for (const row of computeHeaderRows(o)) {
    //, as in `drawHeader`: the tier decides the cell separators' weight.
    const tick = row.tier === "major" ? border : borderMinor;
    for (const x of row.separators) {
      parts.push(
        `<line x1="${x}" y1="${row.top}" x2="${x}" y2="${row.bottomY}" stroke="${escapeSVGText(tick)}"/>`,
      );
    }
    parts.push(
      `<line x1="0" y1="${row.bottomY}" x2="${o.width}" y2="${row.bottomY}" stroke="${escapeSVGText(border)}"/>`,
    );
    // the tier's own font, matching what `drawHeader` paints and what the labels were
    // measured in, so the raster and SVG export paths stay byte-comparable.
    const rowFont = row.tier === "major" ? fontMajor : font;
    for (const label of row.labels) {
      parts.push(
        `<text x="${label.x}" y="${label.y}" fill="${escapeSVGText(fg)}" ` +
          `style="font:${escapeSVGText(rowFont)}" dominant-baseline="middle">${escapeSVGText(label.text)}</text>`,
      );
    }
  }

  return `<g clip-path="url(#${clipId})">${parts.join("")}</g>`;
}
