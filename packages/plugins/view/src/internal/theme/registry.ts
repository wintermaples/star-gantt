// docs/specs/plugins/view.md — internal; the published surface is the plugin value, its public
// types and its `declare module` augmentation, and this module is not part of it.
/**
 * The machine-readable side of the theme token registry: the *names* a canvas painter reads
 * through `ThemeService.get`, and the names the library has retired.
 *
 * It deliberately holds **no values**: a token's value must not live in TS and be mirrored in CSS
 * by hand, and nothing here needs one. The colour half of the set is `FORCED_COLOR_TOKENS`' keys —
 * that map's own purpose makes it exactly the set of canvas-read colours — so the two can never
 * disagree.
 */
import { FORCED_COLOR_TOKENS } from "./forced-colors";

/**
 * The canvas-read tokens that carry something other than a colour: whole `font` shorthands, CSS px
 * lengths, and unitless fractions. They are read through the same `ThemeService.get` as the
 * colours but are exempt from `FORCED_COLOR_TOKENS` and from preset coverage by design: fonts and
 * px lengths are read normally in a forced-colors environment.
 *
 * The registry test asserts that every non-colour token a plugin source actually reads appears
 * here, so a new one cannot be introduced without joining the published token snapshot.
 */
export const NON_COLOR_CANVAS_TOKENS: readonly string[] = [
  "--sg-header-font",
  "--sg-header-major-font",
  "--sg-header-height",
  "--sg-bar-track-alpha",
  "--sg-bar-label-font",
  "--sg-bar-radius",
  "--sg-bar-stroke-width",
  "--sg-bar-fill-bevel",
  "--sg-selection-line-width",
  "--sg-selection-outset",
  "--sg-chart-min-width",
  "--sg-pane-row-min-height",
  "--sg-treegrid-toggle-width",
  "--sg-treegrid-cell-padding",
  "--sg-load-chart-height",
  "--sg-load-lanes-height",
  "--sg-load-lane-height",
  "--sg-load-lane-label-width",
  "--sg-baseline-slip-font",
  "--sg-rv-row-height",
  "--sg-rv-label-width",
  "--sg-rv-height",
];

/**
 * Every token name a canvas painter reads through `ThemeService.get`: the canvas-read colours
 * followed by the non-colour tokens. This is the set a palette has to cover to be self-contained.
 * Tokens consumed only by the library's own stylesheet are deliberately outside it, because DOM
 * content already follows the stylesheet whether a preset is applied or not.
 */
export const CANVAS_READ_TOKENS: readonly string[] = [
  ...Object.keys(FORCED_COLOR_TOKENS),
  ...NON_COLOR_CANVAS_TOKENS,
];

/**
 * Tokens the library once declared and no longer does, mapped to the advice that replaces them.
 *
 * A retired name is valid CSS that paints nothing, which is the least discoverable kind of
 * mistake: the host's declaration is accepted, ignored, and never mentioned. `ThemeService`'s
 * setup diagnostics read each of these off the chart root's computed style — a name the library no
 * longer declares can only read back non-empty if the host set it — and warn once with the advice
 * below.
 */
export const RETIRED_TOKENS: Readonly<Record<string, string>> = {
  // Progress stopped being a second colour laid over the bar and became the bar's own fill at two
  // opacities.
  "--sg-progress-fill":
    "progress is now the bar's own fill at two opacities; tune it with --sg-bar-track-alpha",
  // The DOM-side fallback names that migrated onto their registry names.
  "--sg-text": "renamed to --sg-fg",
  "--sg-text-muted": "renamed to --sg-muted-fg",
};
