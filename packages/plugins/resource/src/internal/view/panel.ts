// docs/specs/plugins/resource.md §3.4 — the resource-view strip's DOM.
/**
 * The panel's DOM: the content of the one `view/bottomPanes` strip, holding one row per resource
 * with absolutely positioned task segments, optionally grouped under team bands.
 *
 * Two properties of the layout are load-bearing (§3, carried verbatim):
 *
 * - **The strip's three columns carry different things.** The view plugin sizes the `gutter`
 *   column to the left panes and the `body` column to the chart pane, so the name column goes in
 *   the gutter — where it lines up with the tree grid — and the lanes go in the body, where a
 *   segment's `left` is a chart-pane x (`tToX` minus horizontal scroll) and needs no correction.
 *   The `trailing` column stays empty. When the gutter has no width (the chart-only `gantt` view
 *   mode), the names fall back to a column of `--sg-rv-label-width` inside the body and the lanes
 *   are offset by it.
 * - **The body is the scroll surface and the gutter mirrors it.** Resource rows are independent of
 *   task rows, so the strip scrolls vertically on its own; the name column follows the body's
 *   `scrollTop` so every name stays beside its lane.
 *
 * Nothing here is pointer-transparent and nothing is a scrim: the strip is a pane of its own with
 * no chart behind it, so it paints opaque surfaces and takes pointer events like any other pane.
 *
 * Colors are applied purely through the CSS cascade via the `.sg-resource-view*` classes and
 * `--sg-rv-*` tokens — nothing here sets an inline color. The panel ships its own scoped
 * stylesheet (a `<style>` element inside the strip, removed with it): every rule reads a
 * `--sg-rv-*` token first and falls back to a core theme token and last to a literal, so the
 * surfaces follow the light/dark scheme without any JS-side color read. Geometry (position/size,
 * varying per paint with scroll/zoom/data) is inline style. Overallocation is conveyed by a
 * modifier class, a `data-over` attribute AND the row's/segment's own text — never by color alone.
 *
 * The columns are cleared and repopulated on every paint; the panel shows one row per resource
 * (typically far fewer than tasks) and culls both axes, so a full rebuild fits the once-per-frame
 * batching the caller applies.
 */
import type { LaneBox } from "@stargantt/plugin-interaction";
import type { ResourceMessages } from "../messages";
import { laneAtY, laneOfResource } from "./lanes";
import type { LaneRecord } from "./lanes";
import type { RvGroup, RvSegment } from "./model";

function el(doc: Document, tag: string, className: string): HTMLElement {
  const e = doc.createElement(tag);
  e.className = className;
  return e;
}

function px(n: number): string {
  return `${n}px`;
}

/**
 * The panel's scoped stylesheet. Hosts restyle through the `--sg-rv-*` tokens; each falls back to
 * the matching core theme token (light/dark aware via the bundled stylesheet) and last to a
 * literal light value, so the panel stays legible even without the theme stylesheet.
 *
 * Contrast at the literal fallbacks: body text #1c1917 on #ffffff = 16.1:1, team band #1c1917 on
 * #f2f0ec = 14.7:1, segment #ffffff on #0f766e = 4.5:1, over segment #ffffff on #b3261e = 6.6:1 —
 * all at or above the 4.5:1 text floor; row/band hairlines are ground, not figure.
 *
 * Two structural rules beyond color:
 *
 * - the header band names the strip: one row high, opaque, carrying the accent edge, so the rows
 *   below it are never read as a continuation of the chart's task rows;
 * - the lane a lane drag would drop into is outlined in the accent color and marked `data-target`.
 *   It is an outline plus a tint, so the mark survives a monochrome rendering.
 */
const PANEL_CSS = `
.sg-resource-view {
  position: relative;
  height: 100%;
  overflow: hidden;
  color: var(--sg-rv-fg, var(--sg-fg, #1c1917));
  font: var(--sg-rv-font, 12px/1.4 system-ui, sans-serif);
  background: var(--sg-rv-bg, var(--sg-bg, #ffffff));
}
.sg-resource-view__names {
  overflow: hidden;
  border-right: 1px solid var(--sg-rv-border, var(--sg-border, #e7e5e4));
}
.sg-resource-view__body {
  overflow-y: auto;
  overflow-x: hidden;
}
.sg-resource-view__body:focus-visible {
  outline: 2px solid var(--sg-rv-accent, var(--sg-focus-stroke, #0f766e));
  outline-offset: -2px;
}
.sg-resource-view__header {
  display: flex;
  align-items: center;
  box-sizing: border-box;
  padding: 0 8px;
  font-weight: 600;
  overflow: hidden;
  white-space: nowrap;
  background: var(--sg-rv-team-bg, var(--sg-header-bg, #f2f0ec));
  color: var(--sg-rv-team-fg, var(--sg-header-fg, #1c1917));
  border-bottom: 1px solid var(--sg-rv-border, var(--sg-border, #e7e5e4));
  border-left: 3px solid var(--sg-rv-accent, var(--sg-focus-stroke, #0f766e));
}
.sg-resource-view__team {
  box-sizing: border-box;
  padding: 4px 8px;
  font-weight: 600;
  overflow: hidden;
  white-space: nowrap;
  background: var(--sg-rv-team-bg, var(--sg-header-bg, #f2f0ec));
  color: var(--sg-rv-team-fg, var(--sg-header-fg, #1c1917));
  border-bottom: 1px solid var(--sg-rv-border, var(--sg-border, #e7e5e4));
}
.sg-resource-view__row {
  border-bottom: 1px solid var(--sg-rv-row-border, var(--sg-border, #e7e5e4));
}
.sg-resource-view__label {
  display: flex;
  align-items: center;
  box-sizing: border-box;
  padding: 0 8px;
  overflow: hidden;
  white-space: nowrap;
  background: var(--sg-rv-bg, var(--sg-bg, #ffffff));
  border-bottom: 1px solid var(--sg-rv-row-border, var(--sg-border, #e7e5e4));
}
.sg-resource-view__label--over {
  font-weight: 600;
}
.sg-resource-view__lane {
  background: var(--sg-rv-lane-bg, var(--sg-rv-bg, var(--sg-bg, #ffffff)));
}
.sg-resource-view__row--target .sg-resource-view__lane,
.sg-resource-view__label--target {
  background: color-mix(in srgb, var(--sg-rv-accent, var(--sg-focus-stroke, #0f766e)) 12%, var(--sg-rv-bg, var(--sg-bg, #ffffff)));
  outline: 2px dashed var(--sg-rv-accent, var(--sg-focus-stroke, #0f766e));
  outline-offset: -2px;
}
.sg-resource-view__track {
  pointer-events: none;
}
.sg-resource-view__seg {
  display: flex;
  align-items: center;
  box-sizing: border-box;
  padding: 0 4px;
  border-radius: 3px;
  overflow: hidden;
  white-space: nowrap;
  background: var(--sg-rv-seg-bg, var(--sg-bar-fill, #0f766e));
  color: var(--sg-rv-seg-fg, var(--sg-bar-inside-label-fg, #ffffff));
}
.sg-resource-view__seg--over {
  background: var(--sg-rv-seg-over-bg, var(--sg-dialog-danger, #b3261e));
  color: var(--sg-rv-seg-over-fg, var(--sg-bar-inside-label-fg, #ffffff));
  outline: 1px dashed var(--sg-rv-seg-over-fg, var(--sg-bar-inside-label-fg, #ffffff));
  outline-offset: -2px;
}
`;

/** The three columns of a bottom strip, as the view plugin hands them to `mount`. */
export interface PanelColumns {
  pane: HTMLElement;
  gutter: HTMLElement;
  body: HTMLElement;
  trailing: HTMLElement;
}

/** Everything one repaint of the panel's content needs. */
export interface PanelContent {
  groups: readonly RvGroup[];
  /** The chart's virtual horizontal scroll offset. */
  scrollLeft: number;
  /**
   * Content x of an instant — `TimelineService.tToX`. `null` while no timeline is composed, which
   * leaves the rows painted and every segment omitted: a segment without an x is not a segment.
   */
  tToX: ((t: number) => number) | null;
  messages: ResourceMessages;
}

/** The layout numbers a paint lays its bands out with — the theme tokens, read once. */
export interface PanelMetrics {
  /** Row height in px (`--sg-rv-row-height`, fallback 28). */
  rowHeight: number;
  /** Team band height in px — one row height, so lane math stays exact arithmetic. */
  teamHeight: number;
  /**
   * Width of the in-body name column in px (`--sg-rv-label-width`, fallback 160), used only when
   * the strip's gutter column has no width of its own (the chart-only `gantt` view mode).
   */
  labelWidth: number;
}

/** What the panel needs from its surroundings. */
export interface PanelViewDeps {
  /** The gantt root; lane geometry is reported relative to its inner top edge. */
  root: HTMLElement;
  /**
   * The layout numbers. Called once per paint rather than latched at construction, so the caller
   * can memoize the theme read at the moment the theme service first exists (§9's timing rule)
   * instead of at `setup()`.
   */
  metrics(): PanelMetrics;
}

/** The strip's content plus its placement, rendering and lane geometry. */
export interface PanelView {
  /** Builds the panel inside the strip's columns. Called once, from the contribution's `mount`. */
  mount(columns: PanelColumns): void;
  /** Whether the panel has been mounted into a strip yet. */
  isMounted(): boolean;
  render(content: PanelContent): void;
  /**
   * The resource lane at a root-relative y — measured from the inner top edge of the gantt root,
   * the space `drag/lanes` is declared in — or `undefined` when none is there. Always `undefined`
   * before the strip is mounted, while it is released (height 0) and while it has painted no row.
   */
  laneAt(y: number): LaneBox | undefined;
  /** The lane of one resource, in the same root-relative space `laneAt` answers in. */
  laneOf(resourceId: string): LaneBox | undefined;
  /**
   * Sets the panel's title: both its accessible name and the visible text of its header band, so
   * the two can never disagree. The write is skipped when the text is unchanged.
   */
  describe(ariaLabel: string): void;
  /**
   * Empties the strip and forgets its lane geometry, so the seam answers `undefined` for every y.
   * That is what a released strip is: it shows no lane, whatever its element's box still measures.
   */
  clear(): void;
  /**
   * Marks one resource's lane as the drop target of a lane drag, or clears the mark with `null`.
   * Idempotent; an id no row carries clears the mark.
   */
  highlight(resourceId: string | null): void;
  /** Removes the panel's own elements from the strip. `ctx.own()`-shaped. */
  dispose(): void;
}

/**
 * Creates the panel view. It renders nothing until `mount` places it in a strip — and touches no
 * DOM at all before then: `deps.root` may not be a real element yet (a headless composition, or
 * one without `stargantt.view` to ever call `mount`), so even `deps.root.ownerDocument` is read
 * lazily, on first actual use inside `mount`/`render`, never at construction (§9's timing rule).
 */
export function createPanelView(deps: PanelViewDeps): PanelView {
  let columns: PanelColumns | null = null;
  /** The gutter-hosted name column, scroll-mirrored to the body. */
  let names: HTMLElement | null = null;
  /** The body scroller: the strip's scroll surface and the lane space's origin. */
  let body: HTMLElement | null = null;
  /**
   * Set on first `mount()`, from the mounted `pane`'s own `ownerDocument` — never from
   * `deps.root` at construction time (see the module doc above). Definite-assignment: every other
   * use of `doc` below runs from `mount`/`render`, both unreachable before `mount` sets it.
   */
  let doc!: Document;
  /** Created on first `mount()` — see the module doc above. */
  let style: HTMLStyleElement | null = null;

  let lastAriaLabel: string | null = null;
  let target: string | null = null;
  /**
   * Lane geometry of the latest paint, in the body's content space. Reused across paints
   * (`length = 0`) rather than reallocated: this is the one array the paint path touches per row.
   */
  const lanes: LaneRecord[] = [];
  /** The elements a highlight has to toggle, by resource id, from the latest paint. Reused. */
  const rowElements = new Map<string, readonly HTMLElement[]>();
  /** The latest paint's content, so a vertical scroll can re-window without a new model. */
  let lastContent: PanelContent | null = null;
  /** The row window of the latest paint, in content-space px, for the scroll re-window test. */
  let windowTop = 0;
  let windowBottom = Number.POSITIVE_INFINITY;
  /**
   * The body scroller's placement against the root, cached for the lane seam: `laneAt` runs per
   * pointermove, and two `getBoundingClientRect` calls there are forced layout reads. Dropped on
   * every paint and clear; resizes reach a paint through the caller's own ResizeObserver.
   */
  let bodyBox: { top: number; height: number } | null = null;

  function measureBodyBox(): { top: number; height: number } | null {
    const scroller = body;
    if (scroller === null) return null;
    if (bodyBox === null) {
      const box = scroller.getBoundingClientRect();
      const rootBox = deps.root.getBoundingClientRect();
      bodyBox = { top: box.top - rootBox.top, height: box.height };
    }
    return bodyBox;
  }

  /** Whether the strip's gutter column is wide enough to hold the name column. */
  function gutterWidth(): number {
    const gutter = columns?.gutter;
    if (gutter === undefined) return 0;
    const width = gutter.getBoundingClientRect().width;
    return Number.isFinite(width) && width > 0 ? width : 0;
  }

  function applyTargetClass(): void {
    for (const [id, elements] of rowElements) {
      const on = id === target;
      for (const element of elements) {
        const isLabel = element.classList.contains("sg-resource-view__label");
        element.classList.toggle(
          isLabel ? "sg-resource-view__label--target" : "sg-resource-view__row--target",
          on,
        );
        if (on) element.setAttribute("data-target", "true");
        else element.removeAttribute("data-target");
      }
    }
  }

  // A segment's `left` is a chart-pane x (`tToX` minus the horizontal scroll), the same number the
  // chart header is drawn at — and it reaches the screen unchanged because the body column tracks
  // the chart pane. With no gutter to put names in, the track cancels the in-body name column's
  // offset instead, so the alignment survives that fallback too.
  function renderSegment(
    seg: RvSegment,
    content: PanelContent,
    tToX: (t: number) => number,
    track: HTMLElement,
  ): void {
    const x1 = tToX(seg.start) - content.scrollLeft;
    const x2 = tToX(seg.end) - content.scrollLeft;
    const s = el(
      doc,
      "div",
      seg.over ? "sg-resource-view__seg sg-resource-view__seg--over" : "sg-resource-view__seg",
    );
    // The non-color half of the overallocation signal, beside the label text itself.
    if (seg.over) s.setAttribute("data-over", "true");
    s.style.position = "absolute";
    s.style.left = px(x1);
    // A 2 px floor: a segment narrower than a hairline is still a segment on the row.
    s.style.width = px(Math.max(2, x2 - x1));
    s.style.top = "3px";
    s.style.bottom = "3px";
    const text = content.messages.segmentLabel({
      taskName: seg.taskName,
      unitsPercent: Math.round(seg.units * 100),
      project: seg.project,
      over: seg.over,
    });
    s.textContent = text;
    // A clipped segment's own text is unreadable; the native tooltip carries it in full without
    // covering the row (no hover delay of our own to tune, no element over the lane).
    s.title = text;
    track.appendChild(s);
  }

  /** One full (re)paint of the panel into its columns — `render` and the scroll re-window. */
  function renderInto(content: PanelContent): void {
    const scroller = body;
    const nameColumn = names;
    if (scroller === null || nameColumn === null) return;
    // Read the scroll offset (and viewport height) BEFORE emptying the columns: clearing collapses
    // the scroll height, so in a real browser a `scrollTop` read after the clear flushes layout
    // against the emptied scroller and clamps to 0 — every mid-roster repaint would snap the panel
    // back to the top. The captured offset drives the culling window and is written back once the
    // rebuilt stacks have restored the scroll height.
    const scrollTop = scroller.scrollTop;
    const clientHeight = scroller.clientHeight;
    const bodyWidth = scroller.clientWidth;
    // One read per paint, never per row: the tokens behind it are memoized by the caller.
    const metrics = deps.metrics();
    scroller.textContent = "";
    nameColumn.textContent = "";
    lanes.length = 0;
    rowElements.clear();
    lastContent = content;
    bodyBox = null;

    // With a gutter to put names in, the lane fills the body column and a segment's x needs no
    // correction; without one, the names take a column inside the body and the lane starts after it.
    const inBody = gutterWidth() <= 0;
    const nameOffset = inBody ? metrics.labelWidth : 0;

    // Vertical culling: rows outside the scroll window (plus two rows of overscan) get their
    // combined height as one spacer per column instead of elements — the lane records still cover
    // every row, so the seam and the scroll height are unchanged. A layout-less environment
    // reports no client height and renders everything.
    const overscan = 2 * metrics.rowHeight;
    const cullRows = Number.isFinite(clientHeight) && clientHeight > 0;
    const winTop = cullRows ? scrollTop - overscan : 0;
    const winBottom = cullRows ? scrollTop + clientHeight + overscan : Number.POSITIVE_INFINITY;
    windowTop = Math.max(0, winTop);
    windowBottom = winBottom;
    // Horizontal culling: segments wholly outside `[0, bodyWidth)` in chart-pane x are not built.
    // A `0` width (layout-less) disables the cull.
    const tToX = content.tToX;
    const cullSegments = tToX !== null && Number.isFinite(bodyWidth) && bodyWidth > 0;

    let pendingScroller = 0;
    let pendingNames = 0;
    const flushSpacers = (): void => {
      if (pendingScroller > 0) {
        const spacer = el(doc, "div", "sg-resource-view__spacer");
        spacer.style.height = px(pendingScroller);
        scroller.appendChild(spacer);
        pendingScroller = 0;
      }
      if (pendingNames > 0) {
        const spacer = el(doc, "div", "sg-resource-view__spacer");
        spacer.style.height = px(pendingNames);
        nameColumn.appendChild(spacer);
        pendingNames = 0;
      }
    };

    // The header band: the strip's title row. It spans both columns so the two stacks stay
    // row-aligned, but the text lives in the body's half — the wide one — and the gutter's half is
    // a spacer, hidden from assistive tech (the title is the region's accessible name already).
    const gutterHeader = el(
      doc,
      "div",
      "sg-resource-view__header sg-resource-view__header--spacer",
    );
    gutterHeader.style.height = px(metrics.rowHeight);
    gutterHeader.style.boxSizing = "border-box";
    nameColumn.appendChild(gutterHeader);
    const bodyHeader = el(doc, "div", "sg-resource-view__header");
    bodyHeader.style.height = px(metrics.rowHeight);
    bodyHeader.style.boxSizing = "border-box";
    bodyHeader.textContent = lastAriaLabel ?? "";
    scroller.appendChild(bodyHeader);

    // Every band the panel stacks has an explicit height, so the lane geometry below is exact
    // arithmetic over the same numbers the DOM is laid out with — no measurement round trip, and
    // the rows stay pixel-aligned with each other whatever the reader's zoom.
    let y = metrics.rowHeight;
    for (const group of content.groups) {
      if (group.name !== null) {
        flushSpacers();
        // The summary sentence is long, so it goes in the wide body column; the gutter keeps a
        // band of the same height so the two stacks stay row-aligned.
        const gutterTeam = el(doc, "div", "sg-resource-view__team sg-resource-view__team--spacer");
        gutterTeam.style.height = px(metrics.teamHeight);
        gutterTeam.style.boxSizing = "border-box";
        nameColumn.appendChild(gutterTeam);
        const bodyTeam = el(doc, "div", "sg-resource-view__team");
        bodyTeam.style.height = px(metrics.teamHeight);
        bodyTeam.style.boxSizing = "border-box";
        bodyTeam.textContent = content.messages.teamSummary({
          name: group.name,
          memberCount: group.rows.length,
          capacity: group.capacity,
          peak: group.peak,
          free: group.free,
          overloadedMembers: group.overloadedMembers,
        });
        scroller.appendChild(bodyTeam);
        y += metrics.teamHeight;
      }
      for (const row of group.rows) {
        const key = String(row.resourceId);
        // A row wholly outside the scroll window: record its lane and its height, no elements.
        if (y + metrics.rowHeight <= winTop || y >= winBottom) {
          lanes.push({ resourceId: key, y, height: metrics.rowHeight });
          y += metrics.rowHeight;
          pendingScroller += metrics.rowHeight;
          if (!inBody) pendingNames += metrics.rowHeight;
          continue;
        }
        flushSpacers();
        const labelText = content.messages.rowLabel({
          name: row.name,
          capacity: row.capacity,
          peak: row.peak,
          over: row.over,
        });
        const label = el(
          doc,
          "div",
          row.over
            ? "sg-resource-view__label sg-resource-view__label--over"
            : "sg-resource-view__label",
        );
        label.style.height = px(metrics.rowHeight);
        label.style.boxSizing = "border-box";
        label.textContent = labelText;
        label.title = labelText;
        // Overallocation reaches a colour-blind reader, a monochrome print and a screen reader
        // alike: the label text says so (the catalog's own wording), the weight changes, and the
        // attribute is queryable.
        if (row.over) label.setAttribute("data-over", "true");

        const rowEl = el(
          doc,
          "div",
          row.over ? "sg-resource-view__row sg-resource-view__row--over" : "sg-resource-view__row",
        );
        if (row.over) rowEl.setAttribute("data-over", "true");
        rowEl.setAttribute("data-sg-resource", key);
        rowEl.style.position = "relative";
        rowEl.style.height = px(metrics.rowHeight);
        rowEl.style.boxSizing = "border-box";
        lanes.push({ resourceId: key, y, height: metrics.rowHeight });
        y += metrics.rowHeight;

        const lane = el(doc, "div", "sg-resource-view__lane");
        lane.style.position = "absolute";
        lane.style.left = px(nameOffset);
        lane.style.right = "0";
        lane.style.top = "0";
        lane.style.bottom = "0";
        lane.style.overflow = "hidden";
        // The track cancels the in-body name column's offset when there is one, so a segment's
        // `left` is a chart-pane x either way and the lane's clipping crops what slides under.
        const track = el(doc, "div", "sg-resource-view__track");
        track.style.position = "absolute";
        track.style.left = px(-nameOffset);
        track.style.right = "0";
        track.style.top = "0";
        track.style.bottom = "0";
        if (tToX !== null) {
          // Segments are start-sorted (the model sorts them), so the right edge is a binary search
          // — every segment from `stop` on starts at or past `bodyWidth` — and the left edge a
          // scan that drops segments ending at or before `0`. The DOM for what remains is
          // identical to an unculled paint.
          const segs = row.segments;
          let stop = segs.length;
          if (cullSegments) {
            let lo = 0;
            let hi = segs.length;
            while (lo < hi) {
              const mid = (lo + hi) >> 1;
              if (tToX((segs[mid] as RvSegment).start) - content.scrollLeft >= bodyWidth) hi = mid;
              else lo = mid + 1;
            }
            stop = lo;
          }
          for (let i = 0; i < stop; i += 1) {
            const seg = segs[i] as RvSegment;
            if (cullSegments && tToX(seg.end) - content.scrollLeft <= 0) continue;
            renderSegment(seg, content, tToX, track);
          }
        }
        lane.appendChild(track);
        rowEl.appendChild(lane);

        if (inBody) {
          // No gutter: the name column rides inside the body, in front of the lane.
          label.style.position = "absolute";
          label.style.left = "0";
          label.style.top = "0";
          label.style.bottom = "0";
          label.style.width = px(metrics.labelWidth);
          label.style.height = "";
          rowEl.appendChild(label);
        } else {
          nameColumn.appendChild(label);
        }
        scroller.appendChild(rowEl);
        rowElements.set(key, [rowEl, label]);
      }
    }
    flushSpacers();
    // Restore the offset the reader had: the clear above zeroed it in engines that flush layout on
    // read/write, and the rebuilt stacks have just re-established the scroll height. The name
    // column mirrors the same pre-clear capture.
    scroller.scrollTop = scrollTop;
    nameColumn.scrollTop = scrollTop;
    applyTargetClass();
  }

  return {
    mount: (cols) => {
      columns = cols;
      cols.pane.classList.add("sg-resource-view");
      cols.pane.setAttribute("data-sg-resource-view", "resource-view");
      cols.pane.setAttribute("role", "region");
      if (lastAriaLabel !== null) cols.pane.setAttribute("aria-label", lastAriaLabel);
      // The first (and only) moment a real document is guaranteed: `deps.root` may be the plain
      // stand-in of a headless composition, which has no `ownerDocument` at all.
      doc = cols.pane.ownerDocument;
      // The scoped stylesheet lives inside the strip so removing the panel removes it too. Class
      // names are `sg-`-prefixed, so the document-wide rules cannot collide with host CSS.
      const sheet = doc.createElement("style");
      sheet.textContent = PANEL_CSS;
      style = sheet;
      cols.pane.appendChild(sheet);
      // The name column is presentational: it repeats what each lane's own row text already says,
      // and it is the body that scrolls.
      const nameColumn = el(doc, "div", "sg-resource-view__names");
      nameColumn.setAttribute("aria-hidden", "true");
      nameColumn.style.height = "100%";
      cols.gutter.appendChild(nameColumn);
      names = nameColumn;
      const scroller = el(doc, "div", "sg-resource-view__body");
      scroller.style.height = "100%";
      // A scrollable region must be reachable and scrollable keyboard-only (WCAG 2.2 §2.1.1); the
      // focus ring is the stylesheet's `:focus-visible` rule, so it shows on keyboard focus only.
      scroller.setAttribute("tabindex", "0");
      scroller.addEventListener("scroll", () => {
        if (names !== null) names.scrollTop = scroller.scrollTop;
        // Rows outside the scroll window are not in the DOM; a scroll past the overscan re-windows
        // from the last content without rebuilding the model. The lane geometry the seam reads is
        // rebuilt by the same pass, so a drag over a freshly scrolled strip is never stale.
        if (
          lastContent !== null &&
          (scroller.scrollTop < windowTop ||
            scroller.scrollTop + scroller.clientHeight > windowBottom)
        ) {
          renderInto(lastContent);
        }
      });
      cols.body.appendChild(scroller);
      body = scroller;
      // The names gutter is presentational and does not scroll itself; a wheel gesture over it
      // still scrolls the rows, forwarded to the body scroller. Explicitly non-passive, because
      // the forward is only correct if the default scroll does not also happen.
      nameColumn.addEventListener(
        "wheel",
        (e: WheelEvent) => {
          scroller.scrollTop += e.deltaY;
          e.preventDefault();
        },
        { passive: false },
      );
    },

    isMounted: () => body !== null,

    render: (content) => renderInto(content),

    clear: () => {
      if (body !== null) body.textContent = "";
      if (names !== null) names.textContent = "";
      lanes.length = 0;
      rowElements.clear();
      target = null;
      lastContent = null;
      bodyBox = null;
      windowTop = 0;
      windowBottom = Number.POSITIVE_INFINITY;
    },

    laneAt: (y) => {
      const scroller = body;
      if (scroller === null) return undefined;
      const box = measureBodyBox();
      if (box === null || box.height <= 0) return undefined;
      return laneAtY(lanes, y, scroller.scrollTop, box.top, box.height);
    },

    laneOf: (resourceId) => {
      const scroller = body;
      if (scroller === null) return undefined;
      const box = measureBodyBox();
      if (box === null) return undefined;
      return laneOfResource(lanes, resourceId, scroller.scrollTop, box.top, box.height);
    },

    describe: (ariaLabel) => {
      if (ariaLabel === lastAriaLabel) return;
      lastAriaLabel = ariaLabel;
      columns?.pane.setAttribute("aria-label", ariaLabel);
    },

    highlight: (resourceId) => {
      const next = resourceId === null ? null : String(resourceId);
      if (next === target) return;
      target = next;
      applyTargetClass();
    },

    dispose: () => {
      style?.parentNode?.removeChild(style);
      style = null;
      names?.parentNode?.removeChild(names);
      body?.parentNode?.removeChild(body);
      if (columns !== null) {
        // The pane element is view-owned: it is returned exactly as found, attributes included.
        columns.pane.classList.remove("sg-resource-view");
        columns.pane.removeAttribute("data-sg-resource-view");
        columns.pane.removeAttribute("role");
        columns.pane.removeAttribute("aria-label");
      }
      names = null;
      body = null;
      columns = null;
      lanes.length = 0;
      rowElements.clear();
      lastContent = null;
      bodyBox = null;
    },
  };
}
