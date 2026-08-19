// docs/specs/plugins/interaction.md §6.4, §6.4a — the one `.sg-tooltip` element: how content is
// rendered into it, where it is positioned, and what it remembers so the tasks store subscription
// can refresh it in place.
/**
 * The tooltip panel — the feature's single piece of DOM.
 *
 * It is the only place that writes to the element, which makes it the whole answer to "is a tooltip
 * on screen, and for which hit?". Positioning arithmetic lives in `./placement`; this module only
 * measures, writes and remembers.
 *
 * `TooltipContent` / `TooltipContentProvider` and the `tooltip/content` extension-point declaration
 * live in the package's single declaration site (`src/types.ts`, architecture.md ch. 1.4); this
 * file re-exports them locally so this feature's own modules keep importing from here.
 */
import type { HitResult } from "@stargantt/plugin-view";
import { placePanel, visibleBounds } from "./placement";
import type { PanelSize } from "./placement";

export type { TooltipContent, TooltipContentProvider } from "../../types";
import type { TooltipContent, TooltipContentProvider } from "../../types";

/* ------------------------------------------------------------------ *
 * The panel
 * ------------------------------------------------------------------ */

/** Resolves the content for one hit, or declines with `undefined`. */
export type ResolveContent = (hit: Readonly<HitResult>) => TooltipContent | undefined;

export interface PanelOptions {
  /** The document the element is created in, and whose window bounds placement answers to. */
  doc: Document;
  /** The element the panel is mounted under: the renderer's DOM overlay, or the Gantt root. */
  host: HTMLElement;
  /** Consulted on every show and on every refresh; `undefined` means "nothing to display". */
  resolve: ResolveContent;
  /**
   * Whether the panel itself must stay a pointer target (§6.4a, WCAG 1.4.13 "Hoverable").
   *
   * Only the hover trigger needs this: a hover-shown tooltip can cancel its own pending hide by
   * being entered. A click-triggered panel has no hide-on-leave to cancel, so it must not swallow
   * pointer presses landing on it — the panel is `pointer-events: none` instead.
   */
  hoverable: boolean;
}

/** The panel's controls, as the hover state machine and the plugin's subscriptions use them. */
export interface TooltipPanel {
  /** The `.sg-tooltip` element, for the plugin's own pointer listeners. */
  readonly element: HTMLElement;
  /** Whether a tooltip is currently on screen. */
  isVisible(): boolean;
  /**
   * Resolves content for `hit` and, when there is any, shows it anchored at `x`/`y` (host-local
   * coordinates). Returns whether a tooltip is now showing that hit; a decline leaves whatever was
   * on screen exactly as it was, so the caller decides what a decline means.
   */
  show(hit: Readonly<HitResult>, x: number, y: number): boolean;
  /** Takes the tooltip down and forgets its anchor. */
  hide(): void;
  /**
   * Re-resolves the visible tooltip's own anchor and replaces its content in place, hiding it when
   * the anchor no longer resolves. Does nothing when no tooltip is visible.
   */
  refresh(): void;
  /** Detaches the element from the document. */
  destroy(): void;
}

/** Creates the element, mounts it hidden under `host`, and returns its controls. */
export function createPanel(options: PanelOptions): TooltipPanel {
  const { doc, host, resolve, hoverable } = options;

  const el = doc.createElement("div");
  el.className = "sg-tooltip";
  el.setAttribute("role", "tooltip");
  el.style.position = "absolute";
  // §6.4a WCAG 1.4.13 "Hoverable" — the hover trigger's panel is a pointer target so it can cancel
  // its own pending hide; the below-right offset placement keeps it from ever covering the anchor
  // bar. A click-triggered panel has no hide-on-leave to cancel, and letting it capture pointer
  // events would swallow presses aimed at whatever the panel happens to be sitting on top of, so it
  // stays `pointer-events: none`.
  el.style.pointerEvents = hoverable ? "auto" : "none";
  el.style.display = "none";
  host.appendChild(el);

  /** The currently mounted `HTMLElement` content, if any — removed before the next render. */
  let mounted: HTMLElement | null = null;

  // §6.4a freshness — the hit + coordinates the currently visible tooltip was shown for, so the
  // tasks store subscription can re-resolve it. `null` whenever nothing is shown, kept in lockstep
  // with `hide()`/`show()`.
  let anchor: { hit: Readonly<HitResult>; x: number; y: number } | null = null;

  function unmount(): void {
    if (mounted !== null) {
      mounted.remove();
      mounted = null;
    }
    el.textContent = "";
  }

  // Overflow is judged against the panel's natural (shrink-to-fit, `max-width`-bounded) size.
  // `max-content` takes the containing block out of the width computation altogether, so the
  // measurement below cannot read a squeezed width, and — just as importantly — the panel cannot
  // be re-squeezed into a tall sliver once the final `left` puts it near the containing block's
  // edge. Parking it at the host's origin keeps the measurement honest even where `max-content` is
  // unavailable.
  /** Measures `el`'s natural (shrink-to-fit) size, parking it at the origin to do so. */
  function measureNatural(): PanelSize {
    el.style.width = "max-content";
    el.style.left = "0px";
    el.style.top = "0px";
    return { width: el.offsetWidth, height: el.offsetHeight };
  }

  // The panel is offset below-right of the anchor and, near an edge, flipped to above-left; where
  // flipping is not enough, clamped, so it stays fully visible. Internal, not configurable.
  // `document.defaultView` is absent in headless/test environments, in which case the offset still
  // applies but there is nothing to flip or clamp against.
  function place(x: number, y: number): void {
    // `x`/`y` are in `host`'s local coordinate space (pane-local CSS pixels, as delivered by the
    // renderer's pointer events — `el` is positioned absolutely inside `host`), but the bounds
    // below are measured from the browser window's top-left. Translate through `host`'s own
    // position in the window so the offset/flip/clamp arithmetic operates in a single, consistent
    // coordinate space.
    const hostRect = host.getBoundingClientRect();

    const size = measureNatural();

    const view = doc.defaultView;
    const position = placePanel(
      hostRect.left + x,
      hostRect.top + y,
      size,
      view == null ? null : visibleBounds(el.parentElement, view),
    );

    el.style.left = `${position.left - hostRect.left}px`;
    el.style.top = `${position.top - hostRect.top}px`;
  }

  function show(hit: Readonly<HitResult>, x: number, y: number): boolean {
    const content = resolve(hit);
    if (content === undefined) return false;
    unmount();
    if (typeof content === "string") {
      el.textContent = content;
    } else {
      el.appendChild(content);
      mounted = content;
    }
    // Visible before measuring: an `el.offsetWidth`/`offsetHeight` read against `display: none`
    // is always zero, which would defeat the clamp in `place()`.
    el.style.display = "";
    place(x, y);
    anchor = { hit, x, y };
    return true;
  }

  function hide(): void {
    unmount();
    el.style.display = "none";
    anchor = null;
  }

  function refresh(): void {
    if (anchor === null) return;
    const { hit, x, y } = anchor;
    if (!show(hit, x, y)) hide();
  }

  return {
    element: el,
    isVisible: () => el.style.display !== "none",
    show,
    hide,
    refresh,
    destroy: () => el.remove(),
  };
}
