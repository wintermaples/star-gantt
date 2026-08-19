// docs/specs/plugins/view.md — internal; not part of the published surface.
/**
 * Surface metrics and devicePixelRatio observation.
 *
 * The five numbers a resize pass depends on travel as one value object instead of five memo
 * variables, so "did anything change?" is a single comparison rather than an order-dependent chain
 * of early returns.
 */

/** Everything the canvas sizing pass depends on, measured once per pass. */
export interface SurfaceMetrics {
  /** Chart-pane border-box width in CSS px. */
  readonly width: number;
  /** Chart-pane border-box height in CSS px. */
  readonly height: number;
  readonly dpr: number;
  /** Band reserved at the body's top edge through `renderer/insets`. */
  readonly insetTop: number;
  /** Band reserved at the body's bottom edge through `renderer/insets`. */
  readonly insetBottom: number;
}

/** True when two measurements would produce identical canvas and viewport geometry. */
export function sameMetrics(a: SurfaceMetrics | null, b: SurfaceMetrics): boolean {
  return (
    a !== null &&
    a.width === b.width &&
    a.height === b.height &&
    a.dpr === b.dpr &&
    a.insetTop === b.insetTop &&
    a.insetBottom === b.insetBottom
  );
}

/**
 * The paintable height: the body height minus both reserved bands, never negative.
 *
 * This is `Viewport.height` — the bands are excluded from the viewport, so content coordinate
 * `y = 0` lands immediately under the top band (docs/specs/plugins/view.md).
 */
export function paintableHeight(metrics: SurfaceMetrics): number {
  return Math.max(0, metrics.height - metrics.insetTop - metrics.insetBottom);
}

/** A live devicePixelRatio subscription. */
export interface DprWatcher {
  dispose(): void;
}

/**
 * Reports devicePixelRatio changes (a monitor move, a browser zoom) through `matchMedia`.
 *
 * The query pins the ratio observed at subscription time, so the subscription is renewed after every
 * change; a host without `matchMedia` simply never reports one.
 */
// docs/specs/plugins/view.md — DPR change is observed through `matchMedia`.
export function createDprWatcher(onChange: () => void): DprWatcher {
  let unwatch: (() => void) | null = null;

  function arm(): void {
    unwatch?.();
    unwatch = null;
    if (typeof globalThis.matchMedia !== "function") return;
    const dpr = globalThis.devicePixelRatio || 1;
    const mql = globalThis.matchMedia(`(resolution: ${dpr}dppx)`);
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
