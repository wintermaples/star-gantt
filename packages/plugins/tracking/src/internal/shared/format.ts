// docs/specs/plugins/tracking.md §6 (closing note) — "Amounts in cost/EVM builders render rounded
// through `Intl.NumberFormat("en-US")` with no currency symbol (SPI/CPI two decimals); the plugin
// never assumes a currency — hosts wanting locale/currency formatting replace the builders."
//
// Shared by the message catalog's default builders (`costCurvePoint`, `breakdownEntry`,
// `evmCurvePoint`) and by the cost/EVM panels' built-in tile rendering (§2.15's ten dashboard
// tiles), so the two surfaces never drift on rounding.

const AMOUNT_FORMAT = new Intl.NumberFormat("en-US", { maximumFractionDigits: 0 });
const INDEX_FORMAT = new Intl.NumberFormat("en-US", {
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});
const PERCENT_FORMAT = new Intl.NumberFormat("en-US", { maximumFractionDigits: 0 });

// `Intl.NumberFormat` rounds a small negative magnitude (e.g. `-0.4` at zero fraction digits) to
// negative zero and prints the sign anyway (`"-0"`) — a rounding artifact, not a real negative
// amount/percent, and reads as a display bug (review minor: "formatAmount zero-clamp"). Every
// zero-fraction-digit formatter here clamps that one string shape back to `"0"`.
function dropNegativeZero(text: string): string {
  return text === "-0" ? "0" : text;
}

/** A money amount, rounded to a whole number, no currency symbol. Non-finite input reads `"0"`. */
export function formatAmount(value: number): string {
  return dropNegativeZero(AMOUNT_FORMAT.format(Number.isFinite(value) ? value : 0));
}

/** SPI/CPI-style index, always two decimals; `"—"` for a non-finite or `undefined` value. */
export function formatIndex(value: number | undefined): string {
  return typeof value === "number" && Number.isFinite(value) ? INDEX_FORMAT.format(value) : "—";
}

/** A 0–100 percent share, rounded to a whole number. Non-finite input reads `"0"`. */
export function formatPercent(value: number): string {
  return dropNegativeZero(PERCENT_FORMAT.format(Number.isFinite(value) ? value : 0));
}
