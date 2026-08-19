// docs/specs/plugins/export.md §9 — internal module: not part of the published surface.
/**
 * Numeric formatting shared by every SVG writer of the recording proxy.
 *
 * Not part of the package's published surface.
 */

/**
 * Fixed-precision number formatting: SVG output stays short and stable across platforms.
 *
 * A non-finite value formats as `0`, so a stray `NaN` degrades to a harmless coordinate instead of
 * producing invalid markup.
 */
export function num(v: number): string {
  if (!Number.isFinite(v)) return "0";
  return String(Math.round(v * 1000) / 1000);
}
