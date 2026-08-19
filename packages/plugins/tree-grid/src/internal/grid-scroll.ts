/**
 * The grid's scroll state: the shared vertical viewport position, and the horizontal lockstep
 * between the header and the body.
 *
 * Wheel input consumed by the grid never moves its own vertical offset directly — it asks the
 * view plugin to move the shared vertical viewport through `requestScrollTop`, and the new
 * position comes back through the viewport subscription, mirrored in here via
 * `onViewportScrollTop`, which is what actually schedules the grid's repaint. The horizontal
 * offset is the body's own native scroll and stays entirely private to the grid.
 */
// docs/specs/plugins/tree-grid.md § Scroll synchronization — the shared vertical viewport as the
// single source of truth, native horizontal scrolling with a bidirectional header lockstep kept
// private to the grid, the extent the clamp measures, and scroll-into-view.
import type { TaskId } from "@stargantt/plugin-data-store";
import { normalizeWheelDelta } from "@stargantt/sdk";
import type { RowModel } from "./row-model";

/** The parts of a `WheelEvent` the grid reads. */
interface GridWheelEvent {
  deltaX: number;
  deltaY: number;
  /** 0 = pixels, 1 = lines, 2 = pages (the `WheelEvent.DOM_DELTA_*` constants). */
  deltaMode: number;
  shiftKey: boolean;
  preventDefault(): void;
}

export interface GridScrollDeps {
  model: RowModel;
  /** The pane viewport's height in CSS px. */
  viewportHeight(): number;
  /** Queues a repaint on the next frame. */
  schedule(): void;
  /**
   * Asks the view plugin to move the shared vertical viewport (`ViewService.scrollTo`). The grid
   * never moves its own vertical offset directly; the new position comes back through the
   * viewport subscription.
   */
  requestScrollTop(scrollTop: number): void;
  /**
   * The renderer's resolved wheel-speed multiplier, or `1` when the composition has no renderer —
   * both panes scroll the shared vertical viewport at one speed.
   */
  wheelSpeedFactor?(): number;
}

export interface GridScroll {
  /** The current virtual vertical offset in CSS px. */
  top(): number;
  /** Clamps the virtual offset into the current content range; call once per repaint. */
  clamp(): void;
  /**
   * Consumes the vertical component of a wheel gesture, asking the view plugin to move the shared
   * vertical viewport. A horizontal-dominant gesture (trackpad pan, `Shift`+wheel, horizontal
   * wheel) is left untouched so it falls through to the body's native horizontal scroll container.
   */
  onWheel(e: GridWheelEvent): void;
  /** Mirrors the shared vertical viewport in, repainting only when the offset moved. */
  onViewportScrollTop(scrollTop: number): void;
  /**
   * Brings the row for `id` fully within the pane viewport by the minimum amount, doing nothing when
   * the row is already fully visible or is not part of the current row model (unknown id, or hidden
   * inside a collapsed branch).
   */
  scrollRowIntoView(id: TaskId): void;
}

export function createGridScroll(deps: GridScrollDeps): GridScroll {
  const { model } = deps;
  let current = 0;

  return {
    top: () => current,
    clamp(): void {
      const max = Math.max(0, model.totalHeight() - deps.viewportHeight());
      if (current > max) current = max;
      if (current < 0) current = 0;
    },
    onWheel(e): void {
      if (e.shiftKey || Math.abs(e.deltaX) > Math.abs(e.deltaY)) return;
      e.preventDefault();
      // docs/specs/plugins/tree-grid.md § Scroll synchronization — the same wheel-unit
      // normalization and the same speed multiplier as the chart pane's wheel path, so one notch
      // moves the shared vertical viewport identically whichever pane it lands on.
      const dy = normalizeWheelDelta(e, deps.viewportHeight()).dy * (deps.wheelSpeedFactor?.() ?? 1);
      const max = Math.max(0, model.totalHeight() - deps.viewportHeight());
      const next = Math.min(max, Math.max(0, current + dy));
      if (next === current) return;
      // Not an offset of its own: `current` is the provisional value of the shared viewport, which
      // the request below round-trips back through `onViewportScrollTop` inside this same call
      // stack (store notification is synchronous), where the equality guard stops it.
      current = next;
      deps.schedule();
      deps.requestScrollTop(next);
    },
    onViewportScrollTop(scrollTop): void {
      if (scrollTop === current) return;
      current = scrollTop;
      deps.schedule();
    },
    scrollRowIntoView(id): void {
      const row = model.rowOf(id);
      if (row === undefined) return;
      const y = model.yOf(row);
      const h = model.rowHeight(row);
      const vh = deps.viewportHeight();
      let next = current;
      if (y < current) next = y;
      else if (y + h > current + vh) next = y + h - vh;
      const max = Math.max(0, model.totalHeight() - vh);
      next = Math.min(max, Math.max(0, next));
      if (next === current) return;
      // Provisional, exactly as in `onWheel`: the request round-trips back into
      // `onViewportScrollTop` on this same call stack and stops at its equality guard.
      current = next;
      // A scroll that actually moves the pane repaints, exactly like a wheel scroll: the
      // round-tripped viewport update comes back with the offset already stored here and stops at
      // `onViewportScrollTop`'s equality guard, so this is the only place the repaint can be
      // queued. Callers do not add one of their own — `setFocused` reflects its mark in place and
      // schedules nothing.
      // docs/specs/plugins/tree-grid.md § Scroll synchronization
      deps.schedule();
      deps.requestScrollTop(next);
    },
  };
}

/**
 * The horizontal lockstep handler: mirrors `source`'s `scrollLeft` onto `target`.
 *
 * Registered in both directions — the body's native scroll drives the header, and a scroll of the
 * header itself (the browser's scroll-into-view when an off-pane header cell takes keyboard focus)
 * drives the body back — so the two can never come to rest misaligned. The equality guard is what
 * stops the pair from re-triggering each other.
 */
export function mirrorScrollLeft(source: HTMLElement, target: HTMLElement): () => void {
  return () => {
    if (target.scrollLeft !== source.scrollLeft) target.scrollLeft = source.scrollLeft;
  };
}
