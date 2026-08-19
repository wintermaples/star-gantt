// docs/specs/plugins/tree-grid.md § Config — unusable values are dropped silently at snapshot
// time, and the config is snapshotted once so later caller mutation has no effect.
/**
 * Config normalization: turns the raw, possibly hostile conditional-formatting options into an
 * immutable resolved shape with every unusable value dropped and every default filled in.
 */
import type { ConditionalFormatRule } from "../../types";
import type { ConditionalFormatConfig } from "./types";

export const OVERDUE_COLOR = "#c53030";
// The behind/complete defaults are translucent so a label drawn inside the bar before the overlay
// stays readable through the status wash; a host may still configure opaque colors, which are
// passed through unchanged.
export const PROGRESS_BEHIND_COLOR = "rgba(197, 48, 48, 0.35)";
// A token reference, not a literal, so the default stays equal to the bar fill in every scheme and
// under every theme preset.
/** Resolves to `--sg-bar-fill`, so on-track bars look unchanged by default. */
export const PROGRESS_ON_TRACK_COLOR = "var(--sg-bar-fill, #0f766e)";
export const PROGRESS_COMPLETE_COLOR = "rgba(47, 133, 90, 0.35)";

export interface ResolvedOverdue {
  color: string;
  icon: boolean;
}

export interface ResolvedProgress {
  behind: string;
  onTrack: string;
  complete: string;
}

export interface ResolvedConfig {
  rules: ConditionalFormatRule[];
  /** Ordered [priorityKey, color] pairs; insertion order of the config object. */
  priorityColors: Array<[string, string]>;
  overdue: ResolvedOverdue | null;
  progress: ResolvedProgress | null;
  legend: boolean;
  now: () => number;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null;
}

function usableColor(v: unknown): v is string {
  return typeof v === "string" && v !== "";
}

/**
 * Normalizes a rule list: entries that are not objects, or whose `when`/`style` is not an object,
 * are dropped, and every surviving rule is copied so a later mutation by the caller cannot change
 * what the chart paints. Anything that is not an array normalizes to an empty list.
 */
export function normalizeRules(rules: unknown): ConditionalFormatRule[] {
  if (!Array.isArray(rules)) return [];
  return rules
    .filter((r): r is ConditionalFormatRule => isRecord(r) && isRecord(r.when) && isRecord(r.style))
    .map((r) => ({
      when: r.when,
      style: { ...(usableColor(r.style.color) ? { color: r.style.color } : {}) },
      ...(typeof r.legend === "string" && r.legend !== "" ? { legend: r.legend } : {}),
    }));
}

/**
 * Normalizes a priority → color map into ordered pairs, dropping entries whose value is not a
 * non-empty string. Anything that is not an object normalizes to an empty list.
 */
export function normalizePriorityColors(colors: unknown): Array<[string, string]> {
  if (!isRecord(colors)) return [];
  return Object.entries(colors).filter((e): e is [string, string] => usableColor(e[1]));
}

export function resolveConfig(config: ConditionalFormatConfig | undefined): ResolvedConfig {
  const c: ConditionalFormatConfig = isRecord(config) ? config : {};

  const rules: ConditionalFormatRule[] = normalizeRules(c.rules);

  const priorityColors: Array<[string, string]> = normalizePriorityColors(c.priorityColors);

  let overdue: ResolvedOverdue | null = null;
  if (c.overdue === true) overdue = { color: OVERDUE_COLOR, icon: true };
  else if (isRecord(c.overdue)) {
    overdue = {
      color: usableColor(c.overdue.color) ? c.overdue.color : OVERDUE_COLOR,
      icon: c.overdue.icon !== false,
    };
  }

  let progress: ResolvedProgress | null = null;
  if (c.progress === true) {
    progress = {
      behind: PROGRESS_BEHIND_COLOR,
      onTrack: PROGRESS_ON_TRACK_COLOR,
      complete: PROGRESS_COMPLETE_COLOR,
    };
  } else if (isRecord(c.progress)) {
    progress = {
      behind: usableColor(c.progress.behind) ? c.progress.behind : PROGRESS_BEHIND_COLOR,
      onTrack: usableColor(c.progress.onTrack) ? c.progress.onTrack : PROGRESS_ON_TRACK_COLOR,
      complete: usableColor(c.progress.complete) ? c.progress.complete : PROGRESS_COMPLETE_COLOR,
    };
  }

  return {
    rules,
    priorityColors,
    overdue,
    progress,
    legend: c.legend === true,
    now: typeof c.now === "function" ? c.now : Date.now,
  };
}
