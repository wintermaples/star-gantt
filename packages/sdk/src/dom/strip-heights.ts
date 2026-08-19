/**
 * Bottom-strip height bookkeeping: what a `view/bottomPanes` contributor tracks about its own
 * strip — the height the layout last reported, whether the reader chose it, and the show/hide
 * toggle that releases the strip at height 0 and restores it later.
 *
 * Pure state: no DOM, no host, no plugin context.
 */

/** One strip's tracked height, plus whether the reader — rather than the plugin — chose it. */
export interface StripHeightTracker {
  /** The strip's current height in CSS px, as last reported (or contributed initially). */
  height(): number;
  /** Whether a height change the plugin did not itself request has been observed. */
  isManual(): boolean;
  /**
   * Runs `dispatch` (a `view/setBottomPaneHeight` dispatch of the plugin's own) with the tracker
   * primed to treat any synchronously arriving `resized` report as self-requested — the layout's
   * clamp may alter the applied value, so the report is matched by origin, not by value.
   */
  selfRequest(dispatch: () => void): void;
  /** Feeds one `onResize` report. Marks the strip user-sized unless inside `selfRequest`. */
  resized(height: number): void;
  /** Seeds the height the contribution initially carried (reported by no `onResize`). */
  seed(height: number): void;
}

/** Creates one strip's height tracker. */
export function createStripHeightTracker(): StripHeightTracker {
  let current = 0;
  let manual = false;
  let inSelfRequest = false;
  return {
    height: () => current,
    isManual: () => manual,
    selfRequest: (dispatch) => {
      inSelfRequest = true;
      try {
        dispatch();
      } finally {
        inSelfRequest = false;
      }
    },
    resized: (height) => {
      current = height;
      // Any height change the plugin did not itself request marks the strip as user-sized.
      if (!inSelfRequest) manual = true;
    },
    seed: (height) => {
      current = height;
    },
  };
}

/** One strip's shown/hidden state (§1 `bandVisible` / `lanesVisible`). */
export interface StripToggle {
  /** Whether the strip is currently shown. */
  visible(): boolean;
  /** Shows or hides the strip; a no-op when it already is in the requested state. */
  set(visible: boolean): void;
}

/** What a strip toggle needs from its surroundings. */
export interface StripToggleDeps {
  /** Whether the strip starts shown — the config value. */
  initial: boolean;
  /** The strip's current height, as the layout last reported it. */
  currentHeight: () => number;
  /**
   * Whether the strip's current height is one the **reader** chose — a divider drag or keystroke,
   * or a host height setter — rather than one the plugin derived (the band's token, the lanes'
   * roster formula). Only a reader's height is worth carrying across a hide.
   */
  readerSized: () => boolean;
  /** The height to show a strip at whose height nobody chose — the band token, the roster
   *  formula, evaluated at the moment of showing. */
  defaultHeight: () => number;
  /** Applies a height through the layout, as a request of the plugin's own. */
  apply: (height: number) => void;
  /** Runs after an actual change, so the plugin can repaint. */
  onChange: () => void;
}

/**
 * Creates one strip's visibility toggle.
 *
 * Hiding applies a height of exactly 0, which the layout treats as releasing the strip outright —
 * no reserved height, no divider.
 *
 * Showing restores the height the **reader** last gave the strip, and otherwise re-derives one
 * from `defaultHeight()` at that moment. The distinction is the whole point: a height the plugin
 * derived is a function of state that may have moved on while the strip was hidden — the lanes'
 * roster formula above all — so replaying it would put back a strip sized for a roster that no
 * longer exists, which is the very "band of empty height nobody asked for" this toggle exists to
 * prevent. A height the reader chose is theirs and is replayed verbatim.
 *
 * The initial state is carried by the contribution's own height, so constructing the toggle
 * applies nothing.
 */
export function createStripToggle(deps: StripToggleDeps): StripToggle {
  let shown = deps.initial;
  /** The reader's height to restore on the next show; `0` = they never chose one. */
  let remembered = 0;
  return {
    visible: () => shown,
    set: (next) => {
      if (next === shown) return;
      if (!next) {
        // Captured *before* the release, so the layout's own clamp on the released height can
        // never become the height the strip is later restored to — and only when the reader chose
        // it, so a stale derived height can never be replayed.
        const current = deps.currentHeight();
        remembered = deps.readerSized() && current > 0 ? current : 0;
      }
      shown = next;
      deps.apply(next ? (remembered > 0 ? remembered : deps.defaultHeight()) : 0);
      deps.onChange();
    },
  };
}
