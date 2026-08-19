// docs/specs/plugins/resource.md §3.6 — the band's step-first y-scale.
/**
 * The aggregate band's step-first y scale and axis-label layout — pure computation, no DOM.
 *
 * The scale is built from a ROUND STEP, so every tick is a round multiple by construction; the
 * "nice" ceiling is a consequence of the step, not an independent rounding. Rounding only the
 * ceiling and dividing it evenly yields unrounded labels (0 / 1.67 / 3.33 / 5 at four ticks) —
 * the defect this module exists to prevent.
 *
 * Headless: no DOM, no service reference.
 */

/** Minimum vertical room per tick when deriving how many the plot can hold. */
export const PX_PER_TICK = 24;

/** Nominal height, in CSS px, of one axis label's box — collision testing and centring use it. */
export const AXIS_LABEL_HEIGHT = 14;

/** The allowed step mantissas, ascending: the step is the smallest usable `m × 10ⁿ`. */
const STEP_MANTISSAS = [1, 2, 2.5, 5] as const;

/** Rounds away float noise from step multiples (`0.1 × 3 → 0.30000000000000004`). */
function roundValue(value: number): number {
  return Number(value.toFixed(10));
}

/** Formats a y-axis tick value in its minimal decimal form (`2.5`, never `2.50`). */
export function formatAxisValue(value: number): string {
  return String(roundValue(value));
}

/** The band's y scale: the round step, the derived ceiling, and every tick value ascending. */
export interface AxisScale {
  step: number;
  ceiling: number;
  /** `0, step, 2·step, …, ceiling`, ascending; float noise already rounded away. */
  ticks: number[];
}

/**
 * Derives the step-first y scale for a peak value over a plot of `plotHeight` CSS px.
 *
 * `maxTicks = clamp(floor(plotHeight / 24), 2, 5)` (zero baseline included); the step is the
 * smallest `m × 10ⁿ` (`m ∈ {1, 2, 2.5, 5}`) with `peak / step ≤ maxTicks − 1`; the ceiling is
 * `ceil(peak / step) × step`. Returns `null` when there is no positive finite peak to scale.
 *
 * `unit` (default 1) is the magnitude the `m × 10ⁿ` search runs in: the peak is expressed in it,
 * the step is chosen there, and the returned step, ceiling and ticks are converted back. Values
 * that are milliseconds of working time pass `durationUnitMs` — the shared ladder's own magnitude
 * query, never a local copy — so every tick is a round duration such as `4h` rather
 * than a round millisecond count.
 *
 * A magnitude passed as a FUNCTION is asked again about the ceiling the search produced, and the
 * search re-runs whenever the ceiling belongs to a larger magnitude than the peak did: the ceiling
 * is a drawn label, and a scale chosen in the peak's magnitude can overshoot into the next one (a
 * 23h peak over two slots ceils to 40h, which prints `1.7d`).
 */
export function computeAxisScale(
  peak: number,
  plotHeight: number,
  unit: number | ((value: number) => number) = 1,
): AxisScale | null {
  if (!Number.isFinite(peak) || peak <= 0) return null;
  const magnitudeOf = (value: number): number => {
    const resolved = typeof unit === "function" ? unit(value) : unit;
    return typeof resolved === "number" && Number.isFinite(resolved) && resolved > 0 ? resolved : 1;
  };

  let scale = magnitudeOf(peak);
  let result = scaleIn(peak, plotHeight, scale);
  // The magnitude only ever grows here (the ceiling is never below the peak), and a fixed one
  // settles on the first comparison, so the loop is bounded well inside its guard.
  for (let pass = 0; pass < 3; pass += 1) {
    const promoted = magnitudeOf(result.ceiling);
    if (!(promoted > scale)) break;
    scale = promoted;
    result = scaleIn(peak, plotHeight, scale);
  }
  return result;
}

/** One step-first search for a positive `peak`, in the fixed magnitude `scale`. */
function scaleIn(peak: number, plotHeight: number, scale: number): AxisScale {
  const scaled = peak / scale;
  const maxTicks = Math.min(5, Math.max(2, Math.floor(plotHeight / PX_PER_TICK)));
  const slots = maxTicks - 1;

  // The smallest candidate that can possibly satisfy `peak / s <= slots` is near `peak / slots`;
  // starting one decade below keeps the search exact without a long walk up.
  let exponent = Math.floor(Math.log10(scaled / slots)) - 1;
  for (;;) {
    for (const mantissa of STEP_MANTISSAS) {
      const step = roundValue(mantissa * Math.pow(10, exponent));
      // The epsilon forgives float noise when the peak is an exact multiple of the step
      // (e.g. peak 2 at step 2), never a genuinely over-full scale.
      if (scaled / step <= slots * (1 + 1e-9)) {
        const ceiling = roundValue(Math.ceil(scaled / step - 1e-9) * step);
        const count = Math.round(ceiling / step);
        const ticks: number[] = [];
        for (let i = 0; i <= count; i += 1) ticks.push(roundValue(i * step) * scale);
        return { step: step * scale, ceiling: ceiling * scale, ticks };
      }
    }
    exponent += 1;
  }
}

/**
 * One surviving axis label. `top` is the label box's top edge in the drawn box's coordinates;
 * `null` marks the zero baseline's label, which the renderer bottom-anchors instead.
 */
export interface AxisLabelBox {
  value: number;
  text: string;
  top: number | null;
}

export interface AxisLabelLayoutInput {
  /** The scale's tick values, ascending (`AxisScale.ticks`). */
  ticks: readonly number[];
  /** The y of a value in the drawn box's coordinates — the projection's own mapping. */
  yOf(value: number): number;
  /** Height of the drawn box the labels must stay inside. */
  height: number;
  /** Height of one label's box; `AXIS_LABEL_HEIGHT` unless a caller measures its own. */
  labelHeight?: number;
  /**
   * Renders one tick's value as text. Omitted, the minimal decimal form is used; while the band
   * sums the per-resource matrix the caller passes the catalog's duration builder, so a tick reads
   * `4h` and never a raw millisecond count.
   */
  format?: (value: number) => string;
}

/**
 * Places the axis labels, dropping the ones that would collide.
 *
 * Each label is centred vertically on its tick line, except the zero baseline's, which stays
 * bottom-anchored inside the box; every box is clamped inside `[0, height]`. Labels are emitted
 * from the ceiling downward, and a label whose box would overlap a previously emitted one is
 * dropped — so a short plot degrades to fewer legible labels, and the ceiling label (the reader's
 * only cue to the scale) survives longest. The returned list keeps that emission order.
 */
export function layoutAxisLabels(input: AxisLabelLayoutInput): AxisLabelBox[] {
  const labelHeight = input.labelHeight ?? AXIS_LABEL_HEIGHT;
  const format = input.format ?? formatAxisValue;
  const maxTop = Math.max(0, input.height - labelHeight);
  const accepted: { top: number }[] = [];
  const out: AxisLabelBox[] = [];

  for (let i = input.ticks.length - 1; i >= 0; i -= 1) {
    const value = input.ticks[i] as number;
    const zero = value === 0;
    const top = zero ? maxTop : Math.min(maxTop, Math.max(0, input.yOf(value) - labelHeight / 2));
    const collides = accepted.some(
      (box) => top < box.top + labelHeight && top + labelHeight > box.top,
    );
    if (collides) continue;
    accepted.push({ top });
    out.push({ value, text: format(value), top: zero ? null : top });
  }

  return out;
}
