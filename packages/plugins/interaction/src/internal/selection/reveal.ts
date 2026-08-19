// docs/specs/plugins/interaction.md §2.1 / §6.1 — the arithmetic of the reveal scroll: which edge a
// partly visible bar is pulled to, and when nothing moves at all.
/**
 * Horizontal reveal geometry: given where a bar sits in the chart viewport, decide the scroll
 * position that brings it into view.
 *
 * Pure arithmetic — no view service, no DOM — so the rules are unit-testable on their own.
 */

/** Gap kept between a revealed bar and the viewport edge it was pulled to, in CSS pixels. */
export const REVEAL_MARGIN_PX = 24;

/**
 * The scroll offset that reveals a bar, or `undefined` when the current one already shows it.
 *
 * `x` / `width` describe the bar in viewport-local pixels (`x` is 0 at the left edge of the chart
 * viewport), `viewportWidth` and `scrollLeft` describe the viewport itself. A bar clipped on the
 * left is pulled to the left edge and one clipped on the right to the right edge — the minimum
 * movement that reveals it, so a click never re-centres a bar that only just pokes out. A bar too
 * wide to fit between the margins shows its start instead, unless it already spans the whole
 * viewport, in which case there is nothing to reveal.
 */
export function revealScrollLeft(
  x: number,
  width: number,
  viewportWidth: number,
  scrollLeft: number,
  margin: number = REVEAL_MARGIN_PX,
): number | undefined {
  if (!(viewportWidth > 0)) return undefined;
  if (!Number.isFinite(x) || !Number.isFinite(width) || !Number.isFinite(scrollLeft)) {
    return undefined;
  }
  const barWidth = Math.max(0, width);
  // The margin never eats the viewport: on a narrow chart it shrinks rather than pushing the bar
  // back out of view.
  const m = Math.max(0, Math.min(margin, Math.floor(viewportWidth / 4)));
  const left = x;
  const right = x + barWidth;

  if (barWidth + 2 * m > viewportWidth) {
    // Wider than the viewport: it can never satisfy both margins. Already covering the viewport
    // edge to edge means it is as revealed as it gets.
    if (left <= m && right >= viewportWidth - m) return undefined;
    return Math.round(scrollLeft + left - m);
  }
  if (left < m) return Math.round(scrollLeft + left - m);
  if (right > viewportWidth - m) return Math.round(scrollLeft + right - (viewportWidth - m));
  return undefined;
}
