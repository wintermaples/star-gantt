// docs/specs/plugins/interaction.md §6.2 — `autoScroll` and `frameSync` both run at
// animation-frame cadence; this is their one scheduling seam.
/**
 * One animation-frame step: schedule a callback for the next frame, cancelable.
 *
 * The SDK's `createFrameScheduler` coalesces repeated requests into one standing run, which is what
 * a repaint wants; these two features instead re-arm a *fresh* step each time (the auto-scroll loop
 * chains one frame after another, the frame-synced move replays the latest queued position), so
 * they need a handle per step rather than a single-flight scheduler. Falls back to a short timer
 * where `requestAnimationFrame` does not exist, so both degrade to timer cadence rather than dying.
 */

/** A scheduled frame that can be cancelled before it runs. */
export interface FrameHandle {
  cancel(): void;
}

/** Timer used when `requestAnimationFrame` is unavailable, roughly one 60Hz frame. */
export const FRAME_FALLBACK_MS = 16;

/** Schedules `cb` for the next animation frame (or a ~16ms timer without rAF). */
export function nextFrame(cb: () => void): FrameHandle {
  if (typeof globalThis.requestAnimationFrame === "function") {
    const id = globalThis.requestAnimationFrame(() => cb());
    return { cancel: () => globalThis.cancelAnimationFrame?.(id) };
  }
  const id = setTimeout(cb, FRAME_FALLBACK_MS);
  return { cancel: () => clearTimeout(id) };
}
