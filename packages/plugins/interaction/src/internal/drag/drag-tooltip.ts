// docs/specs/plugins/interaction.md §6.2 "dragTooltip" — a small DOM readout of the dates a release
// would commit, following the drag.
/**
 * The drag tooltip element: created lazily on first show, repositioned per move, hidden between
 * drags and removed when the plugin is disposed. The caller supplies the document and the pane;
 * nothing else of the host is touched, so the manager is exercisable against a fake DOM.
 */
import { styled } from "@stargantt/sdk";

/** The tooltip's element class, the hook a host stylesheet can restyle it by. */
export const DRAG_TOOLTIP_CLASS = "sg-drag-tooltip";

/** How far above the anchor point the tooltip's bottom sits, in CSS pixels. */
export const DRAG_TOOLTIP_GAP_PX = 8;

/** Where one `show` call anchors the tooltip, in pane-local CSS pixels. */
export interface DragTooltipAnchor {
  /** The pointer's x — the tooltip's preferred left edge, clamped into the pane. */
  readonly x: number;
  /** The y the tooltip's bottom sits `DRAG_TOOLTIP_GAP_PX` above — the dragged bar's top. */
  readonly yAbove: number;
  /** The top used instead when there is no room above — just under the dragged bar. */
  readonly yBelow: number;
  /** The pane's usable width, the right clamp bound. */
  readonly paneWidth: number;
}

/** The drag tooltip: show it with fresh text and position, hide it, or tear it down. */
export interface DragTooltip {
  /** Shows the tooltip reading `text`, positioned around `anchor` so it stays inside the pane. */
  show(text: string, anchor: DragTooltipAnchor): void;
  /** Hides the tooltip without destroying it, ready for the next drag. */
  hide(): void;
  /** Removes the element. The single disposal path — registered once with `ctx.own()`. */
  dispose(): void;
}

/** Creates the (initially empty) tooltip manager for one chart pane. */
export function createDragTooltip(doc: Document, pane: HTMLElement): DragTooltip {
  let el: HTMLElement | null = null;
  // The last measured readout, so `show` re-reads offsetWidth/offsetHeight (a forced layout) only
  // when the text actually changed — the date strings change per snapped step, while `show` runs
  // per pointer move, and measuring every move would thrash layout inside the drag frame budget.
  let lastText: string | null = null;
  let lastWidth = 0;
  let lastHeight = 0;

  function ensure(): HTMLElement {
    if (el !== null) return el;
    const node = doc.createElement("div");
    node.className = DRAG_TOOLTIP_CLASS;
    styled(node, {
      position: "absolute",
      pointerEvents: "none",
      zIndex: "10",
      padding: "2px 6px",
      borderRadius: "3px",
      font: "12px system-ui, sans-serif",
      whiteSpace: "nowrap",
      // White on near-black: 15.9:1, comfortably past the 4.5:1 text minimum in both schemes.
      background: "rgba(32, 32, 32, 0.92)",
      color: "#ffffff",
      display: "none",
    });
    pane.appendChild(node);
    el = node;
    return node;
  }

  return {
    show(text, anchor): void {
      const node = ensure();
      if (text !== lastText) {
        node.textContent = text;
        node.style.display = "block";
        // Measured after the text and display are set, so the box reflects this readout — and
        // before positioning, so the clamps below use the real size. Cached until the text
        // changes: the box's size depends only on its text.
        lastWidth = node.offsetWidth;
        lastHeight = node.offsetHeight;
        lastText = text;
      } else {
        node.style.display = "block";
      }
      const width = lastWidth;
      const height = lastHeight;
      // Above the bar so it and its handles stay unobscured; when the first visible row leaves no
      // room above, the readout flips below the bar instead of being clipped past the pane's top.
      const above = anchor.yAbove - DRAG_TOOLTIP_GAP_PX - height;
      node.style.top = `${above >= 0 ? above : anchor.yBelow}px`;
      // Clamped into the pane on both sides, so an edge drag keeps the whole readout visible.
      node.style.left = `${Math.min(Math.max(0, anchor.x), Math.max(0, anchor.paneWidth - width))}px`;
    },
    hide(): void {
      if (el !== null) el.style.display = "none";
      lastText = null;
    },
    dispose(): void {
      el?.remove();
      el = null;
      lastText = null;
    },
  };
}
