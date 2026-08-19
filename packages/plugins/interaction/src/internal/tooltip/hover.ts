// docs/specs/plugins/interaction.md §6.4a — trigger and the hover delays (`showDelay`/`hideDelay`),
// sticky Escape dismissal, and the WCAG 1.4.13 "Hoverable" grace period. The trigger-dependent
// branching (click/both shows on press, hover records a sticky dismissal on press) lives in
// `wire.ts`, which is the only caller that knows the configured trigger.
/**
 * When the tooltip appears and disappears.
 *
 * One state object — the tracked target, the dismissed target and the two pending timers — with a
 * named transition per input, instead of free variables written from several handlers. The panel it
 * drives is a plain port (`isVisible` / `show` / `hide`), so the whole machine, delays included, can
 * be exercised with fake timers and no DOM.
 *
 * The state:
 *
 * | Field | Meaning |
 * |---|---|
 * | `tracked` | the `kind:id` key of the target the machine currently follows |
 * | `dismissed` | the key a dismissal (Escape, or a hover-trigger press) stuck; no show timer is armed for it |
 * | `showTimer` | counting down to a hover-triggered show |
 * | `hideTimer` | counting down to a hover-end hide |
 */
import type { HitResult } from "@stargantt/plugin-view";

/** The `kind:id` key of one hit-test result — the identity the hover state machine tracks by. */
export function hitKey(hit: Readonly<HitResult>): string {
  return `${hit.kind}:${String(hit.id)}`;
}

/** What the machine is allowed to do to the tooltip panel. */
export interface HoverPanelPort {
  /** Whether a tooltip is currently on screen. */
  isVisible(): boolean;
  /**
   * Shows the tooltip for `hit` at `x`/`y`, and reports whether it went up: a `false` means the
   * content resolution declined and the panel was left untouched.
   */
  show(hit: Readonly<HitResult>, x: number, y: number): boolean;
  /** Takes the tooltip down. */
  hide(): void;
}

/** The two hover delays, in milliseconds, already validated and defaulted. */
export interface HoverDelays {
  showDelay: number;
  hideDelay: number;
}

/**
 * The tooltip's show/hide state machine. Each method is one input; nothing else mutates the state.
 */
export interface HoverMachine {
  /**
   * A pointer-down on a bar (the click/both trigger show). It outranks everything in flight: pending
   * timers are dropped, any sticky dismissal is lifted, and the tooltip either shows at once or —
   * when nothing resolves — goes down.
   */
  onClick(hit: Readonly<HitResult>, x: number, y: number): void;
  /**
   * A hover sample over a bar. Entering a new target arms the show delay for it; resting on the
   * tracked target changes nothing; a target dismissed (Escape or a hover-trigger press) stays
   * dismissed.
   */
  onHit(hit: Readonly<HitResult>, x: number, y: number): void;
  /** A hover sample over no bar: the show delay is dropped and the hide delay armed. */
  onLeave(): void;
  /** The pointer entered the panel itself — the pending hide is cancelled (WCAG 1.4.13 hoverable). */
  onPanelEnter(): void;
  /** The pointer left the panel — the same hide delay is armed again (WCAG 1.4.13 hoverable). */
  onPanelLeave(): void;
  /**
   * A dismissal: hides now, and sticks it to the tracked target — only leaving the bar or a fresh
   * `pointer/barDown` lifts it. Used both for Escape (every trigger) and for a hover-trigger press
   * on the currently hover-tracked bar (§6.4a "hover" state row).
   */
  onDismiss(): void;
  /** A scroll: hides now and forgets both the tracked and the dismissed target. */
  onScroll(): void;
  /**
   * A gesture or a background press: hides now, without touching the tracked target, so the
   * tooltip stays down for the rest of the gesture.
   */
  onSuppress(): void;
  /** Drops both pending timers, for disposal. */
  cancelTimers(): void;
}

type Timer = ReturnType<typeof globalThis.setTimeout>;

interface HoverState {
  tracked: string | undefined;
  dismissed: string | undefined;
  showTimer: Timer | null;
  hideTimer: Timer | null;
  /** The latest sampled coordinates for the pending show, updated by every same-target `onHit`. */
  pending: { x: number; y: number } | undefined;
}

/** Creates the state machine driving `panel` with the given delays. */
export function createHoverMachine(panel: HoverPanelPort, delays: HoverDelays): HoverMachine {
  const state: HoverState = {
    tracked: undefined,
    dismissed: undefined,
    showTimer: null,
    hideTimer: null,
    pending: undefined,
  };

  function clearShowTimer(): void {
    if (state.showTimer !== null) {
      globalThis.clearTimeout(state.showTimer);
      state.showTimer = null;
    }
    state.pending = undefined;
  }

  function clearHideTimer(): void {
    if (state.hideTimer !== null) {
      globalThis.clearTimeout(state.hideTimer);
      state.hideTimer = null;
    }
  }

  // §6.4a WCAG 1.4.13 "Hoverable" — the one grace period the panel gets: the pointer leaving the bar
  // and the pointer leaving the panel arm the identical countdown, so a pointer travelling from the
  // bar into the panel keeps the tooltip alive. Nothing is armed when there is nothing shown, and an
  // already-running countdown is never restarted.
  /** Arms the hover-end hide, if a visible tooltip is not already counting down. */
  function armHide(): void {
    if (!panel.isVisible() || state.hideTimer !== null) return;
    state.hideTimer = globalThis.setTimeout(() => {
      state.hideTimer = null;
      panel.hide();
      state.tracked = undefined;
    }, delays.hideDelay);
  }

  /**
   * Arms the show delay for a freshly entered target.
   *
   * The coordinates are read from `state.pending` at fire time, not captured here: further
   * same-target `onHit` samples update `state.pending` while the timer counts down (the pointer
   * usually keeps moving during the delay), so the eventual `show()` anchors on where the pointer
   * ended up, not where it entered.
   */
  function armShow(hit: Readonly<HitResult>, x: number, y: number): void {
    state.pending = { x, y };
    state.showTimer = globalThis.setTimeout(() => {
      state.showTimer = null;
      const coords = state.pending;
      state.pending = undefined;
      if (coords !== undefined) panel.show(hit, coords.x, coords.y);
    }, delays.showDelay);
  }

  /**
   * Common tail of every "point the machine at a different target" transition: tracks `key`, drops
   * the show timer and takes down whatever the previous target was showing. The caller decides
   * what happens next — nothing more (the target is dismissed) or a fresh `armShow` (it is not).
   */
  function retarget(key: string): void {
    state.tracked = key;
    clearShowTimer();
    if (panel.isVisible()) panel.hide();
  }

  return {
    onClick(hit, x, y): void {
      // A "both" composition can have a hover cycle in flight; a click always wins outright.
      clearShowTimer();
      clearHideTimer();
      // §6.4a — a deliberate click always re-opens a bar a dismissal had stuck, whatever bar it
      // lands on.
      state.dismissed = undefined;
      if (!panel.show(hit, x, y)) {
        state.tracked = undefined;
        panel.hide();
        return;
      }
      // Track the clicked bar as the current hover target too, so the very next `pointer/barHover`
      // sample over the same bar (which fires on virtually every subsequent mouse-move frame) is
      // treated as a same-bar continuation rather than a "different bar" transition that would
      // immediately hide and restart the show-delay countdown. This is what makes "both" a superset
      // of "click" rather than a degraded version of it.
      // `pointer/barDown` always carries a hit — a press that resolves to none is
      // `pointer/background` instead — so the key is unconditional.
      state.tracked = hitKey(hit);
    },

    onHit(hit, x, y): void {
      const key = hitKey(hit);
      // Re-entering the tracked bar within `hideDelay` cancels the pending hide outright.
      clearHideTimer();

      // §6.4a — a dismissal stuck this exact bar (WCAG 1.4.13): keep tracking it, but never arm the
      // show timer for it, however long the pointer dwells. Only leaving the bar or a fresh
      // `pointer/barDown` lifts the dismissal.
      if (key === state.dismissed) {
        retarget(key);
        return;
      }

      if (key === state.tracked && (panel.isVisible() || state.showTimer !== null)) {
        // Same bar, and either already shown or still counting down to its first show. A
        // still-pending show keeps tracking the latest coordinates so it anchors on where the
        // pointer ended up, not where it entered; an already-shown tooltip is not repositioned by
        // further rest samples.
        if (state.showTimer !== null) state.pending = { x, y };
        return;
      }

      // A different bar (or the same bar re-entered from a full hide): restart the show timer
      // for it, hiding whatever the previous target was showing immediately.
      retarget(key);
      armShow(hit, x, y);
    },

    onLeave(): void {
      // The pointer left every bar. A pending show never fired, so nothing is owed to it.
      clearShowTimer();
      // §6.4a — the sticky dismissal ends when the pointer leaves the dismissed bar.
      state.dismissed = undefined;
      if (panel.isVisible()) {
        armHide();
      } else {
        // Nothing shown or pending: forget the last target so a later hover of the same bar
        // is treated as a fresh enter rather than a no-op continuation.
        state.tracked = undefined;
      }
    },

    onPanelEnter: clearHideTimer,
    onPanelLeave: armHide,

    onDismiss(): void {
      // Nothing shown and nothing counting down to a show: there is nothing to dismiss. Without
      // this, a stale `tracked` left over from a suppressed gesture (`onSuppress` deliberately
      // keeps it, see below) would get latched into `dismissed` here, sticking a bar the user never
      // saw a tooltip for.
      if (!panel.isVisible() && state.showTimer === null) return;
      clearShowTimer();
      clearHideTimer();
      // For the hover trigger, stick the dismissal to this exact bar (WCAG 1.4.13): further
      // same-bar `pointer/barHover` samples must not re-arm the show timer.
      if (state.tracked !== undefined) state.dismissed = state.tracked;
      panel.hide();
    },

    onScroll(): void {
      clearShowTimer();
      clearHideTimer();
      state.tracked = undefined;
      state.dismissed = undefined;
      panel.hide();
    },

    onSuppress(): void {
      // Deliberately leaves `tracked` alone (unlike `onScroll`, which forgets it): a gesture or a
      // background press takes the tooltip down but is not itself a dismissal, so the very next
      // `onHit` for the same bar shows again normally instead of being treated as a fresh target.
      // That same untouched `tracked` is exactly why `onDismiss` above cannot latch `dismissed`
      // from `tracked` alone — it also has to check something is actually visible or pending,
      // or a stray dismissal after a suppressed gesture would stick a dismissal to a bar whose
      // tooltip the user never saw.
      clearShowTimer();
      clearHideTimer();
      panel.hide();
    },

    cancelTimers(): void {
      clearShowTimer();
      clearHideTimer();
    },
  };
}
