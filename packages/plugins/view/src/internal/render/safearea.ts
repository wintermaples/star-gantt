// docs/specs/plugins/view.md — internal; not part of the published surface.
/**
 * The chart pane's overlay safe area and the four `--sg-safe-*` custom properties that
 * publish it.
 *
 * Two halves, both testable without a host: `resolveSafeArea` is pure geometry — the resolved
 * `renderer/insets` bands plus the static scrollbar reservation — and the writer keeps the pane's
 * inline custom properties in step with it, touching the DOM only for a value that actually
 * changed.
 */
import { sanePositive } from "./insets";
import { SCROLLBAR_EDGE_GAP, SCROLLBAR_TRACK_THICKNESS } from "./scrollbars";
import type { ResolvedInsets } from "./index";

// docs/specs/plugins/view.md
// the strip a synthetic scrollbar occupies on the edge it hugs: its edge gap plus its
// track thickness. rejected tokenizing either number (a theme token is a host-writable
// *input* by construction, and the bars' geometry was never designed to be re-derived from one),
// so this is the one place the two literals are added up.
/** The layout space an overlay keeps clear of a synthetic scrollbar's edge (10 CSS px). */
export const SCROLLBAR_RESERVATION = SCROLLBAR_EDGE_GAP + SCROLLBAR_TRACK_THICKNESS;

/**
 * The distance in CSS px from each edge of the chart pane's border box to the matching edge of its
 * safe area — the region a corner-anchored overlay may occupy.
 */
export interface SafeArea {
  readonly top: number;
  readonly right: number;
  readonly bottom: number;
  readonly left: number;
}

/** The four sides, in the order they are written. */
export const SAFE_AREA_SIDES = ["top", "right", "bottom", "left"] as const;

// docs/specs/plugins/view.md
/** The custom property each side is published as. */
export const SAFE_AREA_PROPERTIES = {
  top: "--sg-safe-top",
  right: "--sg-safe-right",
  bottom: "--sg-safe-bottom",
  left: "--sg-safe-left",
} as const satisfies Record<keyof SafeArea, string>;

/**
 * The safe area of a pane whose bands are `insets`, whose scrollbars are on or off, and whose base
 * text direction is `direction`.
 *
 * The scrollbar reservation is **static**: it is present on every edge a bar can occupy whenever
 * the bars are enabled, whether or not one is showing at the moment, so an overlay is never jumped
 * on the instant content starts to overflow; with the bars disabled it is zero on every edge.
 *
 * The vertical bar hugs the pane's **inline-end** edge — right in LTR, left in RTL, the same
 * mirroring the bar itself performs — so the inline reservation moves with `direction` and the
 * opposite edge reserves nothing. The horizontal bar always hugs the bottom edge, above whatever
 * the bottom band reserves, so the bottom reservation is direction-independent.
 */
// docs/specs/plugins/view.md
export function resolveSafeArea(
  insets: ResolvedInsets,
  scrollbarEnabled: boolean,
  direction: "ltr" | "rtl",
): SafeArea {
  const reservation = scrollbarEnabled ? SCROLLBAR_RESERVATION : 0;
  const inlineEnd = direction === "rtl" ? "left" : "right";
  return {
    // The bands are already sanitized by the reducer; sanitizing again keeps a foreign reduced
    // value (re-define) from publishing a negative or non-finite length.
    top: sanePositive(insets.top),
    right: inlineEnd === "right" ? reservation : 0,
    bottom: sanePositive(insets.bottom) + reservation,
    left: inlineEnd === "left" ? reservation : 0,
  };
}

/** The one member of `CSSStyleDeclaration` the writer needs. */
export interface InlineCustomProperties {
  /**
   * Optional because a non-browser host's style object may not have it — the writer then publishes
   * nothing rather than throwing, exactly as the theme plugin's inline preset writer does.
   */
  setProperty?(name: string, value: string, priority?: string): void;
}

export interface SafeAreaWriter {
  /**
   * Publishes `area`, writing every property whose value differs from the one last written — which
   * on the first call is all four, including the zero ones.
   */
  write(area: SafeArea): void;
}

/**
 * Creates the writer for one element's inline `--sg-safe-*` properties.
 *
 * The values last written are remembered here rather than read back from the element: reading a
 * custom property back would be a layout read in a layout-write pass, and nothing else writes
 * these four.
 */
// docs/specs/plugins/view.md
export function createSafeAreaWriter(style: InlineCustomProperties): SafeAreaWriter {
  const written = new Map<string, string>();
  return {
    write(area) {
      const setProperty = style.setProperty;
      if (typeof setProperty !== "function") return;
      for (const side of SAFE_AREA_SIDES) {
        const name = SAFE_AREA_PROPERTIES[side];
        const value = `${area[side]}px`;
        if (written.get(name) === value) continue;
        written.set(name, value);
        setProperty.call(style, name, value);
      }
    },
  };
}
