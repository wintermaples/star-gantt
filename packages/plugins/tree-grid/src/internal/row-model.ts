/**
 * The row model behind `stargantt.rows`.
 *
 * Owns `visibleRows` — the flat array reflecting collapse state — plus the row-index⇔TaskId
 * cross-lookup and row height geometry. Pure logic: no DOM, no core imports.
 */
import type { DataService, ReadonlyDataView, Task, TaskId } from "@stargantt/plugin-data-store";
import type { ResolvedRowHeight, RowsSnapshot } from "../types";
import { Fenwick } from "./fenwick";

// docs/specs/plugins/tree-grid.md § Config
/**
 * The row height used wherever no contribution overrides it, in CSS pixels.
 *
 * It is the default of `TreeGridConfig.rowHeight` and is deliberately not re-exported from the
 * package entry.
 */
export const DEFAULT_ROW_HEIGHT = 28;

// docs/specs/plugins/tree-grid.md § Extension points
/**
 * The seed of the `rows/height` reduction — it returns the incoming default unchanged, so the
 * resolved height is the default until some contribution overrides it.
 *
 * Identity comparison against this exact function is what lets the model detect "no contributions
 * at all" and take the zero-cost fixed-height path, in which no Fenwick tree is built.
 */
export const defaultRowHeightResolver: ResolvedRowHeight = (_task, defaultHeight) => defaultHeight;

export class RowModel {
  /** The visible rows — flat, in tree order, collapsed subtrees omitted. */
  private ids: TaskId[] = [];
  private index = new Map<TaskId, number>();
  private depths: number[] = [];
  private branch: boolean[] = [];
  /** Per-row heights; empty while `uniform` (never materialized for fixed-height grids). */
  private heights: number[] = [];
  private fenwick: Fenwick | null = null;
  private uniform = true;
  private total = 0;
  private collapsed = new Set<TaskId>();
  private stale = true;
  // Display order only; `null` means "store order" (the `orderKey` order `view.children` carries).
  private sortCompare: ((a: Readonly<Task>, b: Readonly<Task>) => number) | null = null;

  constructor(
    private readonly data: DataService,
    /** Reads the current `rows/height` reduction; called once per rebuild. */
    private readonly resolver: () => ResolvedRowHeight,
    // docs/specs/plugins/tree-grid.md § Config — `TreeGridConfig.rowHeight`, already validated by
    // the caller. It is the `defaultHeight` handed to `rows/height` contributions and the height of
    // every row none of them overrides.
    /** Height in CSS px of a row no `rows/height` contribution overrides. */
    private readonly defaultHeight: number = DEFAULT_ROW_HEIGHT,
  ) {}

  /** Marks the flattening stale; the rebuild itself is deferred to the next query. */
  invalidate(): void {
    this.stale = true;
  }

  /**
   * Expands or collapses a row. With `expanded` omitted the current state is toggled.
   * Returns whether the state actually changed.
   */
  setExpanded(id: TaskId, expanded?: boolean): boolean {
    const current = !this.collapsed.has(id);
    const next = expanded === undefined ? !current : expanded;
    if (next === current) return false;
    if (next) this.collapsed.delete(id);
    else this.collapsed.add(id);
    this.stale = true;
    return true;
  }

  isExpanded(id: TaskId): boolean {
    return !this.collapsed.has(id);
  }

  /**
   * Sets (or clears, with `null`) the sibling-scoped sort comparator. Each sibling group — the
   * roots, and each parent's children — is ordered independently by the same comparator; the tree
   * structure itself is untouched. `null` restores the store's own `orderKey` order. Marks the
   * flattening stale; the re-sort itself is deferred to the next query.
   */
  setSortComparator(compare: ((a: Readonly<Task>, b: Readonly<Task>) => number) | null): void {
    this.sortCompare = compare;
    this.stale = true;
  }

  rowCount(): number {
    this.ensure();
    return this.ids.length;
  }

  taskIdAt(row: number): TaskId | undefined {
    this.ensure();
    return this.ids[row];
  }

  rowOf(id: TaskId): number | undefined {
    this.ensure();
    return this.index.get(id);
  }

  rowHeight(row: number): number {
    this.ensure();
    if (row < 0 || row >= this.ids.length) return 0;
    return this.uniform ? this.defaultHeight : (this.heights[row] ?? this.defaultHeight);
  }

  // docs/specs/plugins/tree-grid.md § Services — the same reduction `measure()` runs, but keyed by
  // task instead of by row, so a task with no visible row (a collapsed summary's child, which is
  // exactly what a split row draws) still gets an answer. No flattening is needed, so `ensure()` is
  // deliberately not called: this is one store read plus one reduction call.
  /** The `rows/height` result for a task, whatever its row visibility. */
  resolvedHeightOf(id: TaskId): number | undefined {
    const task = this.data.getTask(id);
    if (task === undefined) return undefined;
    const resolve = this.resolver();
    if (resolve === defaultRowHeightResolver) return this.defaultHeight;
    return this.heightFor(task, resolve);
  }

  /** Row index → y. O(1) while fixed-height, O(log n) once the Fenwick tree exists. */
  yOf(row: number): number {
    this.ensure();
    const n = this.ids.length;
    const r = row < 0 ? 0 : row > n ? n : Math.floor(row);
    if (this.uniform) return r * this.defaultHeight;
    return this.fenwick === null ? 0 : this.fenwick.prefix(r);
  }

  /** scrollTop → row index. O(1) while fixed-height, O(log n) once the Fenwick tree exists. */
  rowAtY(y: number): number {
    this.ensure();
    const n = this.ids.length;
    if (n === 0) return 0;
    if (!(y > 0)) return 0; // also catches NaN
    if (this.uniform) {
      const row = Math.floor(y / this.defaultHeight);
      return row >= n ? n - 1 : row;
    }
    const row = this.fenwick === null ? 0 : this.fenwick.findIndex(y);
    return row >= n ? n - 1 : row;
  }

  totalHeight(): number {
    this.ensure();
    return this.total;
  }

  // docs/specs/plugins/tree-grid.md § Services — the value the `rows` store carries. `ids` is
  // replaced wholesale by every flattening, never mutated in place, so the array handed out here
  // stays a valid snapshot of the moment it was taken.
  /** The current visible row set as the immutable snapshot the `rows` store publishes. */
  snapshot(): RowsSnapshot {
    this.ensure();
    return { taskIds: this.ids, totalHeight: this.total };
  }

  /* --- internals used by the grid pane, not part of `RowsService` --- */

  task(id: TaskId): Readonly<Task> | undefined {
    return this.data.getTask(id);
  }

  /** Tree depth of a visible row (0 = root); drives the grid pane's indentation. */
  depthAt(row: number): number {
    this.ensure();
    return this.depths[row] ?? 0;
  }

  /** Whether the visible row has children — i.e. whether it gets an expand/collapse toggle. */
  hasChildrenAt(row: number): boolean {
    this.ensure();
    return this.branch[row] ?? false;
  }

  /** True while the fixed-height fast path is in effect (no Fenwick tree built). */
  isUniform(): boolean {
    this.ensure();
    return this.uniform;
  }

  private ensure(): void {
    if (!this.stale) return;
    this.stale = false;
    this.flatten();
    this.measure();
  }

  /**
   * The children of one parent (or the roots, for `key === null`), in the order the flattening
   * should visit them: the store's own `orderKey` order while `sortCompare` is `null`, otherwise
   * sorted by it. Sorting is sibling-scoped — this is called once per sibling group — and does not
   * touch `view.children` itself, so the store's order survives underneath it.
   */
  private orderedChildren(view: ReadonlyDataView, key: TaskId | null): readonly TaskId[] {
    const list = view.children.get(key) ?? [];
    const compare = this.sortCompare;
    if (compare === null || list.length < 2) return list;
    // A dangling id (no `byId` entry) sorts as if equal to everything; `flatten`'s own
    // `byId.has` guard drops it from the output regardless, so its position here is moot.
    return [...list].sort((a, b) => {
      const ta = view.byId.get(a);
      const tb = view.byId.get(b);
      if (ta === undefined || tb === undefined) return 0;
      return compare(ta, tb);
    });
  }

  /** DFS over `children` (orderKey or sorted order), skipping collapsed subtrees. Iterative: 100k deep is legal. */
  private flatten(): void {
    const view = this.data.query();
    const ids: TaskId[] = [];
    const depths: number[] = [];
    const branch: boolean[] = [];
    const index = new Map<TaskId, number>();

    const roots = this.orderedChildren(view, null);
    // Explicit stack, deepest-last, so children pop in the order `orderedChildren` returns them.
    const stack: { id: TaskId; depth: number }[] = [];
    for (let i = roots.length - 1; i >= 0; i -= 1) {
      const id = roots[i];
      if (id !== undefined) stack.push({ id, depth: 0 });
    }

    while (stack.length > 0) {
      const node = stack.pop();
      if (node === undefined) break;
      // A parentId cycle in malformed data would otherwise loop forever; `index` already answers
      // "seen before", so the guard is free.
      if (index.has(node.id)) continue;
      if (!view.byId.has(node.id)) continue;

      const row = ids.length;
      ids.push(node.id);
      depths.push(node.depth);
      index.set(node.id, row);

      const children = this.orderedChildren(view, node.id);
      branch.push(children.length > 0);
      if (children.length === 0 || this.collapsed.has(node.id)) continue;
      for (let i = children.length - 1; i >= 0; i -= 1) {
        const child = children[i];
        if (child !== undefined) stack.push({ id: child, depth: node.depth + 1 });
      }
    }

    this.ids = ids;
    this.depths = depths;
    this.branch = branch;
    this.index = index;
  }

  /**
   * One task's height under an already-read reduction. A non-finite or negative result would
   * corrupt every prefix sum irrecoverably, so it is treated as "no override" rather than
   * propagated.
   */
  private heightFor(task: Readonly<Task>, resolve: ResolvedRowHeight): number {
    const h = resolve(task, this.defaultHeight);
    return typeof h === "number" && Number.isFinite(h) && h >= 0 ? h : this.defaultHeight;
  }

  /**
   * Recomputes row heights, and with them the vertical geometry.
   *
   * When every row uses the default height no Fenwick tree is built and offsets fall back to plain
   * division arithmetic. Two escapes lead there: with **no** `rows/height` contribution at all the
   * per-row heights are never even computed (the reduction's seed is identity, so every row is
   * provably the default), and with contributions that all return the default the heights array is
   * discarded again.
   */
  private measure(): void {
    const n = this.ids.length;
    const resolve = this.resolver();

    if (resolve === defaultRowHeightResolver) {
      this.heights = [];
      this.fenwick = null;
      this.uniform = true;
      this.total = n * this.defaultHeight;
      return;
    }

    const heights = new Array<number>(n);
    let uniform = true;
    for (let row = 0; row < n; row += 1) {
      const id = this.ids[row];
      const task = id === undefined ? undefined : this.data.getTask(id);
      const h = task === undefined ? this.defaultHeight : this.heightFor(task, resolve);
      heights[row] = h;
      if (h !== this.defaultHeight) uniform = false;
    }

    if (uniform) {
      this.heights = [];
      this.fenwick = null;
      this.uniform = true;
      this.total = n * this.defaultHeight;
      return;
    }

    this.heights = heights;
    this.fenwick = new Fenwick(heights);
    this.uniform = false;
    this.total = this.fenwick.total();
  }
}
