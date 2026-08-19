// docs/specs/plugins/tree-grid.md § Extension points — the rule engine's wiring: the bar-style
// provider, the bar overlay renderer, the legend and the overdue day-rollover repaint.
/**
 * Conditional formatting: a rule engine that maps task properties to bar colors and warnings —
 * host-defined AND/OR condition rules, a priority-color preset, an overdue-task warning (color
 * plus icon), progress-status coloring of the progress fill, and an optional legend describing the
 * active rules. With the feature dormant nothing is colored and the chart renders exactly as it
 * would without it.
 *
 * Colors may name one of the chart's CSS custom properties instead of a literal value, in which
 * case they follow the theme.
 */
import type { Disposable, PluginContext } from "@stargantt/core";
import type { DataService, Task } from "@stargantt/plugin-data-store";
import type { ThemeService, ViewService } from "@stargantt/plugin-view";
import { MS_DAY, startOfUtcDay } from "@stargantt/sdk";
import type { TreeGridMessages } from "../../types";
import type { BarBox, BarStyle } from "../upward";
import { createColorResolver } from "./color";
import { resolveConfig } from "./config";
import { LEGEND_CORNERS, isLegendCorner, legendEntries, mountLegend } from "./legend";
import type { LegendCorner } from "./legend";
import { createOverlayRenderer, overlayActive } from "./overlay";
import { createStyleResolver } from "./style";
import type { ConditionalFormatConfig } from "./types";

const PLUGIN_ID = "stargantt.tree-grid";

/** What the feature needs from the plugin that hosts it. */
export interface ConditionalFormatDeps {
  /** The resolved `conditionalFormat` config nest. */
  config: ConditionalFormatConfig;
  /** The resolved plugin-wide message catalog. */
  messages: TreeGridMessages;
  /** The task store. */
  data: DataService;
  /** The theme the token-referencing colors resolve through. */
  theme: ThemeService;
  /** The view, for the chart pane element and layer invalidation. */
  view: ViewService;
}

/** Reports one contained fault through the chart's plugin-error event. */
function report(ctx: PluginContext, feature: string, cause: unknown): void {
  ctx.emit("core/pluginError", { pluginId: PLUGIN_ID, error: { feature, cause } });
}

/**
 * Wraps a per-frame callable in a latched error barrier: the first throw is reported once via
 * `core/pluginError`, and the feature then stays off for the life of the instance.
 */
function latched<A extends unknown[], R>(
  ctx: PluginContext,
  feature: string,
  fn: (...args: A) => R,
): (...args: A) => R | undefined {
  let dead = false;
  return (...args: A): R | undefined => {
    if (dead) return undefined;
    try {
      return fn(...args);
    } catch (error) {
      dead = true;
      report(ctx, feature, error);
      return undefined;
    }
  };
}

export function setupConditionalFormat(ctx: PluginContext, deps: ConditionalFormatDeps): void {
  const { data, theme, view, messages } = deps;
  const resolved = resolveConfig(deps.config);

  /* --- color resolution ------------------------------------------------ */

  const color = createColorResolver({
    theme,
    // Reported once per distinct string: the resolver runs per visible bar per paint pass, so an
    // unlatched report would emit at frame rate.
    onUnresolved: (raw) =>
      report(
        ctx,
        "color",
        new Error(
          `${PLUGIN_ID}: the color ${JSON.stringify(raw)} does not resolve to a ` +
            `value that can be painted; no color was applied`,
        ),
      ),
  });

  // `style()` and the overlay painter are each called once per visible bar within one synchronous
  // paint pass, and both read `resolved.now()` for the same overdue check. Memoized here rather
  // than in `resolved` itself (so `resolveConfig`'s `now` stays a plain, directly-testable
  // function): the cached value is cleared on a microtask, which fires only *between* synchronous
  // call stacks — i.e. between one paint pass and the next — so this is one `now()` call per pass
  // rather than one per bar.
  let nowCache: number | undefined;
  const currentNow = (): number => {
    if (nowCache === undefined) {
      nowCache = resolved.now();
      queueMicrotask(() => {
        nowCache = undefined;
      });
    }
    return nowCache;
  };

  /* --- the bar-style contribution --------------------------------------- */

  // The provider is contributed unconditionally: a contribution cannot be withdrawn or added later
  // at a defined position. With no rules it answers `undefined` for every task, which is what an
  // absent provider does.
  const styles = createStyleResolver({ ...resolved, now: currentNow }, color);
  ctx.contribute(
    "taskbars/style",
    latched(ctx, "style", (task: Readonly<Task>): BarStyle | undefined => styles.style(task)),
  );

  /* --- the bar overlay contribution ------------------------------------- */

  // The corner radius the progress-status fill is clipped with: the `--sg-bar-radius` token, the
  // same token the bars are drawn with by default (a per-chart bar-radius override bypasses the
  // token and is not visible here). With an unusable token value the clip is square.
  const barRadius = (): number => {
    const raw = theme.get("--sg-bar-radius");
    if (raw === "") return 0;
    const parsed = Number.parseFloat(raw);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
  };

  const overlayDeps = {
    getTask: (id: BarBox["id"]): Task | undefined => data.getTask(id),
    now: currentNow,
    progress: resolved.progress,
    overdue: resolved.overdue,
    barRadius,
    color,
  };
  if (overlayActive(overlayDeps)) {
    const draw = createOverlayRenderer(overlayDeps);
    ctx.contribute(
      "taskbars/overlays",
      latched(ctx, "overlay", (g: CanvasRenderingContext2D, bar: Readonly<BarBox>): void =>
        draw(g, bar),
      ),
    );
  }

  /* --- the legend -------------------------------------------------------- */

  if (resolved.legend) {
    // docs/specs/plugins/tree-grid.md § Extension points — the corner slot is arbitrated in code;
    // a refused claim keeps the panel where the registry offers room instead.
    const grant = ctx.claimSlot("overlay-corner", "bottom-right", LEGEND_CORNERS);
    const corner: LegendCorner =
      grant.granted || !isLegendCorner(grant.alternative) ? "bottom-right" : grant.alternative;
    // Entries are derived once, here, from the rules and colors this feature was configured
    // with — nothing later can replace them, so there is no update path to keep open.
    const entries = legendEntries(
      { ...resolved, rules: styles.rules(), priorityColors: styles.priorityColors(), messages },
      (error) => report(ctx, "legendPriority", error),
    );
    // The mount point is the element the view plugin hands out, never found by its class string.
    const legend = mountLegend({
      document: ctx.root.ownerDocument,
      parent: view.chartPaneElement(),
      entries,
      corner,
    });
    ctx.own({ dispose: () => legend.dispose() });
  }

  /* --- overdue day-rollover repaint --------------------------------------- */

  // One owned disposable clears whichever timeout is currently armed; re-arming only swaps the
  // variable, so the core's ownership list stays a fixed size.
  if (resolved.overdue !== null) {
    let timeoutId: ReturnType<typeof globalThis.setTimeout> | undefined;
    const disposable: Disposable = {
      dispose: () => {
        if (timeoutId !== undefined) globalThis.clearTimeout(timeoutId);
        timeoutId = undefined;
      },
    };
    ctx.own(disposable);
    const armNextMidnight = (): void => {
      const now = Date.now();
      const delay = startOfUtcDay(now) + MS_DAY - now;
      timeoutId = globalThis.setTimeout(() => {
        timeoutId = undefined;
        view.invalidate("main");
        armNextMidnight();
      }, delay);
    };
    armNextMidnight();
  }
}
