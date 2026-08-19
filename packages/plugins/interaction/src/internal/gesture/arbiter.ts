// docs/specs/plugins/interaction.md §1 — the unified gesture arbiter.
/**
 * One state machine decides what every pointer event means, and dispatches the result to the
 * feature modules.
 *
 * Previously the same `pointer/*` stream was subscribed independently by selection, drag-edit,
 * tooltip and context-menu, which competed with each other; here click / drag-start / hover
 * interpretation is decided in one place. The machine is hostless — every feature arrives as a
 * plain interface — so all nine states and all ten inputs are exercisable with recording doubles.
 *
 * The transition tables of §1.3 are implemented literally: one method per input, one branch per
 * state, and an explicit no-op wherever the table says "ignored".
 */
import type { Events } from "@stargantt/core";
import type { TaskId } from "@stargantt/plugin-data-store";
// Type-only: they load the sibling packages' `declare module "@stargantt/core"` augmentations, so
// the input payloads below are the very shapes the view and the tree grid emit rather than
// hand-copied restatements of them. Erased at emit — no runtime edge is added.
import type {} from "@stargantt/plugin-view";
import type {} from "@stargantt/plugin-tree-grid";

/* ------------------------------------------------------------------ *
 * Input payloads — the ten surviving input-stream events
 * ------------------------------------------------------------------ */

export type BarHoverInput = Events["pointer/barHover"];
export type BarDownInput = Events["pointer/barDown"];
export type BarMoveInput = Events["pointer/barMove"];
export type BarUpInput = Events["pointer/barUp"];
export type BackgroundInput = Events["pointer/background"];
export type GridDownInput = Events["grid/rowPointerDown"];
export type GridMoveInput = Events["grid/rowPointerMove"];
export type GridUpInput = Events["grid/rowPointerUp"];
export type GridRowMenuInput = Events["grid/rowContextMenu"];
export type GridBackgroundMenuInput = Events["grid/backgroundContextMenu"];

/* ------------------------------------------------------------------ *
 * States
 * ------------------------------------------------------------------ */

// docs/specs/plugins/interaction.md §1.2 — the nine states.
/**
 * `link-drag` is reserved: no input can enter it until Phase 4 wires the dependency port gestures,
 * and it exists in the type so that wiring re-shapes nothing.
 */
export type ArbiterState =
  | "idle"
  | "hover"
  | "pressing"
  | "dragging-bar"
  | "dragging-row"
  | "dragging-lane"
  | "rubber-band"
  | "link-drag"
  | "context";

/* ------------------------------------------------------------------ *
 * The feature modules the arbiter dispatches to
 * ------------------------------------------------------------------ */

/** A pointer position, as the selection's deferred collapse reads it. */
export interface ArbiterPoint {
  pointerId: number;
  clientX: number;
  clientY: number;
  /** The raw event's `type`; `"pointercancel"` marks a lost capture. */
  type: string;
}

/** A press reduced to what the selection reads, whichever surface delivered it. */
export interface ArbiterPress extends ArbiterPoint {
  id: TaskId;
  ctrlKey: boolean;
  metaKey: boolean;
  shiftKey: boolean;
}

/** What the arbiter drives the selection module by. */
export interface ArbiterSelection {
  mode(): "single" | "multi" | "none";
  barPress(press: ArbiterPress): void;
  gridPress(press: ArbiterPress): void;
  /** A move while a press is pending — the deferred collapse's slop test. */
  pointerMove(e: ArbiterPoint): void;
  /** The end of a press — the deferred collapse's resolution. */
  pointerUp(e: ArbiterPoint): void;
  /** Drops a pending deferred collapse without resolving it. */
  clearPending(): void;
  rubberBandBegin(x: number, y: number): void;
  rubberBandMove(x: number, y: number): void;
  rubberBandEnd(
    x: number,
    y: number,
    release: { ctrlKey: boolean; metaKey: boolean; cancelled: boolean },
  ): void;
  /** Abandons a rubber band in flight; reports whether there was one. */
  rubberBandCancel(): boolean;
}

/** What one press-and-move became, as the drag module reports it back to the arbiter. */
export type DragAxis = "none" | "bar" | "row" | "lane";

/** What the arbiter drives the drag module by. */
export interface ArbiterDrag {
  /** Arms a gesture for a bar press (a no-op for a hit kind this module does not edit). */
  press(e: BarDownInput): void;
  /** A move while a press is armed: the threshold and the axis decision. */
  pressMove(e: BarMoveInput): DragAxis;
  /** A move while a bar-surface drag is running. */
  dragMove(e: BarMoveInput): void;
  /** The release or cancelled capture of a bar-surface gesture. */
  up(e: BarUpInput): void;
  /** A press on empty chart space — the click-move placement. */
  background(e: BackgroundInput): void;
  /** A grid-row press: arms the row-drag press bookkeeping. */
  gridPress(e: GridDownInput): void;
  /** A move while a grid press is armed. */
  gridPressMove(e: GridMoveInput): "none" | "row";
  /** A move while a grid-originated row drag runs. */
  gridDragMove(e: GridMoveInput): void;
  /** The release or cancelled capture of a grid-originated gesture. */
  gridUp(e: GridUpInput): void;
  /** Abandons whatever is running without committing anything. */
  cancel(): void;
  /** Drops an armed press: a grid press that never became a drag, and the click-move pick-up. */
  clearPress(): void;
}

/** What the arbiter drives the tooltip module by (inert until wired). */
export interface ArbiterTooltip {
  /** A hover sample over a bar, or off every bar when `hit` is absent. */
  hover(e: BarHoverInput): void;
  /** A press on a bar: shows for the click trigger, and records the hover dismissal. */
  press(e: BarDownInput): void;
  /** Hides while a gesture owns the pointer. */
  suppress(): void;
  /** Escape: hides and sticks the dismissal to the tracked target. */
  dismiss(): void;
}

/**
 * What the arbiter drives the context menu by (inert until wired).
 *
 * Each `openAt*` reports whether a menu actually opened (review round 1 minor-1 fix): an empty
 * resolution opens nothing, and the arbiter must not enter its `context` state for a press that
 * opened no menu — doing so would strand the machine under no menu until the next press, with hover
 * and the tooltip inert in between.
 */
export interface ArbiterContextMenu {
  /** Whether the feature is composed at all — a menu press is an ordinary press without it. */
  enabled(): boolean;
  openAtHit(e: BarDownInput): boolean;
  openAtBackground(e: BackgroundInput): boolean;
  openAtRow(e: GridRowMenuInput): boolean;
  openAtGridBackground(e: GridBackgroundMenuInput): boolean;
  close(): void;
}

/**
 * What the arbiter drives the edit dialog by (inert until wired).
 *
 * The double-activation detector is fed presses, not releases: bus events carry no click count, so
 * two presses of the same target inside the window are the double. Every press that the arbiter
 * filters out still arrives, with `counts: false`, so a filtered press between two plain ones
 * cannot let them pair.
 *
 * `target` is an opaque detector key (`"bar:<id>"` / `"row:<id>"`, `String(id)`-stamped so a
 * `"bar:"` and a `"row:"` press of the same task never pair); `id` rides alongside it as the raw,
 * untouched `TaskId` — the string is only ever a detector key, never something to parse back into
 * an id. `TaskId` is `string | number`, so reconstructing it by slicing the prefix off `target`
 * would always yield a string and silently never match a numeric id in the store.
 */
export interface ArbiterEditDialog {
  /** Records one press of `target`/`id`; a press with `counts: false` only resets the detector (`id`
   *  then unused — nothing opens on a filtered press). */
  press(target: string, id: TaskId, counts: boolean): void;
  /** Clears a pending half-double for a press that carries no target at all. */
  reset(): void;
}

/** Everything the arbiter needs. */
export interface ArbiterDeps {
  selection: ArbiterSelection;
  drag: ArbiterDrag;
  tooltip: ArbiterTooltip;
  contextMenu: ArbiterContextMenu;
  editDialog: ArbiterEditDialog;
}

/** The arbiter: one method per input-stream event, plus Escape and the menu's own close. */
export interface Arbiter {
  state(): ArbiterState;
  barHover(e: BarHoverInput): void;
  barDown(e: BarDownInput): void;
  barMove(e: BarMoveInput): void;
  barUp(e: BarUpInput): void;
  background(e: BackgroundInput): void;
  gridPointerDown(e: GridDownInput): void;
  gridPointerMove(e: GridMoveInput): void;
  gridPointerUp(e: GridUpInput): void;
  gridContextMenu(e: GridRowMenuInput): void;
  gridBackgroundContextMenu(e: GridBackgroundMenuInput): void;
  /** Escape, delivered from the document-level listener. */
  escape(): void;
  /**
   * The menu widget closed itself — on an outside press, on focus leaving it, on a scroll, on a
   * data change or on activating an entry. The machine returns to `idle`.
   */
  menuClosed(): void;
}

/** The secondary (context-menu) pointer button. */
const RIGHT_BUTTON = 2;

/**
 * Whether a press asks for the context menu: a secondary-button press, or Ctrl + the primary button
 * (the macOS convention, honored on every OS so the gesture is portable).
 */
export function isMenuPress(event: { button: number; ctrlKey: boolean }): boolean {
  return event.button === RIGHT_BUTTON || (event.button === 0 && event.ctrlKey === true);
}

/**
 * Whether a press may count towards a double activation: no selection modifier held, and not a
 * button known to be non-primary.
 *
 * "Known to be non-primary" fails open — a `button` that is not a readable number counts as
 * primary — so an emitter that omits the field cannot silently disable the gesture.
 */
export function activationCounts(event: {
  button?: number;
  ctrlKey?: boolean;
  metaKey?: boolean;
  shiftKey?: boolean;
}): boolean {
  const modifierHeld =
    event.ctrlKey === true || event.metaKey === true || event.shiftKey === true;
  const nonPrimary = typeof event.button === "number" && event.button !== 0;
  return !modifierHeld && !nonPrimary;
}

/** The press bookkeeping `pressing` and the three dragging states carry. */
interface ActivePress {
  /** Which surface the press came from — it decides which move stream advances the gesture. */
  readonly surface: "bar" | "grid" | "background";
  readonly pointerId: number;
}

/** A bar press reduced to the flat shape the selection reads. */
function barPressOf(e: BarDownInput, id: TaskId): ArbiterPress {
  return {
    id,
    pointerId: e.event.pointerId,
    clientX: e.event.clientX,
    clientY: e.event.clientY,
    ctrlKey: e.event.ctrlKey === true,
    metaKey: e.event.metaKey === true,
    shiftKey: e.event.shiftKey === true,
    type: e.event.type,
  };
}

/** A grid-row press reduced to the same flat shape. */
function gridPressOf(e: GridDownInput): ArbiterPress {
  return {
    id: e.id,
    pointerId: e.pointerId,
    clientX: e.clientX,
    clientY: e.clientY,
    ctrlKey: e.ctrlKey,
    metaKey: e.metaKey,
    shiftKey: e.shiftKey,
    // The grid publishes a flat shape with no raw event; a tracked press is never a cancelled
    // capture (its own `cancelled` flag rides the release instead).
    type: "pointerdown",
  };
}

/** A pointer move or release reduced to what the deferred collapse reads. */
function pointOf(e: BarMoveInput | BarUpInput): ArbiterPoint {
  return {
    pointerId: e.event.pointerId,
    clientX: e.event.clientX,
    clientY: e.event.clientY,
    type: e.event.type,
  };
}

/** The three hit kinds this plugin's own gestures start from. */
function isEditableHitKind(kind: string): boolean {
  return kind === "bar" || kind === "handle" || kind === "progress";
}

export function createArbiter(deps: ArbiterDeps): Arbiter {
  const { selection, drag, tooltip, contextMenu, editDialog } = deps;

  let state: ArbiterState = "idle";
  let press: ActivePress | undefined;

  /** Whether this event's pointer is the one that started the gesture in flight. */
  function ownsPointer(pointerId: number): boolean {
    return press !== undefined && press.pointerId === pointerId;
  }

  /** Ends whatever is in flight and returns to rest. */
  function toIdle(): void {
    press = undefined;
    state = "idle";
  }

  /** The `idle` row of `pointer/barDown`, shared by `hover` and (after a close) by `context`. */
  function pressFromIdle(e: BarDownInput): void {
    if (contextMenu.enabled() && isMenuPress(e.event)) {
      // A press this branch diverts to the context menu is exactly the button/modifier-filtered
      // kind that must still reset the double-activation detector — reaching here without
      // touching it would let two plain presses pair across an intervening menu press
      // (left, right, left).
      if (e.hit.kind === "bar") {
        editDialog.press(`bar:${String(e.hit.id)}`, e.hit.id, false);
      } else {
        editDialog.reset();
      }
      // minor-1 fix: only enter `context` when a menu actually opened. An empty resolution leaves
      // the machine exactly where this press found it — `idle`/`hover` untouched (so a following
      // hover still arms the tooltip), or `idle` when the press arrived via a prior `context` (the
      // menu it just closed is gone and nothing replaced it).
      if (contextMenu.openAtHit(e)) {
        state = "context";
      } else if (state === "context") {
        state = "idle";
      }
      return;
    }
    // Only the bar body selects: a handle press starts a resize and a link press belongs to the
    // dependency feature.
    if (e.hit.kind === "bar") {
      selection.barPress(barPressOf(e, e.hit.id));
      editDialog.press(`bar:${String(e.hit.id)}`, e.hit.id, activationCounts(e.event));
    } else {
      // A non-bar hit carries no target to press with, so the detector is cleared directly.
      editDialog.reset();
    }
    // A hit kind outside bar/handle/progress (a link, a port, a third party's own shape) arms no
    // gesture — the reserved `link-drag` state stays unreachable until Phase 4 wires it.
    if (isEditableHitKind(e.hit.kind)) drag.press(e);
    tooltip.press(e);
    press = { surface: "bar", pointerId: e.event.pointerId };
    state = "pressing";
  }

  /** The `idle` row of `pointer/background`, shared by `hover` and (after a close) by `context`. */
  function backgroundFromIdle(e: BackgroundInput): void {
    if (contextMenu.enabled() && isMenuPress(e.event)) {
      // minor-1 fix: as `pressFromIdle` above — only enter `context` on an actual open.
      if (contextMenu.openAtBackground(e)) {
        state = "context";
      } else if (state === "context") {
        state = "idle";
      }
      return;
    }
    tooltip.suppress();
    // A press on empty space ends whatever the previous gesture deferred.
    selection.clearPending();
    // The click-move placement and the rubber-band begin are not exclusive — in
    // `"multi"` mode with an armed pick-up both happen on the same press.
    drag.background(e);
    if (selection.mode() === "multi") {
      selection.rubberBandBegin(e.x, e.y);
      press = { surface: "background", pointerId: e.event.pointerId };
      state = "rubber-band";
      return;
    }
    state = "idle";
  }

  /** The `idle` row of `grid/rowPointerDown`, shared by `hover` and `context`. */
  function gridPressFromIdle(e: GridDownInput): void {
    selection.gridPress(gridPressOf(e));
    drag.gridPress(e);
    editDialog.press(`row:${String(e.id)}`, e.id, activationCounts(e));
  }

  /** The `pressing` / dragging rule that outranks every other move handling. */
  function abandonedByButtons(e: BarMoveInput): boolean {
    if (e.event.buttons !== 0) return false;
    // A release lost outside the window, or a pointer taken over by another application. Nothing
    // further is dispatched and nothing is reverted: live dispatches stand as dispatched.
    drag.cancel();
    selection.clearPending();
    toIdle();
    return true;
  }

  return {
    state: () => state,

    barHover(e): void {
      // The renderer suppresses hover sampling while it owns a capture, so every other state
      // ignores this input.
      if (state !== "idle" && state !== "hover") return;
      tooltip.hover(e);
      state = "hover";
    },

    barDown(e): void {
      if (state === "context") {
        // Close first, then process exactly as from `idle` — which may re-open at the new hit.
        contextMenu.close();
        pressFromIdle(e);
        return;
      }
      // A gesture is already armed or running: the press stream belongs to it.
      if (state !== "idle" && state !== "hover") return;
      pressFromIdle(e);
    },

    barMove(e): void {
      switch (state) {
        case "hover":
          // Defensive: the renderer emits `barMove` only during a gesture.
          tooltip.suppress();
          state = "idle";
          return;
        case "context":
          // The anchor is about to move under the menu.
          contextMenu.close();
          toIdle();
          return;
        case "pressing": {
          if (press?.surface !== "bar") return;
          if (abandonedByButtons(e)) return;
          selection.pointerMove(pointOf(e));
          const axis = drag.pressMove(e);
          if (axis === "none") return;
          tooltip.suppress();
          state = axis === "bar" ? "dragging-bar" : axis === "row" ? "dragging-row" : "dragging-lane";
          return;
        }
        case "dragging-bar":
        case "dragging-lane":
        case "dragging-row": {
          // A grid-originated row drag is advanced by the grid's own move stream instead.
          if (press?.surface !== "bar" || !ownsPointer(e.event.pointerId)) return;
          if (abandonedByButtons(e)) return;
          drag.dragMove(e);
          return;
        }
        case "rubber-band": {
          // A move carrying a hit is not the background-started gesture this state tracks.
          if (e.hit !== undefined) return;
          selection.rubberBandMove(e.x, e.y);
          return;
        }
        default:
          return;
      }
    },

    barUp(e): void {
      switch (state) {
        case "pressing": {
          if (press?.surface !== "bar") return;
          // Click resolution: the deferred collapse applies only on a release in place.
          selection.pointerUp(pointOf(e));
          drag.up(e);
          toIdle();
          return;
        }
        case "dragging-bar":
        case "dragging-row":
        case "dragging-lane": {
          if (press?.surface !== "bar" || !ownsPointer(e.event.pointerId)) return;
          drag.up(e);
          toIdle();
          return;
        }
        case "rubber-band": {
          if (e.hit !== undefined) return;
          selection.rubberBandEnd(e.x, e.y, {
            ctrlKey: e.event.ctrlKey === true,
            metaKey: e.event.metaKey === true,
            cancelled: e.event.type === "pointercancel",
          });
          toIdle();
          return;
        }
        default:
          return;
      }
    },

    background(e): void {
      if (state === "context") {
        contextMenu.close();
        backgroundFromIdle(e);
        return;
      }
      // While a capture is in flight the whole press stream is routed through barMove/barUp, so
      // this input cannot occur in the pressing or dragging states.
      if (state !== "idle" && state !== "hover") return;
      backgroundFromIdle(e);
    },

    gridPointerDown(e): void {
      if (state === "context") {
        // The menu stays open: it is the widget's own outside-press listener that closes it, after
        // which the machine is effectively in the `idle` handling of this press.
        gridPressFromIdle(e);
        return;
      }
      // A running gesture owns the pointer, and a second pointer never arms.
      if (state !== "idle" && state !== "hover") return;
      gridPressFromIdle(e);
      press = { surface: "grid", pointerId: e.pointerId };
      state = "pressing";
    },

    gridPointerMove(e): void {
      if (state === "pressing") {
        if (press?.surface !== "grid" || !ownsPointer(e.pointerId)) return;
        if (drag.gridPressMove(e) === "row") state = "dragging-row";
        return;
      }
      if (state === "dragging-row") {
        if (press?.surface !== "grid" || !ownsPointer(e.pointerId)) return;
        drag.gridDragMove(e);
      }
    },

    gridPointerUp(e): void {
      if (state !== "pressing" && state !== "dragging-row") return;
      if (press?.surface !== "grid" || !ownsPointer(e.pointerId)) return;
      drag.gridUp(e);
      toIdle();
    },

    gridContextMenu(e): void {
      switch (state) {
        case "idle":
        case "hover":
        case "pressing":
          // The press bookkeeping of `pressing` is dropped, menu opens or not.
          selection.clearPending();
          drag.clearPress();
          press = undefined;
          // minor-1 fix: only enter `context` on an actual open; otherwise `idle` — the dropped
          // press bookkeeping means there is nothing left to return `pressing`/`hover` to.
          state = contextMenu.openAtRow(e) ? "context" : "idle";
          return;
        case "context":
          contextMenu.close();
          state = contextMenu.openAtRow(e) ? "context" : "idle";
          return;
        default:
          // The chart pane holds the capture: the grid pane cannot open a menu over it.
          return;
      }
    },

    gridBackgroundContextMenu(e): void {
      switch (state) {
        case "idle":
        case "hover":
        case "pressing":
          selection.clearPending();
          drag.clearPress();
          press = undefined;
          // minor-1 fix: as `gridContextMenu` above.
          state = contextMenu.openAtGridBackground(e) ? "context" : "idle";
          return;
        case "context":
          contextMenu.close();
          state = contextMenu.openAtGridBackground(e) ? "context" : "idle";
          return;
        default:
          return;
      }
    },

    escape(): void {
      switch (state) {
        case "idle":
        case "hover":
          // The opt-in `clearOnEscape` shortcut runs on its own path (it is a keyboard shortcut,
          // not a gesture input); here Escape only forgets a click-move pick-up and dismisses a
          // visible tooltip.
          drag.clearPress();
          tooltip.dismiss();
          return;
        case "pressing":
          // The armed gesture, a pending grid press, a deferred collapse and a click-move pick-up
          // are all dropped; nothing is dispatched.
          drag.cancel();
          drag.clearPress();
          selection.clearPending();
          tooltip.dismiss();
          toIdle();
          return;
        case "dragging-bar":
        case "dragging-row":
        case "dragging-lane":
          // The drag is abandoned: the task keeps whatever the store holds — live dispatches stand
          // as dispatched — the ghost is repainted away and the machinery is settled.
          drag.cancel();
          drag.clearPress();
          tooltip.dismiss();
          toIdle();
          return;
        case "rubber-band":
          // Exactly as a cancelled capture: the rectangle disappears, the selection is untouched,
          // and the eventual `pointer/barUp` finds no gesture.
          selection.rubberBandCancel();
          selection.clearPending();
          tooltip.dismiss();
          toIdle();
          return;
        case "context":
          // The menu widget closes itself on Escape; the machine follows it back to rest, and the
          // pick-up and tooltip dismissals of the `idle` row still run.
          contextMenu.close();
          drag.clearPress();
          tooltip.dismiss();
          toIdle();
          return;
        default:
          return;
      }
    },

    menuClosed(): void {
      if (state !== "context") return;
      toIdle();
    },
  };
}
