/**
 * The `renderer/hitTest` contribution of `stargantt.task-bars`: what a point in the chart body
 * lands on.
 *
 * The classification itself is `./geometry`'s `hitKind`; this module only walks from a viewport
 * point to the one row that point falls in and to that row's task.
 */
import type { HitTester } from "@stargantt/plugin-view";
import type { Task } from "@stargantt/plugin-data-store";
import type { CollapsedSummary, MilestoneShape } from "../types";
import type {
  ExpandReader,
  RowHeightReader,
  RowReader,
  ScrollOffsets,
  TaskReader,
  TaskTreeReader,
  TimeMapper,
} from "./deps";
import {
  BAR_CURSOR,
  HANDLE_CURSOR,
  PROGRESS_CURSOR,
  barRect,
  hitKind,
  isMilestone,
  withinExpanded,
} from "./geometry";
import { isHiddenSummaryRow, isSplitParentRow, visibleChildIdsOf } from "./split";

/** The display options the hit test honours; all default to the classic behaviour. */
export interface HitTestOptions {
  /** Widen every bar's hit zone to at least 24 × 24 CSS px. */
  expandedHitArea?: boolean;
  /** What a collapsed summary shows, which decides what a point over its row can land on. */
  collapsedSummary?: CollapsedSummary;
}

/** What the hit test reads: the row model, the store, the time scale and the scroll offsets. */
export interface HitTestDeps {
  /** Row geometry, plus the by-task height resolution the split row's child filter needs. */
  rows: RowReader & RowHeightReader;
  data: TaskReader;
  scale: TimeMapper;
  /** The chart viewport as of the pointer event — the `ViewService.viewport` store's value. */
  viewport(): ScrollOffsets;
  /** Expansion state; required only when a display option needs it. */
  expand?: ExpandReader;
  /** Child index; required only for the split-view option. */
  tree?: TaskTreeReader;
  /**
   * The resolved marker shape for one milestone; omitted means every milestone hit-tests as the
   * default diamond. Non-default shapes hit-test as the full bounding square.
   */
  shapeOf?: (task: Readonly<Task>) => MilestoneShape;
  options?: HitTestOptions;
}

/** What a hit tester answers with. */
type Hit = ReturnType<HitTester>;

/** The one row a content-space Y falls in, with the task it shows. */
interface RowBand {
  top: number;
  height: number;
  task: Readonly<Task>;
}

/**
 * The row band containing `contentY`, or `undefined` when the point is above the content, past
 * its end, or on a row with no resolvable task. `rowAtY` clamps to the last row, so a point past
 * the end of the content would otherwise be attributed to it.
 */
function rowBandAt(deps: HitTestDeps, contentY: number): RowBand | undefined {
  const { rows, data } = deps;
  if (!(contentY >= 0)) return undefined; // also catches NaN
  if (rows.rowCount() === 0) return undefined;
  const row = rows.rowAtY(contentY);
  const top = rows.yOf(row);
  const height = rows.rowHeight(row);
  if (contentY < top || contentY >= top + height) return undefined;
  const id = rows.taskIdAt(row);
  if (id === undefined) return undefined;
  const task = data.getTask(id);
  return task === undefined ? undefined : { top, height, task };
}

/** Classifies the point against one bar's rectangle, honouring the display options. */
function resolveKind(
  deps: HitTestDeps,
  options: HitTestOptions,
  task: Readonly<Task>,
  box: ReturnType<typeof barRect>,
  contentX: number,
  contentY: number,
): ReturnType<typeof hitKind> {
  // The resolved marker shape decides the milestone hit shape, so the whole painted glyph is
  // clickable.
  const shape = deps.shapeOf !== undefined && isMilestone(task) ? deps.shapeOf(task) : undefined;
  const kind = hitKind(task, box, contentX, contentY, shape);
  // The expanded zone answers only for the bar body: handles and the progress strip keep their exact
  // geometry, so widening the target never steals their affordances.
  if (kind === undefined) {
    return options.expandedHitArea === true && withinExpanded(box, contentX, contentY) ? "bar" : undefined;
  }
  return kind;
}

// The progress strip is a hit zone only; the cursor is the sole thing that changes over it, and
// nothing new is painted anywhere.
function cursorFor(kind: NonNullable<ReturnType<typeof hitKind>>): string {
  if (kind === "handle") return HANDLE_CURSOR;
  return kind === "progress" ? PROGRESS_CURSOR : BAR_CURSOR;
}

// An in-row child is an ordinary editing surface, so the same handle/progress/bar zones apply to it.
// Children are painted in store order, later on top, so the walk runs backwards: the bar the user
// can see is the one they grab. And only the painted children answer: the child list is the same
// filtered one the paint pass draws, so a child whose own row is hidden cannot be grabbed through
// the split row either.
/** A split row answers for whichever child bar the point lands on, with that child's own zones. */
function hitChildBar(
  deps: HitTestDeps,
  options: HitTestOptions,
  band: RowBand,
  contentX: number,
  contentY: number,
  tToX: (t: number) => number,
): Hit {
  const childIds = visibleChildIdsOf(deps.tree!, deps.rows, band.task.id);
  for (let i = childIds.length - 1; i >= 0; i -= 1) {
    const childId = childIds[i];
    if (childId === undefined) continue;
    const child = deps.data.getTask(childId);
    if (child === undefined) continue;
    const box = barRect(child, band.top, band.height, tToX);
    const kind = resolveKind(deps, options, child, box, contentX, contentY);
    if (kind !== undefined) return { kind, id: child.id, cursor: cursorFor(kind) };
  }
  return undefined;
}

// Only this plugin knows the bar and handle rectangles, so only it can answer with those kinds.
/**
 * Builds the hit tester: it converts the viewport point to content coordinates, finds the row the
 * point is inside (rejecting a point past the end of the content, which `rowAtY` would otherwise
 * clamp onto the last row), and classifies the point against that row's bar.
 */
export function createHitTester(deps: HitTestDeps): HitTester {
  const { scale } = deps;
  const options = deps.options ?? {};
  const tToX = (t: number): number => scale.tToX(t);
  return (x, y) => {
    const vp = deps.viewport();
    const contentX = x + vp.scrollLeft;
    const contentY = y + vp.scrollTop;
    const band = rowBandAt(deps, contentY);
    if (band === undefined) return undefined;
    const { task } = band;
    // The same shared predicates the paint pass uses (split.ts), so a row hit-tests exactly as it
    // paints.
    if (isSplitParentRow(options.collapsedSummary, deps.expand, deps.tree, task)) {
      return hitChildBar(deps, options, band, contentX, contentY, tToX);
    }
    if (isHiddenSummaryRow(options.collapsedSummary, deps.expand, task)) return undefined;
    const box = barRect(task, band.top, band.height, tToX);
    const kind = resolveKind(deps, options, task, box, contentX, contentY);
    if (kind === undefined) return undefined;
    return { kind, id: task.id, cursor: cursorFor(kind) };
  };
}
