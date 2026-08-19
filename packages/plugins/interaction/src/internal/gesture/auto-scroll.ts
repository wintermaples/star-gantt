// docs/specs/plugins/interaction.md §6.2 "autoScroll" — dragging a bar to within an edge zone of
// the chart pane scrolls the view, so a drop target beyond the current viewport is reachable
// without releasing.
/**
 * The auto-scroll arithmetic: how fast a pointer parked near a pane edge scrolls the view. Pure
 * numbers in, pixels-per-frame out — the drag controller owns the animation-frame loop.
 */

/** How close to a pane edge the pointer must be before auto-scroll engages, in CSS pixels. */
export const AUTO_SCROLL_ZONE_PX = 32;

/** The fastest auto-scroll advances, in CSS pixels per animation frame. */
export const AUTO_SCROLL_MAX_PX = 20;

/**
 * The horizontal scroll a pointer at viewport-local `x` in a pane `width` wide asks for, in signed
 * CSS pixels per frame: 0 outside the edge zones, ramping linearly to the maximum at the very edge.
 * Negative scrolls left. A degenerate pane (width not above twice the zone) never scrolls, so a
 * tiny pane cannot oscillate between its two zones.
 */
export function edgeVelocity(
  x: number,
  width: number,
  zone = AUTO_SCROLL_ZONE_PX,
  max = AUTO_SCROLL_MAX_PX,
): number {
  if (!(width > zone * 2)) return 0;
  if (x < zone) return -max * Math.min(1, (zone - x) / zone);
  if (x > width - zone) return max * Math.min(1, (x - (width - zone)) / zone);
  return 0;
}
