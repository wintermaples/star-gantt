/**
 * Public value types of `@stargantt/plugin-theme`.
 *
 * They live here rather than in `index.ts` so the internal modules can import them without
 * depending on the plugin entry point (which imports them back).
 */
// docs/specs/plugins/view.md

/**
 * A chart's colour-scheme pin.
 *
 * `"light"` / `"dark"` make the chart resolve the library's default palette in that scheme
 * whatever the page and the OS are doing; `"auto"` — the default — leaves the choice to the page,
 * which is the behaviour of every composition written before this option existed.
 */
export type ColorScheme = "light" | "dark" | "auto";

/** Options of `ThemeService.setPreset`. */
export interface SetPresetOptions {
  /**
   * `"replace"` (the default) drops the tokens of the previously applied preset and leaves only
   * the named one's; `"merge"` layers the named preset over the tokens already applied, so a base
   * palette can keep standing while an accent group is swapped.
   */
  mode?: "replace" | "merge";
}

/**
 * A preset that pins a colour scheme alongside its tokens.
 *
 * Wherever a preset is accepted, this object form and the plain token map are interchangeable. The
 * scheme pin exists because a preset, like a hand-written CSS palette, usually sets only part of
 * the token set: without it the remainder follows the OS, and a dark palette on a light page
 * paints a mixed chart.
 */
export interface ThemePreset {
  /** Pinned on the chart element for as long as this preset is applied. Omitted: pin untouched. */
  colorScheme?: "light" | "dark";
  /** The preset's tokens — CSS custom-property names to CSS values. */
  tokens: Readonly<Record<string, string>>;
}

/** One measured relationship reported by `ThemeService.audit()`. */
export interface ThemeAuditEntry {
  /** Stable identifier of the checked relationship, for example `"bar-fill/bg"`. */
  id: string;
  /**
   * `"contrast"` measures the WCAG contrast ratio between two tokens; `"order"` counts how many
   * adjacent steps of an ordered group are in the wrong order.
   */
  kind: "contrast" | "order";
  /** The tokens the check read, in the order the id names them. */
  tokens: readonly string[];
  /** The measured value: a contrast ratio, or a count of out-of-order steps. */
  measured: number;
  /** The floor a `"contrast"` entry must reach, or the ceiling an `"order"` entry must not pass. */
  min: number;
  /** Whether the measurement meets `min`. */
  ok: boolean;
}
