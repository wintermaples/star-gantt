// docs/specs/plugins/view.md — internal; not part of the published surface.
/**
 * The scrollable range: the content extent reduction and the per-axis clamp.
 *
 * Pure, so the clamp arithmetic every scroll path shares — wheel, `RendererService.scrollTo`, the
 * thumb drag and the re-clamp on shrink — is testable without a host.
 */
import type { ContentExtentContribution } from "./index";

/** The resolved content size per axis; `undefined` on an axis nothing reports a finite value for. */
export interface ContentExtent {
  readonly width: number | undefined;
  readonly height: number | undefined;
}

/** The extent of a composition that contributes nothing: both axes unbounded. */
export const UNBOUNDED: ContentExtent = { width: undefined, height: undefined };

/**
 * Reduces `renderer/contentExtent` contributions to one extent per axis: the maximum of the finite
 * values they currently report.
 *
 * Every contribution's `measure` is called on every reduction and nothing is cached across calls,
 * because the content size tracks live data. Each call is guarded individually: a throwing `measure`
 * is reported through `onFault` and contributes nothing to either axis, and the reduction proceeds
 * with the remaining contributions.
 */
// docs/specs/plugins/view.md
export function resolveContentExtent(
  contributions: readonly ContentExtentContribution[] | undefined,
  onFault: (error: unknown) => void,
): ContentExtent {
  let width: number | undefined;
  let height: number | undefined;
  for (const contribution of contributions ?? []) {
    if (typeof contribution !== "object" || contribution === null) continue;
    if (typeof contribution.measure !== "function") continue;
    let result: { width?: number; height?: number } | undefined;
    try {
      result = contribution.measure();
    } catch (error) {
      onFault(error);
      continue;
    }
    if (typeof result !== "object" || result === null) continue;
    const w = result.width;
    if (typeof w === "number" && Number.isFinite(w)) width = width === undefined ? w : Math.max(width, w);
    const h = result.height;
    if (typeof h === "number" && Number.isFinite(h)) height = height === undefined ? h : Math.max(height, h);
  }
  return { width, height };
}

/**
 * Clamps a scroll offset to `[0, max(0, extent − viewportSize)]`.
 *
 * `extent === undefined` leaves the axis unbounded above, which is what keeps the renderer usable in
 * a composition that contributes no extent at all.
 */
// docs/specs/plugins/view.md
export function clampAxis(value: number, extent: number | undefined, viewportSize: number): number {
  const lower = Math.max(0, value);
  if (extent === undefined) return lower;
  return Math.min(lower, Math.max(0, extent - viewportSize));
}

/** The part of a `WheelEvent` the chart pane's scroll arithmetic reads. */
export interface WheelInput {
  readonly deltaX: number;
  readonly deltaY: number;
  readonly shiftKey: boolean;
}

/** A wheel notch resolved to a signed displacement per axis, in CSS pixels. */
export interface WheelDelta {
  readonly dx: number;
  readonly dy: number;
}

/**
 * Resolves a wheel notch to the displacement the chart pane applies.
 *
 * Shift+wheel is the desktop convention for scrolling horizontally, but the browser implements it
 * inside its own scroller: the event a listener receives still reports the notch on `deltaY`. The
 * pane owns its scroll entirely, so it performs that swap itself. An event that already carries a
 * horizontal component of its own — a trackpad, a tilt wheel, an engine that swaps the axes before
 * dispatch — is left alone, which is what keeps this idempotent rather than swapping twice.
 */
// docs/specs/plugins/view.md
export function resolveWheelDelta(e: WheelInput): WheelDelta {
  if (e.shiftKey && e.deltaX === 0) return { dx: e.deltaY, dy: 0 };
  return { dx: e.deltaX, dy: e.deltaY };
}
