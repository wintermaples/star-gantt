// docs/specs/plugins/view.md
/**
 * A side pane's `role="separator"` divider: the element itself, and the pointer-drag plus
 * keyboard resize behaviour hung on it.
 *
 * Split out of the module root so the mount loop stays readable; the clamp, the width write and
 * the collapse toggle stay with the module that owns the pane bookkeeping and are passed in.
 */
import type { PluginContext } from "@stargantt/core";
import { listen } from "@stargantt/sdk";
import { CLICK_THRESHOLD_PX } from "./drag-owner";
import type { DragOwner } from "./drag-owner";

/**
 * Bookkeeping the panes module needs per mounted pane: enough to clamp
 * resize (pointer or keyboard) to `[minWidth, maxWidth]` and the chart pane's floor, to keep the
 * divider's `aria-value*` attributes in sync, and — for a `collapsible` pane — to collapse it to
 * zero width and restore the width it had before collapsing, from either the divider's boundary
 * click/`Enter`/`Space` or the `view/paneToggle` command.
 */
export interface PaneState {
  el: HTMLElement;
  min: number;
  max: number;
  collapsible: boolean;
  collapsed: boolean;
  /** The pane's current (if expanded) or last-known-before-collapse (if collapsed) width. */
  width: number;
  onResize: ((width: number) => void) | undefined;
  /** The pane's `role="separator"` divider, if `resizable !== false`; used to keep its
   * `aria-value*` attributes in sync. `undefined` when the pane rendered no divider. */
  divider: HTMLElement | undefined;
}

/** Everything `createPaneDivider` needs to build one divider element. */
export interface PaneDividerInput {
  doc: Document;
  state: PaneState;
  side: "left" | "right";
  /** `false` when the contribution opted out of resizing — no separator is rendered at all. */
  resizable: boolean;
  /** The contribution's accessible name for the divider; blank counts as absent. */
  label: string | undefined;
}

/**
 * Creates the divider element for a pane, or `null` when the contribution opted out of resizing
 * (`resizable: false`) — in which case no separator is rendered at all.
 *
 * The element is only built here; `armPaneDivider` attaches the behaviour once the module has
 * inserted it into the pane row.
 */
export function createPaneDivider(input: PaneDividerInput): HTMLElement | null {
  const { doc, state, side, resizable, label } = input;
  if (!resizable) return null;
  const divider = doc.createElement("div");
  divider.className = "sg-pane-divider";
  // Which neighbor is the contributed pane. The stylesheet needs it to place the hit
  // band's slack on the chart side across the pane's header strip, so the band cannot cover
  // a control the pane puts at its own inner edge (`tree-grid`'s column-resize handles).
  divider.setAttribute("data-side", side === "left" ? "left" : "right");
  // docs/specs/plugins/view.md — a focusable named separator. Its `aria-value*` attributes are
  // written by the module's `updateAria`, once `state.divider` below makes the pane's state
  // reachable from it.
  divider.setAttribute("role", "separator");
  divider.setAttribute("aria-orientation", "vertical");
  // A blank label counts as absent, matching the bottom region's treatment of the same
  // field: a tabbable separator must never end up unnamed, so the empty string does not
  // suppress text here the way it does for visible catalog strings (docs/specs/plugins/view.md).
  divider.setAttribute("aria-label", label?.trim() || "Resize pane");
  divider.tabIndex = 0;
  state.divider = divider;
  return divider;
}

/** The seams `armPaneDivider` calls back into — the pane bookkeeping stays in the module root. */
export interface PaneDividerBehavior {
  ctx: PluginContext;
  divider: HTMLElement;
  state: PaneState;
  side: "left" | "right";
  dragOwner: DragOwner;
  clampBounds(state: PaneState): { min: number; max: number };
  applyWidth(state: PaneState, width: number): void;
  setCollapsed(state: PaneState, target: boolean): void;
  paneWidth(state: PaneState): number;
}

/** Attaches the pointer-drag and keyboard resize/collapse behaviour to a divider. */
export function armPaneDivider(deps: PaneDividerBehavior): void {
  const { ctx, divider, state, side, dragOwner, clampBounds, applyWidth, setCollapsed, paneWidth } =
    deps;
  // Dragging resizes the adjacent contributed pane, clamped to [minWidth, maxWidth] and
  // the width at which the chart pane would be pushed below its own minimum; the
  // chart pane (the flex-growing member) absorbs the remaining width. A press that releases
  // without crossing the click threshold is a boundary click: see the `pointerup`
  // handler in `installDocListeners`, which toggles collapse for a `collapsible` pane.
  listen(ctx, divider, "pointerdown", (e: PointerEvent) => {
    // The plugin's own width state, not a measured rect: the keyboard steps also start
    // from state (`state.width`; the `paneWidth` helper only differs for a collapsed
    // pane), and two parallel measurements diverge exactly when it matters (under
    // container pressure, where CSS has shrunk the pane below its remembered width).
    const startWidth = paneWidth(state);
    // Captured for the Escape revert: the remembered width and collapse state as they were
    // before the drag, so a cancel restores them exactly.
    const startRemembered = state.width;
    const startCollapsed = state.collapsed;
    // The effective upper clamp for this drag, captured once at `pointerdown` —
    // see the `clampBounds` doc comment for why it stays constant for the whole drag.
    const max = clampBounds(state).max;
    const startX = e.clientX;
    const sign = side === "left" ? 1 : -1;
    /** Set once pointer travel exceeds `CLICK_THRESHOLD_PX`, ruling out a boundary click. */
    let moved = false;
    const claimed = dragOwner.claim({
      pointerId: e.pointerId,
      move: (ev) => {
        const dx = ev.clientX - startX;
        if (Math.abs(dx) >= CLICK_THRESHOLD_PX) moved = true;
        // docs/specs/plugins/view.md — until the travel threshold is crossed, the press is still
        // a candidate boundary click, so the pane's width (notably the remembered pre-collapse
        // width of a collapsed pane, whose rendered start width is 0) must not be overwritten and
        // `onResize` must not fire for what pointerup will classify as a collapse/expand click.
        if (!moved) return;
        // docs/specs/plugins/view.md — clamp to [minWidth, max];
        // an omitted maxWidth and no determinable chart floor together carry through as
        // +Infinity, leaving the upper end unbounded. `applyWidth` clears a stale
        // `collapsed` flag (dragging a collapsed pane's divider outward must desync it
        // from the rendered nonzero width, so a later `view/paneToggle { collapsed: true }`
        // isn't an early-return no-op), refreshes the divider's `aria-value*` attributes,
        // and fires the guarded `onResize`.
        applyWidth(state, Math.min(max, Math.max(state.min, startWidth + sign * dx)));
      },
      // A press that never moved past the click threshold is a boundary click,
      // toggling collapse on a `collapsible` pane.
      up: () => {
        if (!moved) setCollapsed(state, !state.collapsed);
      },
      // Escape mid-drag: full revert (gantt-ui-ux checklist). A sub-threshold press applied
      // nothing, so only a moved drag has anything to restore; a pane that started
      // collapsed goes back to collapsed with its remembered width intact.
      cancel: () => {
        if (!moved) return;
        if (startCollapsed) {
          state.width = startRemembered;
          setCollapsed(state, true);
        } else {
          applyWidth(state, startWidth);
        }
      },
    });
    if (!claimed) return;
    // Keeps move/up events flowing to this document even when the pointer crosses an
    // iframe or leaves the window mid-drag. Guarded: capture is best-effort only.
    try {
      divider.setPointerCapture(e.pointerId);
    } catch {
      /* pointer already gone — the pointercancel listener releases the drag */
    }
  });

  // docs/specs/plugins/view.md — keyboard resize/collapse, routed through the same clamp as the
  // drag. Which arrow grows the pane depends on the
  // pane's side — the arrow that moves the divider outward (away from the chart pane).
  const growKey = side === "left" ? "ArrowRight" : "ArrowLeft";
  const shrinkKey = side === "left" ? "ArrowLeft" : "ArrowRight";
  listen(ctx, divider, "keydown", (e: KeyboardEvent) => {
    if (e.key === growKey || e.key === shrinkKey) {
      // A key the divider handles must not also trigger an in-chart binding on the same key
      // (e.g. `stargantt.keyboard-a11y`'s row navigation, which listens on `ctx.root`) or
      // scroll the page — hence both `preventDefault` and `stopPropagation`.
      e.preventDefault();
      e.stopPropagation();
      const step = e.shiftKey ? 64 : 16;
      const delta = e.key === growKey ? step : -step;
      const { min, max } = clampBounds(state);
      applyWidth(state, Math.min(max, Math.max(min, state.width + delta)));
    } else if (e.key === "Home" || e.key === "End") {
      e.preventDefault();
      e.stopPropagation();
      const { min, max } = clampBounds(state);
      applyWidth(state, e.key === "Home" ? min : max);
    } else if ((e.key === "Enter" || e.key === " ") && state.collapsible) {
      e.preventDefault();
      e.stopPropagation();
      setCollapsed(state, !state.collapsed);
    }
  });
}
