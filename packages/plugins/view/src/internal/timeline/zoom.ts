/**
 * The time axis itself: which zoom level is active, where content x = 0 sits, and the two
 * conversions between an instant and a horizontal position.
 *
 * Holds no DOM and no host: the composed level list arrives as a callback and a level change is
 * reported through one. That is what makes the anchored-zoom arithmetic — the part a wrong sign
 * would make the chart jump on — testable without booting a chart.
 *
 * Internal: not part of the published surface.
 */
import type { ZoomLevel } from "./index";
import { MS_DAY } from "./scale";

// docs/specs/plugins/view.md
// the omitted-`origin` default.
/** Start of the UTC day containing `now`. */
export function startOfUtcDay(now: number): number {
  return Math.floor(now / MS_DAY) * MS_DAY;
}

// docs/specs/plugins/view.md — rule 3
/**
 * The usability rule for one entry of `TimelineScaleConfig.zoomLevels`: a non-empty string `id`, a
 * finite `pxPerDay` greater than zero, and a non-empty `scales` array. An entry that fails it is
 * skipped; if that leaves the configured array empty, the built-ins are used instead.
 */
export function usableLevel(value: unknown): value is ZoomLevel {
  if (value === null || typeof value !== "object") return false;
  const level = value as Partial<ZoomLevel>;
  return (
    typeof level.id === "string" &&
    level.id !== "" &&
    typeof level.pxPerDay === "number" &&
    Number.isFinite(level.pxPerDay) &&
    level.pxPerDay > 0 &&
    Array.isArray(level.scales) &&
    level.scales.length > 0
  );
}

/** How the axis is set up: the config values that concern it, already read off the host's object. */
export interface ZoomAxisOptions {
  /** `TimelineScaleConfig.origin`; a non-finite or absent value falls back to the current UTC day. */
  origin: number | undefined;
  /** `TimelineScaleConfig.initialZoom`; resolved once, against the composed list (§1.2). */
  initialZoom: string | undefined;
  /** Plugin id, used only in the error messages the axis raises. */
  pluginId: string;
  /** The composed `timeline/zoomLevels` list, read fresh on every use. */
  levels(): ZoomLevel[];
  /**
   * Called after the active level changed, with its index in the composed list (the payload
   * shape). The axis has already moved by then, so a repaint requested here paints the new scale.
   */
  onZoomChanged(index: number): void;
  /**
   * Called after `setOrigin` moved the origin, with the number of content pixels every existing x
   * grew by — `(previousOrigin - nextOrigin) * pxPerMs`, positive when the origin moved earlier.
   * The axis has already moved by then, so the compensating scroll this triggers is measured
   * against the new mapping.
   *
   * Never called for a zoom, which does not move the origin at all.
   */
  onOriginChanged(shiftPx: number): void;
  /**
   * Called by the anchored zoom, with the number of content pixels `scrollLeft` must move by for the
   * anchor to stay under the same point of the chart area. Never 0; positive zooming in and negative
   * zooming out for an anchor at or after the origin, both signs inverted for one before it.
   *
   * The axis has already switched level by then, so the caller's scroll target is measured — and
   * clamped by the renderer — against the new mapping. That clamp is load-bearing at both ends: at
   * 0 it stops a zoom-out at the axis's left edge, and at the content extent it stops a zoom-in
   * anchored past the data from following the anchor into empty space.
   */
  onAnchorScroll(deltaPx: number): void;
}

export interface ZoomAxis {
  /** Content x of an instant: `(t - origin) * pxPerMs`. */
  tToX(t: number): number;
  /** The instant at a content x — the inverse of `tToX`. */
  xToT(x: number): number;
  /** The instant currently placed at content x = 0. */
  origin(): number;
  /**
   * Moves the instant placed at content x = 0 and reports the resulting content shift through
   * `onOriginChanged`, so the caller can compensate the scroll position.
   *
   * A non-finite value, and a value equal to the current origin, are ignored: neither reports a
   * shift.
   */
  setOrigin(ms: number): void;
  /** Pixels per millisecond at the active level. */
  pxPerMs(): number;
  /** The active level, resolving `initialZoom` against the composed list on the first call. */
  currentLevel(): ZoomLevel;
  /**
   * The active level as it reads right now, **without** resolving `initialZoom`.
   *
   * For a reader that needs a value before the ladder is complete — seeding the published store at
   * setup, where only this plugin's own levels have been contributed. Calling `currentLevel()`
   * there would latch the resolution against that partial list and permanently lose a level
   * another plugin is about to contribute.
   */
  peekLevel(): ZoomLevel;
  /**
   * Activates the level named `id`, keeping `anchorTime` under the same point of the chart area
   * when one is given.
   *
   * Throws when no composed level carries that id. A no-op when the level is already active — no
   * event, no repaint.
   */
  setZoomLevel(id: string, anchorTime?: number): void;
  /**
   * One notch of the Ctrl+wheel gesture: switches to the next level by density — finer for a
   * negative `deltaY`, coarser otherwise — keeping the instant under the pointer in place.
   *
   * Does nothing when the gesture would leave the level range, or when the active level is not in
   * the composed list at all. `contentX` is asked for the pointer's content x only once a level
   * change is certain, so a notch at either end of the range costs no layout measurement.
   */
  zoomByWheel(deltaY: number, contentX: () => number): void;
  /**
   * One step of the command-driven zoom: switches to the next level by density — finer for
   * `"in"`, coarser for `"out"` — keeping `anchorTime` under the same point of the chart area when
   * one is given.
   *
   * Does nothing when the step would leave the level range, or when the active level is not in
   * the composed list at all. The same density ordering the Ctrl+wheel gesture uses, so the two
   * inputs always agree on what "in" means.
   */
  stepZoom(direction: "in" | "out", anchorTime?: number): void;
}

/**
 * Creates the axis: the origin, the active-level resolution and the anchored zoom.
 *
 * `origin` is the axis's only mutable anchor. `tToX` is a *content* coordinate (the viewport's
 * `scrollLeft` is render-owned). Day-aligning the default origin keeps day boundaries
 * on multiples of `pxPerDay`, which the header grid assumes.
 *
 * The origin moves for exactly one reason: `setOrigin`, i.e. a deliberate decision about where the
 * axis begins. It never moves for a zoom. An anchored zoom holds its anchor with the scroll instead
 * (`onAnchorScroll`), which is bounded on both sides by the renderer's clamp; letting the zoom move
 * the origin is what once made repeated zooming walk the axis away from the data without bound.
 * `setOrigin` shifts every existing x, so the caller compensates the scroll by the same distance —
 * which is what `onOriginChanged` reports.
 */
export function createZoomAxis(options: ZoomAxisOptions): ZoomAxis {
  const { pluginId, levels, onZoomChanged, onOriginChanged, onAnchorScroll } = options;
  const configuredOrigin = options.origin;
  const configuredInitialZoom = options.initialZoom;

  /** `x = (t - origin) * pxPerMs`. */
  let origin: number =
    configuredOrigin !== undefined && Number.isFinite(configuredOrigin)
      ? configuredOrigin
      : startOfUtcDay(Date.now());
  /** `null` until `initialZoom` resolves or an explicit `setZoomLevel`; resolves to the first level. */
  let currentId: string | null = null;
  // docs/specs/plugins/view.md — `initialZoom` is resolved exactly once, against
  // the composed `timeline/zoomLevels` list as it reads at startup. Deferring to the first read
  // rather than resolving at setup is what lets a level contributed by another plugin be named: at
  // setup time only this plugin's own levels have been registered.
  let initialZoomPending = configuredInitialZoom !== undefined;

  /** The level `currentId` names, else the named `initialZoom`, else the first entry. */
  function resolveFrom(list: readonly ZoomLevel[], useInitial: boolean): ZoomLevel {
    if (currentId !== null) {
      for (const level of list) if (level.id === currentId) return level;
    }
    if (useInitial) {
      for (const level of list) if (level.id === configuredInitialZoom) return level;
    }
    const head = list[0];
    if (head === undefined) throw new Error(`${pluginId}: no zoom levels are registered`);
    return head;
  }

  function peekLevel(): ZoomLevel {
    return resolveFrom(levels(), initialZoomPending);
  }

  function currentLevel(): ZoomLevel {
    const list = levels();
    if (initialZoomPending && list.length > 0) {
      initialZoomPending = false;
      // silent fallback: an id no registered level carries leaves `currentId` null, i.e. the
      // first entry wins — the same treatment `origin` gives an unusable value. No throw, no
      // `core/pluginError`, nothing logged.
      if (list.some((level) => level.id === configuredInitialZoom)) {
        currentId = configuredInitialZoom ?? null;
      }
    }
    return resolveFrom(list, false);
  }

  function pxPerMs(): number {
    return currentLevel().pxPerDay / MS_DAY;
  }

  function tToX(t: number): number {
    return (t - origin) * pxPerMs();
  }

  function xToT(x: number): number {
    return origin + x / pxPerMs();
  }

  // docs/specs/plugins/view.md — the origin became settable so that content left of
  // it (a plan that started before the default "start of today") stops being unreachable: the
  // renderer clamps `scrollLeft` at 0, so a negative content x cannot be scrolled to by any gesture.
  function setOrigin(ms: number): void {
    if (typeof ms !== "number" || !Number.isFinite(ms)) return;
    if (ms === origin) return;
    const previous = origin;
    origin = ms;
    // Every content x is `(t - origin) * pxPerMs`, so lowering the origin by Δt raises every x by
    // `Δt * pxPerMs`. Reported after the move, so the caller's compensating scroll and the extent
    // it is clamped against are both measured on the new mapping.
    onOriginChanged((previous - ms) * pxPerMs());
  }

  function setZoomLevel(id: string, anchorTime?: number): void {
    const list = levels();
    const index = list.findIndex((level) => level.id === id);
    const next = index < 0 ? undefined : list[index];
    if (next === undefined) throw new Error(`${pluginId}: unknown zoom level "${id}"`);
    const previous = currentLevel();
    if (next === previous) return;

    // docs/specs/plugins/view.md — the anchor stays under the same point of the
    // chart area while `pxPerMs` changes, and the *scroll* is what holds it there. The origin does
    // not take part: it is the instant at content x = 0 and nothing reaches left of it, so a zoom
    // that moved it would either strand earlier content (moving it later) or accumulate unbounded
    // dead space (moving it earlier, once per zoom, never recovered).
    const before = previous.pxPerDay / MS_DAY;
    const after = next.pxPerDay / MS_DAY;
    let anchorScrollPx = 0;
    if (anchorTime !== undefined && Number.isFinite(anchorTime) && after > 0 && before > 0) {
      // The anchor's content x is `(anchorTime - origin) * pxPerMs`, so this is exactly how far it
      // travels across the density change — and therefore how far `scrollLeft` must follow it.
      // Negative when zooming out, where the renderer's clamp at 0 is what stops the view at the
      // axis's left edge instead of scrolling into content that does not exist.
      anchorScrollPx = (anchorTime - origin) * (after - before);
    }
    currentId = next.id;
    // After the level switch, so the caller's scroll target — and the extent the renderer clamps it
    // against — are both measured on the new mapping.
    if (anchorScrollPx !== 0) onAnchorScroll(anchorScrollPx);

    // the payload is `{ level: number }` while ids are strings; the index in the registered
    // level list is the only number available.
    onZoomChanged(index);
  }

  // Memoised on the composed list's reference (the same pattern as the renderer's
  // `createLayerOrder`): `levels()` is reference-stable while the contribution set is unchanged,
  // and a wheel gesture delivers many notches per second — cloning and sorting the level list per
  // notch was allocation for a value that only changes when levels are (re)contributed.
  let densitySource: readonly ZoomLevel[] | null = null;
  let densitySorted: readonly ZoomLevel[] = [];
  function levelsByDensity(): readonly ZoomLevel[] {
    const list = levels();
    if (list !== densitySource) {
      densitySource = list;
      densitySorted = list.slice().sort((a, b) => a.pxPerDay - b.pxPerDay);
    }
    return densitySorted;
  }

  /** The next level by px-per-day density, or `undefined` at either end of the range. */
  function nextByDensity(direction: "in" | "out"): ZoomLevel | undefined {
    const current = currentLevel();
    // Ordered by density rather than by contribution order, so "in" always means a finer scale
    // regardless of the order levels were contributed in.
    const byDensity = levelsByDensity();
    const i = byDensity.indexOf(current);
    if (i < 0) return undefined;
    return byDensity[direction === "in" ? i + 1 : i - 1];
  }

  function zoomByWheel(deltaY: number, contentX: () => number): void {
    const next = nextByDensity(deltaY < 0 ? "in" : "out");
    if (next === undefined) return;
    setZoomLevel(next.id, xToT(contentX()));
  }

  // docs/specs/plugins/view.md — the `timeline/zoomIn` /
  // `timeline/zoomOut` commands step the same density-ordered ladder the wheel gesture walks.
  function stepZoom(direction: "in" | "out", anchorTime?: number): void {
    const next = nextByDensity(direction);
    if (next === undefined) return;
    setZoomLevel(next.id, anchorTime);
  }

  return {
    tToX,
    xToT,
    origin: () => origin,
    setOrigin,
    pxPerMs,
    currentLevel,
    peekLevel,
    setZoomLevel,
    zoomByWheel,
    stepZoom,
  };
}
