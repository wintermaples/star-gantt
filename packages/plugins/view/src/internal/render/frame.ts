// docs/specs/plugins/view.md — internal; not part of the published surface.
/**
 * The invalidate/paint clock: per-layer dirty flags coalesced into one pass per animation frame.
 *
 * Kept out of `setup()` so the batching rules — one pass per frame, a timer fallback where there is
 * no `requestAnimationFrame`, nothing scheduled twice — can be tested against a fake clock alone.
 */
import { LAYER_ORDER } from "./dom";
import type { CanvasLayer } from "./index";

export interface FrameLoop {
  /** Marks one canvas dirty and schedules the pass. Unknown layer names are ignored. */
  invalidate(layer: CanvasLayer): void;
  /** Marks all three canvases dirty and schedules the pass. */
  invalidateAll(): void;
  /**
   * Schedules a pass without dirtying anything.
   *
   * Hover resolution rides the paint frame: it must run in the next pass even when no canvas needs
   * repainting (docs/specs/plugins/view.md).
   */
  schedule(): void;
  /**
   * Runs the pass now, on the calling stack, instead of waiting for the frame callback.
   *
   * For the caller that has already destroyed what is on screen: re-sizing a canvas re-initializes
   * its backing store, so a pass left to the frame clock would let the cleared surface be
   * composited first (docs/specs/plugins/view.md). A call from inside the
   * pass is ignored — the pass in flight already owes the surface — and so is one after disposal.
   *
   * A pass already scheduled is cancelled, since this one covers it: the dirty flags it would claim
   * are the ones just painted, and the rest of the pass (overlay sync, hover, scrollbars, prefetch)
   * is not gated on them and would simply run a second time for the same state.
   */
  flush(): void;
  /** Reports whether `layer` is dirty and clears the flag in the same call. */
  claimDirty(layer: CanvasLayer): boolean;
  /** Cancels a pending pass; the loop must not be used afterwards. */
  dispose(): void;
}

/**
 * Creates the loop. `run` is invoked once per scheduled pass, from the frame callback.
 *
 * All three layers start dirty, so the first scheduled pass paints everything.
 */
// docs/specs/plugins/view.md — one composite per rAF, never a paint per event.
export function createFrameLoop(run: () => void): FrameLoop {
  const dirty: Record<CanvasLayer, boolean> = { background: true, main: true, overlay: true };
  let frame: number | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;
  /** Guards `flush()` against re-entering a pass that a paint-time side effect triggered. */
  let running = false;
  let disposed = false;

  function runPass(): void {
    running = true;
    try {
      run();
    } finally {
      running = false;
    }
  }

  function runFrame(): void {
    frame = null;
    timer = null;
    runPass();
  }

  /** Drops a scheduled pass without disposing of the loop, so a later one can be scheduled again. */
  function unschedule(): void {
    if (frame !== null && typeof globalThis.cancelAnimationFrame === "function") {
      globalThis.cancelAnimationFrame(frame);
    }
    if (timer !== null) globalThis.clearTimeout(timer);
    frame = null;
    timer = null;
  }

  /** Coalesces invalidations into one paint pass per animation frame. */
  function schedule(): void {
    if (frame !== null || timer !== null) return;
    if (typeof globalThis.requestAnimationFrame === "function") {
      frame = globalThis.requestAnimationFrame(runFrame);
      return;
    }
    // No rAF (non-browser host, jsdom without the shim): §3.2-2's batching still holds — one pass
    // per ~frame — so fall back to a timer rather than silently never painting.
    timer = globalThis.setTimeout(runFrame, 16);
  }

  return {
    invalidate(layer) {
      if (layer !== "background" && layer !== "main" && layer !== "overlay") return;
      dirty[layer] = true;
      schedule();
    },
    invalidateAll() {
      for (const name of LAYER_ORDER) dirty[name] = true;
      schedule();
    },
    schedule,
    flush() {
      if (running || disposed) return;
      unschedule();
      runPass();
    },
    claimDirty(layer) {
      if (!dirty[layer]) return false;
      dirty[layer] = false;
      return true;
    },
    dispose() {
      disposed = true;
      unschedule();
    },
  };
}
