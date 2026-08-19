// docs/specs/plugins/view.md — internal; not part of the published surface.
/**
 * The `renderer/domOverlays` feature: the lazily built clip host, one wrapper per
 * contribution, and the per-frame scroll alignment.
 */
import { createOverlayHost, createOverlayItem } from "./dom";
import type { DomOverlayContribution } from "./index";

export interface DomOverlaysDeps {
  /** The `.sg-dom-overlay` region the clip host is created inside. */
  region: HTMLElement;
  /** The contributions, read at build time (`renderer/domOverlays`, collect). */
  contributions(): readonly DomOverlayContribution[] | undefined;
  /** The current scroll offsets, so a wrapper is aligned before `mount` ever sees it (§4.4). */
  scroll(): { left: number; top: number };
  /** Hands a created element's removal to the core, which owns teardown. */
  own(dispose: () => void): void;
  onFault(error: unknown): void;
}

export interface DomOverlays {
  /** Builds the clip host and the wrappers and calls each `mount` exactly once. */
  build(): void;
  /** Keeps the clip host on the viewport rectangle, so it clips the inset bands away (§4.2-3). */
  resize(width: number, height: number): void;
  /** Translates every wrapper by the negated scroll offsets. */
  sync(scrollLeft: number, scrollTop: number): void;
}

export function createDomOverlays(deps: DomOverlaysDeps): DomOverlays {
  // docs/specs/plugins/view.md — the clip host and the wrappers are
  // created lazily: when nothing contributes (the default preset composition) the rendered DOM is
  // exactly what it was before this point existed.
  let clipHost: HTMLElement | null = null;
  let built = false;
  let items: HTMLElement[] = [];
  let width = 0;
  let height = 0;

  const transform = (left: number, top: number): string => `translate(${-left}px, ${-top}px)`;

  function applySize(): void {
    if (clipHost === null) return;
    clipHost.style.width = `${width}px`;
    clipHost.style.height = `${height}px`;
  }

  deps.own(() => {
    items = [];
    clipHost = null;
  });

  return {
    build() {
      if (built) return;
      built = true;
      const list = deps.contributions() ?? [];
      // §4.4 — an empty point creates nothing at all.
      if (list.length === 0) return;

      const host = createOverlayHost(deps.region.ownerDocument);
      clipHost = host;
      deps.region.appendChild(host);
      deps.own(() => host.remove());
      applySize();

      // §4.3 — mounted and appended in collect order (plugin startup order, ties by registration
      // order), so DOM order and hence the stacking of equally positioned elements is deterministic.
      for (const contribution of list) {
        // §4.4 — a value that is not a usable contribution is skipped silently, without a wrapper.
        if (typeof contribution !== "object" || contribution === null) continue;
        if (typeof contribution.mount !== "function") continue;
        const item = createOverlayItem(deps.region.ownerDocument, String(contribution.id));
        host.appendChild(item);
        deps.own(() => item.remove());
        items.push(item);
        // The wrapper is attached and already scroll-aligned before `mount` sees it (§4.4).
        const scroll = deps.scroll();
        item.style.transform = transform(scroll.left, scroll.top);
        try {
          contribution.mount(item);
        } catch (error) {
          // §3 fault isolation / §4.4 — the faulting wrapper is left as `mount` got it and the
          // remaining contributions still mount.
          deps.onFault(error);
        }
      }
    },
    resize(nextWidth, nextHeight) {
      width = nextWidth;
      height = nextHeight;
      applySize();
    },
    sync(scrollLeft, scrollTop) {
      if (items.length === 0) return;
      // docs/specs/plugins/view.md — applied inside the same once-per-rAF
      // pass that composites the canvases, so HTML and canvas reach the screen in one browser paint.
      const value = transform(scrollLeft, scrollTop);
      for (const item of items) item.style.transform = value;
    },
  };
}
