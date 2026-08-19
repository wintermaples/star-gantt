// docs/specs/plugins/view.md — internal; not part of the published surface.
/**
 * Critical-rendering-path instrumentation: the time from plugin setup to the first completed
 * on-screen composite.
 *
 * The number exists so a host can watch the 300ms first-paint budget
 * (docs/specs/plugins/view.md) on real data without instrumenting the
 * renderer from outside.
 */

export interface FirstPaintMeter {
  /** Records the first completed paint pass; later calls are no-ops. */
  markPaint(): void;
  /** Milliseconds from creation to the first `markPaint()`, or `undefined` before it. */
  ms(): number | undefined;
}

/** Creates the meter; `now` is injectable for tests and defaults to `performance.now`. */
export function createFirstPaintMeter(now?: () => number): FirstPaintMeter {
  const clock =
    now ??
    (typeof globalThis.performance?.now === "function"
      ? () => globalThis.performance.now()
      : () => Date.now());
  const start = clock();
  let first: number | undefined;
  return {
    markPaint() {
      if (first === undefined) first = Math.max(0, clock() - start);
    },
    ms: () => first,
  };
}
