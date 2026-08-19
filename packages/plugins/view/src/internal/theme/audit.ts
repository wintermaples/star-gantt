// docs/specs/plugins/view.md — internal module, not part of the published surface.
/**
 * `ThemeService.audit()` (docs/specs/plugins/view.md): the contrast audit
 * this repository used to perform by hand and record in stylesheet comments, turned into something
 * a host can run against its own palette.
 *
 * The pairs below are exactly the figure/ground relationships §4 documents, with the floor each is
 * audited to: 4.5:1 where the foreground is text, 3:1 where it is a non-text UI mark (WCAG 1.4.11).
 * The function takes a reader rather than a service so it stays pure with respect to the plugin.
 */
import { contrastRatio, parseColor } from "@stargantt/sdk";
import type { ThemeAuditEntry } from "./types";

/** Floors, named so the pair table reads as the contract does. */
const TEXT = 4.5;
const UI = 3;

/** One documented figure/ground pair: `id`, foreground token, background token, floor. */
const PAIRS: readonly (readonly [string, string, string, number])[] = [
  ["fg/bg", "--sg-fg", "--sg-bg", TEXT],
  ["muted-fg/bg", "--sg-muted-fg", "--sg-bg", TEXT],
  ["header-fg/header-bg", "--sg-header-fg", "--sg-header-bg", TEXT],
  ["header-tick/header-bg", "--sg-header-tick", "--sg-header-bg", UI],
  ["bar-fill/bg", "--sg-bar-fill", "--sg-bg", UI],
  ["summary-fill/bg", "--sg-summary-fill", "--sg-bg", UI],
  ["milestone-fill/bg", "--sg-milestone-fill", "--sg-bg", UI],
  ["bar-inside-label-fg/bar-fill", "--sg-bar-inside-label-fg", "--sg-bar-fill", TEXT],
  ["bar-label-fg/bg", "--sg-bar-label-fg", "--sg-bg", TEXT],
  ["selection-stroke/bar-fill", "--sg-selection-stroke", "--sg-bar-fill", UI],
  ["selection-stroke/bg", "--sg-selection-stroke", "--sg-bg", UI],
  ["focus-stroke/bg", "--sg-focus-stroke", "--sg-bg", UI],
  ["today-line/bg", "--sg-today-line", "--sg-bg", UI],
  ["link-line/bg", "--sg-link-line", "--sg-bg", UI],
  ["tooltip-fg/tooltip-bg", "--sg-tooltip-fg", "--sg-tooltip-bg", TEXT],
];

/**
 * The four row states, faintest first. Their *distance* from the chart background must increase
 * along this list: a hover fill that reads fainter than the stripe it paints over inverts the
 * feedback, which is the failure the ordering check exists to catch.
 */
const ROW_STATES: readonly string[] = [
  "--sg-bg",
  "--sg-row-stripe-bg",
  "--sg-row-hover-bg",
  "--sg-row-selected-bg",
];

/** Reads one token's current value — `ThemeService.get`, narrowed to what the audit needs. */
export type TokenReader = (token: string) => string;

/** Rounds to two decimals so a reported ratio reads like the ones in the contract's comments. */
function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

/**
 * Measures the palette `read` resolves: one entry per documented contrast pair, plus the row-state
 * ordering. Pairs whose values do not parse as colours are omitted — the audit reports what it
 * measured and never a default verdict.
 */
export function auditPalette(read: TokenReader): ThemeAuditEntry[] {
  const out: ThemeAuditEntry[] = [];
  for (const [id, fgToken, bgToken, min] of PAIRS) {
    const fg = parseColor(read(fgToken));
    const bg = parseColor(read(bgToken));
    if (fg === null || bg === null) continue;
    const measured = round2(contrastRatio(fg, bg));
    out.push({ id, kind: "contrast", tokens: [fgToken, bgToken], measured, min, ok: measured >= min });
  }

  const order = auditRowOrder(read);
  if (order !== null) out.push(order);
  return out;
}

/** The row-state ordering entry, or `null` when any of the four states does not parse. */
function auditRowOrder(read: TokenReader): ThemeAuditEntry | null {
  const base = parseColor(read(ROW_STATES[0] ?? ""));
  if (base === null) return null;
  const distances: number[] = [];
  for (const token of ROW_STATES) {
    const color = parseColor(read(token));
    if (color === null) return null;
    // Distance from the chart background, measured the same way the contrast pairs are: a state's
    // fill is judged by how far it moves the surface, whichever direction the scheme moves it in.
    distances.push(contrastRatio(color, base));
  }
  let violations = 0;
  for (let i = 1; i < distances.length; i += 1) {
    if ((distances[i] ?? 0) < (distances[i - 1] ?? 0)) violations += 1;
  }
  return {
    id: "row-state-order",
    kind: "order",
    tokens: ROW_STATES,
    measured: violations,
    min: 0,
    ok: violations === 0,
  };
}
