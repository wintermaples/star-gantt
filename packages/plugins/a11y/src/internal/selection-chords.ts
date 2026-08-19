// docs/specs/plugins/a11y.md § Default bindings — the keyboard anchor and the multi-selection chords.
/**
 * The keyboard's relationship with the composed selection: the range anchor, the `Shift`+arrow
 * range chord, the `Ctrl`+`Space` toggle, the `syncSelection` single-row replace, and the
 * announcements that follow an effective change.
 *
 * Everything here works through the late-resolved `SelectionService` and a couple of callbacks, so
 * it can be exercised with plain doubles — no host, no DOM. A composition without a selection
 * service resolves `undefined` on every call: the chords then do nothing and their `when` gate
 * reports them inactive, so the keystrokes fall through to other contributions.
 *
 * **On the A→B→A loop.** Every `select()` this module performs comes straight back through the
 * service's own state subscription, whose handler drops the anchor (a selection this plugin did not
 * make no longer corresponds to a row it chose). Rather than suppressing that handler with a
 * re-entrancy flag, the anchor is **written after** each of this module's own `select()` calls, so
 * its own echo is immediately superseded and a foreign change still clears it
 * (`references/code-quality.md` §4) — correct whether the service publishes synchronously or not.
 */
import { sameIdSet } from "@stargantt/sdk";
import type { TaskId } from "@stargantt/plugin-data-store";
import type { SelectionService } from "@stargantt/plugin-interaction";
import { asIdSet } from "./ids";
import type { FocusCause } from "./mirror";

/** The slice of the row model these chords read; `RowsService` satisfies it structurally. */
export interface RowOrder {
  rowCount(): number;
  rowOf(id: TaskId): number | undefined;
  rowHeight(row: number): number;
  taskIdAt(row: number): TaskId | undefined;
}

/** What a focus placement does to the selection state, by cause. */
export interface PlacementEffects {
  /** Whether the placement becomes the new range anchor. */
  anchor: boolean;
  /** Whether the placement replaces the selection with the focused row (when `syncSelection`). */
  select: boolean;
}

// A `Shift` chord drives the selection over a row range itself, so its placement neither re-anchors
// nor replaces. A pointer press re-anchors (the anchor follows the click) but leaves the selection
// to `stargantt.selection`, which owns what a press selects (toggle on Ctrl, range on Shift) —
// replacing it with `[id]` here would clobber that. A keyboard move and a `FocusService.focus` call
// do both.
/** The anchor / selection consequences of a placement made for `cause`. */
export function placementEffects(cause: FocusCause): PlacementEffects {
  switch (cause) {
    case "shift":
      return { anchor: false, select: false };
    case "pointer":
      return { anchor: true, select: false };
    case "keyboard":
    case "api":
      return { anchor: true, select: true };
    default: {
      // A new cause must state its effects here rather than silently inheriting someone else's.
      const exhaustive: never = cause;
      return exhaustive;
    }
  }
}

export interface SelectionChordsDeps {
  rows: RowOrder;
  /** The late, optional selection lookup — `undefined` while no provider is composed. */
  selection(): SelectionService | undefined;
  /** `A11yConfig.syncSelection`: whether a plain focus move replaces the selection. */
  syncSelection: boolean;
  /** Moves the roving focus by `delta` rows, reporting the move as `Shift`-caused. */
  shiftMoveFocus(delta: number): void;
  /** The task the roving focus currently sits on. */
  focusedTask(): TaskId | undefined;
  /** Speaks through the polite live region. */
  announce(message: string): void;
  /** The `selectionCount` catalog member. */
  selectionCount(count: number): string;
}

export interface SelectionChords {
  /** Applies a focus placement's anchor / `syncSelection` consequences. */
  onFocusPlaced(id: TaskId, cause: FocusCause): void;
  /**
   * Invalidates an anchor whose row has left the row order, at the moment the focus itself moved:
   * checking only when the anchor is read would resurrect one whose row disappeared and came back —
   * a collapse followed by an expand — and `Shift`+arrow would then range from a row the user never
   * anchored on.
   */
  onFocusChanged(): void;
  /** Drops the anchor: the selection is no longer one this plugin chose. */
  onSelectionChanged(): void;
  /** Whether the composed selection reports multi-selection mode (the chords' `when` gate). */
  multiSelection(): boolean;
  /** `Shift`+arrow: moves the focus one row and selects the inclusive visible-row range. */
  shiftMove(delta: number): void;
  /** `Ctrl`+`Space`: toggles the focused row's membership, leaving the rest of the set and the focus. */
  toggleFocused(): void;
  /** The current range anchor, for tests. */
  anchor(): TaskId | undefined;
}

export function createSelectionChords(deps: SelectionChordsDeps): SelectionChords {
  const { rows } = deps;

  // The keyboard anchor for `Shift`+arrow range selection: the row of the last non-Shift focus
  // placement (a plain arrow move, a pointer press, or a `FocusService.focus()` call). Plugin-local,
  // distinct from the pointer path's own anchor inside `stargantt.selection` (the two are accepted
  // to diverge after a mixed Shift-click / Shift+Arrow sequence).
  let anchor: TaskId | undefined;

  /** The selected set of a resolved service, hardened against a foreign provider's payload shape. */
  const selectedOf = (service: SelectionService): ReadonlySet<TaskId> =>
    asIdSet(service.state.get().taskIds) ?? new Set<TaskId>();

  // Announces the resulting selection size through the live region, but only when the chord
  // actually changed the selection (a chord that leaves the set equal announces nothing).
  const announceIfChanged = (service: SelectionService, before: ReadonlySet<TaskId>): void => {
    const after = selectedOf(service);
    if (sameIdSet(before, after)) return;
    deps.announce(deps.selectionCount(after.size));
  };

  /**
   * Selects `ids` and (re)states the anchor afterwards — see the A→B→A note at the top. A foreign
   * subscriber that synchronously moves the focus from inside the echo has its nested anchor write
   * superseded by `anchorAfter`; the chord that just ran is the more recent user intent.
   */
  const applySelection = (
    service: SelectionService,
    ids: readonly TaskId[],
    anchorAfter: TaskId | undefined,
  ): void => {
    service.select(ids);
    anchor = anchorAfter;
  };

  return {
    anchor: () => anchor,

    multiSelection: () => deps.selection()?.mode() === "multi",

    onFocusPlaced: (id, cause) => {
      const effects = placementEffects(cause);
      if (!effects.anchor) return;
      const service = effects.select && deps.syncSelection ? deps.selection() : undefined;
      // Without a composed service `syncSelection` has nothing to sync: the focus moves alone,
      // exactly as with `syncSelection: false`, and no error is reported.
      if (service !== undefined) applySelection(service, [id], id);
      else anchor = id;
    },

    onFocusChanged: () => {
      if (anchor !== undefined && rows.rowOf(anchor) === undefined) anchor = undefined;
    },

    onSelectionChanged: () => {
      anchor = undefined;
    },

    // `Shift`+arrow moves the roving focus one row without the `syncSelection` single-row replace,
    // and selects the inclusive **visible-row range** (the row model's order, i.e. the same rows a
    // Shift-click would range over) between the anchor and the new focus. With no usable anchor,
    // the row the focus is leaving becomes the anchor, so the first Shift press still selects a
    // two-row range rather than acting like a plain move.
    shiftMove: (delta) => {
      const service = deps.selection();
      if (service === undefined) return;
      if (rows.rowCount() === 0) return;
      // A recorded anchor can go stale without ever passing back through a placement: the mirror's
      // own render fallback relocates or clears the focus when the row it was placed on
      // disappears. An anchor whose row no longer exists is therefore treated as no anchor at all.
      const from =
        anchor !== undefined && rows.rowOf(anchor) !== undefined ? anchor : deps.focusedTask();
      deps.shiftMoveFocus(delta);
      anchor = from;
      const newId = deps.focusedTask();
      const anchorRow = from === undefined ? undefined : rows.rowOf(from);
      const newRow = newId === undefined ? undefined : rows.rowOf(newId);
      if (anchorRow === undefined || newRow === undefined) return;
      const lo = Math.min(anchorRow, newRow);
      const hi = Math.max(anchorRow, newRow);
      const range: TaskId[] = [];
      for (let row = lo; row <= hi; row += 1) {
        // A row resolved to height 0 is hidden (that is how the filter hides filtered-out rows) and
        // unreachable for the keyboard, so a range spanning it must not select it: the user would
        // otherwise act on rows nobody can see, and the announced count would not match the visible
        // one.
        if (!(rows.rowHeight(row) > 0)) continue;
        const id = rows.taskIdAt(row);
        if (id !== undefined) range.push(id);
      }
      const before = selectedOf(service);
      applySelection(service, range, from);
      announceIfChanged(service, before);
    },

    // `Ctrl`+`Space`: the keyboard twin of Ctrl-click. The anchor is left exactly as it was.
    toggleFocused: () => {
      const service = deps.selection();
      if (service === undefined) return;
      const id = deps.focusedTask();
      if (id === undefined) return;
      const before = selectedOf(service);
      const next = new Set(before);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      const keep = anchor;
      applySelection(service, [...next], keep);
      announceIfChanged(service, before);
    },
  };
}
