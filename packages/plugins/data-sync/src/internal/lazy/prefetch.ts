// docs/specs/plugins/data-sync.md §3.3
/**
 * Scroll-velocity estimation for prefetching: consecutive scroll samples yield a predicted
 * near-future position, extending the ensured range in the scroll direction. Pure and hostless.
 */

/** How far ahead the predicted position looks, in milliseconds. */
export const PREFETCH_HORIZON_MS = 200;

export interface ScrollSample {
  timeMs: number;
  scrollTop: number;
}

export class ScrollPredictor {
  private previous: ScrollSample | undefined;

  /**
   * Feeds one scroll sample and returns the predicted `scrollTop` `PREFETCH_HORIZON_MS` from now,
   * or `undefined` when no velocity is measurable (first sample, zero elapsed time, or no
   * movement).
   */
  sample(next: ScrollSample): number | undefined {
    const prev = this.previous;
    this.previous = next;
    if (prev === undefined) return undefined;
    const dt = next.timeMs - prev.timeMs;
    const dy = next.scrollTop - prev.scrollTop;
    if (dt <= 0 || dy === 0) return undefined;
    return next.scrollTop + (dy / dt) * PREFETCH_HORIZON_MS;
  }

  reset(): void {
    this.previous = undefined;
  }
}

/**
 * The extra row range to prefetch: from the visible edge in the scroll direction to the
 * predicted position, capped at `prefetchPages` pages. Returns `undefined` when the prediction
 * stays inside the visible range.
 */
export function prefetchRange(
  visibleFirst: number,
  visibleLast: number,
  predictedRow: number,
  prefetchPages: number,
  pageSize: number,
): { offset: number; limit: number } | undefined {
  if (prefetchPages < 1) return undefined;
  const cap = prefetchPages * pageSize;
  if (predictedRow > visibleLast) {
    const to = Math.min(predictedRow, visibleLast + cap);
    return { offset: visibleLast + 1, limit: Math.max(1, to - visibleLast) };
  }
  if (predictedRow < visibleFirst) {
    const from = Math.max(0, Math.max(predictedRow, visibleFirst - cap));
    if (from >= visibleFirst) return undefined;
    return { offset: from, limit: visibleFirst - from };
  }
  return undefined;
}
