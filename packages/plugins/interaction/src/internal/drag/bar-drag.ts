// docs/specs/plugins/interaction.md §1.3 (`dragging-bar`) — the date and progress drags: what one
// press-and-drag on a bar proposes, draws and commits.
/**
 * The bar-surface half of the drag feature, and every piece of per-drag machinery that belongs to
 * it: the ghost, the auto-scroll loop, the drag tooltip, the dependency preview and the origin
 * hold.
 *
 * The gesture object itself is owned by the controller (it is shared with the row and lane paths),
 * so it arrives as an argument or through the `current()` accessor the controller supplies. Nothing
 * here reaches for a service directly — every outside thing is a dep — so the whole date path is
 * exercisable without booting a host.
 */
import type { TaskId } from "@stargantt/plugin-data-store";
import { edgeVelocity } from "../gesture/auto-scroll";
import { nextFrame } from "../gesture/frame";
import type { FrameHandle } from "../gesture/frame";
import {
  GHOST_FILL,
  GHOST_FILL_TOKEN,
  GHOST_STROKE,
  GHOST_STROKE_TOKEN,
  drawCommitTarget,
  drawGhost,
  ghostRectsFor,
} from "../gesture/ghost";
import type { GhostViewport } from "../gesture/ghost";
import { directSuccessors } from "./dependency-preview";
import { createDragTooltip, DRAG_TOOLTIP_GAP_PX } from "./drag-tooltip";
import type { DragTooltip } from "./drag-tooltip";
import type { TimeRange } from "./gesture";
import {
  applyMove,
  decideMove,
  isCancelledCapture,
  mintCoalesceKey,
  proposalAt,
  progressOf,
  startGesture,
} from "./pointer-gesture";
import type {
  BarPlacement,
  DateGesture,
  Gesture,
  MoveInput,
  ProgressGesture,
} from "./pointer-gesture";
import type { BarDownInput, BarMoveInput, BarUpInput } from "../gesture/arbiter";
import type { DragEditDeps } from "./deps";

/** What the bar drag needs from the controller: the gesture in flight, and how to abandon it. */
export interface BarDragHost {
  /** The gesture the controller currently owns, or `null`. */
  current(): Gesture | null;
  /** Abandons the gesture in flight (the auto-scroll loop's own exit path). */
  cancel(): void;
}

/** The date/progress path of the drag feature. */
export interface BarDrag {
  /** The gesture a bar press arms, or `null` when this press starts none. */
  start(e: BarDownInput, coalesceKeyPrefix: string): Gesture | null;
  /** Advances the gesture with one pointer move. */
  move(active: Gesture, e: BarMoveInput): void;
  /** Commits the release. A cancelled capture never reaches here. */
  commit(active: Gesture, e: BarUpInput): void;
  /** Ends the per-drag machinery; safe to call with none running. */
  settle(): void;
  /** Paints the ghost, the commit target and the dependency preview. */
  draw(g: CanvasRenderingContext2D, vp: Readonly<GhostViewport>, active: DateGesture): void;
  /** The horizontal reach a running date drag needs the scrollable range to cover. */
  measure(active: DateGesture): number;
  /** Removes the tooltip element and cancels any scheduled frame. Owned once by the caller. */
  dispose(): void;
}

export function createBarDrag(deps: DragEditDeps, host: BarDragHost): BarDrag {
  const config = deps.config;

  /** The direct successors the current drag previews, empty while none are previewed. */
  let previewTargets: readonly TaskId[] = [];
  /** Created lazily on the first drag that needs it, so a chart without the option allocates none. */
  let tooltip: DragTooltip | null = null;
  /** The auto-scroll velocity the last pointer position asked for, px per frame, signed. */
  let autoScrollVx = 0;
  /** The scheduled auto-scroll step, while the loop is running. */
  let autoScrollFrame: FrameHandle | null = null;

  function tooltipFor(): DragTooltip {
    tooltip ??= createDragTooltip(deps.root.ownerDocument, deps.chartPane());
    return tooltip;
  }

  /**
   * Where a task's bar sits, in content coordinates, or `undefined` when it has no visible bar.
   *
   * The bar service answers in viewport-local pixels as of the latest composite; the view may
   * scroll during a drag, so the scroll offsets are added back here and subtracted again when the
   * ghost is drawn.
   */
  function placementOf(id: TaskId, range: Readonly<TimeRange>): BarPlacement | undefined {
    const box = deps.bars.barBoxOf(id);
    if (box === undefined) return undefined;
    const vp = deps.viewport();
    const left = box.x + vp.scrollLeft;
    return {
      left,
      top: box.y + vp.scrollTop,
      width: box.width,
      height: box.height,
      // The box's edges against their own dates, which is what the ghost is displaced from. A
      // content x would go stale the moment the drag extends the origin; this padding does not.
      startOffset: left - deps.timeline.tToX(range.start),
      endOffset: left + box.width - deps.timeline.tToX(range.end),
    };
  }

  /**
   * The other selected tasks a move drag carries along, with the dates each holds now, or
   * `undefined` when the press was not inside a multi-selection. Summaries never join: the store
   * rejects direct writes to them.
   */
  function capturePeers(draggedId: TaskId): { id: TaskId; origin: TimeRange }[] | undefined {
    const selected = deps.selected();
    if (!selected.has(draggedId) || selected.size <= 1) return undefined;
    const peers: { id: TaskId; origin: TimeRange }[] = [];
    for (const peerId of selected) {
      if (peerId === draggedId) continue;
      const peer = deps.getTask(peerId);
      if (peer === undefined || peer.type === "summary") continue;
      peers.push({ id: peerId, origin: { start: peer.start, end: peer.end } });
    }
    return peers;
  }

  function start(e: BarDownInput, prefix: string): Gesture | null {
    const kind = e.hit.kind;
    if (kind !== "bar" && kind !== "handle" && kind !== "progress") return null;
    const task = deps.getTask(e.hit.id);
    if (task === undefined) return null;
    // A summary's dates and progress are derived from its children and the store rejects direct
    // writes, so a press on a summary bar starts no gesture at all: no ghost ever suggests an edit
    // that cannot commit.
    if (task.type === "summary") return null;
    const bar = placementOf(task.id, { start: task.start, end: task.end });
    if (bar === undefined) return null;

    const gesture = startGesture({
      // The guard above already admits only these three, but `HitResult.kind` is an open union
      // (other plugins report their own kinds), so the narrowing is spelled out rather than
      // asserted.
      hitKind: kind === "progress" ? "progress" : kind === "handle" ? "handle" : "bar",
      id: task.id,
      pointerId: e.event.pointerId,
      clientX: e.event.clientX,
      clientY: e.event.clientY,
      bar,
      coalesceKey: mintCoalesceKey(prefix),
      origin: { start: task.start, end: task.end },
      progress: task.progress ?? 0,
      // The pointer's own time decides which end a handle drag grabbed; `e.x` is viewport-local, so
      // the viewport's scroll offset turns it back into a content coordinate.
      grabbed: deps.timeline.xToT(e.x + deps.viewport().scrollLeft),
    });

    if (gesture.kind === "date") {
      // A move drag that starts inside the current multi-selection carries the other selected tasks
      // along; their origins are captured now, the displacement is applied at commit time.
      if (config.multiDrag && gesture.mode === "move") {
        const peers = capturePeers(task.id);
        if (peers !== undefined) gesture.peers = peers;
      }
      // The successor set is fixed for the drag's duration; only their geometry is re-read per paint.
      previewTargets = config.dependencyPreview ? directSuccessors(deps.links(), task.id) : [];
    }
    return gesture;
  }

  /** The numbers a pointer event contributes to the gesture arithmetic. */
  function moveInput(active: Gesture, e: { event: PointerEvent; x: number }): MoveInput {
    return {
      clientX: e.event.clientX,
      clientY: e.event.clientY,
      buttons: e.event.buttons,
      altKey: e.event.altKey,
      x: e.x,
      // Only a progress drag needs the offset (a date drag works in client-space deltas), so the
      // viewport is read on that path alone rather than once per move of every drag.
      scrollLeft: active.kind === "progress" ? deps.viewport().scrollLeft : 0,
      pxPerMs: deps.timeline.pxPerMs,
      // Alt handling lives in `proposalAt` alone, so the rounding rule is always passed through —
      // one gate, not two that must agree.
      rounding: deps.snap,
      minDuration: config.minDuration,
    };
  }

  /** Applies the dates to the store, unless they are already what this gesture put there. */
  function commitDates(active: DateGesture, range: Readonly<TimeRange>): void {
    if (range.start === active.dispatched.start && range.end === active.dispatched.end) return;
    // Every peer moves by the same committed displacement, under the same `coalesceKey`, so the
    // whole group is one undo entry. The displacement is measured against the gesture's origin, so
    // a `liveUpdate` drag never accumulates drift across its many dispatches.
    const delta = range.start - active.origin.start;
    active.dispatched = { start: range.start, end: range.end };
    deps.moveTask({
      id: active.id,
      start: range.start,
      end: range.end,
      coalesceKey: active.coalesceKey,
    });
    for (const peer of active.peers ?? []) {
      deps.moveTask({
        id: peer.id,
        start: peer.origin.start + delta,
        end: peer.origin.end + delta,
        coalesceKey: active.coalesceKey,
      });
    }
  }

  /** Applies the fraction to the store, unless it is already what this gesture put there. */
  function commitProgress(active: ProgressGesture, value: number): void {
    if (value === active.dispatched) return;
    active.dispatched = value;
    deps.setProgress({ id: active.id, progress: value, coalesceKey: active.coalesceKey });
  }

  /**
   * The earliest start this proposal implies across the whole gesture. Peers move by the committed
   * displacement, so the leftmost member of a multi-drag — not the grabbed one — decides how far
   * left the gesture reaches.
   */
  function earliestProposedStart(active: DateGesture, range: Readonly<TimeRange>): number {
    const delta = range.start - active.origin.start;
    let earliest = range.start;
    for (const peer of active.peers ?? []) {
      const start = peer.origin.start + delta;
      if (start < earliest) earliest = start;
    }
    return earliest;
  }

  /** The latest end this proposal implies across the whole gesture. */
  function latestProposedEnd(active: DateGesture, range: Readonly<TimeRange>): number {
    const delta = range.start - active.origin.start;
    let latest = range.end;
    for (const peer of active.peers ?? []) {
      const end = peer.origin.end + delta;
      if (end > latest) latest = end;
    }
    return latest;
  }

  /** Asks the axis to cover the earliest start this proposal implies, peers included. */
  function extendOriginFor(active: DateGesture, range: Readonly<TimeRange>): void {
    deps.timeline.requestOriginExtension(earliestProposedStart(active, range));
  }

  /**
   * Scrolls the committed start into view by the minimum amount, and only leftwards.
   *
   * A drag can reach earlier than the chart opened, and the origin extension compensates the scroll
   * while auto-scroll moves it the other way; the two very nearly cancel, so the committed bar can
   * be left behind the viewport's left edge with nothing pointing at it.
   */
  function revealCommitted(active: DateGesture, range: Readonly<TimeRange>): void {
    const earliest = earliestProposedStart(active, range);
    // Only a gesture that reached *earlier than it began* can have had its result hidden on the
    // left. Without this an end resize would reveal the task's *start*.
    if (!(earliest < earliestProposedStart(active, active.origin))) return;
    const x = deps.timeline.tToX(earliest);
    if (!Number.isFinite(x)) return;
    const { scrollLeft } = deps.viewport();
    if (x >= scrollLeft) return;
    deps.scrollTo(x);
  }

  /** One auto-scroll step: scroll, shift the press origin, re-derive the proposal, re-arm. */
  function autoScrollStep(): void {
    autoScrollFrame = null;
    const active = host.current();
    if (active === null || active.kind !== "date" || !active.dragging || autoScrollVx === 0) return;
    // Heading left, the room this step needs may not exist yet: the scroll is clamped at content
    // x 0 and, on a chart that extends its origin, this drag is what creates what lies beyond.
    // Asking first is what breaks the deadlock — scrolling first would clamp at 0 and return below,
    // before the proposal that would have asked for the room was ever re-derived.
    if (autoScrollVx < 0) {
      const reach = earliestProposedStart(active, active.range) + autoScrollVx / deps.timeline.pxPerMs;
      deps.timeline.requestOriginExtension(reach);
    }
    const before = deps.viewport().scrollLeft;
    deps.scrollTo(before + autoScrollVx);
    const moved = deps.viewport().scrollLeft - before;
    // The scrollable range's end stops the loop; the next pointer move can restart it.
    if (moved === 0) return;
    // Scrolling the view under a stationary pointer is the same edit as moving the pointer over a
    // stationary view: shifting the press origin by the scrolled distance lets the ordinary
    // client-delta arithmetic describe it.
    active.clientX -= moved;
    const input = active.lastInput;
    if (input !== undefined) {
      const decision = decideMove(active, input);
      if (decision.type === "date") {
        applyMove(active, decision);
        // Before the commit, and regardless of it: the next frame's scroll needs the range to exist.
        extendOriginFor(active, decision.proposal.commit);
        if (config.liveUpdate) commitDates(active, decision.proposal.commit);
      }
    }
    deps.invalidateOverlay();
    autoScrollFrame = nextFrame(autoScrollStep);
  }

  /**
   * The readout is the dates a release right now would commit, anchored above the dragged bar at
   * the pointer's x so the bar and its handles stay unobscured.
   */
  function showDragTooltip(active: DateGesture, e: { x: number; y: number }): void {
    const box = deps.bars.barBoxOf(active.id);
    tooltipFor().show(
      deps.messages.dragTooltip({ start: active.commit.start, end: active.commit.end }),
      {
        x: e.x,
        yAbove: box === undefined ? e.y : box.y,
        yBelow: (box === undefined ? e.y : box.y + box.height) + DRAG_TOOLTIP_GAP_PX,
        paneWidth: deps.viewport().width,
      },
    );
  }

  function move(active: Gesture, e: BarMoveInput): void {
    const input = moveInput(active, e);
    const decision = decideMove(active, input);
    if (decision.type === "abandon" || decision.type === "ignore") return;
    applyMove(active, decision);

    if (active.kind === "progress") {
      // Nothing is painted for a progress drag, so with `liveUpdate` off the change becomes visible
      // only on release.
      if (decision.type === "progress" && config.liveUpdate) commitProgress(active, decision.value);
      return;
    }
    active.lastInput = input;
    // `liveUpdate: true` dispatches the *snapped* proposal per move, so the store and everything
    // reacting to it follow in real time; the unsnapped ghost is drawn regardless.
    if (decision.type === "date") {
      extendOriginFor(active, decision.proposal.commit);
      if (config.liveUpdate) commitDates(active, decision.proposal.commit);
    }

    if (config.dragTooltip) showDragTooltip(active, e);

    // The pointer's distance into the edge zone sets the velocity; the loop runs on animation
    // frames and each real pointer move re-reads the zone, so leaving it stops the scroll.
    if (config.autoScroll) {
      autoScrollVx = edgeVelocity(e.x, deps.viewport().width);
      if (autoScrollVx !== 0 && autoScrollFrame === null) autoScrollFrame = nextFrame(autoScrollStep);
    }

    // Every move of this gesture repaints: the band now moves with the pointer, so a "skip the
    // repaint while the proposed range is unchanged" short-circuit would freeze it. The view still
    // composites at most once per animation frame.
    deps.invalidateOverlay();
  }

  function commit(active: Gesture, e: BarUpInput): void {
    if (isCancelledCapture(e.event.type)) return;
    if (active.kind === "progress") {
      commitProgress(active, progressOf(active, e.x, deps.viewport().scrollLeft));
      return;
    }
    // A drag whose commit range equals what the store already holds for this gesture — the task's
    // own dates when nothing was dispatched during it — changes nothing and is not worth a history
    // entry.
    const committed = proposalAt(active, moveInput(active, e)).commit;
    commitDates(active, committed);
    // After the commit, so the scroll is measured against the axis the commit has settled.
    revealCommitted(active, committed);
  }

  function settle(): void {
    autoScrollVx = 0;
    autoScrollFrame?.cancel();
    autoScrollFrame = null;
    if (previewTargets.length > 0) previewTargets = [];
    tooltip?.hide();
    // The one place every date gesture ends, so the origin hold cannot be leaked by an exit path
    // (release, Escape, a lost capture, a lost button). While it is held the axis is never
    // retracted, which is what stops a pointer held still mid-drag from having the origin snap back
    // underneath it.
    deps.timeline.releaseOriginExtension();
  }

  /** The ghost's colours for this paint, from the chart's CSS custom properties where set. */
  function ghostColors(): { fill: string; stroke: string } {
    return {
      fill: deps.themeColor(GHOST_FILL_TOKEN) || GHOST_FILL,
      stroke: deps.themeColor(GHOST_STROKE_TOKEN) || GHOST_STROKE,
    };
  }

  function draw(
    g: CanvasRenderingContext2D,
    vp: Readonly<GhostViewport>,
    active: DateGesture,
  ): void {
    const { band, target } = ghostRectsFor(active, deps.timeline, vp);
    const { fill, stroke } = ghostColors();
    if (band !== undefined) drawGhost(g, band, fill, stroke);
    if (target !== undefined) drawCommitTarget(g, target, stroke);
    // Each direct successor is outlined displaced by the drag's own (unsnapped) displacement: a
    // first-order hint, dashed and fill-less so it reads as tentative, never as a second bar.
    if (previewTargets.length === 0) return;
    const deltaPx = deps.timeline.tToX(active.range.start) - deps.timeline.tToX(active.origin.start);
    for (const id of previewTargets) {
      const box = deps.bars.barBoxOf(id);
      if (box === undefined) continue;
      drawCommitTarget(
        g,
        { x: box.x + deltaPx, y: box.y, width: box.width, height: box.height },
        stroke,
      );
    }
  }

  function measure(active: DateGesture): number {
    // The *unsnapped* proposal, so the bound covers what the ghost occupies — but never less than
    // the group's own committed reach. The point reduces by `max`, so a value below that would be
    // actively wrong in a composition where this is the only horizontal contributor: a drag heading
    // left would shrink the range under its own scroll compensation.
    const end = Math.max(
      latestProposedEnd(active, active.range),
      latestProposedEnd(active, active.origin),
    );
    // The same one-viewport slack the bars add, so the two agree on the convention.
    return deps.timeline.tToX(end) + deps.viewport().width;
  }

  return {
    start,
    move,
    commit,
    settle,
    draw,
    measure,
    dispose(): void {
      autoScrollFrame?.cancel();
      autoScrollFrame = null;
      tooltip?.dispose();
      tooltip = null;
    },
  };
}
