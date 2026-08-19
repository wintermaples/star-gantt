// docs/specs/plugins/view.md — internal; not part of the published surface.
/**
 * Scroll prediction for off-screen prefetch: recent scroll samples are extrapolated into the
 * viewport the user is about to see, so a warm pass (an off-screen composite over that viewport)
 * can populate contribution-side caches before the region scrolls in.
 */
import type { Viewport } from "./index";

export interface ScrollPredictor {
  /** Records the scroll position reached at this instant. */
  sample(scrollLeft: number, scrollTop: number): void;
  /**
   * The viewport predicted `leadMs` ahead of the latest sample, clamped to non-negative offsets;
   * `undefined` while disabled, before two samples exist, when the samples are stale, or when the
   * position is not moving.
   */
  predict(current: Readonly<Viewport>): Viewport | undefined;
}

export interface PredictorOptions {
  enabled: boolean;
  /** How far ahead to extrapolate. Defaults to 200ms. */
  leadMs?: number;
  /** Samples older than this are stale and predict nothing. Defaults to 250ms. */
  staleMs?: number;
  now?(): number;
}

export function createScrollPredictor(options: PredictorOptions): ScrollPredictor {
  const lead = positive(options.leadMs, 200);
  const stale = positive(options.staleMs, 250);
  const now = options.now ?? (() => Date.now());

  let prev: { left: number; top: number; t: number } | null = null;
  let last: { left: number; top: number; t: number } | null = null;

  if (!options.enabled) return { sample: () => {}, predict: () => undefined };

  return {
    sample(scrollLeft, scrollTop) {
      prev = last;
      last = { left: scrollLeft, top: scrollTop, t: now() };
    },
    predict(current) {
      if (prev === null || last === null) return undefined;
      const dt = last.t - prev.t;
      if (dt <= 0) return undefined;
      if (now() - last.t > stale) return undefined;
      const vx = (last.left - prev.left) / dt;
      const vy = (last.top - prev.top) / dt;
      if (vx === 0 && vy === 0) return undefined;
      return {
        scrollLeft: Math.max(0, last.left + vx * lead),
        scrollTop: Math.max(0, last.top + vy * lead),
        width: current.width,
        height: current.height,
      };
    },
  };
}

function positive(value: number | undefined, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : fallback;
}
