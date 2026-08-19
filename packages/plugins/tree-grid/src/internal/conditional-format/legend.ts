// docs/specs/plugins/tree-grid.md § Extension points — the `.sg-cf-legend` panel and the corner
// slot it is arbitrated into.
/**
 * The legend: entry derivation from the resolved config, and the single DOM panel mounted in the
 * chart body. Every entry pairs a color swatch with a text label, so meaning is never carried by
 * color alone. The panel never intercepts pointer events.
 */
import type { ConditionalFormatRule, TreeGridMessages } from "../../types";
import { cssColor } from "./color";
import type { ResolvedConfig } from "./config";

export interface LegendEntry {
  color: string;
  label: string;
}

/** The four corners of the chart pane's safe area a corner-anchored overlay can occupy. */
export type LegendCorner = "top-left" | "top-right" | "bottom-left" | "bottom-right";

/** Every corner name this plugin knows, for the slot claim's candidate vocabulary. */
export const LEGEND_CORNERS: readonly LegendCorner[] = [
  "top-left",
  "top-right",
  "bottom-left",
  "bottom-right",
];

/** Whether a string names one of the four corners. */
export function isLegendCorner(value: string | undefined): value is LegendCorner {
  return value !== undefined && (LEGEND_CORNERS as readonly string[]).includes(value);
}

/**
 * What the legend is derived from: the resolved config's presets plus the rules and priority
 * colors currently in effect, and the message catalog its built-in labels come from.
 */
export type LegendSource = Pick<ResolvedConfig, "overdue" | "progress"> & {
  rules: readonly ConditionalFormatRule[];
  priorityColors: readonly (readonly [string, string])[];
  messages: TreeGridMessages;
};

/**
 * Derives the legend entries in order: labelled rules, the overdue entry, the priority entries,
 * then the three progress entries. A throwing `legendPriority` builder falls back to the built-in
 * default for that entry (the caller reports it once).
 */
export function legendEntries(
  resolved: LegendSource,
  onBuilderError: (error: unknown) => void,
): LegendEntry[] {
  const entries: LegendEntry[] = [];
  for (const rule of resolved.rules) {
    if (rule.legend !== undefined && rule.style.color !== undefined) {
      entries.push({ color: rule.style.color, label: rule.legend });
    }
  }
  if (resolved.overdue !== null) {
    entries.push({ color: resolved.overdue.color, label: resolved.messages.legendOverdue });
  }
  let reported = false;
  for (const [priority, color] of resolved.priorityColors) {
    let label: string;
    try {
      label = resolved.messages.legendPriority({ priority });
      if (typeof label !== "string") label = `Priority ${priority}`;
    } catch (error) {
      if (!reported) {
        reported = true;
        onBuilderError(error);
      }
      label = `Priority ${priority}`;
    }
    entries.push({ color, label });
  }
  if (resolved.progress !== null) {
    entries.push(
      { color: resolved.progress.behind, label: resolved.messages.legendProgressBehind },
      { color: resolved.progress.onTrack, label: resolved.messages.legendProgressOnTrack },
      { color: resolved.progress.complete, label: resolved.messages.legendProgressComplete },
    );
  }
  return entries;
}

export interface LegendDeps {
  document: Document;
  /** Chart body the panel is mounted in — the view service's chart pane element. */
  parent: HTMLElement;
  entries: LegendEntry[];
  /** The corner the slot registry granted; defaults to the bottom-right one this plugin asks for. */
  corner?: LegendCorner;
}

export interface Legend {
  /**
   * Replaces the panel's contents with a new entry list, mounting the panel if it was absent and
   * removing it when the new list is empty.
   */
  update(entries: LegendEntry[]): void;
  dispose(): void;
}

/** The margin this plugin owns between the safe-area corner and the legend's box, CSS px. */
const LEGEND_MARGIN_PX = 8;

// A corner slot is the corner of the chart pane's *safe area* (the pane's box minus the timeline
// header band and minus the synthetic scrollbars' strips), which the view plugin publishes on the
// pane as four inline `--sg-safe-*` lengths, plus this plugin's own margin. The `0px` fallbacks are
// normative: they keep the same declaration meaningful on a pane that published nothing.
function slotCss(corner: LegendCorner): string {
  const vertical =
    corner === "top-left" || corner === "top-right"
      ? `top:calc(var(--sg-safe-top, 0px) + ${LEGEND_MARGIN_PX}px);`
      : `bottom:calc(var(--sg-safe-bottom, 0px) + ${LEGEND_MARGIN_PX}px);`;
  const horizontal =
    corner === "top-left" || corner === "bottom-left"
      ? `left:calc(var(--sg-safe-left, 0px) + ${LEGEND_MARGIN_PX}px);`
      : `right:calc(var(--sg-safe-right, 0px) + ${LEGEND_MARGIN_PX}px);`;
  return vertical + horizontal;
}

// The floor rule: the whole panel stays inside the safe area at the 720×540 viewport floor, where
// the chart pane is down to its `--sg-chart-min-width` (240px). Both caps are pane-relative (never
// fixed pixel maxima) and leave this plugin's margin on the far side too, so the legend can never
// span the safe area's full width or height — a long label wraps, and a legend with more entries
// than the pane is tall is clipped at the safe area's top edge rather than covering the timeline
// header. Hosts that need every entry of an unusually long legend visible restyle the public
// `.sg-cf-legend` class.
const CAPS =
  `max-width:calc(100% - var(--sg-safe-left, 0px) - var(--sg-safe-right, 0px) - ${
    LEGEND_MARGIN_PX * 2
  }px);` +
  `max-height:calc(100% - var(--sg-safe-top, 0px) - var(--sg-safe-bottom, 0px) - ${
    LEGEND_MARGIN_PX * 2
  }px);` +
  "overflow:hidden;";

function buildPanel(
  document: Document,
  entries: LegendEntry[],
  corner: LegendCorner,
): HTMLElement {
  const panel = document.createElement("div");
  panel.className = "sg-cf-legend";
  panel.style.cssText =
    "position:absolute;" +
    slotCss(corner) +
    CAPS +
    "z-index:10;pointer-events:none;" +
    "font:11px sans-serif;color:#1c1917;background:rgba(255,255,255,0.92);" +
    "border:1px solid rgba(0,0,0,0.15);border-radius:4px;padding:6px 8px;";
  for (const entry of entries) {
    const row = document.createElement("div");
    row.style.cssText = "display:flex;align-items:center;gap:6px;line-height:16px;";
    const swatch = document.createElement("span");
    // A swatch is styled, not painted on canvas, so CSS resolves a custom property by itself —
    // a bare token only has to be wrapped in `var()` to show the same color the bar gets.
    const background = cssColor(entry.color);
    swatch.style.cssText =
      "display:inline-block;width:10px;height:10px;border-radius:2px;" +
      "border:1px solid rgba(0,0,0,0.25);background:" +
      (background === "" ? "transparent" : background) +
      ";";
    const label = document.createElement("span");
    label.textContent = entry.label;
    row.appendChild(swatch);
    row.appendChild(label);
    panel.appendChild(row);
  }
  return panel;
}

/**
 * Mounts the legend panel. With zero entries nothing is mounted and `dispose()` is a no-op.
 * The built-in inline styling is a light neutral panel; hosts restyle via `.sg-cf-legend`.
 */
export function mountLegend(deps: LegendDeps): Legend {
  const corner: LegendCorner = deps.corner ?? "bottom-right";
  let panel: HTMLElement | null = null;
  const remove = (): void => {
    panel?.remove();
    panel = null;
  };
  const update = (entries: LegendEntry[]): void => {
    remove();
    if (entries.length === 0) return;
    panel = buildPanel(deps.document, entries, corner);
    deps.parent.appendChild(panel);
  };
  update(deps.entries);
  return { update, dispose: remove };
}
