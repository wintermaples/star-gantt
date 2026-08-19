// docs/specs/plugins/interaction.md §1.3 (`rubber-band`)
/**
 * Pure geometry helpers for rubber-band selection: turning a drag's origin/current point pair into
 * a normalized rectangle, and testing that rectangle against bar boxes. Kept separate from canvas
 * painting so both can be unit-tested without a renderer or a real canvas.
 */
import type { Rect } from "./paint";

/** The two corners a rubber-band drag has produced so far, in viewport-local CSS pixels. */
export interface DragCorners {
  originX: number;
  originY: number;
  curX: number;
  curY: number;
}

/**
 * Normalizes a drag's origin/current point pair into a rectangle with a non-negative width and
 * height, regardless of which direction the pointer moved.
 */
export function normalizeRect(corners: Readonly<DragCorners>): Rect {
  const x = Math.min(corners.originX, corners.curX);
  const y = Math.min(corners.originY, corners.curY);
  const width = Math.abs(corners.curX - corners.originX);
  const height = Math.abs(corners.curY - corners.originY);
  return { x, y, width, height };
}

/** Whether two axis-aligned rectangles overlap (touching edges do not count as overlap). */
export function rectsIntersect(a: Readonly<Rect>, b: Readonly<Rect>): boolean {
  return a.x < b.x + b.width && a.x + a.width > b.x && a.y < b.y + b.height && a.y + a.height > b.y;
}
