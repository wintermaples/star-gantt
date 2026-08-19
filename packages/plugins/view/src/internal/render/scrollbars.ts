// docs/specs/plugins/view.md — internal; not part of the published surface.
/**
 * The synthetic scrollbars: geometry, the active-style linger, and the thumb drag.
 *
 * One module for the whole feature — creation, per-frame update and drag handling — so enabling,
 * disabling or reasoning about scrollbars means reading one file rather than four regions of the
 * plugin's `setup()`. The geometry itself is pure and unit-testable on its own.
 */
import { createScrollbar, scrollbarAxisClass } from "./dom";
import { capturePointer, releasePointer } from "./pointer";
import type { ScrollbarAxis } from "./dom";
import type { PointerClaim } from "./pointer";
import type { ContentExtent } from "./scroll";
import type { ResolvedInsets, Viewport } from "./index";

/** Smallest thumb size (CSS px) so it stays grabbable at large extents. */
export const SCROLLBAR_MIN_THUMB = 24;
/** How long the active (scroll-in-progress) style lingers after the last movement. */
export const SCROLLBAR_LINGER_MS = 300;
/** Gap (CSS px) between a bar and the body edge it hugs; mirrors the stylesheet's offset. */
export const SCROLLBAR_EDGE_GAP = 2;
/**
 * A bar's cross-axis thickness (CSS px); mirrors the stylesheet's `.sg-scrollbar--vertical` width
 * and `.sg-scrollbar--horizontal` height.
 *
 * Only the safe area (`safearea.ts`) needs the number in TS — the bars themselves are sized by the
 * stylesheet — and ruled out publishing it as a theme token, since a registry token is a
 * host-writable input and this thickness is one the bars' pointer geometry cannot re-derive
 * from.
 */
export const SCROLLBAR_TRACK_THICKNESS = 8;

/** The geometry one frame resolved for a bar, and the numbers a drag maps through. */
export interface ThumbGeometry {
  /** Track length along the bar's axis (CSS px). */
  readonly trackSize: number;
  /** Thumb length along the same axis (CSS px). */
  readonly thumbSize: number;
  /** Thumb offset from the track's leading edge (CSS px). */
  readonly thumbOffset: number;
  /** The axis's maximum scroll offset — `contentExtent − viewport size`. */
  readonly maxScroll: number;
}

/**
 * One axis's thumb geometry, or `null` when that axis is not scrollable and its bar is hidden.
 *
 * `thumbSize` is `track × view / content`, floored at a built-in minimum so the thumb stays
 * grabbable at large extents, and `thumbOffset` is `(track − thumb) × scroll / maxScroll`.
 */
// docs/specs/plugins/view.md
export function thumbGeometry(
  trackSize: number,
  view: number,
  content: number | undefined,
  scroll: number,
): ThumbGeometry | null {
  if (content === undefined || content <= view) return null;
  const rawThumb = (trackSize * view) / content;
  const thumbSize = Math.min(trackSize, Math.max(SCROLLBAR_MIN_THUMB, rawThumb));
  const maxScroll = Math.max(0, content - view);
  const thumbOffset = maxScroll > 0 ? ((trackSize - thumbSize) * scroll) / maxScroll : 0;
  return { trackSize, thumbSize, thumbOffset, maxScroll };
}

/**
 * The scroll offset a thumb dragged to `pointer` maps to, or `null` when the thumb fills its track
 * and therefore cannot express a position.
 *
 * `grab` is the offset from the thumb's leading edge to the press point; this is the exact inverse of
 * `thumbGeometry`'s offset formula, and the caller's clamp is what pins a drag past either
 * end at that end.
 */
// docs/specs/plugins/view.md
export function scrollFromThumb(
  pointer: number,
  grab: number,
  geometry: ThumbGeometry,
): number | null {
  const span = geometry.trackSize - geometry.thumbSize;
  if (span <= 0) return null;
  return ((pointer - grab) * geometry.maxScroll) / span;
}

/** Everything one frame's bar update reads. */
export interface ScrollbarViewState {
  readonly vp: Readonly<Viewport>;
  readonly insets: ResolvedInsets;
  readonly extent: ContentExtent;
}

export interface ScrollbarsDeps {
  /** The chart pane: the bars are appended here, over everything else in it. */
  pane: HTMLElement;
  /** `false` suppresses both bars entirely (`RendererConfig.scrollbar`). */
  enabled: boolean;
  // docs/specs/plugins/view.md — the bars are renderer-owned chrome and
  // must mirror for RTL; they are absolutely positioned with physical offsets, so the `dir`
  // attribute alone cannot mirror them and the geometry mirrors here instead.
  /** The chart's base text direction; `"rtl"` mirrors the bars' placement and thumb travel. */
  direction: "ltr" | "rtl";
  claim: PointerClaim;
  /** The scroll position, viewport and extent the current frame resolved. */
  viewState(): ScrollbarViewState;
  /** Writes a scroll offset to one axis through the plugin's single scroll path. */
  scrollAxisTo(axis: ScrollbarAxis, offset: number): void;
  /**
   * Asks for a paint pass without dirtying a canvas.
   *
   * Called when a drag hands the pointer claim back, because the pointer position recorded just
   * before the press was left unresolved for as long as the drag held the claim; without a pass the
   * cursor and `pointer/barHover` would wait for the next pointer movement.
   */
  scheduleFrame(): void;
  /** Attaches a listener whose removal the core owns. */
  listen(el: HTMLElement | Document, type: "pointerdown" | "pointermove" | "pointerup" | "pointercancel", fn: (e: PointerEvent) => void): void;
  /** Hands a resource's disposal to the core. */
  own(dispose: () => void): void;
}

export interface Scrollbars {
  /** Recomputes both bars' visibility, geometry and active style from the current view state. */
  update(): void;
  /** Marks a scroll in progress and (re)arms the linger that fades the active style back out. */
  noteActivity(): void;
}

/** The style/class state `updateBar` last wrote for one bar, so identical frames skip the writes. */
interface AppliedBar {
  active: boolean;
  trackSize: number;
  thumbSize: number;
  thumbOffset: number;
  /** The inset the track hugs — `insets.top` (vertical) or `insets.bottom` (horizontal). */
  inset: number;
}

/** One bar's elements and the geometry the last update resolved for it. */
interface Bar {
  readonly axis: ScrollbarAxis;
  readonly track: HTMLElement;
  readonly thumb: HTMLElement;
  /** `null` while the bar is hidden, i.e. while there is nothing to drag. */
  geometry: ThumbGeometry | null;
  /** What the DOM currently shows; `null` while hidden or before the first visible update. */
  applied: AppliedBar | null;
  /** Whether `display: none` has been written since the bar was last visible (or created). */
  hiddenApplied: boolean;
}

/** The in-flight thumb drag: which bar, which pointer, and where on the thumb it was grabbed. */
interface ThumbDrag {
  readonly bar: Bar;
  readonly pointerId: number | undefined;
  /** Distance from the thumb's leading edge to the press point (CSS px along the axis). */
  readonly grab: number;
}

/**
 * Creates the scrollbar feature.
 *
 * The bars are renderer-owned DOM inside the chart body that reserves no layout space: enabling or
 * disabling them changes no pane geometry, no viewport size and no content coordinate. A disabled
 * feature creates nothing and does no per-frame work at all.
 */
// docs/specs/plugins/view.md
// the vertical bar, the draggable thumb and the horizontal bar
export function createScrollbars(deps: ScrollbarsDeps): Scrollbars {
  const bars: Bar[] = [];
  let scrollActive = false;
  let activeTimer: ReturnType<typeof setTimeout> | null = null;
  let drag: ThumbDrag | null = null;

  if (deps.enabled) {
    for (const axis of ["vertical", "horizontal"] as const) {
      const built = createScrollbar(deps.pane.ownerDocument, axis);
      // Appended last, after the DOM overlay, so the bars overlay everything else in the pane
      // without reserving layout space or claiming a z-index of their own.
      deps.pane.appendChild(built.track);
      deps.own(() => built.track.remove());
      bars.push({
        axis,
        track: built.track,
        thumb: built.thumb,
        geometry: null,
        applied: null,
        hiddenApplied: false,
      });
    }
  }

  function noteActivity(): void {
    if (bars.length === 0) return;
    scrollActive = true;
    if (activeTimer !== null) globalThis.clearTimeout(activeTimer);
    activeTimer = globalThis.setTimeout(() => {
      activeTimer = null;
      scrollActive = false;
      update();
    }, SCROLLBAR_LINGER_MS);
  }

  /** Recomputes one bar; hidden unless its axis's content extent exceeds the viewport size. */
  function updateBar(bar: Bar, state: ScrollbarViewState): void {
    const vertical = bar.axis === "vertical";
    const trackSize = vertical ? state.vp.height : state.vp.width;
    const view = trackSize;
    const content = vertical ? state.extent.height : state.extent.width;
    const scroll = vertical ? state.vp.scrollTop : state.vp.scrollLeft;
    const geometry = thumbGeometry(trackSize, view, content, scroll);
    bar.geometry = geometry;
    if (geometry === null) {
      bar.applied = null;
      if (!bar.hiddenApplied) {
        bar.hiddenApplied = true;
        bar.track.style.display = "none";
      }
      return;
    }
    bar.hiddenApplied = false;
    // a thumb drag holds the active style for its whole duration, not just while the
    // position keeps changing (a drag pinned at an end still emits no `view/scrolled`).
    const active = scrollActive || drag !== null;
    const inset = vertical ? state.insets.top : state.insets.bottom;
    // Skip identical frames: `update()` runs once per composite, and rewriting the className and
    // five style longhands every paint invalidates style for nothing on the vast majority of
    // frames (only a scroll, resize or active-state flip actually moves a bar).
    const last = bar.applied;
    if (
      last !== null &&
      last.active === active &&
      last.trackSize === geometry.trackSize &&
      last.thumbSize === geometry.thumbSize &&
      last.thumbOffset === geometry.thumbOffset &&
      last.inset === inset
    ) {
      return;
    }
    bar.applied = { active, trackSize: geometry.trackSize, thumbSize: geometry.thumbSize, thumbOffset: geometry.thumbOffset, inset };
    const base = `sg-scrollbar ${scrollbarAxisClass(bar.axis)}`;
    bar.track.className = active ? `${base} sg-scrollbar--active` : base;
    bar.track.style.display = "block";
    const rtl = deps.direction === "rtl";
    if (vertical) {
      // The track spans the paintable body height, between the top/bottom `renderer/insets` bands.
      // §6.1 mirroring: the vertical bar hugs the inline-end edge — right in LTR (the
      // stylesheet's `right: 2px`), left in RTL (overridden inline, since the stylesheet uses a
      // physical offset the `dir` attribute cannot flip).
      if (rtl) {
        bar.track.style.left = `${SCROLLBAR_EDGE_GAP}px`;
        bar.track.style.right = "auto";
      }
      bar.track.style.top = `${state.insets.top}px`;
      bar.track.style.height = `${geometry.trackSize}px`;
      bar.thumb.style.top = `${geometry.thumbOffset}px`;
      bar.thumb.style.height = `${geometry.thumbSize}px`;
    } else {
      // The horizontal track spans the body width and hugs the bottom band's upper edge.
      bar.track.style.left = "0px";
      bar.track.style.width = `${geometry.trackSize}px`;
      bar.track.style.bottom = `${state.insets.bottom + SCROLLBAR_EDGE_GAP}px`;
      // §6.1 mirroring: `thumbOffset` measures from the track's leading edge, which is the right
      // edge in RTL, so the physical `left` mirrors there (scroll 0 shows the thumb at the right).
      const physicalOffset = rtl
        ? geometry.trackSize - geometry.thumbSize - geometry.thumbOffset
        : geometry.thumbOffset;
      bar.thumb.style.left = `${physicalOffset}px`;
      bar.thumb.style.width = `${geometry.thumbSize}px`;
    }
  }

  function update(): void {
    if (bars.length === 0) return;
    const state = deps.viewState();
    for (const bar of bars) updateBar(bar, state);
  }

  /** The pointer's position along the bar's axis, measured from the track's leading edge. */
  function trackLocal(bar: Bar, e: { clientX: number; clientY: number }): number {
    const rect = bar.track.getBoundingClientRect();
    if (bar.axis === "vertical") return e.clientY - rect.top;
    // §6.1 mirroring: the horizontal leading edge is the right edge in RTL, matching the mirrored
    // thumb placement, so a drag maps to the same logical offsets in both directions.
    return deps.direction === "rtl" ? rect.right - e.clientX : e.clientX - rect.left;
  }

  function endDrag(e: PointerEvent): void {
    const active = drag;
    if (active === null) return;
    drag = null;
    deps.claim.release("thumb");
    releasePointer(active.bar.thumb, active.pointerId);
    e.stopPropagation();
    // Starts the linger that fades the active style out, now that the drag no longer holds it.
    noteActivity();
    update();
    // The pointer is free again: a hover recorded before the press can now be resolved, which only
    // happens in a paint pass.
    deps.scheduleFrame();
  }

  for (const bar of bars) {
    deps.listen(bar.thumb, "pointerdown", (e) => {
      // docs/specs/plugins/view.md — the press is consumed here: the pane's
      // gesture handler must not see it, so no `pointer/barDown` / `pointer/background` is emitted
      // and no canvas gesture starts underneath the drag.
      e.stopPropagation();
      e.preventDefault();
      if (drag !== null) endDrag(e);
      const geometry = bar.geometry;
      // A hidden bar has no geometry to map a drag through, so the press starts nothing.
      if (geometry === null) return;
      // The claim is what keeps this drag and a canvas gesture mutually exclusive: whichever owns
      // the pointer keeps it until it ends.
      if (!deps.claim.claim("thumb")) return;
      // First drag ever: the document-level move/up/cancel routing is installed on demand, so a
      // chart nobody scrollbar-drags adds no document listeners at all.
      installDragListeners();
      drag = { bar, pointerId: e.pointerId, grab: trackLocal(bar, e) - geometry.thumbOffset };
      capturePointer(bar.thumb, e.pointerId);
      update();
    });
  }

  /** Whether the document-level drag listeners have been attached (once, owned by the core). */
  let dragListenersInstalled = false;

  // The drag's move/up/cancel listeners live on the document, not the thumb: pointer capture is
  // best-effort (`capturePointer` swallows failures), and without capture a pointer that leaves
  // the 8 px thumb — which every real drag does immediately — would stop delivering moves to a
  // thumb-only listener and the drag would stall. Document-level routing keeps the drag tracking
  // wherever the pointer goes, the same pattern the panes plugin's divider dragOwner uses.
  // Installed lazily on the first press: each `deps.listen` hands its removal to the core exactly
  // once, and an idle chart keeps the document listener-free.
  function installDragListeners(): void {
    if (dragListenersInstalled) return;
    dragListenersInstalled = true;
    const doc = deps.pane.ownerDocument;

    deps.listen(doc, "pointermove", (e) => {
      const active = drag;
      if (active === null || active.pointerId !== e.pointerId) return;
      e.stopPropagation();
      const geometry = active.bar.geometry;
      if (geometry === null) return;
      const offset = scrollFromThumb(trackLocal(active.bar, e), active.grab, geometry);
      // A thumb that fills its track cannot express a position: hold rather than divide by zero.
      if (offset === null) return;
      // The scroll path applies the clamp, so a pointer dragged past either end simply pins the
      // position at that end.
      deps.scrollAxisTo(active.bar.axis, offset);
    });

    for (const type of ["pointerup", "pointercancel"] as const) {
      deps.listen(doc, type, (e) => {
        if (drag === null || drag.pointerId !== e.pointerId) return;
        endDrag(e);
      });
    }
  }

  deps.own(() => {
    drag = null;
    deps.claim.release("thumb");
    if (activeTimer !== null) globalThis.clearTimeout(activeTimer);
    activeTimer = null;
  });

  return { update, noteActivity };
}
