// docs/specs/plugins/interaction.md §2.1 / §1.3 — the selection module: the `stargantt.selection`
// service, the press semantics of both surfaces, the rubber band and the bulk delete.
/**
 * Everything the selection feature is, assembled from the pure modules beside it.
 *
 * Hostless: every outside thing it touches (bar geometry, the row order, the grid mirror, the
 * viewport, the store, the command dispatch, the fault channel) arrives as a plain accessor, so the
 * whole feature is exercisable without booting a plugin host.
 */
import { createStore } from "@stargantt/core";
import { sameIdSet } from "@stargantt/sdk";
import type { Store } from "@stargantt/core";
import type { TaskId } from "@stargantt/plugin-data-store";
import type { ResolvedSelection } from "../../config";
import type { InteractionMessages } from "../../messages";
import type { SelectionService, SelectionState } from "../../types";
import { collapseOnMove, collapseOnUp, pressDefersCollapse } from "./deferred-collapse";
import type { PendingCollapse, PointerPoint, PressModifiers } from "./deferred-collapse";
import { createDeleteFlow } from "./delete-flow";
import type { DeleteFlow } from "./delete-flow";
import { revealScrollLeft } from "./reveal";
import { createRubberBandSession } from "./rubber-band-session";
import type { RubberBandSession } from "./rubber-band-session";
import type { BarGeometry } from "./paint";
import { shortcutFor } from "./shortcuts";
import type { ShortcutState } from "./shortcuts";

/** The row order a Shift range is resolved in — the composed row model's own sequence. */
export interface RowOrder {
  rowOf(id: TaskId): number | undefined;
  rowHeight(row: number): number;
  taskIdAt(row: number): TaskId | undefined;
}

/** What the selection module reads from the rest of the composition. */
export interface SelectionDeps {
  /** Bar geometry: the frame pass, the rubber band's catch and the reveal all read it. */
  geometry: BarGeometry;
  /** The composed row order, for Shift-range extension. */
  rows: RowOrder;
  /** Mirrors the selection onto the grid pane's rows. */
  setGridSelected(ids: ReadonlySet<TaskId>): void;
  /** Repaints the selection layer. */
  invalidate(): void;
  /** The chart viewport, for the reveal arithmetic. */
  viewport(): { scrollLeft: number; width: number };
  /** Scrolls the chart horizontally. */
  scrollTo(scrollLeft: number): void;
  /** Time to content x, for a bar with no box in the current composite. */
  tToX(t: number): number;
  /** The task's own dates, for the same fallback. */
  taskDates(id: TaskId): { start: number; end: number } | undefined;
  /** Every task id the store knows — the select-all source. */
  taskIds(): Iterable<TaskId>;
  /** Removes the tasks in one transaction (`task/remove`). */
  removeTasks(ids: readonly TaskId[]): void;
  /** The chart root, where the confirmation dialog mounts and focus is measured against. */
  root: HTMLElement;
  /** Reports a fault in host-supplied code. */
  reportError(error: unknown): void;
}

/** A press on a bar or a grid row, reduced to what the selection reads. */
export interface SelectionPress extends PressModifiers, PointerPoint {
  id: TaskId;
}

/** The selection module: the published service plus the inputs the gesture arbiter drives it by. */
export interface SelectionModule {
  readonly service: SelectionService;
  /** The selected ids right now — the frame pass's input, read once per paint. */
  selected(): ReadonlySet<TaskId>;
  /** The rubber-band rectangle to paint, or `undefined` when no gesture is in flight. */
  rubberBandRect(): ReturnType<RubberBandSession["rect"]>;
  /** Starts a rubber-band gesture at a press on empty chart space. */
  rubberBandBegin(x: number, y: number): void;
  /** Extends the rubber band to the pointer's current position. */
  rubberBandMove(x: number, y: number): void;
  /** Ends the rubber band and adopts what it caught (nothing, for a cancelled capture). */
  rubberBandEnd(
    x: number,
    y: number,
    release: { ctrlKey: boolean; metaKey: boolean; cancelled: boolean },
  ): void;
  /** Abandons a rubber band in flight; reports whether there was one. */
  rubberBandCancel(): boolean;
  /** Applies the selection effect of a press on a bar body. */
  barPress(press: SelectionPress): void;
  /** Applies the selection effect of a press on a grid row (identical semantics). */
  gridPress(press: SelectionPress): void;
  /** A move while a press is pending: past the slop the deferred collapse is discarded. */
  pointerMove(e: PointerPoint): void;
  /** The end of a press: a release in place applies the deferred collapse, every other ending drops it. */
  pointerUp(e: PointerPoint): void;
  /** Drops a pending deferred collapse without resolving it. */
  clearPending(): void;
  /** Whether a bulk-delete confirmation is in flight. */
  confirmInFlight(): boolean;
  /** What a document-level key press means here; `undefined` leaves the key for others. */
  handleKey(press: {
    key: string;
    ctrlKey: boolean;
    metaKey: boolean;
    editableTarget: boolean;
    focusInRoot: boolean;
  }): "select-all" | "clear" | "delete" | undefined;
  /** Performs one of the three shortcut actions. */
  runShortcut(action: "select-all" | "clear" | "delete"): void;
  /** Closes a confirmation dialog in flight. Owned once by the caller. */
  dispose(): void;
}

export function createSelectionModule(
  config: ResolvedSelection,
  messages: InteractionMessages,
  deps: SelectionDeps,
): SelectionModule {
  const mode = config.mode;

  /** The selection itself — the whole of this feature's state. */
  const selected = new Set<TaskId>();
  /**
   * The row of the most recent non-Shift selection action, one end of a Shift-range extension.
   *
   * The press paths move it *before* calling `apply`, which publishes whenever the id set or the
   * anchor differs from what the store currently holds — so an anchor-only press is an effective
   * change like any other and the published state is never stale.
   */
  let anchor: TaskId | undefined;
  /** The collapse a press deferred, waiting for the gesture it belongs to to end. */
  let pending: PendingCollapse | undefined;

  const store = createStore<SelectionState>({ taskIds: new Set<TaskId>() });

  const rubberBand = createRubberBandSession({
    geometry: deps.geometry,
    invalidate: deps.invalidate,
  });

  /**
   * Publishes the current state.
   *
   * `idsChanged` says whether the id set itself moved: only that repaints the chart and re-marks
   * the grid's rows, because neither depends on the anchor. The published `taskIds` snapshot is
   * reused unchanged when the set did not move, so an anchor-only publish allocates nothing and a
   * subscriber comparing `prev.taskIds === next.taskIds` sees the set stand still.
   */
  function publish(idsChanged: boolean): void {
    const snapshot: ReadonlySet<TaskId> = idsChanged ? new Set(selected) : store.get().taskIds;
    if (idsChanged) {
      deps.invalidate();
      // One choke point for every path — pointer, keyboard and programmatic alike.
      deps.setGridSelected(snapshot);
    }
    store.set(anchor === undefined ? { taskIds: snapshot } : { taskIds: snapshot, anchor });
  }

  // §2.1 — the store is published when the id set OR the anchor differs from what is currently
  // published; a write that moves neither publishes nothing, repaints nothing and re-marks nothing.
  /** Adopts `next` as the selection (and whatever `anchor` now holds), publishing only on a change. */
  function apply(next: ReadonlySet<TaskId>): void {
    // Any other write to the selection settles the question the deferred collapse was waiting to
    // answer, so it stops waiting. The collapse's own path clears it before calling in here.
    pending = undefined;
    const idsChanged = !sameIdSet(next, selected);
    // The anchor is moved by the press paths *before* they call in here, so the comparison is
    // against what the store last published rather than against a value this call could set.
    if (!idsChanged && store.get().anchor === anchor) return;
    if (idsChanged) {
      selected.clear();
      for (const id of next) selected.add(id);
    }
    publish(idsChanged);
  }

  /* --- reveal ------------------------------------------------------------ */

  /**
   * Where task `id`'s bar sits horizontally in the chart viewport, or `undefined` when the
   * composition cannot say. The geometry answers for every row in the visible band — including a
   * bar scrolled sideways out of sight, exactly the case worth revealing — and the time scale
   * covers the rest from the task's own dates.
   */
  function barSpan(id: TaskId): { x: number; width: number } | undefined {
    const box = deps.geometry.barBoxOf(id);
    if (box !== undefined) return { x: box.x, width: box.width };
    const dates = deps.taskDates(id);
    if (dates === undefined) return undefined;
    if (!Number.isFinite(dates.start) || !Number.isFinite(dates.end)) return undefined;
    // One viewport read for both ends: two reads could straddle a scroll and produce a span that
    // never existed.
    const scrollLeft = deps.viewport().scrollLeft;
    const left = deps.tToX(dates.start) - scrollLeft;
    const right = deps.tToX(dates.end) - scrollLeft;
    return { x: Math.min(left, right), width: Math.abs(right - left) };
  }

  /** Scrolls the chart the minimum amount that brings `id`'s bar into view; often a no-op. */
  function reveal(id: TaskId): void {
    const span = barSpan(id);
    if (span === undefined) return;
    const vp = deps.viewport();
    const next = revealScrollLeft(span.x, span.width, vp.width, vp.scrollLeft);
    // The view clamps the target to the content extent and only moves for a position that actually
    // changed, so an out-of-range or redundant target costs nothing here.
    if (next !== undefined) deps.scrollTo(next);
  }

  /** The automatic reveal — the grid-press and `select()` paths only, gated on the config. */
  function autoReveal(id: TaskId): void {
    if (config.revealSelected) reveal(id);
  }

  /* --- press handling ---------------------------------------------------- */

  /**
   * The inclusive row range between `from` and `to`, or `undefined` when it cannot be resolved.
   *
   * Every row between the two endpoints joins the range whether or not its bar is currently drawn;
   * a row resolved to height 0 is hidden (how the filter hides filtered-out rows) and unreachable
   * for the keyboard, so a pointer range must not select it either.
   */
  function shiftRange(from: TaskId, to: TaskId): Set<TaskId> | undefined {
    const fromRow = deps.rows.rowOf(from);
    const toRow = deps.rows.rowOf(to);
    if (fromRow === undefined || toRow === undefined) return undefined;
    const lo = Math.min(fromRow, toRow);
    const hi = Math.max(fromRow, toRow);
    const range = new Set<TaskId>();
    for (let row = lo; row <= hi; row++) {
      if (!(deps.rows.rowHeight(row) > 0)) continue;
      const rowId = deps.rows.taskIdAt(row);
      if (rowId !== undefined) range.add(rowId);
    }
    return range;
  }

  /** Applies the selection effect of a press on task `id`'s bar or grid row. */
  function handlePress(id: TaskId, modifiers: PressModifiers): void {
    if (mode === "none") return;
    if (mode !== "multi") {
      apply(new Set<TaskId>([id]));
      return;
    }

    if (modifiers.shiftKey && anchor !== undefined) {
      const range = shiftRange(anchor, id);
      // An unresolvable range falls through to plain-click treatment below — the same outcome as
      // "no anchor".
      if (range !== undefined) {
        apply(range);
        return;
      }
    }

    // The anchor moves BEFORE the set is published, so the snapshot a subscriber receives carries
    // the anchor this very press established rather than the previous one.
    if (modifiers.ctrlKey || modifiers.metaKey) {
      const next = new Set(selected);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      anchor = id;
      apply(next);
      return;
    }

    anchor = id;
    apply(new Set<TaskId>([id]));
  }

  function barPress(press: SelectionPress): void {
    // A new press supersedes whatever the previous one deferred: the gesture that recorded it is
    // over by definition.
    pending = undefined;
    // An unmodified press inside a multi-selection leaves the selection alone for now, so a
    // consumer reading the selection during this same press (the multi-task drag captures its peers
    // there) sees the full pre-press set.
    if (pressDefersCollapse(mode, press, selected, press.id)) {
      pending = {
        id: press.id,
        pointerId: press.pointerId,
        clientX: press.clientX,
        clientY: press.clientY,
      };
      return;
    }
    handlePress(press.id, press);
  }

  function gridPress(press: SelectionPress): void {
    handlePress(press.id, press);
    // The grid row is the one press surface that says nothing about where the bar is, so this is
    // where a reveal earns its keep. It runs even when the press left the selection unchanged. A
    // press on the bar itself deliberately does not reveal: the bar is already under the pointer.
    if (mode !== "none") autoReveal(press.id);
  }

  /* --- bulk delete -------------------------------------------------------- */

  const deleteFlow: DeleteFlow = createDeleteFlow({
    host: deps.root,
    title: (count) => messages.deleteConfirmTitle(count),
    confirmLabel: messages.deleteConfirmButton,
    cancelLabel: messages.deleteCancelButton,
    confirmHook: config.confirmDelete,
    selected: () => selected,
    // One `task/remove` for the whole selection, never one per id: a single transaction, so a
    // single undo restores them all.
    remove: (ids) => deps.removeTasks(ids),
    applySelection: apply,
    reportError: deps.reportError,
  });

  /* --- shortcuts ---------------------------------------------------------- */

  /** Selects every task the composition knows about. */
  function selectAll(): void {
    apply(new Set([...deps.taskIds()]));
  }

  function handleKey(press: {
    key: string;
    ctrlKey: boolean;
    metaKey: boolean;
    editableTarget: boolean;
    focusInRoot: boolean;
  }): "select-all" | "clear" | "delete" | undefined {
    const state: ShortcutState = {
      mode,
      rubberBandActive: rubberBand.active(),
      hasSelection: selected.size > 0,
      focusInRoot: press.focusInRoot,
      confirmInFlight: deleteFlow.inFlight(),
    };
    return shortcutFor(press, config.shortcuts, state);
  }

  function runShortcut(action: "select-all" | "clear" | "delete"): void {
    if (action === "select-all") {
      selectAll();
      return;
    }
    if (action === "clear") {
      apply(new Set());
      return;
    }
    deleteFlow.request();
  }

  /* --- the service -------------------------------------------------------- */

  const service: SelectionService = {
    state: store as Store<SelectionState>,
    select: (ids) => {
      apply(new Set(ids));
      // The host named a task, so the chart shows it. The first id is the one revealed, matching
      // the "primary" task of a multi-id call.
      const first = ids[0];
      if (first !== undefined) autoReveal(first);
    },
    toggle: (id) => {
      const next = new Set(selected);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      apply(next);
    },
    clear: () => apply(new Set()),
    // An explicit request outranks a default-behavior switch: `revealSelected` governs only the
    // automatic reveals (§2.1, deliberate v2 deviation).
    reveal,
    mode: () => mode,
    deleteSelected: () => deleteFlow.request(),
  };

  return {
    service,
    selected: () => selected,
    rubberBandRect: () => rubberBand.rect(),
    rubberBandBegin: (x, y) => rubberBand.begin(x, y),
    rubberBandMove: (x, y) => rubberBand.move(x, y),
    rubberBandEnd(x, y, release): void {
      const caught = rubberBand.end(x, y, release);
      if (caught === undefined) return;
      // Ctrl/Cmd on the release makes the result additive; otherwise it replaces.
      apply(
        caught.additive ? new Set<TaskId>([...selected, ...caught.ids]) : new Set<TaskId>(caught.ids),
      );
    },
    rubberBandCancel: () => rubberBand.cancel(),
    barPress,
    gridPress,
    pointerMove(e): void {
      // Past the slop the press is a drag, and a drag never collapses the selection it started
      // from.
      if (pending !== undefined && collapseOnMove(pending, e) === "discard") pending = undefined;
    },
    pointerUp(e): void {
      // The gesture is over: a release in place by the pressing pointer applies the deferred
      // collapse, and every other ending drops it. Either way nothing stays pending.
      if (pending === undefined) return;
      const resolved = pending;
      pending = undefined;
      if (collapseOnUp(resolved, e) === "apply") {
        // Anchor first, so the published snapshot carries it (see `handlePress`).
        anchor = resolved.id;
        apply(new Set<TaskId>([resolved.id]));
      }
    },
    clearPending(): void {
      pending = undefined;
    },
    confirmInFlight: () => deleteFlow.inFlight(),
    handleKey,
    runShortcut,
    dispose: () => deleteFlow.dispose(),
  };
}
