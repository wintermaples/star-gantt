/**
 * Per-animation-frame coalescing of repeated work.
 *
 * The grid schedules every repaint and every pointer-driven announcement through one of these, so a
 * burst of wheel or `pointermove` events costs one run per frame rather than one run per event.
 */
// docs/specs/plugins/tree-grid.md § Internal modules — heavy work is scheduled onto a frame, never
// done inside a change handler; the coalesced grid layout updates this backs.
import type { Disposable } from "@stargantt/core";

/**
 * The one thing this helper needs from `PluginContext`: somewhere to hand its cancellation. Narrow
 * on purpose, so the throttle can be unit-tested without a host.
 */
export interface FrameThrottleOwner {
  own(d: Disposable): void;
}

/** A callback coalesced onto the next animation frame; see `frameThrottle`. */
export interface FrameThrottle {
  /** Queues `run` for the next frame; a no-op while one is already queued. */
  schedule(): void;
  /** Drops a queued frame without running it. */
  cancel(): void;
}

/**
 * Coalesces repeated calls into one `run` per animation frame, falling back to a 16 ms timer where
 * `requestAnimationFrame` is unavailable. The cancellation is registered with `ctx.own()` exactly
 * once, here, so a pending frame can never outlive the plugin.
 */
export function frameThrottle(owner: FrameThrottleOwner, run: () => void): FrameThrottle {
  let frame: number | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;

  function fire(): void {
    // A cancelled arm leaves both null; bail so an environment with `requestAnimationFrame` but
    // no `cancelAnimationFrame` cannot run a dropped frame (or fire after dispose).
    if (frame === null && timer === null) return;
    frame = null;
    timer = null;
    run();
  }

  function cancel(): void {
    if (frame !== null && typeof globalThis.cancelAnimationFrame === "function") {
      globalThis.cancelAnimationFrame(frame);
    }
    if (timer !== null) globalThis.clearTimeout(timer);
    frame = null;
    timer = null;
  }

  owner.own({ dispose: cancel });

  return {
    schedule(): void {
      if (frame !== null || timer !== null) return;
      if (typeof globalThis.requestAnimationFrame === "function") {
        frame = globalThis.requestAnimationFrame(fire);
        return;
      }
      timer = globalThis.setTimeout(fire, 16);
    },
    cancel,
  };
}
