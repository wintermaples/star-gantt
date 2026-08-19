// docs/specs/plugins/view.md — internal; not part of the published surface.
/**
 * Bidirectional-text helpers for canvas labels.
 *
 * Canvas `fillText` runs the Unicode bidirectional algorithm itself, but it resolves the paragraph
 * direction from the first strong character — so a label that mixes an RTL name with ASCII digits
 * or Latin codes can come out in the wrong visual order relative to the chart's base direction.
 * Wrapping the string in a directional-isolate pair pins the base direction without affecting
 * layout or the glyphs painted.
 */

/** Unicode directional isolates (UAX #9), spelled as escapes so the source stays readable. */
const LRI = "\u2066";
const RLI = "\u2067";
const FSI = "\u2068";
const PDI = "\u2069";

/** Strong RTL characters: Hebrew, Arabic, Syriac, Thaana, RTL marks, and presentation forms. */
const RTL_CHARS = /[\u0591-\u07FF\u200F\u202B\u202E\uFB1D-\uFDFD\uFE70-\uFEFC]/;
/** Strong LTR characters — Latin letters are what task codes typically mix into an RTL name. */
const LTR_CHARS = /[A-Za-z\u00C0-\u024F]/;
const WEAK_NUMERIC = /[0-9]/;

/** True when `text` contains any strong right-to-left character. */
export function hasRtl(text: string): boolean {
  return RTL_CHARS.test(text);
}

/**
 * True when `text` mixes directions in a way the bidirectional algorithm can reorder: strong RTL
 * content together with strong LTR content or digits.
 */
export function isMixedDirection(text: string): boolean {
  return hasRtl(text) && (LTR_CHARS.test(text) || WEAK_NUMERIC.test(text));
}

/**
 * Wraps `text` in a Unicode directional isolate so it renders in the correct visual order for the
 * given base direction, regardless of what the surrounding context or the first strong character
 * would resolve.
 *
 * Strings that are not direction-mixed, or that already start with an isolate, are returned
 * unchanged, so applying the helper unconditionally never double-wraps and never perturbs plain
 * LTR labels. With no base given a first-strong isolate is used. Non-string input yields `""`.
 */
export function bidiIsolate(text: string, base?: "ltr" | "rtl"): string {
  if (typeof text !== "string") return "";
  if (!isMixedDirection(text)) return text;
  const head = text.charAt(0);
  if (head === LRI || head === RLI || head === FSI) return text;
  const open = base === "rtl" ? RLI : base === "ltr" ? LRI : FSI;
  return `${open}${text}${PDI}`;
}
