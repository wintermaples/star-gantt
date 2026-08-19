/**
 * Event-target resolution: walking a pointer or keyboard event's target up to the grid structure it
 * landed in — a body row, a body cell, a header cell, or a header resize handle.
 *
 * Pure DOM reading, no state: every function takes the raw `EventTarget` (typed `unknown`, since an
 * event target need not be an element at all) and answers one question about it.
 */
// docs/specs/plugins/tree-grid.md § Events — the row/toggle distinction, the header cell's
// `data-column-id`, and the resize handle's hit box.

/** Minimal structural view of a DOM node, enough to walk an event target up to its row/column/handle. */
export interface WalkNode {
  className?: unknown;
  parentNode?: WalkNode | null;
  getAttribute?(name: string): string | null;
}

/** Depth cap on every upward walk: malformed or cyclic parent chains must not hang a handler. */
const WALK_GUARD = 32;

/**
 * Views an event target as a walkable node, or `null` when it is not an object at all (`window`,
 * a detached value, `undefined`). Non-elements simply answer "no" to every question below.
 */
function asWalkNode(value: unknown): WalkNode | null {
  return typeof value === "object" && value !== null ? (value as WalkNode) : null;
}

/**
 * The body row an event landed in: its `data-row-index`, plus whether the walk passed through the
 * row's expand toggle (the one part of a row that toggles instead of selecting).
 */
export function locateRow(target: unknown): { row: number; toggle: boolean } | undefined {
  let node = asWalkNode(target);
  let toggle = false;
  for (let guard = 0; node !== null && guard < WALK_GUARD; guard += 1) {
    if (typeof node.className === "string" && node.className.indexOf("sg-grid-toggle") >= 0) {
      toggle = true;
    }
    const attr = node.getAttribute?.("data-row-index");
    if (attr !== undefined && attr !== null && attr !== "") {
      const row = Number.parseInt(attr, 10);
      return Number.isFinite(row) ? { row, toggle } : undefined;
    }
    node = asWalkNode(node.parentNode);
  }
  return undefined;
}

/** Which of a materialized row's `cells` an event target landed in, by index, if any. */
export function locateCellIndex(target: unknown, cells: readonly HTMLElement[]): number | undefined {
  // Widened to `unknown[]` rather than asserting the walked node into an `HTMLElement`: the
  // comparison this needs is identity, which does not care about either side's type.
  const haystack: readonly unknown[] = cells;
  let node = asWalkNode(target);
  for (let guard = 0; node !== null && guard < WALK_GUARD; guard += 1) {
    const idx = haystack.indexOf(node);
    if (idx >= 0) return idx;
    node = asWalkNode(node.parentNode);
  }
  return undefined;
}

/**
 * The `data-column-id` of the closest ancestor **header** cell, walking up from `target`.
 *
 * A body cell carries the same attribute too (for host tests that address a column by id) but is
 * never a header cell, so a node is only accepted here when it also carries the
 * `sg-grid-header-cell` class — the same structural check `isResizeHandle` below uses — rather than
 * on `data-column-id` alone. Without that guard a walk starting inside a body cell would resolve to
 * that cell's column and be mistaken for a header target.
 */
export function locateHeaderColumn(target: unknown): string | undefined {
  let node = asWalkNode(target);
  for (let guard = 0; node !== null && guard < WALK_GUARD; guard += 1) {
    const attr = node.getAttribute?.("data-column-id");
    const isHeaderCell =
      typeof node.className === "string" && node.className.indexOf("sg-grid-header-cell") >= 0;
    if (attr !== undefined && attr !== null && attr !== "" && isHeaderCell) return attr;
    node = asWalkNode(node.parentNode);
  }
  return undefined;
}

/** Whether the event target is (or is inside) a header resize handle. */
export function isResizeHandle(target: unknown): boolean {
  const node = asWalkNode(target);
  return (
    node !== null &&
    typeof node.className === "string" &&
    node.className.indexOf("sg-grid-header-resize-handle") >= 0
  );
}
