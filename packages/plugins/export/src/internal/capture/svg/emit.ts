// docs/specs/plugins/export.md §9 — internal module: not part of the published surface.
/**
 * The recording proxy's emitters: one drawing state plus one shape's geometry turned into the SVG
 * element that reproduces it, and the presentation attributes they share.
 *
 * Pure string functions — they read a `DrawState` and return markup, holding no state of their own,
 * which is what makes the Canvas2D-to-SVG attribute mapping testable on its own.
 *
 * Not part of the package's published surface.
 */
import { escapeAttr, escapeText } from "../xml";
import { num } from "./format";
import { isIdentity, meanScale } from "./matrix";
import type { DrawState } from "./state";

/** `textAlign` values mapped to `text-anchor`; `"start"` is the SVG default and is left out. */
const ANCHOR: Record<string, string> = {
  left: "start",
  start: "start",
  center: "middle",
  right: "end",
  end: "end",
};

/** `textBaseline` values mapped to `dominant-baseline`; `"alphabetic"` is the default. */
const BASELINE: Record<string, string> = {
  top: "text-before-edge",
  hanging: "hanging",
  middle: "central",
  alphabetic: "alphabetic",
  ideographic: "ideographic",
  bottom: "text-after-edge",
};

/** `opacity="…"`, or `""` when the state is fully opaque (or its alpha is unusable). */
export function alphaAttr(s: DrawState): string {
  const a = s.globalAlpha;
  return a >= 1 || !Number.isFinite(a) ? "" : `opacity="${num(a)}"`;
}

/** `transform="matrix(...)"`, or `""` when the CTM is the identity. */
export function transformAttr(s: DrawState): string {
  const m = s.ctm;
  if (isIdentity(m)) return "";
  return `transform="matrix(${m.map(num).join(" ")})"`;
}

/**
 * Stroke presentation attributes.
 *
 * Path geometry is recorded in device space, so its width and dash pattern are pre-scaled by the
 * CTM; rectangles and text carry the CTM as a `transform`, so theirs are not — that is what
 * `inTransformedSpace` selects.
 */
export function strokeAttrs(s: DrawState, inTransformedSpace = false): string {
  const width = inTransformedSpace ? s.lineWidth : s.lineWidth * meanScale(s.ctm);
  const attrs = [`stroke="${escapeAttr(s.strokeStyle)}"`, `stroke-width="${num(width)}"`];
  if (s.lineCap !== "butt") attrs.push(`stroke-linecap="${escapeAttr(s.lineCap)}"`);
  if (s.lineJoin !== "miter") attrs.push(`stroke-linejoin="${escapeAttr(s.lineJoin)}"`);
  if (s.dash.length > 0) {
    const scale = inTransformedSpace ? 1 : meanScale(s.ctm);
    attrs.push(`stroke-dasharray="${s.dash.map((d) => num(d * scale)).join(" ")}"`);
  }
  const alpha = alphaAttr(s);
  if (alpha !== "") attrs.push(alpha);
  return attrs.join(" ");
}

/** `x`/`y`/`width`/`height` for a rectangle, with negative extents normalized to a positive box. */
export function rectGeometry(x: number, y: number, w: number, h: number): string {
  const rx = w < 0 ? x + w : x;
  const ry = h < 0 ? y + h : y;
  return `x="${num(rx)}" y="${num(ry)}" width="${num(Math.abs(w))}" height="${num(Math.abs(h))}"`;
}

/** A filled `<path>` for already-device-space geometry; `rule` takes `fill()`'s winding argument. */
export function fillPathElement(s: DrawState, d: string, rule?: string): string {
  const attrs = [`d="${d}"`, `fill="${escapeAttr(s.fillStyle)}"`];
  if (rule === "evenodd") attrs.push(`fill-rule="evenodd"`);
  const alpha = alphaAttr(s);
  if (alpha !== "") attrs.push(alpha);
  return `<path ${attrs.join(" ")}/>`;
}

/** A stroked `<path>` for already-device-space geometry. */
export function strokePathElement(s: DrawState, d: string): string {
  return `<path d="${d}" fill="none" ${strokeAttrs(s)}/>`;
}

/** A filled `<rect>`, carrying the CTM as a `transform` when it is not the identity. */
export function fillRectElement(
  s: DrawState,
  x: number,
  y: number,
  w: number,
  h: number,
): string {
  const attrs = [rectGeometry(x, y, w, h), `fill="${escapeAttr(s.fillStyle)}"`];
  const alpha = alphaAttr(s);
  if (alpha !== "") attrs.push(alpha);
  const t = transformAttr(s);
  if (t !== "") attrs.push(t);
  return `<rect ${attrs.join(" ")}/>`;
}

/** A stroked `<rect>`, carrying the CTM as a `transform` when it is not the identity. */
export function strokeRectElement(
  s: DrawState,
  x: number,
  y: number,
  w: number,
  h: number,
): string {
  const attrs = [rectGeometry(x, y, w, h), `fill="none"`, strokeAttrs(s, true)];
  const t = transformAttr(s);
  if (t !== "") attrs.push(t);
  return `<rect ${attrs.join(" ")}/>`;
}

/**
 * A `<text>` element for `fillText` / `strokeText`.
 *
 * The anchor and baseline attributes are written only when they differ from the SVG defaults, a
 * finite `maxWidth` becomes `textLength` + `lengthAdjust`, and the CTM rides along as a `transform`
 * exactly as it does for rectangles.
 */
export function textElement(
  s: DrawState,
  text: string,
  x: number,
  y: number,
  maxWidth: number | undefined,
  stroked: boolean,
): string {
  // A `;` inside the font string (an edge-case font-family name, in practice) would otherwise
  // terminate the `font:` declaration early and let whatever follows be read as a second CSS
  // declaration; `escapeAttr` only guards the surrounding XML attribute syntax, not CSS
  // declaration syntax, so the semicolon is additionally escaped as a CSS character escape.
  const font = escapeAttr(s.font).replace(/;/g, "\\3b ");
  const attrs = [`x="${num(x)}"`, `y="${num(y)}"`, `style="font: ${font}"`];
  const anchor = ANCHOR[s.textAlign];
  if (anchor !== undefined && anchor !== "start") attrs.push(`text-anchor="${anchor}"`);
  const baseline = BASELINE[s.textBaseline];
  if (baseline !== undefined && baseline !== "alphabetic") {
    attrs.push(`dominant-baseline="${baseline}"`);
  }
  if (stroked) attrs.push(`fill="none"`, strokeAttrs(s, true));
  else attrs.push(`fill="${escapeAttr(s.fillStyle)}"`);
  if (maxWidth !== undefined && Number.isFinite(maxWidth)) {
    attrs.push(`textLength="${num(maxWidth)}"`, `lengthAdjust="spacingAndGlyphs"`);
  }
  const alpha = alphaAttr(s);
  if (alpha !== "") attrs.push(alpha);
  const t = transformAttr(s);
  if (t !== "") attrs.push(t);
  return `<text ${attrs.join(" ")}>${escapeText(text)}</text>`;
}

/**
 * An approximation of `measureText`, not a measurement: no font metrics exist off-screen.
 *
 * Layers use the width to decide whether a label fits, so a mean-glyph-width estimate derived from
 * the font's pixel size keeps their layout decisions sane.
 */
export function estimateTextWidth(font: string, text: string): number {
  const size = /(\d*\.?\d+)px/.exec(font);
  const px = size === null ? 10 : Number(size[1]);
  return text.length * px * 0.55;
}
