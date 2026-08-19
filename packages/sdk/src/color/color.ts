/**
 * Colour arithmetic: parsing, alpha compositing and WCAG contrast.
 *
 * Everything here is pure and string-in/number-out, so callers are unit-testable without a DOM.
 * The input is whatever `getComputedStyle` reports for a token: `rgb(...)`, `rgba(...)` or — on a
 * value the browser did not resolve, such as an unregistered custom property in a host stylesheet
 * — the authored hex. Anything else (a system-colour keyword under forced colors, a `color()`
 * function, a named colour) returns `null` rather than a guessed value.
 */

/** A parsed colour: straight (non-premultiplied) sRGB channels 0–255 and an alpha 0–1. */
export interface Rgba {
  r: number;
  g: number;
  b: number;
  a: number;
}

const HEX3 = /^#([0-9a-f])([0-9a-f])([0-9a-f])([0-9a-f])?$/i;
const HEX6 = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})?$/i;

/** Parses one `rgb()` / `rgba()` / `#rgb[a]` / `#rrggbb[aa]` value, or `null` if it is none. */
export function parseColor(value: string): Rgba | null {
  const text = value.trim();
  if (text === "") return null;
  if (text === "transparent") return { r: 0, g: 0, b: 0, a: 0 };

  const hex6 = HEX6.exec(text);
  if (hex6 !== null) {
    return {
      r: Number.parseInt(hex6[1] ?? "0", 16),
      g: Number.parseInt(hex6[2] ?? "0", 16),
      b: Number.parseInt(hex6[3] ?? "0", 16),
      a: hex6[4] === undefined ? 1 : Number.parseInt(hex6[4], 16) / 255,
    };
  }
  const hex3 = HEX3.exec(text);
  if (hex3 !== null) {
    const dup = (c: string): number => Number.parseInt(c + c, 16);
    return {
      r: dup(hex3[1] ?? "0"),
      g: dup(hex3[2] ?? "0"),
      b: dup(hex3[3] ?? "0"),
      a: hex3[4] === undefined ? 1 : dup(hex3[4]) / 255,
    };
  }

  // `rgb(1 2 3 / 40%)` and `rgba(1, 2, 3, 0.4)` both reduce to the same four numbers once the
  // separators are normalised; percentages are accepted on the alpha because that is the form
  // `getComputedStyle` uses in some engines.
  const fn = /^rgba?\(([^)]*)\)$/i.exec(text);
  if (fn === null) return null;
  const parts = (fn[1] ?? "")
    .replace(/\//g, " ")
    .split(/[\s,]+/)
    .filter((p) => p !== "");
  if (parts.length < 3) return null;
  const channel = (raw: string): number => {
    const n = Number.parseFloat(raw);
    if (!Number.isFinite(n)) return Number.NaN;
    return raw.endsWith("%") ? (n / 100) * 255 : n;
  };
  const r = channel(parts[0] ?? "");
  const g = channel(parts[1] ?? "");
  const b = channel(parts[2] ?? "");
  if (!Number.isFinite(r) || !Number.isFinite(g) || !Number.isFinite(b)) return null;
  // Clamped like the alpha below: an out-of-range channel (a hand-authored `rgb(-10 300 128)`,
  // say) is still a colour a caller can composite and measure, not a value to reject.
  const clampChannel = (n: number): number => Math.min(255, Math.max(0, n));
  let a = 1;
  if (parts.length >= 4) {
    const raw = parts[3] ?? "";
    const n = Number.parseFloat(raw);
    if (!Number.isFinite(n)) return null;
    a = raw.endsWith("%") ? n / 100 : n;
  }
  return { r: clampChannel(r), g: clampChannel(g), b: clampChannel(b), a: Math.min(1, Math.max(0, a)) };
}

/** Source-over composite of `top` onto an opaque `bottom`; the result is opaque. */
export function composite(top: Rgba, bottom: Rgba): Rgba {
  const a = top.a;
  return {
    r: top.r * a + bottom.r * (1 - a),
    g: top.g * a + bottom.g * (1 - a),
    b: top.b * a + bottom.b * (1 - a),
    a: 1,
  };
}

/** WCAG 2.x relative luminance of an opaque colour. */
export function relativeLuminance(c: Rgba): number {
  const toLinear = (channel: number): number => {
    const s = channel / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * toLinear(c.r) + 0.7152 * toLinear(c.g) + 0.0722 * toLinear(c.b);
}

/**
 * WCAG contrast ratio between a foreground and a background, 1–21.
 *
 * A translucent foreground is composited over the background first, so a palette written with
 * `rgba()` is measured as it paints rather than as it is authored. A translucent *background* is
 * composited over white, the only surface a chart can assume behind a translucent canvas, which is
 * a documented approximation.
 */
export function contrastRatio(foreground: Rgba, background: Rgba): number {
  const bg = background.a >= 1 ? background : composite(background, { r: 255, g: 255, b: 255, a: 1 });
  const fg = foreground.a >= 1 ? foreground : composite(foreground, bg);
  const l1 = relativeLuminance(fg);
  const l2 = relativeLuminance(bg);
  const [lighter, darker] = l1 >= l2 ? [l1, l2] : [l2, l1];
  return (lighter + 0.05) / (darker + 0.05);
}
