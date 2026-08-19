/**
 * The text-shaped painting of `stargantt.task-bars`: bar labels with their halo backdrops and
 * same-side layout, the bar-end icon glyphs, and the assignee avatar badge.
 *
 * Split out of `./paint` (which owns the bar bodies and the theme token names) so neither module
 * outgrows this repository's per-file size budget; the two are one painting layer conceptually and
 * share the label colour and font tokens declared in `./paint`.
 */
import type { BarAvatar, LabelPlacement } from "../types";
import type { Rect } from "./geometry";
import { INSIDE_LABEL_COLOR, LABEL_COLOR, LABEL_FONT } from "./paint";

/**
 * Gap between a bar's right edge and the start of its label, in CSS px.
 */
// The strip immediately outside a bar's edge is where other plugins draw bar-end adornments (the
// built-in case being a connector port, whose painted disc occupies `edge + 9` … `edge + 17` CSS
// px), and 20 is the first offset that clears it; the offset does not need to clear the port's
// larger, transparent hit target.
export const LABEL_GAP = 20;

// The width of the strip outside a bar's edge is not guessed from another plugin's geometry: it is
// the resolved end gutter, published on the bar's own box. The label clears it by this margin
// rather than merely touching it, and the historical 20 px stays as the floor — which is what the
// port's disc (`edge + 9` … `edge + 17`) needs with exactly this margin, so a gutter of 17 px or
// less paints where labels always did.
/** Breathing space kept between the reserved gutter and the first glyph of a label, in CSS px. */
export const LABEL_GUTTER_MARGIN = 3;

/** How far outside a bar's edge its first label starts, given that end's reserved gutter. */
export function labelOffset(gutter: number | undefined): number {
  if (typeof gutter !== "number" || !Number.isFinite(gutter) || gutter <= 0) return LABEL_GAP;
  return Math.max(LABEL_GAP, gutter + LABEL_GUTTER_MARGIN);
}

/** A bar's rectangle plus, where the caller has them, the reservations outside its two edges. */
export interface LabelBox extends Rect {
  gutterStart?: number | undefined;
  gutterEnd?: number | undefined;
}

/**
 * Draws one bar's label immediately to the right of its box, vertically centred on it.
 *
 * One line, no wrapping, no ellipsis and no measurement: text that runs past the right edge of the
 * viewport is cut off by the layer canvas itself. The caller is responsible for saving and
 * restoring the canvas state around this call, and for having checked that the text is non-empty.
 */
export function drawLabel(
  g: CanvasRenderingContext2D,
  box: LabelBox,
  text: string,
  color: string = LABEL_COLOR,
  font: string = LABEL_FONT,
): void {
  g.fillStyle = color;
  g.font = font;
  g.textBaseline = "middle";
  g.textAlign = "left";
  g.fillText(text, box.x + box.width + labelOffset(box.gutterEnd), box.y + box.height / 2);
}

/**
 * Scratch for the inside run's measured widths, reused across calls so the layout costs no
 * allocation of its own. Safe as module state: painting is synchronous and single-threaded, and the
 * array never outlives one `drawPlacedLabels` call.
 */
const insideWidths: number[] = [];

/** One label of a group, as `drawPlacedLabels` needs it. */
export interface GroupLabel {
  text: string;
  placement: LabelPlacement;
  /** Colour for this label; an inside label is measured against its own bar. */
  color: string;
}

// A label outside the bar sits on the chart background, which dependency lines cross. Painting the
// labels above the lines stops the line overwriting the glyphs, but a stroke running behind them
// still cuts the text up; a halo the width of the text is what makes it read.

/** CSS custom property holding the fill painted behind a label drawn outside its bar. */
export const LABEL_BACKDROP_TOKEN = "--sg-bar-label-backdrop";

/** Backdrop fill when the token is unset — the light-scheme chart background at most of its alpha. */
export const LABEL_BACKDROP_COLOR = "rgba(255, 255, 255, 0.82)";

/** Padding around a label's text box, in CSS px. */
export const LABEL_BACKDROP_PADDING = 2;

/** Corner radius of a label's backdrop, in CSS px. */
export const LABEL_BACKDROP_RADIUS = 3;

/** The resolved backdrop for one pass, or `undefined` when the option is off. */
export interface LabelBackdrop {
  color: string;
  padding: number;
  radius: number;
}

/**
 * Fills the backdrop behind one outside-placement label.
 *
 * `x` is the text's left edge and `cy` its middle, matching how `drawPlacedLabels` positions text;
 * `height` is the bar's, so a run of labels beside one bar gets one consistent band rather than a
 * per-glyph box. The caller owns `fillStyle` afterwards — this sets it.
 */
export function drawLabelBackdrop(
  g: CanvasRenderingContext2D,
  backdrop: Readonly<LabelBackdrop>,
  x: number,
  cy: number,
  width: number,
  height: number,
): void {
  const pad = backdrop.padding;
  const top = cy - height / 2;
  g.fillStyle = backdrop.color;
  fillRounded(g, x - pad, top, width + pad * 2, height, backdrop.radius);
}

/** Fills a rectangle whose corners are rounded to `radius`, clamped to half its smaller side. */
function fillRounded(
  g: CanvasRenderingContext2D,
  x: number,
  y: number,
  width: number,
  height: number,
  radius: number,
): void {
  if (!(width > 0) || !(height > 0)) return;
  const r = Math.max(0, Math.min(radius, width / 2, height / 2));
  if (r === 0) {
    g.fillRect(x, y, width, height);
    return;
  }
  g.beginPath();
  g.moveTo(x + r, y);
  g.arcTo(x + width, y, x + width, y + height, r);
  g.arcTo(x + width, y + height, x, y + height, r);
  g.arcTo(x, y + height, x, y, r);
  g.arcTo(x, y, x + width, y, r);
  g.closePath();
  g.fill();
}

// Up to three labels can name the same side of one bar (the host provider's, the duration label and
// the progress label). Drawing each at its side's single anchor printed them on top of each other,
// so a bar could read `Data migrati8d`. Labels that share a side are laid out along it instead, in
// the order they were collected, each starting where the previous one ended.
/**
 * Draws every label of one bar, laying out the labels that share a side along that side.
 *
 * `"right"` runs outward from the right edge, `"left"` outward from the left edge, and the
 * `"inside"` group is centred inside the box as one run and clipped to it so text never spills onto
 * neighbouring bars. A side carrying a single label paints exactly where it did before the group
 * layout existed: one {@link labelOffset} past the right edge, the same before the left edge, or
 * centred on the box. Each side's offset clears whatever gutter that end of the box reserves; the
 * gap *between* two labels sharing a side stays `LABEL_GAP`, since nothing is reserved there.
 *
 * The caller saves and restores the canvas state.
 */
export function drawPlacedLabels(
  g: CanvasRenderingContext2D,
  box: LabelBox,
  labels: readonly GroupLabel[],
  font: string,
  backdrop?: Readonly<LabelBackdrop> | undefined,
  measure?: (g: CanvasRenderingContext2D, text: string) => number,
): void {
  if (labels.length === 0) return;
  // The view's LRU `textWidth` cache when the caller wires it (it keys on `g.font`, set just
  // below), a raw per-call `measureText` otherwise.
  const widthOf =
    measure ?? ((ctx: CanvasRenderingContext2D, text: string) => ctx.measureText(text).width);
  g.font = font;
  g.textBaseline = "middle";
  const cy = box.y + box.height / 2;

  // The two sides beside the bar are drawn first and the inside run last: the inside run paints
  // under a clip, and an outside label drawn while that clip is active would be cut away by it.
  // Each label is measured exactly once — the widths of the inside run are kept for its second
  // pass, since `measureText` allocates a `TextMetrics` and this runs per labelled bar per frame.
  let rightX = box.x + box.width + labelOffset(box.gutterEnd);
  let leftX = box.x - labelOffset(box.gutterStart);
  let insideWidth = 0;
  insideWidths.length = 0;
  for (const label of labels) {
    if (label.placement === "inside") {
      const width = widthOf(g, label.text);
      insideWidths.push(width);
      insideWidth += width;
      continue;
    }
    // The backdrop covers only the text it sits behind, so the dependency line stays visible either
    // side of the label instead of being blanked across the whole gap.
    const width = widthOf(g, label.text);
    if (backdrop !== undefined) {
      const left = label.placement === "right" ? rightX : leftX - width;
      drawLabelBackdrop(g, backdrop, left, cy, width, box.height);
    }
    g.fillStyle = label.color;
    if (label.placement === "right") {
      g.textAlign = "left";
      g.fillText(label.text, rightX, cy);
      rightX += width + LABEL_GAP;
    } else {
      g.textAlign = "right";
      g.fillText(label.text, leftX, cy);
      leftX -= width + LABEL_GAP;
    }
  }
  if (insideWidths.length === 0) return;

  // One clip for the whole inside run: the group is laid out across the bar, so clipping each
  // label to the bar separately would cost a save/restore pair per label for the same rectangle.
  let insideX =
    box.x + box.width / 2 - (insideWidth + LABEL_GAP * (insideWidths.length - 1)) / 2;
  g.save();
  g.beginPath();
  g.rect(box.x, box.y, box.width, box.height);
  g.clip();
  g.textAlign = "left";
  let i = 0;
  for (const label of labels) {
    if (label.placement !== "inside") continue;
    g.fillStyle = label.color;
    g.fillText(label.text, insideX, cy);
    insideX += (insideWidths[i] ?? 0) + LABEL_GAP;
    i += 1;
  }
  g.restore();
}

// End icons and the avatar badge sit on the bar itself, so they use the inside-label foreground and
// the label font.

/** Narrowest bar (relative to its height) that still carries end icons. */
export const MIN_ICONED_WIDTH_RATIO = 2;

/**
 * Draws the end icon glyphs centred inside the two ends of a bar. Bars narrower than twice their
 * height draw no icons — there is no room for a glyph per end. The caller saves/restores state.
 */
export function drawBarIcons(
  g: CanvasRenderingContext2D,
  box: Rect,
  left: string | undefined,
  right: string | undefined,
  color: string,
  font: string,
): void {
  if (box.width < box.height * MIN_ICONED_WIDTH_RATIO) return;
  g.fillStyle = color;
  g.font = font;
  g.textBaseline = "middle";
  g.textAlign = "center";
  const cy = box.y + box.height / 2;
  if (left !== undefined && left !== "") g.fillText(left, box.x + box.height / 2, cy);
  if (right !== undefined && right !== "") {
    g.fillText(right, box.x + box.width - box.height / 2, cy);
  }
}

/** Fill of an avatar badge when its `color` member is omitted or empty. */
export const AVATAR_COLOR = "#5b6470";

// The badge's circle is fixed to the bar height, so the initials are fitted to the circle rather
// than the circle grown to the initials: a badge that resized with its text would change the space
// a bar occupies.

/** The fraction of the badge's diameter the initials may occupy, keeping glyphs off the curve. */
export const AVATAR_TEXT_FIT = 0.8;

/** The smallest font scale the fit ladder shrinks the initials to before it starts truncating. */
export const AVATAR_MIN_FONT_SCALE = 0.6;

/** The initials to paint and the font scale to paint them at. */
export interface AvatarTextFit {
  text: string;
  /** Multiplier applied to the label font's px size; between AVATAR_MIN_FONT_SCALE and 1. */
  scale: number;
}

/**
 * One shared segmenter for the module, created lazily on the first truncation: `new
 * Intl.Segmenter` loads locale data and is far too expensive to construct per avatar per frame.
 * `null` = the platform has no `Intl.Segmenter`; `undefined` = not yet resolved.
 */
let graphemeSegmenter: Intl.Segmenter | null | undefined;

/**
 * Splits text into grapheme clusters, so truncation never cuts a combining mark, a surrogate pair
 * or a ZWJ emoji sequence in half. Falls back to code points where `Intl.Segmenter` is missing.
 */
function graphemesOf(text: string): string[] {
  if (graphemeSegmenter === undefined) {
    const Segmenter = (Intl as { Segmenter?: typeof Intl.Segmenter }).Segmenter;
    graphemeSegmenter =
      typeof Segmenter === "function" ? new Segmenter(undefined, { granularity: "grapheme" }) : null;
  }
  if (graphemeSegmenter === null) return [...text];
  const parts: string[] = [];
  for (const part of graphemeSegmenter.segment(text)) {
    parts.push(part.segment);
  }
  return parts;
}

/**
 * Fits initials into `usable` CSS px: shrink the font first, down to `AVATAR_MIN_FONT_SCALE`, then
 * drop trailing grapheme clusters at that size. Returns `undefined` when not even one cluster
 * fits, which means the badge is painted as a plain disc.
 *
 * `measure` reports the width of a string at full font size. The shrink factor is computed from
 * that one measurement rather than by re-measuring after each font change: advance widths scale
 * linearly with the px size for a fixed family, and one measurement per badge keeps this off the
 * hot path's allocation budget.
 */
export function fitAvatarText(
  measure: (s: string) => number,
  text: string,
  usable: number,
): AvatarTextFit | undefined {
  if (!(usable > 0)) return undefined;
  const full = measure(text);
  // A measurement of zero (or a nonsensical one) is no reason to withhold the text.
  if (!(full > 0)) return { text, scale: 1 };
  if (full <= usable) return { text, scale: 1 };
  const scale = Math.max(AVATAR_MIN_FONT_SCALE, usable / full);
  if (full * scale <= usable) return { text, scale };
  const parts = graphemesOf(text);
  for (let n = parts.length - 1; n >= 1; n -= 1) {
    const candidate = parts.slice(0, n).join("");
    if (measure(candidate) * AVATAR_MIN_FONT_SCALE <= usable) {
      return { text: candidate, scale: AVATAR_MIN_FONT_SCALE };
    }
  }
  return undefined;
}

/** Matches the px size of a CSS font shorthand — the one part of it a scale may touch. */
const FONT_PX_PATTERN = /(\d*\.?\d+)px/;

/**
 * Returns the font shorthand with its px size multiplied by `scale`, rounded to one decimal.
 * A scale of 1 (or a shorthand with no px size) is returned unchanged.
 */
export function scaleFontSize(font: string, scale: number): string {
  if (scale >= 1) return font;
  return font.replace(FONT_PX_PATTERN, (whole, digits: string) => {
    const size = Number.parseFloat(digits);
    if (!Number.isFinite(size)) return whole;
    return `${Math.max(1, Math.round(size * scale * 10) / 10)}px`;
  });
}

/**
 * Draws an assignee badge — a filled circle with initials — centred on the bar's right end,
 * overlapping the bar rather than the strip outside it (that strip is reserved for bar-end
 * adornments such as dependency ports). The initials are shrunk, then truncated at grapheme
 * boundaries, to stay inside the circle; a badge with room for no cluster at all is painted as a
 * plain disc. The caller saves/restores state.
 */
export function drawAvatar(
  g: CanvasRenderingContext2D,
  box: Rect,
  avatar: Readonly<BarAvatar>,
  color: string,
  font: string,
): void {
  const r = Math.max(1, box.height / 2 - 1);
  const cx = box.x + box.width - box.height / 2;
  const cy = box.y + box.height / 2;
  const fill = typeof avatar.color === "string" && avatar.color !== "" ? avatar.color : AVATAR_COLOR;
  g.fillStyle = fill;
  g.beginPath();
  g.arc(cx, cy, r, 0, Math.PI * 2);
  g.fill();
  const initials = avatar.initials;
  if (typeof initials !== "string" || initials === "") return;
  // Measurement is font-sensitive, so the base font is installed before the fit is computed.
  g.font = font;
  const fit = fitAvatarText((s) => g.measureText(s).width, initials, r * 2 * AVATAR_TEXT_FIT);
  if (fit === undefined) return;
  // Initials follow the theme's inside-label foreground; the constant is only the missing-token
  // fallback.
  g.fillStyle = color !== "" ? color : INSIDE_LABEL_COLOR;
  g.font = scaleFontSize(font, fit.scale);
  g.textBaseline = "middle";
  g.textAlign = "center";
  g.fillText(fit.text, cx, cy);
}
