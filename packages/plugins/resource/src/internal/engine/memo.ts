// docs/specs/plugins/resource.md §2.5 — the one-entry memo HELPER (the M1 ruling).
/**
 * The one-entry, one-frame memo of a utilization matrix.
 *
 * The Σ-mode aggregate band and the resource lanes need the SAME matrix in the SAME frame, and a
 * second build would call the per-resource hooks twice per (resource, bucket) and pay for the
 * accrual twice. One entry, keyed by the build's own grid, is enough: within a frame
 * the two consumers ask at the identical key, and nothing outlives the frame that built it.
 *
 * This is a HELPER, not a shared cache — instances are PER CONSUMER, and the only one in the
 * shipped plugin lives in `internal/load-chart/wire.ts`. Within that instance the key
 * `(bucket, start, end, weekStartDay)` is sufficient because the roster, demand recency, hook
 * pair, threshold and edge policy are constants of that one consumer between invalidations. Every
 * other build — heatmap and report calls at other ranges or coarsened widths, and every
 * utilization-side build — bypasses the memo, so no consumer can ever be served a
 * matrix built under another consumer's roster, hooks, threshold or edges.
 *
 * It holds one entry, and every invalidation is wholesale.
 *
 * Headless: no DOM, no service reference.
 */
import type { UtilizationBucketUnit } from "./buckets";
import type { UtilizationMatrix } from "./compute";

/** Builds one matrix for the given grid. */
export type MatrixBuild<R> = (
  bucket: UtilizationBucketUnit,
  start: number,
  end: number,
  weekStartDay: number,
) => UtilizationMatrix<R>;

export interface MatrixMemo<R> {
  /** The matrix for this grid — the held entry when the key matches, a fresh build otherwise. */
  get(
    bucket: UtilizationBucketUnit,
    start: number,
    end: number,
    weekStartDay: number,
  ): UtilizationMatrix<R>;
  /** Drops the held entry. Called at frame boundaries and on the invalidating notifications. */
  invalidate(): void;
}

/** Creates the memo over `build`. */
export function createMatrixMemo<R>(build: MatrixBuild<R>): MatrixMemo<R> {
  let bucket: UtilizationBucketUnit | null = null;
  let from = 0;
  let to = 0;
  let week = 0;
  let held: UtilizationMatrix<R> | null = null;

  return {
    get: (nextBucket, nextFrom, nextTo, nextWeek) => {
      if (
        held !== null &&
        bucket === nextBucket &&
        from === nextFrom &&
        to === nextTo &&
        week === nextWeek
      ) {
        return held;
      }
      held = build(nextBucket, nextFrom, nextTo, nextWeek);
      bucket = nextBucket;
      from = nextFrom;
      to = nextTo;
      week = nextWeek;
      return held;
    },
    invalidate: () => {
      bucket = null;
      held = null;
    },
  };
}
