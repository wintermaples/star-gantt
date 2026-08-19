// docs/specs/plugins/portfolio.md §3.6 — a panel chart canvas's backing store is sized to its CSS
// pixel size × devicePixelRatio and drawn in CSS coordinates over a matching scale, so a chart
// canvas is never CSS-upscaled from a smaller backing.
/**
 * Backing-store sizing and `devicePixelRatio` observation for the dashboard panel's canvas
 * charts (status donut, burndown).
 */

// The panel is built off `host.ownerDocument` (§3.6), so every DPR/resize/media observation
// resolves through that document's own view — `doc.defaultView` — rather than `globalThis`,
// falling back to `globalThis` only when the document has no view (e.g. a detached document in a
// test double).
type View = (Window & typeof globalThis) | typeof globalThis;

function resolveView(doc: Document): View {
  return doc.defaultView ?? globalThis;
}

/** The current `devicePixelRatio` of `doc`'s view, defaulting to `1` when unavailable or not a usable number. */
export function currentDpr(doc: Document): number {
  const dpr = resolveView(doc).devicePixelRatio;
  return typeof dpr === "number" && dpr > 0 ? dpr : 1;
}

/**
 * Resizes a chart canvas's backing store to its CSS size × `dpr` and scales its context to draw
 * in CSS coordinates, resetting the transform first so repeated calls cannot compound.
 *
 * A no-op — the canvas and its transform are left untouched — when the target backing size
 * already matches, so a spurious resize notification (or a `devicePixelRatio` change that leaves
 * the rounded backing size unchanged) costs nothing and allocates nothing.
 *
 * Returns whether the backing was (re)sized, so the caller knows whether to redraw the chart's
 * content — a skipped resize means the previous paint is still correct and needs no repaint.
 */
export function syncChartBacking(
  canvas: HTMLCanvasElement,
  g: CanvasRenderingContext2D,
  cssWidth: number,
  cssHeight: number,
  dpr: number,
): boolean {
  const w = Math.max(1, Math.round(cssWidth * dpr));
  const h = Math.max(1, Math.round(cssHeight * dpr));
  if (canvas.width === w && canvas.height === h) return false;
  canvas.width = w;
  canvas.height = h;
  g.setTransform(1, 0, 0, 1, 0, 0);
  g.scale(dpr, dpr);
  return true;
}

/** A live `devicePixelRatio` (or resize) subscription; `dispose()` stops it. */
export interface DprWatcher {
  dispose(): void;
}

/**
 * Reports `devicePixelRatio` changes (a monitor move, a browser zoom) through `doc`'s view's
 * `matchMedia`. The query pins the ratio observed at subscription time, so the subscription is
 * renewed after every change; a view without `matchMedia` simply never reports one.
 *
 * The caller owns the returned watcher's disposal (this plugin's panel routes it through its
 * per-render listener bag, which the plugin's single `ctx.own()`-registered panel-teardown
 * disposable drains — §3.6's "owned via `ctx.own()`").
 */
export function watchDpr(doc: Document, onChange: () => void): DprWatcher {
  const view = resolveView(doc);
  let unwatch: (() => void) | null = null;

  function arm(): void {
    unwatch?.();
    unwatch = null;
    if (typeof view.matchMedia !== "function") return;
    const mql = view.matchMedia(`(resolution: ${currentDpr(doc)}dppx)`);
    const handler = (): void => {
      onChange();
      arm();
    };
    if (typeof mql.addEventListener === "function") {
      mql.addEventListener("change", handler);
      unwatch = () => mql.removeEventListener("change", handler);
    } else if (typeof mql.addListener === "function") {
      // `MediaQueryList` predates `EventTarget` on older Safari; without this branch DPR changes
      // would go unnoticed there.
      mql.addListener(handler);
      unwatch = () => mql.removeListener(handler);
    }
  }

  arm();
  return {
    dispose() {
      unwatch?.();
      unwatch = null;
    },
  };
}

/**
 * Reports a canvas's border-box size changes through `doc`'s view's `ResizeObserver`, so the
 * burndown chart's backing tracks its card's real width (§3.6) whichever document the panel is
 * mounted into. A view without `ResizeObserver` simply never reports one — the chart keeps its
 * fallback measurement for that view's lifetime.
 */
export function watchResize(doc: Document, target: Element, onChange: () => void): DprWatcher {
  const view = resolveView(doc);
  if (typeof view.ResizeObserver !== "function") {
    return { dispose() {} };
  }
  const ro = new view.ResizeObserver(() => onChange());
  ro.observe(target);
  return { dispose: () => ro.disconnect() };
}
