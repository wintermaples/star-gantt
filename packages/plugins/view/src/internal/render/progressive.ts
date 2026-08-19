// docs/specs/plugins/view.md — internal; not part of the published surface.
/**
 * Progressive detail: frames painted during active scrolling are marked `"coarse"` so layer
 * contributions may skip expensive detail (text, gradients), and a quiet period after the last
 * scroll triggers one full-detail repaint marked `"fine"`.
 *
 * Timer functions are injected so the state machine is testable with a fake clock, and the wiring
 * owns exactly one disposable that clears whichever timer is currently armed.
 */

export interface ProgressiveDetail {
  /** The detail tag of the next painted frame; `undefined` while the feature is disabled. */
  detail(): "coarse" | "fine" | undefined;
  /** Notes a scroll: subsequent frames are coarse, and the refine timer is re-armed. */
  noteScroll(): void;
  /** Clears any armed timer. */
  dispose(): void;
}

export interface ProgressiveOptions {
  enabled: boolean;
  /** Quiet time after the last scroll before the refine repaint. Defaults to 150ms. */
  refineDelayMs?: number;
  /** Invoked when the quiet period elapses; the wiring repaints everything at full detail. */
  onRefine(): void;
  setTimer?(fn: () => void, ms: number): unknown;
  clearTimer?(handle: unknown): void;
}

export function createProgressiveDetail(options: ProgressiveOptions): ProgressiveDetail {
  const delay =
    typeof options.refineDelayMs === "number" &&
    Number.isFinite(options.refineDelayMs) &&
    options.refineDelayMs >= 0
      ? options.refineDelayMs
      : 150;
  const setTimer =
    options.setTimer ?? ((fn: () => void, ms: number) => globalThis.setTimeout(fn, ms));
  const clearTimer =
    options.clearTimer ??
    ((handle: unknown) => globalThis.clearTimeout(handle as ReturnType<typeof setTimeout>));

  let coarse = false;
  /** The one armed timer; re-arming swaps the variable, never registers a new disposable. */
  let timer: unknown = null;

  if (!options.enabled) {
    return { detail: () => undefined, noteScroll: () => {}, dispose: () => {} };
  }

  return {
    detail: () => (coarse ? "coarse" : "fine"),
    noteScroll() {
      coarse = true;
      if (timer !== null) clearTimer(timer);
      timer = setTimer(() => {
        timer = null;
        coarse = false;
        options.onRefine();
      }, delay);
    },
    dispose() {
      if (timer !== null) clearTimer(timer);
      timer = null;
    },
  };
}
