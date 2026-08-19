// docs/specs/plugins/interaction.md §1.3 (`dragging-row`) / §6.2 "rowDrag" — dragging a bar or a
// grid row vertically reorders the task among its siblings, and a drop beside rows of another
// parent re-parents it there.
/**
 * The vertical row drag: which gap between rows a pointer position names, and what dropping the
 * dragged task into that gap writes to the store.
 *
 * Everything here is arithmetic over plain values — the controller passes in the visible rows and
 * two store lookups, and acts on the plan that comes back — so all of it can be exercised without
 * booting a host.
 */
import { midKey } from "@stargantt/plugin-data-store";
import type { TaskId } from "@stargantt/plugin-data-store";
import type { GestureBase } from "./pointer-gesture";

/** What a row-drop plan needs to know about one task. */
export interface RowTask {
  parentId: TaskId | null;
  orderKey?: string;
}

/** The store lookups a drop plan reads. Both are the data service's own answers, unadapted. */
export interface RowLookup {
  getTask(id: TaskId): RowTask | undefined;
  /** The ids of `parent`'s children (or the roots for `null`), in sibling order. */
  childrenOf(parent: TaskId | null): readonly TaskId[];
}

/**
 * One visible row, as the drop arithmetic needs it: identity (where there is one) and extent.
 *
 * A row that carries no draggable task of its own still occupies space, so it still counts when the
 * gaps are measured; a drop beside it simply finds no anchor to file against.
 */
export interface RowBox {
  id: TaskId | undefined;
  y: number;
  height: number;
}

/**
 * A vertical drag of a whole row: same press bookkeeping, but the proposal is a drop gap.
 *
 * A row drag starts from a bar (inheriting an established date gesture's press bookkeeping) and
 * from a grid row (where there is no bar at all), so it carries the press fields itself rather than
 * extending `GestureBase`.
 */
export interface RowGesture {
  readonly kind: "row";
  readonly id: TaskId;
  readonly pointerId: number;
  readonly coalesceKey: string;
  clientX: number;
  readonly clientY: number;
  dragging: boolean;
  /** Which surface started the drag — the chart's bar, or the grid pane's row. */
  readonly surface: "bar" | "grid";
  /** The gap the pointer names right now, or `undefined` while it names none. */
  drop: RowDrop | undefined;
  /** The dragged task's outline depth when the press began. */
  readonly originDepth: number;
  /** The outline depth the pointer proposes right now. */
  depth: number;
}

/** What a row drag needs to know about its press, whatever surface started it. */
export interface RowPress {
  id: TaskId;
  pointerId: number;
  coalesceKey: string;
  clientX: number;
  clientY: number;
  surface: "bar" | "grid";
  /** The dragged task's current outline depth — the zero point of the horizontal travel. */
  originDepth: number;
}

/** The gap between two visible rows a drop would land in. */
export interface RowDrop {
  /** Insertion index among the visible rows with the dragged row removed. */
  index: number;
  /** The y of the insertion line, viewport-local — the middle of the gap the drop names. */
  lineY: number;
  /** The nearest id-carrying visible row above the gap, or `undefined` when none exists. */
  beforeId: TaskId | undefined;
  /** The nearest id-carrying visible row below the gap, or `undefined` when none exists. */
  afterId: TaskId | undefined;
}

/** Starts a row drag from a press that has already passed the drag threshold. */
export function startRowDrag(press: Readonly<RowPress>): RowGesture {
  return {
    kind: "row",
    id: press.id,
    pointerId: press.pointerId,
    coalesceKey: press.coalesceKey,
    clientX: press.clientX,
    clientY: press.clientY,
    dragging: true,
    surface: press.surface,
    drop: undefined,
    originDepth: press.originDepth,
    depth: press.originDepth,
  };
}

/** Turns an established move drag into a row drag, keeping the press bookkeeping. */
export function startRowGesture(from: GestureBase, originDepth: number): RowGesture {
  return startRowDrag({
    id: from.id,
    pointerId: from.pointerId,
    coalesceKey: from.coalesceKey,
    clientX: from.clientX,
    clientY: from.clientY,
    surface: "bar",
    originDepth,
  });
}

// Reused across calls: a row drag re-derives the drop on every pointer move, and this module's
// arithmetic must not allocate per move. The returned `RowDrop` never holds a reference to it.
const dropRows: RowBox[] = [];

/**
 * The gap a pointer at `y` (viewport-local) names among the visible rows, with the dragged row
 * itself removed — dragging a row over its own place is not a move. `undefined` when there are no
 * other rows at all.
 */
export function rowDropAt(
  y: number,
  boxes: readonly RowBox[],
  draggedId: TaskId,
): RowDrop | undefined {
  const rows = dropRows;
  rows.length = 0;
  for (const b of boxes) if (b.id !== draggedId) rows.push(b);
  if (rows.length === 0) return undefined;
  let index = 0;
  while (index < rows.length) {
    const row = rows[index] as RowBox;
    if (y < row.y + row.height / 2) break;
    index += 1;
  }
  const above = rows[index - 1];
  const below = rows[index];
  const lineY =
    above === undefined
      ? (below as RowBox).y
      : below === undefined
        ? above.y + above.height
        : (above.y + above.height + below.y) / 2;
  // A row carrying no task of its own (a hidden-summary or filler row) still bounds the gap
  // geometrically, but it cannot anchor a drop: its `id: undefined` must not read as "no row at
  // all", which would misfile the drop as a first root sibling. Each anchor is therefore the
  // *nearest id-carrying* row on its side of the gap, however many taskless rows sit between.
  let beforeId: TaskId | undefined;
  for (let i = index - 1; i >= 0 && beforeId === undefined; i -= 1) beforeId = (rows[i] as RowBox).id;
  let afterId: TaskId | undefined;
  for (let i = index; i < rows.length && afterId === undefined; i += 1) afterId = (rows[i] as RowBox).id;
  return { index, lineY, beforeId, afterId };
}

/* --- fractional order keys -------------------------------------------- */
// Sibling order is a lexicographic sort over base-62 `orderKey` strings, read as fractions
// `0.<digits>`. The arithmetic is the store's own: `midKey` is imported rather than re-derived, so
// a dropped row's key is value-compatible with the store's reading by construction.

/**
 * A key strictly between `prev` and `next` in lexicographic (= numeric) order. `prev` is `""` for
 * "no lower neighbour"; `next` is `undefined` for "no upper neighbour" (upper bound 1.0).
 * `undefined` when the two do not actually bracket a gap.
 *
 * The store's `midKey` always returns a key, minting one just above `prev` when its neighbours
 * leave no room; a row drop wants the opposite answer there — a key that does not sort before
 * `next` would put the dragged row on the wrong side of it — so such a key is rejected here.
 */
export function keyBetween(prev: string, next: string | undefined): string | undefined {
  const key = midKey(prev, next);
  if (next !== undefined && key >= next) return undefined;
  return key;
}

/** What dropping the dragged task into a gap writes: its new parent and its new sibling key. */
export interface RowPlan {
  parentId: TaskId | null;
  orderKey: string;
}

/* --- outline depth ----------------------------------------------------- */
// The gap says *where between rows*, the pointer's horizontal travel says *how deep*. Deriving the
// parent from the row below the gap alone made the outline a one-way street: a task dropped one
// level in could never be dropped back out at the same gap.

/** How many CSS px of horizontal travel step the drop one outline level. Matches the grid's indent. */
export const DEPTH_STEP_PX = 16;

/** Guard on the ancestor walks: no real outline is this deep, and a cycle must not hang a drag. */
const MAX_DEPTH = 1024;

/** The outline depth of a task: 0 for a root, one more per ancestor. */
export function depthOf(id: TaskId, lookup: RowLookup): number {
  let depth = 0;
  let parent = lookup.getTask(id)?.parentId ?? null;
  // The walk is bounded by the ancestor chain; a store holding a cycle would otherwise spin here,
  // and a drag is not the place to discover that.
  while (parent !== null && depth < MAX_DEPTH) {
    depth += 1;
    const up = lookup.getTask(parent);
    if (up === undefined) break;
    parent = up.parentId;
  }
  return depth;
}

/**
 * The ancestor of `id` sitting at outline depth `depth` — `id` itself when that is its own depth —
 * or `undefined` when the chain holds no such node.
 */
export function ancestorAtDepth(id: TaskId, depth: number, lookup: RowLookup): TaskId | undefined {
  let current: TaskId | undefined = id;
  let level = depthOf(id, lookup);
  while (current !== undefined && level > depth) {
    current = lookup.getTask(current)?.parentId ?? undefined;
    level -= 1;
  }
  return level === depth ? current : undefined;
}

/**
 * The depths a drop into this gap may commit: from the depth of the row below it (any shallower one
 * would open a hole between that row and its parent) up to one level under the row above it
 * (becoming its first child). Both ends are 0 where the neighbouring row is absent, which is what
 * makes the root level reachable at the very top and the very bottom of the chart.
 */
export function depthRangeAt(
  drop: Readonly<RowDrop>,
  lookup: RowLookup,
): { min: number; max: number } {
  const max = drop.beforeId === undefined ? 0 : depthOf(drop.beforeId, lookup) + 1;
  const min = drop.afterId === undefined ? 0 : Math.min(depthOf(drop.afterId, lookup), max);
  return { min, max };
}

/**
 * The depth this drop proposes: the dragged task's own depth, stepped by the pointer's horizontal
 * travel (`dx`, CSS px, signed) one level per `DEPTH_STEP_PX`, clamped into the gap's range.
 */
export function depthFor(
  drop: Readonly<RowDrop>,
  originDepth: number,
  dx: number,
  lookup: RowLookup,
): number {
  const { min, max } = depthRangeAt(drop, lookup);
  const wanted = originDepth + Math.round(dx / DEPTH_STEP_PX);
  return Math.max(min, Math.min(max, wanted));
}

/** Whether filing the dragged task under `parentId` would nest a branch inside itself. */
function nestsInItself(parentId: TaskId | null, draggedId: TaskId, lookup: RowLookup): boolean {
  for (let p: TaskId | null = parentId; p !== null; ) {
    if (p === draggedId) return true;
    const up = lookup.getTask(p);
    if (up === undefined) break;
    p = up.parentId;
  }
  return false;
}

/**
 * Insertion position among the new siblings: just after the row above the gap, taken at the drop's
 * own depth (that row itself when it sits at that depth, otherwise the ancestor of it that does).
 * With no row above — the gap at the very top — or with the gap naming the first child of the row
 * above, the position is the head of the sibling list.
 */
function insertPos(
  drop: Readonly<RowDrop>,
  depth: number,
  siblings: readonly TaskId[],
  lookup: RowLookup,
): number {
  if (drop.beforeId === undefined) return 0;
  const anchor = ancestorAtDepth(drop.beforeId, depth, lookup);
  if (anchor === undefined) return 0;
  const pos = siblings.indexOf(anchor);
  return pos >= 0 ? pos + 1 : siblings.length;
}

/** Whether the drop puts the task back into its own current gap: same parent, same neighbours. */
function isSameGap(
  draggedId: TaskId,
  parentId: TaskId | null,
  siblings: readonly TaskId[],
  pos: number,
  lookup: RowLookup,
): boolean {
  const current = lookup.childrenOf(parentId);
  const own = current.indexOf(draggedId);
  return own >= 0 && siblings[pos - 1] === current[own - 1] && siblings[pos] === current[own + 1];
}

/**
 * The midpoint key between the siblings bracketing `pos`. A bracketing sibling without a key gives
 * the midpoint nothing to bracket against, so the drop is refused rather than writing a key that
 * could sort anywhere among the keyless.
 */
function orderKeyAt(
  siblings: readonly TaskId[],
  pos: number,
  lookup: RowLookup,
): string | undefined {
  const prevId = siblings[pos - 1];
  const nextId = pos < siblings.length ? siblings[pos] : undefined;
  const prevKey = prevId === undefined ? "" : lookup.getTask(prevId)?.orderKey;
  const nextKey = nextId === undefined ? undefined : lookup.getTask(nextId)?.orderKey;
  if (prevKey === undefined) return undefined;
  if (nextId !== undefined && nextKey === undefined) return undefined;
  return keyBetween(prevKey, nextKey);
}

/**
 * The store write a drop implies, or `undefined` when the drop changes nothing or is not allowed.
 *
 * The new parent follows the drop's depth: 0 files the task at the root, and a deeper drop files it
 * under the ancestor of the row above the gap that sits one level higher. A drop whose new parent
 * is the dragged task itself or one of its descendants is refused — a branch cannot be filed inside
 * itself. The new `orderKey` is the midpoint between the bracketing siblings' keys; a neighbouring
 * sibling without a usable key refuses the drop rather than guessing.
 */
export function rowPlanFor(
  drop: Readonly<RowDrop>,
  depth: number,
  draggedId: TaskId,
  lookup: RowLookup,
): RowPlan | undefined {
  const dragged = lookup.getTask(draggedId);
  if (dragged === undefined) return undefined;
  // Depth 0 is the root level, which needs no anchor at all — that is what makes a drop below the
  // last row of a branch able to leave the branch. Any deeper drop is filed under an ancestor of
  // the row above the gap, so without such a row there is nothing to file under.
  let parentId: TaskId | null = null;
  if (depth > 0) {
    if (drop.beforeId === undefined) return undefined;
    parentId = ancestorAtDepth(drop.beforeId, depth - 1, lookup) ?? null;
    if (parentId === null) return undefined;
    if (lookup.getTask(parentId) === undefined) return undefined;
  }
  if (nestsInItself(parentId, draggedId, lookup)) return undefined;

  const siblings = lookup.childrenOf(parentId).filter((id) => id !== draggedId);
  const pos = insertPos(drop, depth, siblings, lookup);
  if (dragged.parentId === parentId && isSameGap(draggedId, parentId, siblings, pos, lookup)) {
    return undefined;
  }
  const orderKey = orderKeyAt(siblings, pos, lookup);
  return orderKey === undefined ? undefined : { parentId, orderKey };
}
