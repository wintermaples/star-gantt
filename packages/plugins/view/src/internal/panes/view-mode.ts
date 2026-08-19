/**
 * View-mode layout planning — pure, hostless (`.claude/skills/gantt-ui-ux/references/code-quality.md`
 * §1): given a view mode and the mounted panes' sides, decides which elements are visible and which
 * pane, if any, grows to fill the width the hidden chart pane frees. The DOM writes stay in the
 * plugin's setup wiring; this module owns only the decision.
 */
// docs/specs/plugins/view.md — "View modes"

/**
 * How the root's flex row presents the chart pane and the contributed side panes.
 *
 * - `"split"` — the default: side panes and the chart pane share the row, exactly as without any
 * view mode at all.
 * - `"grid"` — table view: only the left-side panes (the spreadsheet-like table) are shown; the
 * chart pane and every right-side pane are hidden and the innermost left pane grows to fill the
 * freed width.
 * - `"gantt"` — chart view: every contributed pane is hidden and the chart pane fills the row.
 */
export type ViewMode = "split" | "grid" | "gantt";

/** Parses an untrusted mode value; anything but the three literal modes yields `null`. */
export function parseViewMode(value: unknown): ViewMode | null {
  return value === "split" || value === "grid" || value === "gantt" ? value : null;
}

/** The one property of a mounted pane the planner needs: which side of the chart it sits on. */
export interface PaneSlot {
  side: "left" | "right";
}

/** The planner's verdict: what to hide and which pane (by index) grows, `-1` for none. */
export interface ModeLayout {
  /** `true` hides the renderer's chart pane. */
  chartHidden: boolean;
  /** Per mounted pane (same order as the input): `true` hides the pane and its divider. */
  paneHidden: boolean[];
  /**
   * `true` hides every divider, including those of visible panes: outside split view the visible
   * region's width is fluid (a pane is flex-growing), so a fixed-width divider drag has nothing
   * meaningful to resize.
   */
  dividersHidden: boolean;
  /**
   * Index (into the input array) of the pane that receives `flex: 1 1 auto` so it absorbs the
   * hidden chart pane's width — the innermost left pane in `"grid"` mode; `-1` otherwise.
   */
  growIndex: number;
}

/**
 * Plans the layout for `mode` over the mounted panes, in mount order (left panes first, outermost
 * to innermost, then right panes innermost to outermost — the order the plugin mounts them).
 *
 * Returns `null` when the mode is inapplicable to this composition: `"grid"` with no left-side
 * pane has no table to show, so the switch must be a no-op rather than a blank chart.
 */
export function layoutFor(mode: ViewMode, panes: readonly PaneSlot[]): ModeLayout | null {
  if (mode === "split") {
    return {
      chartHidden: false,
      paneHidden: panes.map(() => false),
      dividersHidden: false,
      growIndex: -1,
    };
  }
  if (mode === "gantt") {
    return {
      chartHidden: false,
      paneHidden: panes.map(() => true),
      dividersHidden: true,
      growIndex: -1,
    };
  }
  // "grid": show left panes only; the innermost (last) left pane grows.
  let growIndex = -1;
  for (let i = 0; i < panes.length; i += 1) {
    if (panes[i]!.side === "left") growIndex = i;
  }
  if (growIndex === -1) return null;
  return {
    chartHidden: true,
    paneHidden: panes.map((p) => p.side !== "left"),
    dividersHidden: true,
    growIndex,
  };
}
