// docs/specs/plugins/interaction.md §1.3 / §6.2 — the drag controller: the one owner of the
// gesture in flight, routing each pointer input to the date, row or lane path.
/**
 * `setup()` wires; this module decides. It owns the single `gesture` variable the three drag kinds
 * share, the click-move pick-up, the grid-surface press bookkeeping and the frame coalescing, and
 * delegates every kind's own arithmetic to the module beside it.
 *
 * Hostless: everything outside arrives through `DragEditDeps`, so the whole controller is
 * exercisable with plain object literals.
 */
import type { TaskId } from "@stargantt/plugin-data-store";
import type { LaneDragProvider } from "../../types";
import type {
  ArbiterDrag,
  BarDownInput,
  BarMoveInput,
  BarUpInput,
  BackgroundInput,
  DragAxis,
  GridDownInput,
  GridMoveInput,
  GridUpInput,
} from "../gesture/arbiter";
import { nextFrame } from "../gesture/frame";
import type { FrameHandle } from "../gesture/frame";
import { GHOST_STROKE, GHOST_STROKE_TOKEN, drawInsertionLine } from "../gesture/ghost";
import type { GhostViewport } from "../gesture/ghost";
import { createBarDrag } from "./bar-drag";
import type { BarDrag } from "./bar-drag";
import type { DragEditDeps } from "./deps";
import { proposeRange, unrounded } from "./gesture";
import { isUsableLaneProvider, laneTargetAt, markLaneTarget, sourceLaneOf, startLaneGesture } from "./lane-drag";
import type { LaneGesture } from "./lane-drag";
import { exceedsThreshold, isCancelledCapture, mintCoalesceKey } from "./pointer-gesture";
import type { Gesture } from "./pointer-gesture";
import {
  DEPTH_STEP_PX,
  depthFor,
  depthOf,
  rowDropAt,
  rowPlanFor,
  startRowDrag,
  startRowGesture,
} from "./row-drag";
import type { RowBox, RowGesture, RowLookup } from "./row-drag";
import { hasOwnRow, viewportRows } from "./row-list";

/** The drag feature's public face: the arbiter's inputs plus the paint and measure hooks. */
export interface DragController extends ArbiterDrag {
  /** Paints the drag preview — the ghost, the commit target and the row insertion line. */
  draw(g: CanvasRenderingContext2D, vp: Readonly<GhostViewport>): void;
  /** The horizontal reach a running date drag needs the scrollable range to cover. */
  measure(): { width?: number };
  /** Cancels scheduled frames and removes the drag tooltip. Owned once by the caller. */
  dispose(): void;
}

/** The plugin id, used as the `coalesceKey` prefix so keys are attributable. */
const KEY_PREFIX = "stargantt.interaction";

export function createDragController(deps: DragEditDeps): DragController {
  const config = deps.config;

  /** The drag in progress, or `null` when the pointer is not editing anything. */
  let gesture: Gesture | RowGesture | LaneGesture | null = null;
  /** The picked-up task of the click-move alternative, or `null` when none is armed. */
  let armed: { id: TaskId } | null = null;
  /** A grid-row press waiting to travel far enough to become a drag. */
  let gridPress: { id: TaskId; pointerId: number; clientX: number; clientY: number } | null = null;
  /** The store lookups a row drop reads, built once per drag (a move must allocate nothing). */
  let rowLookupCache: RowLookup | null = null;
  /** Whether a drop-indicator dispatch is currently showing a mark (gates the clears). */
  let dropIndicatorShown = false;
  /** The pointer move waiting for the next frame, when `frameSync` batches them. */
  let pendingMove: BarMoveInput | null = null;
  /** The scheduled frame-synced move, while one is pending. */
  let moveFrame: FrameHandle | null = null;

  const barDrag: BarDrag = createBarDrag(deps, {
    current: () => (gesture !== null && (gesture.kind === "date" || gesture.kind === "progress") ? gesture : null),
    cancel: () => cancel(),
  });

  /* --- row helpers -------------------------------------------------------- */

  /** Reused per pointer move: the row list is re-read on every move and must not allocate. */
  const rowBoxScratch: RowBox[] = [];

  /** The visible rows, as the row-drop arithmetic reads them (viewport-local y extents). */
  function rowBoxes(): RowBox[] {
    const vp = deps.viewport();
    return viewportRows(deps.rows, { scrollTop: vp.scrollTop, height: vp.height }, rowBoxScratch);
  }

  /** The store lookups a row drop reads, cached for the length of one gesture. */
  function rowLookup(): RowLookup {
    rowLookupCache ??= {
      getTask: (id) => deps.getTask(id),
      childrenOf: (parent) => deps.childrenOf(parent),
    };
    return rowLookupCache;
  }

  /** Mirrors the current drop gap into the grid pane, or clears it when there is none. */
  function showDropIndicator(active: RowGesture | null): void {
    const drop = active?.drop;
    const mark =
      drop === undefined || active === null ? null : { y: drop.lineY, depth: active.depth };
    // A clear with nothing shown would be a no-op dispatch on every non-row gesture's end.
    if (mark === null && !dropIndicatorShown) return;
    dropIndicatorShown = mark !== null;
    deps.showDropIndicator(mark);
  }

  /**
   * One pointer position names both halves of a drop: the gap (from `y`) and the depth (from how
   * far `clientX` has travelled since the press).
   */
  function updateRowDrop(active: RowGesture, y: number, clientX: number): void {
    const drop = rowDropAt(y, rowBoxes(), active.id);
    active.drop = drop;
    const lookup = rowLookup();
    active.depth =
      drop === undefined
        ? active.originDepth
        : depthFor(drop, active.originDepth, clientX - active.clientX, lookup);
    showDropIndicator(active);
    deps.invalidateOverlay();
  }

  /**
   * The gap and the depth under the release decide the write: a new sibling key, and a new parent
   * when the depth names one. A drop the plan refuses commits nothing.
   */
  function commitRowDrop(active: RowGesture, y: number, clientX: number): void {
    const lookup = rowLookup();
    const drop = rowDropAt(y, rowBoxes(), active.id);
    if (drop === undefined) return;
    const depth = depthFor(drop, active.originDepth, clientX - active.clientX, lookup);
    const plan = rowPlanFor(drop, depth, active.id, lookup);
    if (plan === undefined) return;
    deps.updateTask({ id: active.id, after: { parentId: plan.parentId, orderKey: plan.orderKey } });
  }

  /* --- lane helpers ------------------------------------------------------- */

  /** The composed provider, admitted only when it structurally offers what the drag needs. */
  function laneProvider(): LaneDragProvider | undefined {
    const provider = deps.lanes();
    return isUsableLaneProvider(provider) ? provider : undefined;
  }

  /** `clientY` of a pointer event, relative to the gantt root's inner top edge. */
  function rootY(event: PointerEvent): number {
    return event.clientY - deps.root.getBoundingClientRect().top;
  }

  /** A viewport-local y in root-relative space, derived from a pointer event at a known y. */
  function viewportYToRoot(e: { y: number; event: PointerEvent }, y: number): number {
    return rootY(e.event) - e.y + y;
  }

  function processLaneMove(active: LaneGesture, e: BarMoveInput): void {
    const provider = laneProvider();
    active.target =
      provider === undefined
        ? undefined
        : laneTargetAt(rootY(e.event), provider, active.sourceResourceId);
    if (provider !== undefined) markLaneTarget(provider, active.target?.resourceId ?? null);
  }

  /* --- the axis decision -------------------------------------------------- */

  /**
   * The drag's first decisive movement picks its axis: past the threshold with the vertical
   * component strictly dominant, a body-move drag becomes a lane drag (when a provider resolves a
   * lane for the bar) or a row drag instead of a date drag. Handles and progress strips stay
   * horizontal editors regardless.
   */
  function switchAxisIfVertical(active: Gesture, e: BarMoveInput): "row" | "lane" | "none" {
    if (
      !(config.rowDrag || config.resourceDrag) ||
      active.kind !== "date" ||
      active.mode !== "move" ||
      active.dragging ||
      Math.abs(e.event.clientY - active.clientY) <= Math.abs(e.event.clientX - active.clientX)
    ) {
      return "none";
    }
    if (!exceedsThreshold(e.event.clientX - active.clientX, e.event.clientY - active.clientY)) {
      return "none";
    }
    // A vertical gesture reorders rows, so it can only start from a task that has one. An in-row
    // child of a `collapsedSummary: "split"` row is painted inside its parent's row and has none:
    // dragging it stays a horizontal date edit, the only edit its row can express.
    if (!hasOwnRow(deps.rows, deps.bars, active.id)) return "none";

    if (config.resourceDrag) {
      const provider = laneProvider();
      if (provider !== undefined) {
        const box = deps.bars.barBoxOf(active.id);
        const centre =
          box === undefined ? undefined : viewportYToRoot(e, box.y + box.height / 2);
        const source = sourceLaneOf(provider, active.id, centre);
        if (source !== undefined) {
          const lane = startLaneGesture(active, source.resourceId);
          gesture = lane;
          processLaneMove(lane, e);
          return "lane";
        }
      }
    }
    if (!config.rowDrag) return "none";
    const row = startRowGesture(active, depthOf(active.id, rowLookup()));
    gesture = row;
    updateRowDrop(row, e.y, e.event.clientX);
    return "row";
  }

  /* --- shared endings ----------------------------------------------------- */

  /** Ends whatever per-drag machinery is running; safe to call with none running. */
  function settle(): void {
    rowLookupCache = null;
    // Every ending of a row drag — release, Escape, a lost capture, a lost button — clears the grid
    // pane's mark, so no line can outlive the gesture that owns it.
    showDropIndicator(null);
    pendingMove = null;
    moveFrame?.cancel();
    moveFrame = null;
    barDrag.settle();
  }

  /** Drops the drag without changing anything further, repainting away any ghost. */
  function cancel(): void {
    const active = gesture;
    if (active === null) return;
    // Escape, a cancelled capture and a lost button all end a lane drag with nothing written and
    // nothing marked.
    if (active.kind === "lane") {
      const provider = laneProvider();
      if (provider !== undefined) markLaneTarget(provider, null);
    }
    gesture = null;
    settle();
    if (active.dragging) deps.invalidateOverlay();
  }

  /** What one pointer move does to the gesture — the shared body of the two delivery paths. */
  function processMove(active: Gesture | RowGesture | LaneGesture, e: BarMoveInput): DragAxis {
    if (active.kind === "row") {
      updateRowDrop(active, e.y, e.event.clientX);
      return "row";
    }
    if (active.kind === "lane") {
      processLaneMove(active, e);
      return "lane";
    }
    const switched = switchAxisIfVertical(active, e);
    if (switched !== "none") return switched;
    barDrag.move(active, e);
    return active.dragging ? "bar" : "none";
  }

  /* --- the arbiter's inputs ----------------------------------------------- */

  function press(e: BarDownInput): void {
    if (!config.enabled || gesture !== null) return;
    gesture = barDrag.start(e, KEY_PREFIX);
  }

  function pressMove(e: BarMoveInput): DragAxis {
    const active = gesture;
    if (active === null || active.pointerId !== e.event.pointerId) return "none";
    return processMove(active, e);
  }

  function dragMove(e: BarMoveInput): void {
    const active = gesture;
    if (active === null || active.pointerId !== e.event.pointerId) return;
    // With `frameSync` on, moves landing within one frame collapse to the latest and the arithmetic
    // runs once per frame; the release path processes its own event directly, so a commit never
    // waits on a frame. The press-phase move is deliberately not batched: the arbiter needs the
    // axis decision in the same turn as the event that crossed the threshold.
    if (config.frameSync) {
      pendingMove = e;
      if (moveFrame === null) {
        moveFrame = nextFrame(() => {
          moveFrame = null;
          const queued = pendingMove;
          pendingMove = null;
          if (queued === null) return;
          const current = gesture;
          if (current === null || current.pointerId !== queued.event.pointerId) return;
          processMove(current, queued);
        });
      }
      return;
    }
    processMove(active, e);
  }

  function up(e: BarUpInput): void {
    const active = gesture;
    if (active === null || active.pointerId !== e.event.pointerId) return;
    gesture = null;
    const cancelled = isCancelledCapture(e.event.type);
    // The pick-up is forgotten by a cancelled capture and by a completed drag, not only by Escape;
    // a surviving pick-up from an earlier click must never be placed by a press that follows either.
    if (cancelled || active.dragging) armed = null;
    // Any release on a *different* task disarms the pick-up too, handle and progress presses
    // included: interacting with another task withdraws the intent to place the picked-up one.
    if (armed !== null && active.id !== armed.id) armed = null;

    if (!active.dragging) {
      settle();
      // A press and release that never became a drag is a click; on a bar's body it picks the task
      // up, and the next click on empty chart space places it. A cancelled capture picks nothing up.
      if (config.clickMove && active.kind === "date" && active.mode === "move" && !cancelled) {
        armed = { id: active.id };
      }
      return;
    }
    settle();
    deps.invalidateOverlay();
    // The provider's drop-target mark is cleared by every ending of a lane drag, committed or
    // abandoned, so it is cleared here rather than on the commit path below.
    if (active.kind === "lane") {
      const provider = laneProvider();
      if (provider !== undefined) markLaneTarget(provider, null);
    }
    // A cancelled capture arrives as this gesture's single release; it abandons the drag instead of
    // committing it, exactly as Escape does.
    if (cancelled) return;

    if (active.kind === "lane") {
      const provider = laneProvider();
      if (provider === undefined) return;
      const target = laneTargetAt(rootY(e.event), provider, active.sourceResourceId);
      if (target === undefined) return;
      provider.reassign(active.id, active.sourceResourceId, target.resourceId);
      return;
    }
    if (active.kind === "row") {
      commitRowDrop(active, e.y, e.event.clientX);
      return;
    }
    barDrag.commit(active, e);
  }

  function background(e: BackgroundInput): void {
    // The placing click: a press on empty chart space while a task is picked up moves that task's
    // start to the clicked instant, keeping its duration, rounded exactly as a drag's release would
    // be (Alt bypasses). One click is one edit and one undo entry, so no `coalesceKey` is carried.
    const picked = armed;
    if (picked === null) return;
    armed = null;
    if (!config.clickMove) return;
    const task = deps.getTask(picked.id);
    if (task === undefined || task.type === "summary") return;
    const t = deps.timeline.xToT(e.x + deps.viewport().scrollLeft);
    const round = e.event.altKey ? unrounded : (v: number): number => deps.snap.snap(v);
    const range = proposeRange("move", { start: task.start, end: task.end }, t - task.start, round);
    if (range.start === task.start && range.end === task.end) return;
    deps.moveTask({ id: task.id, start: range.start, end: range.end });
  }

  function gridPressDown(e: GridDownInput): void {
    // The primary button only: a right-press opens the context menu, and a middle-press is not this
    // feature's. A gesture already running (a bar drag) owns the pointer until it ends.
    if (!config.enabled || !config.rowDrag || e.button !== 0 || gesture !== null) return;
    gridPress = { id: e.id, pointerId: e.pointerId, clientX: e.clientX, clientY: e.clientY };
  }

  function gridPressMove(e: GridMoveInput): "none" | "row" {
    const pressed = gridPress;
    if (pressed === null || pressed.pointerId !== e.pointerId || gesture !== null) return "none";
    // In the grid there is no horizontal date edit to compete with, and a purely horizontal
    // movement is how a re-parent is asked for — so any direction past the threshold starts the
    // drag, unlike the bar path's vertical-dominance test.
    if (!exceedsThreshold(e.clientX - pressed.clientX, e.clientY - pressed.clientY)) return "none";
    const lookup = rowLookup();
    if (lookup.getTask(pressed.id) === undefined) return "none";
    // A task the row model places on no row of its own has no row to drag.
    if (!hasOwnRow(deps.rows, deps.bars, pressed.id)) return "none";
    gridPress = null;
    const row = startRowDrag({
      id: pressed.id,
      pointerId: pressed.pointerId,
      coalesceKey: mintCoalesceKey(KEY_PREFIX),
      clientX: pressed.clientX,
      clientY: pressed.clientY,
      surface: "grid",
      originDepth: depthOf(pressed.id, lookup),
    });
    gesture = row;
    updateRowDrop(row, e.y, e.clientX);
    return "row";
  }

  function gridDragMove(e: GridMoveInput): void {
    const active = gesture;
    if (active === null || active.kind !== "row" || active.pointerId !== e.pointerId) return;
    updateRowDrop(active, e.y, e.clientX);
  }

  function gridUp(e: GridUpInput): void {
    if (gridPress?.pointerId === e.pointerId) gridPress = null;
    const active = gesture;
    if (active === null || active.kind !== "row" || active.pointerId !== e.pointerId) return;
    gesture = null;
    settle();
    deps.invalidateOverlay();
    // A cancelled capture abandons the drag instead of committing it, exactly as Escape does.
    if (e.cancelled) return;
    commitRowDrop(active, e.y, e.clientX);
  }

  /* --- painting ----------------------------------------------------------- */

  function draw(g: CanvasRenderingContext2D, vp: Readonly<GhostViewport>): void {
    const active = gesture;
    if (active === null || !active.dragging) return;
    if (active.kind === "row") {
      // The line starts at the indent of the depth a release would commit, so the gesture shows
      // *where* and *how deep* at once.
      if (active.drop !== undefined) {
        drawInsertionLine(
          g,
          active.drop.lineY,
          vp.width,
          deps.themeColor(GHOST_STROKE_TOKEN) || GHOST_STROKE,
          active.depth * DEPTH_STEP_PX,
        );
      }
      return;
    }
    // The target lane is marked by the provider itself, in its own strip, which no canvas layer of
    // this plugin reaches. And a progress drag paints nothing: the hit strip is a zone, not a
    // glyph, and a date-shaped ghost would describe an edit that is not happening.
    if (active.kind !== "date") return;
    barDrag.draw(g, vp, active);
  }

  function measure(): { width?: number } {
    const active = gesture;
    // Nothing at all outside a date drag, so the committed data alone bounds a resting chart.
    if (active === null || active.kind !== "date" || !active.dragging) return {};
    return { width: barDrag.measure(active) };
  }

  return {
    press,
    pressMove,
    dragMove,
    up,
    background,
    gridPress: gridPressDown,
    gridPressMove,
    gridDragMove,
    gridUp,
    cancel,
    clearPress(): void {
      armed = null;
      // A grid press that has not become a drag yet must not turn into one afterwards.
      gridPress = null;
    },
    draw,
    measure,
    dispose(): void {
      moveFrame?.cancel();
      moveFrame = null;
      barDrag.dispose();
    },
  };
}
