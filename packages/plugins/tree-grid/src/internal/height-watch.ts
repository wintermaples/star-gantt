/**
 * Repaint trigger for a pane whose rendered height changes without a scroll or a data change.
 *
 * Dragging the bottom pane's divider — or resizing the host container vertically — changes the
 * grid pane's height, and none of the grid's other repaint triggers fire for it: without this
 * watcher a taller pane keeps painting its old row count and shows a blank strip at the bottom.
 * The watcher observes the mounted pane element and calls back on a *height* change only; a
 * width-only resize never calls back, so one divider drag frame never costs a second repaint.
 */
// docs/specs/plugins/tree-grid.md § Internal modules — "repaint on a pane height change"; the grid
// owns a `ResizeObserver` on the element `view` mounted it into, registered through `ctx.own()`
// like every other resource.
import type { Disposable } from "@stargantt/core";

/**
 * The one thing this helper needs from `PluginContext`: somewhere to hand its disposal. Narrow on
 * purpose, so the watcher can be unit-tested without a host.
 */
export interface HeightWatchOwner {
  own(d: Disposable): void;
}

/** A height watcher over one element; see `watchPaneHeight`. */
export interface HeightWatch {
  /** Starts watching `target`'s rendered height. The pane calls this once, from `mount()`. */
  watch(target: HTMLElement): void;
}

/**
 * Calls `onHeightChange` whenever the watched element's rendered height changes.
 *
 * Backed by a `ResizeObserver` where one exists, and by a window `resize` listener otherwise (the
 * same fallback the renderer uses for its pane); in an environment with neither, the watcher is
 * inert and `watch()` is harmless. Whichever resource is created is handed to `owner.own()`
 * exactly once, here, so it can never outlive the plugin.
 *
 * Every notification re-measures the element and compares against the last seen height, so a
 * width-only resize schedules nothing. The observer's initial delivery right after `observe()`
 * usually schedules nothing either, since `watch()` has just measured the same box; it does
 * schedule one repaint when layout was not yet settled at that moment, which is the correct
 * outcome rather than a wasted frame.
 */
export function watchPaneHeight(owner: HeightWatchOwner, onHeightChange: () => void): HeightWatch {
  let target: HTMLElement | null = null;
  let lastHeight = 0;

  /** Adopts `el` as the watched element, snapshotting its current height as the baseline. */
  function adopt(el: HTMLElement): void {
    target = el;
    lastHeight = el.getBoundingClientRect().height;
  }

  // A `ResizeObserver` callback runs after layout — at most once per frame during a divider
  // drag — so the re-measure here forces no reflow; the caller coalesces the actual repaint onto
  // the frame clock, keeping the whole path at one paint per animation frame.
  function check(): void {
    if (target === null) return;
    const height = target.getBoundingClientRect().height;
    if (height === lastHeight) return;
    lastHeight = height;
    onHeightChange();
  }

  if (typeof globalThis.ResizeObserver === "function") {
    const observer = new globalThis.ResizeObserver(() => check());
    owner.own({ dispose: () => observer.disconnect() });
    return {
      watch(el): void {
        adopt(el);
        observer.observe(el);
      },
    };
  }

  if (
    typeof globalThis.addEventListener === "function" &&
    typeof globalThis.removeEventListener === "function"
  ) {
    // No `ResizeObserver` (an older or stripped-down environment): a window `resize` listener
    // still covers the host-container case, though not a divider drag — which such an
    // environment's pane host cannot deliver observer notifications for either.
    const onResize = (): void => check();
    globalThis.addEventListener("resize", onResize);
    owner.own({ dispose: () => globalThis.removeEventListener("resize", onResize) });
    return { watch: adopt };
  }

  // Neither API exists (a bare test DOM): the pane still mounts and paints, it just cannot
  // follow a resize.
  return { watch: adopt };
}
