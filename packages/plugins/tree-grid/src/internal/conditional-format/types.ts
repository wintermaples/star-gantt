// docs/specs/plugins/tree-grid.md § Config — the `conditionalFormat` nest.
/**
 * The conditional-formatting options, nested under the plugin's own config.
 *
 * Supplying the nest at all — even as `{}` — enables the feature; omitting it leaves it dormant,
 * and the chart renders exactly as it would without any formatting rule.
 */
import type {
  ConditionalFormatRule,
  OverdueOptions,
  ProgressStatusColors,
} from "../../types";

export interface ConditionalFormatConfig {
  /**
   * Rule list, evaluated per task in array order; the first matching rule with a usable color
   * decides the bar color. Rules take precedence over the overdue and priority presets.
   */
  rules?: ConditionalFormatRule[];
  /**
   * Preset: maps a task's `meta.priority` value (by its string form) to a bar color, e.g.
   * `{ "1": "#c53030", high: "#dd6b20" }`. Consulted after `rules` and the overdue warning. Each
   * color accepts a theme-token reference in either spelling.
   */
  priorityColors?: Record<string, string>;
  /**
   * Enables the overdue-task warning: tasks whose end has passed while progress is below 1 get a
   * warning bar color and (by default) a warning icon. `true` enables it with defaults.
   */
  overdue?: boolean | OverdueOptions;
  /**
   * Enables progress-status coloring: the progress portion of each ordinary bar is painted in a
   * status color — behind schedule, on track, or complete. `true` enables it with defaults.
   */
  progress?: boolean | ProgressStatusColors;
  /**
   * Mounts a legend panel in the chart body's claimed corner describing every active color rule
   * (swatch plus text). Defaults to `false`. The panel carries the CSS class `sg-cf-legend` for
   * host restyling and never intercepts pointer events.
   */
  legend?: boolean;
  /**
   * Clock used for the overdue check and the expected-progress computation, mainly for tests.
   * Defaults to `Date.now`.
   */
  now?: () => number;
}
