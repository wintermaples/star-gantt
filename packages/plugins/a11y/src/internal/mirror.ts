// docs/specs/plugins/a11y.md § Mirror generation rules.
/**
 * The parallel ARIA DOM: a `role="treegrid"` mirror of the chart, built for the current row window
 * only, plus the polite live region used for announcements.
 *
 * Every element, listener and frame callback is handed to `ctx.own()`, so the core owns disposal.
 * The mirror never reads a selection service itself — `setSelected` is how a caller reports the
 * current selection, which keeps that channel optional at this layer.
 */
import type { PluginContext } from "@stargantt/core";
import type { DataService, ReadonlyDataView, TaskId } from "@stargantt/plugin-data-store";
import type { RowsService } from "@stargantt/plugin-tree-grid";
import type { RowTextParts } from "../types";

// `.sg-a11y` holds the parallel ARIA grid.
const CONTAINER_CLASS = "sg-a11y";
const ROW_CLASS = "sg-a11y-row";
const CELL_CLASS = "sg-a11y-cell";
const LIVE_CLASS = "sg-a11y-live";
// The dependency descriptions live in their own hidden container, one node per materialized row,
// referenced by `aria-describedby`; a treegrid row's children stay gridcells only.
const DESC_CONTAINER_CLASS = "sg-a11y-desc";
const DESC_CLASS = "sg-a11y-desc-item";

// `aria-describedby` ids must be unique per document even with several chart instances on one page,
// so every mirror numbers itself from this module-level counter.
let mirrorInstances = 0;

// Released row elements are parked (detached) for reuse instead of being discarded, bounding GC and
// layout cost while the window resizes; the pool is capped so a one-off giant window cannot pin
// memory forever.
const SLOT_POOL_CAP = 32;

/** Accessible name of the mirrored grid, so it is distinguishable from other widgets on the page. */
const GRID_LABEL = "Gantt chart";

// "visible range + buffer" rows only; the buffer size itself is not mandated.
const BUFFER_ROWS = 5;
/** Used when the root element reports no height (detached container, no layout). */
const DEFAULT_VISIBLE_ROWS = 20;
/** Used when the row model has no row to measure. */
const FALLBACK_ROW_HEIGHT = 28;

interface Slot {
  row: HTMLElement;
  cell: HTMLElement;
  /** The row's `aria-describedby` target, created lazily and only while descriptions are on. */
  desc: HTMLElement | null;
}

// What moved the roving focus, carried alongside the placement itself.
//
// The owner needs this to decide whether the placement also resets the range-selection anchor and
// whether it replaces the selection (`syncSelection`): a `Shift`+arrow move does neither (the chord
// drives the selection over a row range itself), a pointer press resets the anchor but leaves the
// selection to `stargantt.selection`, and a keyboard move or a `FocusService.focus` call does both.
// Passing the cause down with the call is what keeps those decisions out of re-entrancy flags set
// around it (`references/code-quality.md` §4).
/** What caused a focus placement: an arrow-key move, a pointer press, a `Shift` chord, or the service. */
export type FocusCause = "keyboard" | "pointer" | "shift" | "api";

export interface MirrorDeps {
  rows: RowsService;
  data: DataService;
  /** Called when the roving focus lands on a task, with that task's id and what moved it there. */
  onFocus(id: TaskId, cause: FocusCause): void;
  /**
   * Called with the newly focused task — or `undefined` when no row holds the focus any more —
   * every time the effective focus changes, by any cause: an explicit `focusTask` (a keyboard move,
   * a pointer follow, `FocusService.focus`) or this module relocating or clearing an
   * already-placed focus on its own (the focused row's ancestor collapsing, the focused task
   * disappearing from the store). Never called for the internal row-0 fallback before any real
   * placement, and never called when the value does not actually change.
   */
  onFocusChanged(id: TaskId | undefined): void;
  /** Called when DOM focus enters (`true`) or fully leaves (`false`) the mirror's rows. */
  onFocusVisibility(visible: boolean): void;
  /** Accessible name of the grid container. Blank or absent uses the built-in default. */
  label?: string | undefined;
  /** Builds one row's accessible text from the task's fields. */
  rowText(parts: RowTextParts): string;
  /**
   * Builds one row's supplementary description (dependencies), or `""` for none. Absent (the
   * default), no description nodes exist at all and the DOM is byte-identical to the pre-feature
   * mirror.
   */
  rowDescription?: ((id: TaskId) => string) | undefined;
}

export interface Mirror {
  /** The task the roving tabindex currently sits on. */
  focusedId(): TaskId | undefined;
  /**
   * Records the current selection and updates `aria-selected` on every materialized row in place
   * (no rebuild). `undefined` clears the attribute from every row instead of writing `"false"`
   * everywhere — the state of a composition with no selection information to report at all.
   */
  setSelected(ids: ReadonlySet<TaskId> | undefined): void;
  /**
   * Sets or clears `aria-multiselectable` on the treegrid. Called only once a selection service has
   * actually resolved, so a composition without one never carries the attribute.
   */
  setMultiselectable(on: boolean): void;
  /** Whether the roving focus has ever been placed by real interaction, as opposed to the row-0 fallback. */
  focusPlaced(): boolean;
  /** Whether the DOM focus currently sits on one of the mirrored rows. */
  focusVisible(): boolean;
  /** Anchors the mirrored window at the given first-visible row (from `view/scrolled`). */
  setViewportStart(row: number): void;
  /** Moves the roving focus to a task, scrolling the mirrored window to include it, reporting `cause`. */
  focusTask(id: TaskId, cause: FocusCause): void;
  /** Moves the roving focus by `delta` rows, clamped to the ends of the row list, reporting `cause`. */
  moveFocus(delta: number, cause: FocusCause): void;
  /** Replaces the text of the polite live region. */
  announce(message: string): void;
  /** Drops the cached "which rows are navigable" answer; call whenever the row set or data changes. */
  invalidateRows(): void;
  /** Drops the cached root measurement, so the next rebuild measures the container again. */
  remeasure(): void;
  /** Requests a rebuild of the mirrored window on the next frame. */
  schedule(): void;
  /** Rebuilds the mirrored window immediately. */
  render(): void;
  /** The mirror root, for tests and for callers that need to observe the DOM. */
  container: HTMLElement;
}

function el(doc: Document, tag: string, className: string): HTMLElement {
  const node = doc.createElement(tag);
  node.className = className;
  return node;
}

/** Visually hidden, but left in the accessibility tree so screen readers still reach it. */
export function hideVisually(node: HTMLElement): void {
  const style = node.style;
  style.position = "absolute";
  style.width = "1px";
  style.height = "1px";
  style.overflow = "hidden";
  style.whiteSpace = "nowrap";
  style.clipPath = "inset(50%)";
}

export function mountMirror(ctx: PluginContext, deps: MirrorDeps): Mirror {
  const { rows, data } = deps;
  const doc = ctx.root.ownerDocument;

  const container = el(doc, "div", CONTAINER_CLASS);
  container.setAttribute("role", "treegrid");
  // The label is applied once, when the container is created, and not re-read afterwards.
  container.setAttribute("aria-label", deps.label?.trim() || GRID_LABEL);
  hideVisually(container);
  const live = el(doc, "div", LIVE_CLASS);
  live.setAttribute("aria-live", "polite");
  live.setAttribute("aria-atomic", "true");
  hideVisually(live);
  ctx.root.appendChild(container);
  ctx.root.appendChild(live);
  ctx.own({ dispose: () => container.remove() });
  ctx.own({ dispose: () => live.remove() });

  // The description container exists only while the read-out is enabled, so a default configuration
  // adds no DOM at all.
  mirrorInstances += 1;
  const instance = mirrorInstances;
  let descSeq = 0;
  let descContainer: HTMLElement | null = null;
  if (deps.rowDescription !== undefined) {
    descContainer = el(doc, "div", DESC_CONTAINER_CLASS);
    hideVisually(descContainer);
    ctx.root.appendChild(descContainer);
    ctx.own({ dispose: () => descContainer?.remove() });
  }

  const slots: Slot[] = [];
  // Released slots wait here, detached, for the next `newSlot()`.
  const slotPool: Slot[] = [];
  /** First row of the mirrored window, as a position in the navigable sequence. */
  let windowStart = 0;
  // The window's anchor: the first row currently visible in the chart viewport, pushed in from
  // `view/scrolled`. The window follows this, not the focus (the focus is an additional
  // constraint, via the extra slot below).
  let viewportStart = 0;
  // A focused row that has scrolled out of the mirrored window keeps one dedicated slot so the
  // roving tabindex (and with it Tab-reachability) never leaves the DOM. Its `aria-rowindex` states
  // its true position; order in the container is not positional.
  let extraSlot: Slot | null = null;
  /** Whether DOM focus currently sits on a mirror row; drives the visual-only placement. */
  let focusVisible = false;
  let focusedId: TaskId | undefined;
  // Set only by `focusTask` (real keyboard movement, a pointer follow or an explicit
  // `FocusService.focus` call), never by the row-0 fallback below, so callers can tell an
  // actually-placed focus from the internal default.
  let placed = false;
  // `undefined` until `setSelected` is ever called, which is exactly the "no selection information
  // available" state: every row's `aria-selected` stays absent rather than defaulting to `"false"`.
  let selectedIds: ReadonlySet<TaskId> | undefined;

  let frame: number | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;

  // `references/code-quality.md` §8 — one data view per rebuild, shared by every row painted in that
  // pass, instead of a `data.query()` per row per frame. The memoized levels ride along with it: a
  // parent chain walked for one row is reused by its children, so a deep tree costs one walk per
  // branch rather than one per row.
  interface RenderPass {
    view: ReadonlyDataView;
    levels: Map<TaskId, number>;
  }
  let pass: RenderPass | null = null;

  /** The data view for the pass in progress, or a fresh one outside a rebuild. */
  function currentPass(): RenderPass {
    return pass ?? { view: data.query(), levels: new Map() };
  }

  /** Depth of a task in the tree, for `aria-level` (1-based). */
  function levelOf(id: TaskId, active: RenderPass): number {
    const cached = active.levels.get(id);
    if (cached !== undefined) return cached;
    const byId = active.view.byId;
    // The chain is bounded by the tree depth; a corrupt cycle would be a data-store bug, so the
    // walk is additionally capped by the row count.
    const cap = rows.rowCount() + 1;
    const chain: TaskId[] = [id];
    let parent = byId.get(id)?.parentId ?? null;
    let base = 0;
    while (parent !== null && chain.length <= cap) {
      const known = active.levels.get(parent);
      if (known !== undefined) {
        base = known;
        break;
      }
      chain.push(parent);
      parent = byId.get(parent)?.parentId ?? null;
    }
    // Memoize every ancestor visited on the way up, so the walk truly runs once per branch.
    for (let i = chain.length - 1; i >= 0; i -= 1) {
      base += 1;
      active.levels.set(chain[i] as TaskId, base);
    }
    return base;
  }

  function hasChildren(id: TaskId, active: RenderPass): boolean {
    const children = active.view.children.get(id);
    return children !== undefined && children.length > 0;
  }

  /* --- the navigable row sequence ---------------------------------------- */
  // A row whose resolved height is 0 is invisible on screen (that is how the filter hides
  // filtered-out rows), so it is left out of the mirror entirely and skipped by the roving focus: an
  // assistive-technology user must never walk rows nobody can see. The mapping between "position in
  // the navigable sequence" and "row index in the model" is cached, because a full scan is O(rows)
  // and the mirror rebuilds on every scroll frame; `invalidateRows()` drops it whenever the row set
  // changes. `null` means "every row is navigable" — the ordinary case, in which the sequence *is*
  // the row index and no memory is used.
  let navRows: number[] | null = null;
  let navPositions: Map<number, number> | null = null;
  let navStale = true;

  function ensureNav(): void {
    if (!navStale) return;
    navStale = false;
    const count = rows.rowCount();
    let list: number[] | null = null;
    for (let row = 0; row < count; row += 1) {
      if (rows.rowHeight(row) > 0) {
        if (list !== null) list.push(row);
        continue;
      }
      // First hidden row: materialize the list of everything before it, then keep collecting.
      if (list === null) {
        list = [];
        for (let seen = 0; seen < row; seen += 1) list.push(seen);
      }
    }
    navRows = list;
    navPositions = null;
    if (list !== null) {
      const positions = new Map<number, number>();
      for (let i = 0; i < list.length; i += 1) positions.set(list[i] as number, i);
      navPositions = positions;
    }
  }

  /** How many rows a screen reader and the roving focus can reach. */
  function navCount(): number {
    ensureNav();
    return navRows === null ? rows.rowCount() : navRows.length;
  }

  /** The model row index at a position in the navigable sequence. */
  function navRowAt(position: number): number | undefined {
    ensureNav();
    if (navRows === null) {
      return position >= 0 && position < rows.rowCount() ? position : undefined;
    }
    return navRows[position];
  }

  /** The task at a position in the navigable sequence. */
  function navTaskAt(position: number): TaskId | undefined {
    const row = navRowAt(position);
    return row === undefined ? undefined : rows.taskIdAt(row);
  }

  /** The position of a task in the navigable sequence; `undefined` when it has no reachable row. */
  function navPositionOf(id: TaskId | undefined): number | undefined {
    if (id === undefined) return undefined;
    const row = rows.rowOf(id);
    if (row === undefined) return undefined;
    ensureNav();
    if (navRows === null) return row;
    return navPositions?.get(row);
  }

  /** The first navigable position at or after a model row — the window's viewport anchor. */
  function navPositionAtOrAfter(row: number): number {
    ensureNav();
    if (navRows === null) return row;
    // Binary search: the list is ascending by construction.
    let low = 0;
    let high = navRows.length;
    while (low < high) {
      const mid = (low + high) >> 1;
      if ((navRows[mid] as number) < row) low = mid + 1;
      else high = mid;
    }
    return low;
  }

  // `references/code-quality.md` §8 — the root's height is a forced layout read, so it is measured
  // once and kept until something can actually have changed it: the first layout
  // (`lifecycle/ready`) or a resize, both of which call `remeasure()`. Measuring per rebuild would
  // mean a synchronous layout on every scroll frame.
  let rootHeight = 0;
  let measured = false;

  function viewportHeight(): number {
    if (measured) return rootHeight;
    measured = true;
    rootHeight =
      typeof ctx.root.getBoundingClientRect === "function"
        ? ctx.root.getBoundingClientRect().height
        : 0;
    return rootHeight;
  }

  /**
   * How many navigable rows the window holds: the rows the viewport actually covers, plus a buffer
   * at each end.
   *
   * The covered span is read from the row model's cumulative offsets (`yOf` / `rowAtY`), not from
   * one row's height multiplied out, so a chart with variable row heights materializes every row on
   * screen instead of the count a single sample height happens to predict.
   */
  function windowSize(count: number): number {
    if (count === 0) return 0;
    const height = viewportHeight();
    if (height <= 0) return Math.min(count, DEFAULT_VISIBLE_ROWS + BUFFER_ROWS * 2);
    const firstRow = navRowAt(navPositionAtOrAfter(viewportStart)) ?? viewportStart;
    const top = rows.yOf(firstRow);
    // `rowAtY` clamps to the last row, so a viewport taller than the content simply ends there.
    const lastRow = rows.rowAtY(top + Math.max(0, height - 1));
    const first = navPositionAtOrAfter(firstRow);
    const last = navPositionAtOrAfter(lastRow);
    // A viewport shorter than one row still shows that row; a zero-height sample row cannot make
    // the window collapse either, hence the fallback height for the degenerate "no geometry" case.
    const spanned =
      rows.totalHeight() > 0
        ? Math.max(1, last - first + 1)
        : Math.ceil(height / FALLBACK_ROW_HEIGHT);
    return Math.min(count, spanned + BUFFER_ROWS * 2);
  }

  // Documented limitation, not a defect: each row mirrors as exactly **one** `gridcell` carrying
  // the whole `rowText`, not one `gridcell` per composed column. A column-parallel mirror would
  // need the grid's composed columns and a text accessor `ColumnDef` does not expose. Sort state is
  // exposed on the visible `columnheader` cells instead (`aria-sort`), not through this mirror.
  function newSlot(): Slot {
    // Reuse a pooled slot when one is parked: `paintSlot` rewrites every attribute and the text, so
    // a re-attached element carries no stale state a screen reader could observe.
    const pooled = slotPool.pop();
    if (pooled !== undefined) {
      container.appendChild(pooled.row);
      if (pooled.desc !== null && descContainer !== null) descContainer.appendChild(pooled.desc);
      return pooled;
    }
    const row = el(doc, "div", ROW_CLASS);
    row.setAttribute("role", "row");
    row.setAttribute("tabindex", "-1");
    const cell = el(doc, "div", CELL_CLASS);
    cell.setAttribute("role", "gridcell");
    row.appendChild(cell);
    container.appendChild(row);
    return { row, cell, desc: null };
  }

  // Detach a slot and park it for reuse; beyond the cap it is simply dropped.
  function releaseSlot(slot: Slot): void {
    slot.row.remove();
    if (slot.desc !== null) slot.desc.remove();
    if (slotPool.length < SLOT_POOL_CAP) slotPool.push(slot);
  }

  // The row-level half of `setSelected`: applied both from a full `render()` pass (a row newly
  // materialized into the window, e.g. scrolled into view, picks up the latest selection
  // immediately) and from `setSelected` itself (updating the rows already on screen without a
  // rebuild).
  /** Sets or clears `row`'s `aria-selected` for `id`, per the last selection `setSelected` was given. */
  function applySelected(row: HTMLElement, id: TaskId | undefined): void {
    if (id === undefined || selectedIds === undefined) {
      row.removeAttribute("aria-selected");
      return;
    }
    row.setAttribute("aria-selected", selectedIds.has(id) ? "true" : "false");
  }

  /** Whether the DOM focus is currently on one of the mirrored rows. */
  function focusIsInside(): boolean {
    const active = doc.activeElement;
    if (active === null) return false;
    if (typeof container.contains !== "function") return false;
    return container.contains(active);
  }

  function render(): void {
    renderWith(false);
  }

  /**
   * Rebuilds the window. `takeDomFocus` additionally pulls the DOM focus onto the focused row even
   * when it was not already inside the mirror — what an explicit placement (`focusTask`) needs, and
   * the reason the rebuild moves the focus at most once per call.
   */
  function renderWith(takeDomFocus: boolean): void {
    // One data view (and one level memo) for the whole pass — see `currentPass` above.
    pass = { view: data.query(), levels: new Map() };
    try {
      renderPass(takeDomFocus);
    } finally {
      pass = null;
    }
  }

  function renderPass(takeDomFocus: boolean): void {
    // The window this rebuild produces may drop the row that currently holds the DOM focus (a
    // shrinking list pops slots off the end) or hand its element to a different task (a shifting
    // window rewrites slots in place). Either would strand a screen-reader user outside the widget
    // or leave the focus on a row marked `tabindex="-1"`, so whether the focus was inside is
    // recorded before anything moves and restored afterwards.
    const hadFocus = focusIsInside();

    // The count a screen reader hears is the number of rows it can actually reach: rows hidden at
    // height 0 are not part of the sequence, so they are not part of its length either.
    const count = navCount();
    container.setAttribute("aria-rowcount", String(count));

    // The roving focus defaults to the first row, so the mirror always has exactly one row with
    // `tabindex="0"` while there is anything to focus. This also fires when the row the focus was
    // *actually placed on* disappears from under it (a collapsing ancestor, a row hidden by a
    // filter, a store change that drops the task) — `reportFocusChange` below reports it exactly
    // like any other move.
    if (navPositionOf(focusedId) === undefined) {
      const next = count > 0 ? navTaskAt(0) : undefined;
      const changed = next !== focusedId;
      focusedId = next;
      if (changed) reportFocusChange(next);
    }

    // The window is anchored on the viewport (fed in from `view/scrolled`), never on the focus:
    // scrolling the chart moves the mirrored rows even while the focus stays put, so a
    // screen-reader user always reads what is on screen. The focused row is an *additional*
    // constraint, honored by the extra slot below.
    const size = windowSize(count);
    const maxStart = Math.max(0, count - size);
    // The anchor arrives as a model row index (`view/scrolled` → `rowAtY`); it is read as a
    // position in the navigable sequence, so a hidden anchor row lands on the next reachable one.
    const anchor = navPositionAtOrAfter(viewportStart);
    windowStart = Math.min(maxStart, Math.max(0, anchor - BUFFER_ROWS));

    while (slots.length > size) {
      const dropped = slots.pop();
      if (dropped !== undefined) releaseSlot(dropped);
    }
    while (slots.length < size) slots.push(newSlot());

    for (let i = 0; i < slots.length; i += 1) {
      const slot = slots[i];
      if (slot === undefined) continue;
      paintSlot(slot, windowStart + i);
    }

    // A focused row outside the window keeps one dedicated slot, so the roving tabindex (and
    // Tab-reachability of the whole widget) never drops out of the DOM when the user scrolls away
    // from the focus. `aria-rowindex` states its true position; DOM order is not positional for a
    // treegrid mirror that already virtualizes.
    const focusedPosition = navPositionOf(focusedId);
    const outsideWindow =
      focusedPosition !== undefined &&
      (focusedPosition < windowStart || focusedPosition >= windowStart + slots.length);
    if (outsideWindow && focusedPosition !== undefined) {
      if (extraSlot === null) extraSlot = newSlot();
      paintSlot(extraSlot, focusedPosition);
    } else if (extraSlot !== null) {
      releaseSlot(extraSlot);
      extraSlot = null;
    }

    if (hadFocus || takeDomFocus) moveDomFocus();
  }

  /**
   * Paints one slot as the given position in the navigable sequence: ARIA position/level/expanded,
   * tabindex, text.
   */
  function paintSlot(slot: Slot, position: number): void {
    const active = currentPass();
    const id = navTaskAt(position);
    const task = id === undefined ? undefined : active.view.byId.get(id);
    // `aria-rowindex` is 1-based and absolute within the navigable sequence, so a screen reader
    // reports the true position in the full reachable list — matching `aria-rowcount` — even though
    // only this window exists in the DOM.
    slot.row.setAttribute("aria-rowindex", String(position + 1));
    if (id === undefined || task === undefined) {
      slot.row.setAttribute("aria-level", "1");
      slot.row.removeAttribute("aria-expanded");
      slot.row.setAttribute("tabindex", "-1");
      slot.row.removeAttribute("aria-selected");
      slot.cell.textContent = "";
      applyDescription(slot, undefined);
      return;
    }
    slot.row.setAttribute("aria-level", String(levelOf(id, active)));
    if (hasChildren(id, active)) {
      slot.row.setAttribute("aria-expanded", String(rows.isExpanded(id)));
    } else {
      slot.row.removeAttribute("aria-expanded");
    }
    slot.row.setAttribute("tabindex", id === focusedId ? "0" : "-1");
    applySelected(slot.row, id);
    // `progress` is omitted rather than passed as `undefined`, so a host builder can branch on
    // `"progress" in parts` as well as on the value.
    const parts: RowTextParts = { name: task.name, start: task.start, end: task.end };
    if (task.progress !== undefined) parts.progress = task.progress;
    slot.cell.textContent = deps.rowText(parts);
    applyDescription(slot, id);
  }

  // The dependency read-out: a non-empty description materializes the slot's hidden node (lazily,
  // with a document-unique id) and points the row's `aria-describedby` at it; an empty one, an
  // empty row, or the feature being off leaves the row without the attribute and without extra text
  // in the node.
  /** Writes or clears `slot`'s description node and the row's `aria-describedby` link. */
  function applyDescription(slot: Slot, id: TaskId | undefined): void {
    const build = deps.rowDescription;
    const text = build === undefined || id === undefined ? "" : build(id);
    if (text === "") {
      slot.row.removeAttribute("aria-describedby");
      if (slot.desc !== null) slot.desc.textContent = "";
      return;
    }
    if (slot.desc === null) {
      descSeq += 1;
      const desc = el(doc, "div", DESC_CLASS);
      desc.setAttribute("id", `sg-a11y-desc-${instance}-${descSeq}`);
      descContainer?.appendChild(desc);
      slot.desc = desc;
    }
    slot.desc.textContent = text;
    slot.row.setAttribute("aria-describedby", slot.desc.getAttribute("id") ?? "");
  }

  function runFrame(): void {
    frame = null;
    timer = null;
    render();
  }

  /** Heavy work is scheduled onto a frame, never done inside a change handler. */
  function schedule(): void {
    if (frame !== null || timer !== null) return;
    if (typeof globalThis.requestAnimationFrame === "function") {
      frame = globalThis.requestAnimationFrame(runFrame);
      return;
    }
    timer = globalThis.setTimeout(runFrame, 16);
  }

  ctx.own({
    dispose: () => {
      if (frame !== null && typeof globalThis.cancelAnimationFrame === "function") {
        globalThis.cancelAnimationFrame(frame);
      }
      if (timer !== null) globalThis.clearTimeout(timer);
      frame = null;
      timer = null;
    },
  });

  /** Drops the cached root measurement; the next rebuild measures the container again. */
  function remeasure(): void {
    measured = false;
  }

  // The container's height decides how many rows the window holds, and it can only change when the
  // element is resized — so the measurement is refreshed there rather than on every rebuild. When
  // `ResizeObserver` is unavailable (older embedders, a unit-test DOM) the window resize event is
  // the coarse fallback; without either, `lifecycle/ready` still remeasures once after first layout.
  if (typeof globalThis.ResizeObserver === "function") {
    const ro = new globalThis.ResizeObserver(() => {
      remeasure();
      schedule();
    });
    ro.observe(ctx.root);
    ctx.own({ dispose: () => ro.disconnect() });
  } else if (typeof globalThis.addEventListener === "function") {
    const onResize = (): void => {
      remeasure();
      schedule();
    };
    globalThis.addEventListener("resize", onResize);
    ctx.own({ dispose: () => globalThis.removeEventListener("resize", onResize) });
  }

  /** Gives the DOM focus to the mirrored row of the focused task, when that row is materialized. */
  function moveDomFocus(): void {
    if (focusedId === undefined) return;
    const position = navPositionOf(focusedId);
    if (position === undefined) return;
    const slot = slots[position - windowStart] ?? (extraSlot !== null ? extraSlot : undefined);
    if (slot === undefined) return;
    if (typeof slot.row.focus === "function") slot.row.focus();
  }

  // DOM focus entering the mirror (including the never-placed row-0 tabindex fallback) triggers the
  // visual-only placement; leaving it clears the state. A move between two mirror rows is not a
  // transition.
  const onFocusIn = ((): void => {
    if (focusVisible) return;
    focusVisible = true;
    deps.onFocusVisibility(true);
  }) as EventListener;
  const onFocusOut = ((e: Event): void => {
    const related = (e as unknown as { relatedTarget: unknown }).relatedTarget;
    if (related !== null && related !== undefined && typeof container.contains === "function") {
      if (container.contains(related as Node)) return;
    }
    if (!focusVisible) return;
    focusVisible = false;
    deps.onFocusVisibility(false);
  }) as EventListener;
  container.addEventListener("focusin", onFocusIn);
  container.addEventListener("focusout", onFocusOut);
  ctx.own({
    dispose: () => {
      container.removeEventListener("focusin", onFocusIn);
      container.removeEventListener("focusout", onFocusOut);
    },
  });

  // Reports an effective focus change exactly once, from whichever caller actually moved
  // `focusedId`: `focusTask` below, or the row-0 fallback in `render()` above relocating or
  // clearing a focus that was already placed. Gated on `placed` so the internal default the roving
  // tabindex starts on — before any real interaction — is never reported.
  function reportFocusChange(id: TaskId | undefined): void {
    if (placed) deps.onFocusChanged(id);
  }

  function focusTask(id: TaskId, cause: FocusCause): void {
    // A task with no row, and a task whose row is hidden at height 0, are both unreachable: the
    // roving focus never lands on something the user cannot see.
    if (navPositionOf(id) === undefined) return;
    // The very first real placement is an effective change on its own — moving from "nothing placed
    // yet" to `id` — even when `id` happens to already equal the internal row-0 fallback
    // `focusedId` was sitting on (e.g. the first keyboard press on an untouched chart).
    const effectiveChange = id !== focusedId || !placed;
    focusedId = id;
    placed = true;
    // The rebuild takes the DOM focus as part of the same pass: a placement made from outside the
    // mirror (a pointer press, `FocusService.focus`) must move it, and one made from inside it must
    // not move it twice.
    renderWith(true);
    deps.onFocus(id, cause);
    if (effectiveChange) reportFocusChange(id);
  }

  function moveFocus(delta: number, cause: FocusCause): void {
    // Movement counts positions in the navigable sequence, so one arrow press always lands on the
    // next row the user can see, however many hidden rows lie between them.
    const count = navCount();
    if (count === 0) return;
    const current = navPositionOf(focusedId);
    const next = Math.min(count - 1, Math.max(0, (current ?? 0) + delta));
    const id = navTaskAt(next);
    if (id !== undefined) focusTask(id, cause);
  }

  // Updates every currently materialized row's `aria-selected` in place, without going through
  // `render()`'s window/level/text recomputation. A row that is not yet materialized needs no
  // update here: it picks up `selectedIds` from `render()`'s own `applySelected` call the moment it
  // is built.
  function setSelected(ids: ReadonlySet<TaskId> | undefined): void {
    selectedIds = ids;
    for (let i = 0; i < slots.length; i += 1) {
      const slot = slots[i];
      if (slot === undefined) continue;
      applySelected(slot.row, navTaskAt(windowStart + i));
    }
    // The dedicated off-window focused-row slot mirrors selection state too — it is exactly the row
    // a screen-reader user is sitting on, so a stale `aria-selected` there is the worst spot.
    if (extraSlot !== null) applySelected(extraSlot.row, focusedId);
  }

  return {
    focusedId: () => focusedId,
    focusPlaced: () => placed,
    focusVisible: () => focusVisible,
    setViewportStart: (row: number): void => {
      const next = Math.max(0, Math.floor(row));
      if (next === viewportStart) return;
      viewportStart = next;
      schedule();
    },
    focusTask,
    moveFocus,
    setSelected,
    setMultiselectable: (on: boolean): void => {
      if (on) container.setAttribute("aria-multiselectable", "true");
      else container.removeAttribute("aria-multiselectable");
    },
    invalidateRows: (): void => {
      navStale = true;
    },
    remeasure,
    announce: (message) => {
      live.textContent = message;
    },
    schedule,
    render,
    container,
  };
}
