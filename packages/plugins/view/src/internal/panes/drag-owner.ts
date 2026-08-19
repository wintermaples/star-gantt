/**
 * Single-owner pointer-drag arbitration — pure, hostless
 * (`.claude/skills/gantt-ui-ux/references/code-quality.md` §2: when two pointer state machines
 * coexist, their mutual exclusion must be code, not a comment). The plugin has two divider drag
 * machines — the vertical side-pane dividers and the horizontal bottom-pane dividers — and both
 * route their gestures through one owner: a `pointerdown` claims the owner, and while a claim is
 * active every other `pointerdown` is refused, so two dividers can never track the same (or two
 * concurrent) pointers at once. Events from a pointer other than the claiming one are ignored,
 * which keeps a second touch contact from steering or ending someone else's drag.
 */

/** A pointer press below this many CSS px of travel counts as a click, not a drag. */
export const CLICK_THRESHOLD_PX = 3;

/** One in-progress divider drag, as its `pointerdown` handler describes it. */
export interface DragClaim {
  /** The claiming pointer; events carrying any other `pointerId` are ignored. */
  pointerId: number;
  /** Called for every `pointermove` of the claiming pointer while the claim is active. */
  move(e: PointerEvent): void;
  /**
   * Called when the claiming pointer is released (`pointerup`), after the claim has been cleared —
   * the press-classification hook (a sub-threshold press is a click, not a drag). Not called for
   * `pointercancel`, which drops the claim silently.
   */
  up(): void;
  /**
   * Called when the drag is aborted (`Escape`), after the claim has been cleared, so the owner of
   * the drag can revert what its `move()` steps applied. Optional: a claim without it aborts by
   * simply dropping, exactly like `pointercancel`.
   */
  cancel?(): void;
}

/** The arbiter the document-level pointer listeners feed and the `pointerdown` handlers claim. */
export interface DragOwner {
  /** Takes ownership for one drag. Refused (returns `false`) while another claim is active. */
  claim(c: DragClaim): boolean;
  /** Routes a `pointermove` to the active claim, if it came from the claiming pointer. */
  move(e: PointerEvent): void;
  /** Ends the active claim on its pointer's `pointerup`, invoking the claim's `up()`. */
  up(e: PointerEvent): void;
  /** Drops the active claim on its pointer's `pointercancel`, without invoking `up()`. */
  cancel(e: PointerEvent): void;
  /**
   * Aborts the active claim (`Escape` while a drag runs), invoking the claim's optional
   * `cancel()` revert hook. A no-op with no active claim; returns whether a claim was aborted.
   */
  abort(): boolean;
}

/** Creates an owner with no active claim. */
export function createDragOwner(): DragOwner {
  let active: DragClaim | null = null;
  return {
    claim(c: DragClaim): boolean {
      if (active !== null) return false;
      active = c;
      return true;
    },
    move(e: PointerEvent): void {
      if (active !== null && e.pointerId === active.pointerId) active.move(e);
    },
    up(e: PointerEvent): void {
      if (active === null || e.pointerId !== active.pointerId) return;
      const ended = active;
      // Cleared before `up()` runs, so a re-entrant press from inside the callback can claim.
      active = null;
      ended.up();
    },
    cancel(e: PointerEvent): void {
      if (active !== null && e.pointerId === active.pointerId) active = null;
    },
    abort(): boolean {
      if (active === null) return false;
      const aborted = active;
      // Cleared before the hook runs, mirroring `up()`'s re-entrancy discipline.
      active = null;
      aborted.cancel?.();
      return true;
    },
  };
}
