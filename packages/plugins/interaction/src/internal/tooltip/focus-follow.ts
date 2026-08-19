// docs/specs/plugins/interaction.md §6.4a — focus-driven display: when the keyboard focus (the a11y
// plugin's focus store) lands on a row, the same content a pointer trigger would show appears
// anchored to the focused bar, so a keyboard-only user gets the tooltip without a pointer.
// Deliberately no live-region mirror — see `onFocusChanged`.
/**
 * The focus-driven tooltip cycle.
 *
 * One small state holder — whether the visible tooltip was put up by a focus move — with a named
 * transition per input, mirroring `hover.ts`. Everything environmental (service resolution, bar
 * geometry) enters through the ports, so the whole cycle is unit-testable with no host and no DOM.
 */
import type { HitResult } from "@stargantt/plugin-view";

/** Where the focused bar's tooltip anchors, in the panel host's local CSS pixels. */
export interface FocusAnchor {
  x: number;
  y: number;
}

/** What the focus-follow cycle is allowed to do; each member maps onto one plugin seam. */
export interface FocusFollowPorts {
  /**
   * The focused bar's anchor point, or `undefined` when the task has no bar to anchor to (unknown
   * id, hidden row, geometry unavailable). Resolved lazily on every call — the providing services
   * may start after this plugin (or never), so nothing is latched.
   */
  anchorOf(id: string | number): FocusAnchor | undefined;
  /** Shows the tooltip for `hit` at `x`/`y` with click semantics (immediate, dismissal-lifting). */
  show(hit: Readonly<HitResult>, x: number, y: number): void;
  /** Whether a tooltip is on screen — read back after `show` to learn whether content resolved. */
  isVisible(): boolean;
  /** Takes the tooltip down immediately (the pointer-leave analogue for a focus move away). */
  hide(): void;
}

/** The focus-follow transitions, one per input. */
export interface FocusFollow {
  /** A focus placement: shows for the new task, or dismisses when there is none. */
  onFocusChanged(id: string | number | undefined): void;
  /** The DOM focus left the chart root entirely: a focus-shown tooltip is dismissed. */
  onRootBlur(): void;
  /** A pointer trigger took over the panel: the visible tooltip is no longer focus-owned. */
  onPointerShow(): void;
}

/** Creates the focus-driven display cycle over `ports`. */
export function createFocusFollow(ports: FocusFollowPorts): FocusFollow {
  /** Whether the currently visible tooltip was put up by a focus placement. */
  let focusShown = false;

  function dismiss(): void {
    if (focusShown) {
      ports.hide();
      focusShown = false;
    }
  }

  return {
    onFocusChanged(id): void {
      // Focus left every row (blur / empty chart): dismiss like a pointer leaving the bar. A
      // pointer-shown tooltip is deliberately left alone — focus movement does not own it.
      if (id === undefined) {
        dismiss();
        return;
      }
      const anchor = ports.anchorOf(id);
      if (anchor === undefined) {
        // The focused task has no bar to anchor to; whatever a previous focus move showed is stale.
        dismiss();
        return;
      }
      // The synthetic hit runs the identical §6.4 content resolution a pointer press on the bar
      // would run, so the keyboard user reads exactly what the pointer user sees. `cursor` is part
      // of the `HitResult` shape but meaningless without a pointer.
      ports.show({ kind: "bar", id, cursor: "default" }, anchor.x, anchor.y);
      focusShown = ports.isVisible();
      // Deliberately NO live-region mirror: the ARIA mirror row the focus just landed on already
      // carries the reading, and the shared polite region is last-write-wins — announcing here
      // would clobber the action announcement of the very keystroke that moved focus (an
      // expand/collapse landed as tooltip text instead of "… expanded").
    },

    onRootBlur: dismiss,

    onPointerShow(): void {
      focusShown = false;
    },
  };
}
