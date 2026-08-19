// docs/specs/plugins/interaction.md §1.3 (`rubber-band`)
/**
 * The rubber-band drag as one state machine with named transitions (`begin` / `move` / `end` /
 * `cancel`), instead of a free `DragCorners | undefined` variable read and written from four
 * handlers.
 *
 * Hostless: the only outside things it touches are the visible bar geometry and a repaint request,
 * both handed in, so the whole gesture is unit-testable without booting a plugin host. It knows
 * nothing about the selection itself — `end()` reports which bars the rectangle caught and whether
 * the release asked for an additive result, and the caller decides what the selection becomes.
 */
import type { TaskId } from "@stargantt/plugin-data-store";
import type { BarGeometry, Rect } from "./paint";
import { normalizeRect, rectsIntersect } from "./rubberband";
import type { DragCorners } from "./rubberband";

export interface RubberBandOptions {
  /** Bar geometry — only `visibleBoxes()` is read, when the gesture ends. */
  geometry: BarGeometry;
  /** Asks for a repaint; called on every transition that changes the rectangle on screen. */
  invalidate(): void;
}

/** What a completed rubber-band gesture caught. */
export interface RubberBandResult {
  /** The ids of every visible bar the rectangle touched, in row order. */
  ids: TaskId[];
  /** Whether the release carried Ctrl/Cmd, i.e. asked to add to the current selection. */
  additive: boolean;
}

/** Modifier state of the pointer event that ended the gesture. */
export interface ReleaseModifiers {
  ctrlKey?: boolean;
  metaKey?: boolean;
}

export interface RubberBandSession {
  /** Whether a gesture is in flight. */
  active(): boolean;
  /** The rectangle to paint, or `undefined` when no gesture is in flight. */
  rect(): Rect | undefined;
  /** Starts a gesture at a press on empty chart space. */
  begin(x: number, y: number): void;
  /** Extends the gesture to the pointer's current position; a no-op when none is in flight. */
  move(x: number, y: number): void;
  /**
   * Ends the gesture at its authoritative final position and reports what it caught, or
   * `undefined` when no gesture was in flight or the capture was cancelled (which abandons the
   * rectangle and leaves the selection untouched).
   */
  end(
    x: number,
    y: number,
    release: ReleaseModifiers & { cancelled?: boolean },
  ): RubberBandResult | undefined;
  /**
   * Abandons a gesture in flight exactly as a cancelled capture does, and reports whether there was
   * one — the Escape path, which must stay inert when there is nothing to cancel.
   */
  cancel(): boolean;
}

export function createRubberBandSession(options: RubberBandOptions): RubberBandSession {
  const { geometry, invalidate } = options;

  /** The drag in progress, or `undefined` when no rubber-band gesture is active. */
  let corners: DragCorners | undefined;

  return {
    active: () => corners !== undefined,
    rect: () => (corners === undefined ? undefined : normalizeRect(corners)),
    begin(x, y): void {
      corners = { originX: x, originY: y, curX: x, curY: y };
      invalidate();
    },
    move(x, y): void {
      if (corners === undefined) return;
      corners.curX = x;
      corners.curY = y;
      invalidate();
    },
    end(x, y, release): RubberBandResult | undefined {
      if (corners === undefined) return undefined;
      // The release carries the gesture's authoritative final position; a move normally arrives
      // immediately before it with the same coordinates, but this does not depend on that.
      const rect = normalizeRect({ ...corners, curX: x, curY: y });
      corners = undefined;
      invalidate();

      // A cancelled capture abandons the gesture: the rectangle disappears and the selection is
      // untouched.
      if (release.cancelled === true) return undefined;

      const ids = geometry
        .visibleBoxes()
        .filter((box) => rectsIntersect(rect, box))
        .map((box) => box.id);
      return { ids, additive: release.ctrlKey === true || release.metaKey === true };
    },
    cancel(): boolean {
      if (corners === undefined) return false;
      corners = undefined;
      invalidate();
      return true;
    },
  };
}
