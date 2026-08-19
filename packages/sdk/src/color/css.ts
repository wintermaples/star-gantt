// CSS length parsing (docs/specs/sdk.md, Module: sdk/color): a consumer resolves a numeric CSS
// custom property through this helper rather than trusting host-supplied text directly.
/**
 * Parses a CSS pixel length such as `"44px"` into a number of CSS pixels.
 *
 * A leading number is enough — the unit suffix is ignored — so both `"44px"` and `"44"` read as
 * `44`. Anything that does not yield a **positive, finite** number returns `fallback`: an empty
 * token (the property is not declared), a non-numeric token, and zero or negative lengths all
 * degrade to the caller's default rather than collapsing a layout, because the value comes from
 * host CSS and cannot be trusted.
 */
export function parsePx(value: string, fallback: number): number {
  const n = Number.parseFloat(value);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}
