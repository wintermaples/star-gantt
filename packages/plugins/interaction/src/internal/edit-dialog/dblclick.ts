// docs/specs/plugins/interaction.md §1.1 ("Double-activation window (edit dialog)") / §1.3 (the
// `idle`/`pressing` rows' `editDialog.press` dispatch) — the double-activation detector the
// gesture arbiter's `ArbiterEditDialog` port feeds.
/**
 * Detects a double activation: two presses of the same target within a time window.
 *
 * Pure and clock-injected, so it is testable without timers. A press of a different target, or one
 * outside the window, starts a new sequence; a detected double resets the state, so a triple press
 * is one double followed by a fresh single. A press the caller marks as not counting (`counts:
 * false` — a non-primary button, a selection modifier held, or any other upstream filter the
 * arbiter already applied) never counts and clears any pending half-double, so two counting presses
 * never pair across an intervening filtered one.
 *
 * The arbiter performs the filtering (`activationCounts`); this detector only tracks the pairing.
 */

/** The double-press detector over an injected clock. */
export interface DoubleActivation {
  /**
   * Records one press of `target` and reports whether it completed a double activation.
   *
   * `counts` defaults to `true`. Passing `false` — the caller has already filtered this press out
   * for a reason of its own (non-primary button, selection modifier held, ...) — never counts as a
   * press and resets the pending half-double, so it always returns `false` and the next counting
   * press starts a fresh sequence rather than pairing with whatever preceded the filtered press.
   */
  press(target: string, counts?: boolean): boolean;
  /**
   * Clears any pending half-double without recording a press at all — for a filtered event that
   * carries no target to press with (a `pointer/barDown` whose hit is not a bar).
   */
  reset(): void;
}

/** Two presses of the same target at most this many milliseconds apart are a double. */
export const DOUBLE_ACTIVATION_MS = 400;

/**
 * Creates a double-press detector: `press(target)` returns true when the same target was pressed
 * at most `windowMs` milliseconds before, and false otherwise. `press(target, false)` — a press the
 * caller has already filtered out — always returns false and resets the detector instead of
 * recording a pending half-double.
 */
export function createDoubleActivation(windowMs: number, now: () => number): DoubleActivation {
  let lastTarget: string | null = null;
  let lastAt = 0;
  const reset = (): void => {
    lastTarget = null;
  };
  return {
    press(target: string, counts = true): boolean {
      if (!counts) {
        reset();
        return false;
      }
      const at = now();
      const double = target === lastTarget && at - lastAt <= windowMs;
      if (double) {
        reset();
        return true;
      }
      lastTarget = target;
      lastAt = at;
      return false;
    },
    reset,
  };
}
