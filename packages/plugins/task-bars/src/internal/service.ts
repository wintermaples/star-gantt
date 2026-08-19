/**
 * The `stargantt.task-bars` geometry service and the composite snapshot behind it.
 *
 * One place owns every bar box this plugin produces: the boxes the paint pass draws, the box the
 * on-demand service member computes, and the snapshot the two composite members answer from. The
 * rule itself still lives in `./geometry` — this module only chooses coordinate spaces and keeps
 * the snapshot.
 */
import type { Task, TaskId } from "@stargantt/plugin-data-store";
import type { BarBox, CollapsedSummary, TaskBarsService } from "../types";
import type { ExpandReader, RowReader, ScrollOffsets, TaskReader, TimeMapper } from "./deps";
import type { EndGutterReader } from "./gutter";
import { NO_GUTTER } from "./gutter";
import type { Rect } from "./geometry";
import { barRect, isSummary } from "./geometry";

/** The services bar geometry is derived from. */
export interface BarGeometryDeps {
  rows: RowReader;
  data: TaskReader;
  scale: TimeMapper;
  /** Expansion state, so the service can tell a collapsed summary from an expanded one. */
  expand: ExpandReader;
  /** What a collapsed summary presents, which decides whether it has a bar of its own. */
  collapsedSummary: CollapsedSummary;
  // The resolved reservation is published on every box this plugin reports; omitting the reader is
  // the gutter-free composition, which reports 0.
  /** The resolved end-gutter pair, read per box from the latest resolution. */
  gutter?: Pick<EndGutterReader, "current">;
}

/** A bar box together with the task it belongs to. */
export interface PlacedBar {
  task: Readonly<Task>;
  box: BarBox;
}

/**
 * Bar geometry for one plugin instance: the published service plus the two computations the paint
 * pass needs and the hand-off that installs each finished pass as the latest composite.
 */
export interface BarGeometry {
  /** The value published as the `stargantt.task-bars` service. */
  readonly service: TaskBarsService;
  /**
   * Content-space box for a task on any row — on screen or not — or `undefined` when the task is
   * unknown or hidden inside a collapsed branch.
   */
  contentBoxOf(id: TaskId): BarBox | undefined;
  /**
   * Viewport-local box for the task occupying one row, or `null` when that row has nothing to
   * draw (no task id, or an id the store does not know).
   */
  placedBarAt(row: number, vp: ScrollOffsets): PlacedBar | null;
  /**
   * Viewport-local box for an arbitrary task placed in a given row — the split-view pass draws a
   * collapsed parent's children in the parent's own row band with this.
   */
  placedBoxFor(task: Readonly<Task>, row: number, vp: ScrollOffsets): BarBox;
  /** Converts a time instant to a viewport-local x, given the current horizontal scroll. */
  viewX(t: number, scrollLeft: number): number;
  /**
   * Installs the snapshot a finished paint pass produced as the latest composite, which is what
   * the two composite members answer from afterwards.
   */
  commit(list: BarBox[], index: Map<TaskId, BarBox>): void;
}

// The one bar-geometry computation, in content coordinates: the paint pass, the hit test and the
// service's on-demand member all go through `internal/geometry`'s `barRect`, so the contractual
// rule (inset 4, minimum height 6, minimum width 2, milestone box = a square of the bar height
// centred on the start instant) exists once.
/** Builds the geometry service and the snapshot the paint pass feeds it. */
export function createBarGeometry(deps: BarGeometryDeps): BarGeometry {
  const { rows, data, scale, expand, collapsedSummary } = deps;
  const gutter = deps.gutter;
  // One place turns the geometry rule's rectangle into a published box, so the reservation reaches
  // `barBoxOf`, `visibleBoxes`, `barRect` and every box handed to a contribution alike.
  const boxOf = (id: TaskId, rect: Readonly<Rect>, dx: number, dy: number): BarBox => {
    const reserved = gutter === undefined ? NO_GUTTER : gutter.current();
    return {
      id,
      x: rect.x - dx,
      y: rect.y - dy,
      width: rect.width,
      height: rect.height,
      gutterStart: reserved.start,
      gutterEnd: reserved.end,
    };
  };
  // One closure for the whole instance rather than one per bar per frame: `barRect` takes the
  // time→x mapping as a function, and allocating it inside the pass would be a per-bar allocation
  // in the hot draw path.
  const tToX = (t: number): number => scale.tToX(t);

  // The boxes the last paint pass produced. The pass computes them in order to draw, so publishing
  // them costs one array push and one map insert per visible row; nothing is recomputed on the read
  // side, which is what makes the service safe to call from a pointer handler.
  let compositeList: BarBox[] = [];
  let compositeIndex = new Map<TaskId, BarBox>();

  function contentBoxOf(id: TaskId): BarBox | undefined {
    // `rowOf` is `undefined` for an unknown id and for a task hidden inside a collapsed branch,
    // which are exactly the two cases the member answers `undefined` for.
    const row = rows.rowOf(id);
    if (row === undefined) return undefined;
    // A row whose resolved `rows/height` is 0 is hidden, so it has no geometry to answer with.
    // Without this a consumer that draws from a box rather than from the bar itself (dependency
    // routing, overlays) keeps drawing the row after it has been filtered out, collapsed onto
    // whichever row follows it.
    if (!(rows.rowHeight(row) > 0)) return undefined;
    const task = data.getTask(id);
    if (task === undefined) return undefined;
    const rect = barRect(task, rows.yOf(row), rows.rowHeight(row), tToX);
    return boxOf(task.id, rect, 0, 0);
  }

  // The presentation question `barRect` deliberately does not answer. `barRect` reports a collapsed
  // summary's rolled-up span whatever the mode, because a dependency line into a folded branch has
  // to land somewhere; a plugin decorating a *bar* needs to know whether one is painted, which is
  // this.
  function hasOwnBar(id: TaskId): boolean {
    const row = rows.rowOf(id);
    if (row === undefined) return false;
    if (!(rows.rowHeight(row) > 0)) return false;
    const task = data.getTask(id);
    if (task === undefined) return false;
    if (collapsedSummary === "range") return true;
    return !(isSummary(task) && !expand.isExpanded(id));
  }

  const service: TaskBarsService = {
    barBoxOf: (id) => compositeIndex.get(id),
    // A fresh array per call, so a caller may keep it across frames; the boxes inside are shared
    // with the paint pass and the contract forbids mutating them.
    visibleBoxes: () => compositeList.slice(),
    // Computed per call rather than read from the composite: the caller may ask about a task the
    // last paint never visited, and the answer is scroll-independent.
    barRect: (id) => contentBoxOf(id),
    hasOwnBar,
  };

  return {
    service,
    contentBoxOf,
    placedBarAt(row: number, vp: ScrollOffsets): PlacedBar | null {
      const id = rows.taskIdAt(row);
      if (id === undefined) return null;
      // A hidden (zero-height) row draws nothing, and contributes nothing to the geometry snapshot
      // the paint pass publishes.
      if (!(rows.rowHeight(row) > 0)) return null;
      const task = data.getTask(id);
      if (task === undefined) return null;
      const content = barRect(task, rows.yOf(row), rows.rowHeight(row), tToX);
      return { task, box: boxOf(task.id, content, vp.scrollLeft, vp.scrollTop) };
    },
    placedBoxFor(task: Readonly<Task>, row: number, vp: ScrollOffsets): BarBox {
      const content = barRect(task, rows.yOf(row), rows.rowHeight(row), tToX);
      return boxOf(task.id, content, vp.scrollLeft, vp.scrollTop);
    },
    viewX: (t: number, scrollLeft: number): number => tToX(t) - scrollLeft,
    commit(list: BarBox[], index: Map<TaskId, BarBox>): void {
      compositeList = list;
      compositeIndex = index;
    },
  };
}
