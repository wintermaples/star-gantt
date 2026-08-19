// docs/specs/plugins/resource.md §3.6 / §4.2 — the load heatmap card and its `overlay-corner` slot.
/**
 * The resources × buckets utilization matrix as a colour-intensity grid: a positioned card in
 * whichever corner of the chart pane's safe area the `overlay-corner` claim resolves to.
 *
 * Hostless: the module builds and wires DOM off a mount element, a corner and callbacks; `wire.ts`
 * owns the slot claim, the rAF batching and disposal. Every colour comes from a `--sg-load-*` theme
 * token through `var()` with a fallback, and every style is inline — this plugin ships no
 * stylesheet.
 *
 * Overload is never signalled by colour alone (WCAG 1.4.1): an over cell carries the `--over`
 * modifier class, a 2 px outline AND a `!` glyph.
 */
import { OVERLOAD_EPSILON } from "../engine/compute";
import type { UtilizationReportCell, UtilizationReportRow } from "../areas";
import type { LoadChartHeatmapCellInput } from "../messages";

/** Fixed heatmap cell box, CSS px (§3.6). */
const CELL_PX = 16;

/** The card's own margin inside its corner slot (§3.6). */
const SLOT_MARGIN_PX = 8;

/** The four corners of the chart pane's safe area a corner-anchored overlay can occupy. */
export type HeatmapCorner = "top-left" | "top-right" | "bottom-left" | "bottom-right";

/** Every corner name this feature knows, for the slot claim's candidate vocabulary. */
export const HEATMAP_CORNERS: readonly HeatmapCorner[] = [
  "top-left",
  "top-right",
  "bottom-left",
  "bottom-right",
];

/** The corner the card requests (§4.2). */
export const REQUESTED_CORNER: HeatmapCorner = "top-right";

export function isHeatmapCorner(value: string | undefined): value is HeatmapCorner {
  return value !== undefined && (HEATMAP_CORNERS as readonly string[]).includes(value);
}

/**
 * The corner a `claimSlot("overlay-corner", "top-right", …)` grant resolves to: the requested corner
 * when granted, the proposed alternative when it names one of the four known corners, the requested
 * corner otherwise (no free slot left — the registry has already reported the collision). Mirrors
 * the scheduling diagnostics panel's `resolveCorner` exactly.
 */
export function resolveCorner(grant: { granted: boolean; alternative?: string }): HeatmapCorner {
  return grant.granted || !isHeatmapCorner(grant.alternative)
    ? REQUESTED_CORNER
    : grant.alternative;
}

/** The corner-slot positioning, written in terms of that corner's own `--sg-safe-*` pair. */
export function slotStyles(corner: HeatmapCorner): Record<string, string> {
  const vertical =
    corner === "top-left" || corner === "top-right"
      ? { top: `calc(var(--sg-safe-top, 0px) + ${String(SLOT_MARGIN_PX)}px)` }
      : { bottom: `calc(var(--sg-safe-bottom, 0px) + ${String(SLOT_MARGIN_PX)}px)` };
  const horizontal =
    corner === "top-left" || corner === "bottom-left"
      ? { left: `calc(var(--sg-safe-left, 0px) + ${String(SLOT_MARGIN_PX)}px)` }
      : { right: `calc(var(--sg-safe-right, 0px) + ${String(SLOT_MARGIN_PX)}px)` };
  return { ...vertical, ...horizontal };
}

/**
 * The span the safe area leaves on one axis, minus the slot margin at both ends — a PANE-RELATIVE
 * cap, so the whole card stays inside the safe area at the 720×540 viewport floor, where the chart
 * pane is clamped to `--sg-chart-min-width`. A fixed 520 px cap alone overflows the pane there.
 */
function insideSafeArea(near: "left" | "top", far: "right" | "bottom"): string {
  return `calc(100% - var(--sg-safe-${near}, 0px) - var(--sg-safe-${far}, 0px) - ${String(2 * SLOT_MARGIN_PX)}px)`;
}

/** The §3.6 cell shading: fill opacity encodes utilization, clamped to `[0, 1]`. */
export function cellOpacity(ratio: number | null, allocated: number): number {
  if (ratio === null) return allocated > 0 ? 1 : 0;
  return Math.min(1, Math.max(0, ratio));
}

/** Load-chart surfaces judge overload at threshold 1, with the unified epsilon (§2.4). */
export function isOverloadedCell(cell: UtilizationReportCell): boolean {
  return cell.allocated > cell.capacity + OVERLOAD_EPSILON;
}

export interface HeatmapDeps {
  /**
   * The element the card is appended to and positioned against — the chart pane, which publishes
   * the `--sg-safe-*` lengths the slot below is written in terms of.
   */
  mount: HTMLElement;
  /** The corner the `overlay-corner` claim resolved to. */
  corner: HeatmapCorner;
  title: string;
  closeLabel: string;
  rows: () => readonly UtilizationReportRow[];
  cellLabel: (input: LoadChartHeatmapCellInput) => string;
  onClose: () => void;
}

/** An open heatmap card: its element, a data-driven re-render, and removal. */
export interface HeatmapHandle {
  readonly el: HTMLElement;
  refresh(): void;
  dispose(): void;
}

/** Creates and mounts the heatmap card (§3.6). */
export function createHeatmapPanel(deps: HeatmapDeps): HeatmapHandle {
  const doc = deps.mount.ownerDocument;

  const el = doc.createElement("div");
  el.className = "sg-load-heatmap";
  el.setAttribute("role", "region");
  el.setAttribute("aria-label", deps.title);
  Object.assign(el.style, {
    position: "absolute",
    ...slotStyles(deps.corner),
    zIndex: "900",
    maxWidth: `min(520px, ${insideSafeArea("left", "right")})`,
    maxHeight: `min(60%, ${insideSafeArea("top", "bottom")})`,
    display: "flex",
    flexDirection: "column",
    padding: "8px",
    borderRadius: "6px",
    background: "var(--sg-load-heatmap-bg, #ffffff)",
    color: "var(--sg-load-heatmap-fg, #1f2937)",
    border: "1px solid var(--sg-load-heatmap-border, rgba(0, 0, 0, 0.25))",
    boxShadow: "0 4px 16px rgba(0, 0, 0, 0.2)",
    font: "12px system-ui, sans-serif",
    // Unlike the strips (which are inert chrome), the card is interactive.
    pointerEvents: "auto",
  });

  const head = doc.createElement("div");
  Object.assign(head.style, {
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    gap: "8px",
  });
  const title = doc.createElement("div");
  title.className = "sg-load-heatmap__title";
  title.textContent = deps.title;
  title.style.fontWeight = "600";
  const close = doc.createElement("button");
  close.className = "sg-load-heatmap__close";
  close.type = "button";
  close.setAttribute("aria-label", deps.closeLabel);
  close.textContent = "×";
  Object.assign(close.style, {
    // WCAG 2.2 §2.5.8 — a pointer target of at least 24×24 CSS px.
    minWidth: "24px",
    minHeight: "24px",
    border: "none",
    background: "transparent",
    color: "inherit",
    cursor: "pointer",
    font: "inherit",
  });
  close.addEventListener("click", () => deps.onClose());
  head.appendChild(title);
  head.appendChild(close);
  el.appendChild(head);

  const table = doc.createElement("div");
  table.className = "sg-load-heatmap__table";
  table.setAttribute("role", "table");
  table.setAttribute("aria-label", deps.title);
  Object.assign(table.style, { overflow: "auto", marginTop: "6px" });
  // A scrollable region must be reachable and scrollable keyboard-only (WCAG 2.2 §2.1.1): a
  // tabindex puts the scroller in the tab order so arrow keys scroll it. The UA focus ring stays
  // (no outline is suppressed), so focus is visible.
  table.setAttribute("tabindex", "0");
  el.appendChild(table);

  el.addEventListener("keydown", (e: KeyboardEvent) => {
    if (e.key === "Escape") deps.onClose();
  });
  deps.mount.appendChild(el);

  // A programmatic `openHeatmap()` puts focus on the card so its Escape handler is reachable
  // keyboard-only from the moment it opens; the previous holder is restored on close.
  const previousFocus = doc.activeElement;
  el.tabIndex = -1;
  if (typeof (el as { focus?: unknown }).focus === "function") el.focus();

  function refresh(): void {
    table.textContent = "";
    for (const row of deps.rows()) {
      const rowEl = doc.createElement("div");
      rowEl.className = "sg-load-heatmap__row";
      rowEl.setAttribute("role", "row");
      Object.assign(rowEl.style, {
        display: "flex",
        alignItems: "center",
        gap: "1px",
        margin: "1px 0",
      });

      const header = doc.createElement("div");
      header.className = "sg-load-heatmap__rowheader";
      header.setAttribute("role", "rowheader");
      header.textContent = row.resourceName;
      Object.assign(header.style, {
        flex: "0 0 120px",
        overflow: "hidden",
        textOverflow: "ellipsis",
        whiteSpace: "nowrap",
      });
      rowEl.appendChild(header);

      for (const cell of row.cells) {
        const over = isOverloadedCell(cell);
        const cellEl = doc.createElement("div");
        cellEl.className = over
          ? "sg-load-heatmap__cell sg-load-heatmap__cell--over"
          : "sg-load-heatmap__cell";
        cellEl.setAttribute("role", "cell");
        const label = deps.cellLabel({
          start: cell.start,
          end: cell.end,
          allocated: cell.allocated,
          capacity: cell.capacity,
          ratio: cell.ratio,
          resourceName: row.resourceName,
        });
        cellEl.setAttribute("aria-label", label);
        cellEl.setAttribute("title", label);
        Object.assign(cellEl.style, {
          flex: `0 0 ${String(CELL_PX)}px`,
          width: `${String(CELL_PX)}px`,
          height: `${String(CELL_PX)}px`,
          boxSizing: "border-box",
          position: "relative",
        });

        // The shade lives on a child so its opacity never fades the overload glyph or outline.
        const fill = doc.createElement("div");
        fill.className = "sg-load-heatmap__fill";
        Object.assign(fill.style, {
          position: "absolute",
          top: "0",
          left: "0",
          width: "100%",
          height: "100%",
          background: "var(--sg-load-fill, #6f90c0)",
          opacity: String(cellOpacity(cell.ratio, cell.allocated)),
        });
        cellEl.appendChild(fill);

        if (over) {
          cellEl.style.outline = "2px solid var(--sg-load-over-fill, #b3261e)";
          cellEl.style.outlineOffset = "-2px";
          const glyph = doc.createElement("span");
          glyph.className = "sg-load-heatmap__over-glyph";
          glyph.textContent = "!";
          Object.assign(glyph.style, {
            position: "relative",
            display: "block",
            textAlign: "center",
            fontSize: "11px",
            fontWeight: "700",
            lineHeight: `${String(CELL_PX)}px`,
            color: "var(--sg-load-heatmap-fg, #1f2937)",
          });
          cellEl.appendChild(glyph);
        }
        rowEl.appendChild(cellEl);
      }
      table.appendChild(rowEl);
    }
  }

  refresh();
  return {
    el,
    refresh,
    dispose: () => {
      const active = doc.activeElement;
      const held =
        active === el ||
        (active !== null && typeof el.contains === "function" && el.contains(active));
      el.remove();
      // Restore focus only when the card actually held it, and the previous holder is still
      // focusable in the document — never steal focus the reader has since moved elsewhere.
      const prev = previousFocus as { focus?: () => void; isConnected?: boolean } | null;
      if (held && prev !== null && typeof prev.focus === "function" && prev.isConnected !== false) {
        prev.focus();
      }
    },
  };
}
