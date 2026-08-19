/**
 * Once-per-frame repaint batching, as a small owned object.
 *
 * However many triggers fire in a single tick (scroll, data change, zoom, resize, layout), a
 * consumer that calls `schedule()` on each of them still runs its callback at most once for that
 * frame. Hosts without `requestAnimationFrame` fall back to a ~16ms timer so the batching still
 * holds.
 */

/** A single-flight repaint scheduler; `dispose` cancels a pending run and is `ctx.own()`-shaped. */
export interface FrameScheduler {
  /** Requests one run; collapses repeated requests until the pending run fires. */
  schedule(): void;
  /** Cancels any pending run. `ctx.own()`-shaped. */
  dispose(): void;
}

/** Creates a scheduler that runs `run` at most once per animation frame (or ~16ms without RAF). */
export function createFrameScheduler(run: () => void): FrameScheduler {
  let frame: number | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;

  const fire = (): void => {
    frame = null;
    timer = null;
    run();
  };

  return {
    schedule: () => {
      if (frame !== null || timer !== null) return;
      if (typeof globalThis.requestAnimationFrame === "function") {
        frame = globalThis.requestAnimationFrame(fire);
        return;
      }
      timer = globalThis.setTimeout(fire, 16);
    },
    dispose: () => {
      if (frame !== null && typeof globalThis.cancelAnimationFrame === "function") {
        globalThis.cancelAnimationFrame(frame);
      }
      if (timer !== null) globalThis.clearTimeout(timer);
      frame = null;
      timer = null;
    },
  };
}
