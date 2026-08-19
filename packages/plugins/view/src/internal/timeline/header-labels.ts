/**
 * Which header boundaries carry a label, and where that label lands.
 *
 * The two rules that decide it — fit-based thinning and the sticky leading label —
 * are pure functions of measured text and cell geometry, so they live here rather than inside the
 * paint: they are the part of the header that needs its own tests.
 *
 * Internal: not part of the published surface.
 */
import type { HeaderDrawOptions, HeaderTier } from "./header-options";
import type { ScaleUnit } from "./scale";
import { advance, calendarIndex, normalizeStep, normalizeStepOffset, ticks } from "./scale";
import type { ScaleRow } from "./index";

/** One label the header paints: a formatted boundary, positioned inside its row. */
export interface HeaderLabel {
  text: string;
  x: number;
  y: number;
}

// docs/specs/plugins/view.md
// fit-based thinning selects boundaries by `calendarIndex` (their absolute position in the
// row's own unit sequence, not their position in the visible-boundary array), so the labelled set
// is stable while the user scrolls. `ticks()` aligns a `step` row's boundaries to the same index,
// so the boundaries and the labelled subset are anchored on one shared notion of the calendar.

/** One boundary a row could label: its position, formatted text, measured width and own cell width. */
export interface LabelCandidate {
  /** Local (post-`scrollLeft`) x of the boundary's own left edge; negative when it precedes the surface. */
  x: number;
  text: string;
  /** `measureText(text)` — painted width of `text` at the header's current font. */
  width: number;
  /** Distance to the next boundary in this row, i.e. this cell's own width. */
  cellWidth: number;
  calIndex: number;
}

/**
 * Every boundary of `row` that overlaps `[from, to)`, with its formatted label measured and its
 * own cell width resolved (via `advance()` for the last visible boundary, whose right edge may
 * fall outside `[from, to)`). A `ScaleRow.format` throw is reported and that boundary is skipped
 * entirely — it never becomes a label candidate — matching the pre- fault barrier.
 */
export function labelCandidates(
  row: ScaleRow,
  rowIndex: number,
  tier: HeaderTier,
  boundaries: number[],
  separators: number[],
  o: HeaderDrawOptions,
): LabelCandidate[] {
  const unit: ScaleUnit = row.unit;
  const step = normalizeStep(row.step);
  const candidates: LabelCandidate[] = [];
  for (let i = 0; i < boundaries.length; i++) {
    const t = boundaries[i]!;
    const x = separators[i]!;
    let text: string;
    try {
      text = row.format(t, o.locale);
    } catch (error) {
      o.onFormatError(error);
      continue;
    }
    const nextT = boundaries[i + 1] ?? advance(t, unit, step, o.timeZone);
    // docs/specs/plugins/view.md — the header-cell template
    // rewrites the label *before* it is measured, so fit-based thinning and the sticky
    // leading label both operate on the text actually painted. The hook arrives already
    // wrapped in its latched fault barrier; any non-string result keeps the default label.
    if (o.cellFormat !== undefined) {
      const custom = o.cellFormat({
        time: t,
        endTime: nextT,
        unit,
        step,
        rowIndex,
        locale: o.locale,
        defaultLabel: text,
      });
      if (typeof custom === "string") text = custom;
    }
    candidates.push({
      x,
      text,
      width: o.measureText(text, tier),
      cellWidth: o.tToX(nextT) - o.scrollLeft - x,
      calIndex: calendarIndex(t, unit, o.firstDayOfWeek, o.timeZone),
    });
  }
  return candidates;
}

// docs/specs/plugins/view.md
// this row's own boundaries are already `step` calendar units apart, so "every n-th
// boundary" is every n-th multiple of `step` in calendar-index space, not every n-th integer.
// Dividing the step out of the absolute calendar index (rather than, say, counting off the
// candidate array) keeps the selection anchored on the boundary's own absolute position: two
// paints that share a boundary agree on whether it is labelled, regardless of which other
// boundaries happen to be visible or how the array was indexed.
// A `stepOffset` (docs/specs/plugins/view.md) shifts the
// anchor before the step is divided out, so a fiscal-year row's selection stays anchored on its
// own boundaries.
export function stepIndex(calIndex: number, step: number, stepOffset = 0): number {
  return Math.floor((calIndex - stepOffset) / step);
}

/**
 * Smallest positive integer *n* at which `width` (label width plus both paddings) fits in *n*
 * cells of width `cell` — i.e. the least *n* satisfying `width <= n * cell` — or `Infinity` when
 * no *n* up to `maxN` does.
 *
 * A cell of zero or negative width never fits a positive label, and the comparison itself is the
 * authority: the division only seeds the search, and the two corrective steps re-check it in
 * floating point, so the answer agrees exactly with `width > n * cell` evaluated directly.
 */
function minCellsToFit(width: number, cell: number, maxN: number): number {
  // A NaN on either side makes `width > n * cell` false, i.e. the label counts as fitting — the
  // reduction has to reproduce that rather than reading NaN as "too wide".
  if (Number.isNaN(width) || Number.isNaN(cell)) return 1;
  // For a non-positive cell, `n * cell` never grows with n, so if n = 1 does not fit, nothing does.
  if (!(cell > 0)) return width <= cell ? 1 : Number.POSITIVE_INFINITY;
  let n = Math.ceil(width / cell);
  // A sub-unit seed (a label narrower than one cell) still needs at least one cell; an infinite one
  // never fits any finite cell, which the `maxN` bound below rejects.
  if (!(n >= 1)) n = 1;
  if (!(n <= maxN)) return Number.POSITIVE_INFINITY;
  while (n <= maxN && width > n * cell) n++;
  if (n > maxN) return Number.POSITIVE_INFINITY;
  while (n > 1 && width <= (n - 1) * cell) n--;
  return n;
}

/**
 * Smallest *n* ≥ 1 at which every boundary this row would label at that spacing — every
 * candidate whose step-normalized calendar index (its absolute calendar index divided by the
 * row's `step`) is a multiple of *n* — holds its label in *n* of its own cell widths. *n* = 1
 * (label every boundary) is returned unchanged when everything already fits, so a row whose
 * labels fit paints exactly as before.
 *
 * A candidate is dropped when its `format()` throws (see `labelCandidates`), which can put a gap
 * in an otherwise-consecutive run of step-normalized indices; an *n* that ends up matching no
 * surviving candidate is rejected rather than accepted vacuously, so a row is never left with a
 * "thinning factor" that in fact draws zero labels. When no *n* qualifies, the candidate count is
 * returned — the same value the search's last step would have produced.
 *
 * Runs in O((span + count) · log count) rather than testing every candidate against every *n*:
 * each candidate is reduced once to the least *n* that fits it, and each *n* then visits only the
 * multiples of *n* inside the index span (the harmonic sum), or all candidates when that is
 * cheaper for a sparse span.
 *
 * docs/specs/plugins/view.md —.
 */
export function thinningFactor(
  candidates: LabelCandidate[],
  labelPadding: number,
  step: number,
  stepOffset = 0,
): number {
  const count = candidates.length;
  if (count === 0) return 0;

  // Step-normalized index → the largest *n* the boundaries at that index demand. Two candidates
  // cannot share an index in practice (boundaries are distinct), but taking the maximum keeps the
  // reduction faithful if they ever did: both would be selected together, so both must fit.
  const need = new Map<number, number>();
  let minIndex = Number.POSITIVE_INFINITY;
  let maxIndex = Number.NEGATIVE_INFINITY;
  for (const c of candidates) {
    const k = stepIndex(c.calIndex, step, stepOffset);
    const fit = minCellsToFit(c.width + 2 * labelPadding, c.cellWidth, count);
    const previous = need.get(k);
    need.set(k, previous === undefined ? fit : Math.max(previous, fit));
    if (k < minIndex) minIndex = k;
    if (k > maxIndex) maxIndex = k;
  }
  // A NaN calendar index cannot be walked by multiples; fall back to scanning the map.
  const span = Number.isFinite(minIndex) && Number.isFinite(maxIndex) ? maxIndex - minIndex : NaN;

  for (let n = 1; n <= count; n++) {
    let selected = false;
    let fits = true;
    // Walking the multiples of `n` costs about `span / n` lookups; scanning every candidate costs
    // `need.size`. Whichever is smaller answers the identical question, so take it.
    if (span / n < need.size) {
      // Smallest multiple of `n` at or after `minIndex`; exact for integer indices this side of
      // 2^53, since IEEE division of two exactly-representable integers is correctly rounded.
      const first = Math.ceil(minIndex / n) * n;
      for (let k = first; k <= maxIndex; k += n) {
        const fit = need.get(k);
        if (fit === undefined) continue;
        selected = true;
        if (fit > n) {
          fits = false;
          break;
        }
      }
    } else {
      for (const [k, fit] of need) {
        if (k % n !== 0) continue;
        selected = true;
        if (fit > n) {
          fits = false;
          break;
        }
      }
    }
    if (fits && selected) return n;
  }
  return count;
}

/**
 * The labels one row paints: its candidates, thinned to the row's fit-based factor and placed
 * inside the row's band.
 *
 * `o.thinningRange`, when given, replaces the painted span's candidates for the purpose of
 * choosing that factor only (an export tile resolves it over the whole exported range so
 * adjacent tiles agree); the labels themselves always come from the painted span. `centerY` is the
 * baseline the row's labels sit on — the middle of its band.
 */
export function rowLabels(
  row: ScaleRow,
  rowIndex: number,
  tier: HeaderTier,
  boundaries: number[],
  separators: number[],
  centerY: number,
  o: HeaderDrawOptions,
): HeaderLabel[] {
  const candidates = labelCandidates(row, rowIndex, tier, boundaries, separators, o);
  if (candidates.length === 0) return [];

  const step = normalizeStep(row.step);
  const stepOffset = normalizeStepOffset(row.stepOffset, step);
  // an export tile computes the thinning factor over the WHOLE exported span, so
  // adjacent tiles always agree on which boundaries carry a label; the on-screen header
  // (no `thinningRange`) keeps computing it from the visible candidates.
  let thinningCandidates = candidates;
  if (o.thinningRange !== undefined) {
    const allBoundaries = ticks(
      o.thinningRange.from,
      o.thinningRange.to,
      row.unit,
      row.step,
      o.firstDayOfWeek,
      o.timeZone,
      row.stepOffset,
    );
    const allSeparators = allBoundaries.map((t) => o.tToX(t) - o.scrollLeft);
    thinningCandidates = labelCandidates(row, rowIndex, tier, allBoundaries, allSeparators, o);
  }
  const n = thinningFactor(thinningCandidates, o.labelPadding, step, stepOffset);

  const labels: HeaderLabel[] = [];
  for (const c of candidates) {
    if (stepIndex(c.calIndex, step, stepOffset) % n !== 0) continue;
    // docs/specs/plugins/view.md — a cell straddling the surface's left edge
    // (its own left edge negative, its right edge inside the surface) sticks its label to the
    // surface's left edge instead of its own off-surface one, dropping it entirely rather than
    // truncating when even that sliver cannot hold the whole string. Only the leading boundary
    // of a row can ever straddle: `ticks()` returns the boundary at-or-before `from` first, so
    // every later boundary starts at or after `from`, i.e. at x ≥ 0.
    const cellRight = c.x + c.cellWidth;
    if (o.sticky && c.x < 0 && cellRight > 0) {
      if (c.width + 2 * o.labelPadding <= cellRight) {
        labels.push({ text: c.text, x: o.labelPadding, y: centerY });
      }
      continue;
    }
    // with `sticky` off (export tiles) a straddling cell's label paints at its true —
    // possibly negative — x; the per-tile clip leaves exactly the slice this tile owns.
    labels.push({ text: c.text, x: c.x + o.labelPadding, y: centerY });
  }
  return labels;
}
