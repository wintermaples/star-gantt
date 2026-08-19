// docs/specs/plugins/perf-tools.md §1.1 — the rolling frame-time window.
/**
 * A rolling window of frame durations backed by a preallocated ring buffer, so the per-frame hot
 * path (`sample`) allocates nothing. `stats()` allocates one summary object per call and is meant
 * for throttled consumers (the overlay readout, the service).
 */
import type { FrameStats } from "../types";

/** A zero-copy view over the ring for the sparkline: `at(i)` yields sample i, oldest first. */
export interface RingView {
  readonly length: number;
  at(index: number): number;
}

export interface FrameMeter {
  /** Records one frame duration (ms). Non-finite or negative samples are ignored. */
  sample(durationMs: number): void;
  /** Summarizes the current window; all-zero when empty. */
  stats(): FrameStats;
  /** The current window contents, oldest first, without copying. */
  ring(): RingView;
}

/** Creates the rolling-window meter: a preallocated `windowSize`-length ring buffer. */
export function createFrameMeter(windowSize: number, budgetMs: number): FrameMeter {
  const buffer = new Float64Array(windowSize);
  let next = 0; // write cursor
  let count = 0; // samples held, <= windowSize
  let last = 0;

  const view: RingView = {
    get length() {
      return count;
    },
    at(index: number): number {
      // oldest sample sits at `next` once the ring is full, at 0 before that
      const start = count < windowSize ? 0 : next;
      return buffer[(start + index) % windowSize] ?? 0;
    },
  };

  return {
    sample(durationMs: number): void {
      if (!Number.isFinite(durationMs) || durationMs < 0) return;
      buffer[next] = durationMs;
      next = (next + 1) % windowSize;
      if (count < windowSize) count += 1;
      last = durationMs;
    },
    stats(): FrameStats {
      if (count === 0) {
        return { fps: 0, avgMs: 0, maxMs: 0, lastMs: 0, frames: 0, overBudget: 0 };
      }
      let sum = 0;
      let max = 0;
      let over = 0;
      const start = count < windowSize ? 0 : next;
      for (let i = 0; i < count; i += 1) {
        const v = buffer[(start + i) % windowSize] ?? 0;
        sum += v;
        if (v > max) max = v;
        if (v > budgetMs) over += 1;
      }
      const avg = sum / count;
      return {
        fps: avg > 0 ? 1000 / avg : 0,
        avgMs: avg,
        maxMs: max,
        lastMs: last,
        frames: count,
        overBudget: over,
      };
    },
    ring: () => view,
  };
}

/** Aggregates an unbounded run of samples (a whole recording), without keeping them. */
export interface StatsAccumulator {
  add(durationMs: number): void;
  stats(): FrameStats;
}

/** Creates the aggregate-over-a-recording accumulator (§1.2 — the aggregate `PerfTrace.stats`). */
export function createStatsAccumulator(budgetMs: number): StatsAccumulator {
  let sum = 0;
  let max = 0;
  let last = 0;
  let frames = 0;
  let over = 0;
  return {
    add(durationMs: number): void {
      if (!Number.isFinite(durationMs) || durationMs < 0) return;
      sum += durationMs;
      if (durationMs > max) max = durationMs;
      if (durationMs > budgetMs) over += 1;
      last = durationMs;
      frames += 1;
    },
    stats(): FrameStats {
      const avg = frames > 0 ? sum / frames : 0;
      return { fps: avg > 0 ? 1000 / avg : 0, avgMs: avg, maxMs: max, lastMs: last, frames, overBudget: over };
    },
  };
}
