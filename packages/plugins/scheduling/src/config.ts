// docs/specs/plugins/scheduling.md §11
/**
 * `SchedulingConfig` — the five configuration nests, each covering a distinct feature area, and
 * their resolution.
 *
 * **Presence semantics (§11, normative).** The `dependencies` nest — the one preset-bundled UI
 * feature — is ENABLED with the defaults below when omitted. The `calendars`, `criticalPath` and
 * `diagnostics` nests — opt-in features — leave their features DORMANT when omitted (no registry
 * seed, no shading, no CP visuals, no panel); passing the nest, even `{}`, enables the feature with
 * the defaults below. `autoSchedule` needs no presence gating: the engine service is always
 * provided and its two fields default as listed.
 *
 * Every unusable field value silently falls back to its default, and everything is read once at
 * `setup()`, so a later mutation of the host's object cannot change a running chart.
 */
import type { CalendarDef, CalendarId, LinkType } from "@stargantt/plugin-data-store";
import type { SchedulingMessages } from "./internal/messages";

/* ------------------------------------------------------------------ *
 * Calendar registry entries (§1.2)
 * ------------------------------------------------------------------ */

/** A registry calendar: a `CalendarDef` plus registry-only metadata. */
export interface CalendarInit extends CalendarDef {
  /** Human-readable name shown by editors and pickers. Defaults to `String(id)`. */
  name?: string;
  /**
   * Marks the project-default calendar: used for tasks without a `calendarId`, shaded when
   * `calendars.shadeCalendar` is omitted, and the `snap/workingTime` default (§4.1). At most one
   * entry should carry it; when several do, the first registered wins.
   */
  isDefault?: boolean;
}

/* ------------------------------------------------------------------ *
 * Raw config (what the host passes)
 * ------------------------------------------------------------------ */

/** Line geometry of a dependency route (§5.3). */
export interface LinkStyleConfig {
  /** Stroke width in CSS px. Default `1.5`. */
  width?: number;
  /** Canvas dash pattern. Omitted means solid. */
  dash?: readonly number[];
  /** Arrowhead form. Default `"filled"`. */
  arrowHead?: "filled" | "open" | "none";
}

/** Which sections the working-calendar editor carries (§6.3). */
export type CalendarEditorSection = "days" | "hours" | "periods" | "assign";

/** §11.1 — dependency links. Enabled with these defaults when the nest is omitted. */
export interface DependenciesConfig {
  /** Ports, port drag, keyboard chord, 17 px end-gutter reservation. Default `true`. */
  allowLinkCreate?: boolean;
  /** Line routing. Default `"elbow"`. */
  routingStyle?: "elbow" | "straight";
  /** Keyboard-path link type; the pointer path always derives it. Default `"FS"`. */
  defaultLinkType?: LinkType;
  /** Lag filled in on both creation paths, in ms; negative is a lead. Default: none. */
  defaultLag?: number;
  /** Whether routed lines are painted and answer link hits. Default `true`. */
  showLinks?: boolean;
  /** Line geometry (§5.3). */
  linkStyle?: LinkStyleConfig;
  /** Per-type line colour; non-string and empty entries are ignored. Default `{}`. */
  typeColors?: Partial<Record<LinkType, string>>;
  /** Click-to-select a line; Delete/Backspace remove, Escape deselects. Default `false`. */
  linkEditing?: boolean;
  /** Hover + selection dependency-path emphasis. Default `false`. */
  highlightPaths?: boolean;
  /** The side-panel dependency inspector. Default `false`. */
  inspector?: boolean;
  /** Drop-candidate ring during a link drag. Default `false`. */
  highlightDropTargets?: boolean;
  /** Negative-slack links drawn in `conflictColor` and dashed. Default `false`. */
  highlightConflicts?: boolean;
  /** The conflict warning colour. Default `"#dc2626"`. */
  conflictColor?: string;
  /** Zero-slack links drawn thicker in the driving token. Default `false`. */
  highlightDriving?: boolean;
  /** Skip drawing lines wholly outside the horizontal window. Default `false`. */
  cullLines?: boolean;
  /** Elbow routes detour around intervening bars. Default `false`. */
  avoidBars?: boolean;
}

/** §11.2 — the headless engine. */
export interface AutoScheduleConfig {
  /**
   * Turns on automatic propagation along dependency links and summary roll-up, inside the edit's
   * own transaction. Off by default: a chart that composes this plugin and says nothing else moves
   * only what the user edited. The service stays fully functional for direct calls either way, and
   * cycle rejection is unaffected (§2.7).
   */
  enabled?: boolean;
  /** Contributes the read-only schedule-mode grid column (§2.4). Default `false`. */
  modeColumn?: boolean;
}

/** §11.3 — working calendars. Dormant when the nest is omitted. */
export interface CalendarsConfig {
  /** Initial registry, registered in order at setup; unusable entries are ignored. */
  calendars?: readonly CalendarInit[];
  /** Which calendar's non-working time is shaded. Default: the registry default. */
  shadeCalendar?: CalendarId;
  /**
   * Whether registry calendars are reflected into automatic scheduling (§2.2). `false`: the engine
   * resolves against the data store alone, the no-calendars behaviour. Default `true`.
   */
  scheduling?: boolean;
  /** Whether the editor is mounted and which sections it carries (§6.3). Default `false`. */
  editor?: boolean | { sections?: readonly CalendarEditorSection[] };
}

/** §11.4 — critical-path visuals. Dormant when the nest is omitted. */
export interface CriticalPathConfig {
  /** Master switch for all visuals; the analysis service works either way. Default `true`. */
  enabled?: boolean;
  /** Total float at or below this many fixed days counts as critical. Default `0`. */
  thresholdDays?: number;
  /** Width of the near-critical band; `0` turns the class off. Default `0`. */
  nearCriticalDays?: number;
  /** Critical bar / outline / link colour override. Default: token, then fallback. */
  criticalColor?: string;
  /** Near-critical bar / outline colour override. Default: token, then fallback. */
  nearCriticalColor?: string;
  /** Negative-float bar / outline colour override. Default: token, then fallback. */
  negativeFloatColor?: string;
  /** Recolour + outline classified bars. Default `true`. */
  highlightBars?: boolean;
  /** Critical-link emphasis strokes. Default `true`. */
  highlightLinks?: boolean;
  /** Free-float extension bars. Default `false`. */
  showFloat?: boolean;
  /** Free-float bar fill override. Default: token, then fallback. */
  floatColor?: string;
}

/** §11.5 — the schedule-diagnostics panel. Dormant when the nest is omitted. */
export interface DiagnosticsConfig {
  /** Mounts the findings panel (§8). Counts as `false` unless exactly `true`. */
  panel?: boolean;
}

/** Options for the scheduling plugin. */
export interface SchedulingConfig {
  /** Dependency links (§5). Enabled with its defaults when omitted. */
  dependencies?: DependenciesConfig;
  /** The headless engine (§2). */
  autoSchedule?: AutoScheduleConfig;
  /** Working calendars (§6). Dormant when omitted. */
  calendars?: CalendarsConfig;
  /** Critical path (§7). Dormant when omitted. */
  criticalPath?: CriticalPathConfig;
  /** Schedule diagnostics (§8). Dormant when omitted. */
  diagnostics?: DiagnosticsConfig;
  /** Per-key replacements for the plugin's user-visible strings (§12). */
  messages?: Partial<SchedulingMessages>;
}

/* ------------------------------------------------------------------ *
 * Resolved config (what the plugin runs on)
 * ------------------------------------------------------------------ */

/** The dependency nest with every field decided. */
export interface ResolvedDependencies {
  allowLinkCreate: boolean;
  routingStyle: "elbow" | "straight";
  defaultLinkType: LinkType;
  defaultLag: number | undefined;
  showLinks: boolean;
  linkStyle: {
    width: number;
    dash: readonly number[] | undefined;
    arrowHead: "filled" | "open" | "none";
  };
  typeColors: Readonly<Partial<Record<LinkType, string>>>;
  linkEditing: boolean;
  highlightPaths: boolean;
  inspector: boolean;
  highlightDropTargets: boolean;
  highlightConflicts: boolean;
  conflictColor: string;
  highlightDriving: boolean;
  cullLines: boolean;
  avoidBars: boolean;
}

/** The engine nest with every field decided. */
export interface ResolvedAutoSchedule {
  enabled: boolean;
  modeColumn: boolean;
}

/** The calendars nest with every field decided; `undefined` at the top level means dormant. */
export interface ResolvedCalendars {
  calendars: readonly CalendarInit[];
  shadeCalendar: CalendarId | undefined;
  scheduling: boolean;
  /** The sections the editor carries, or `undefined` when no editor is mounted. */
  editor: readonly CalendarEditorSection[] | undefined;
}

/** The critical-path nest with every field decided; `undefined` at the top level means dormant. */
export interface ResolvedCriticalPath {
  enabled: boolean;
  thresholdDays: number;
  nearCriticalDays: number;
  criticalColor: string | undefined;
  nearCriticalColor: string | undefined;
  negativeFloatColor: string | undefined;
  highlightBars: boolean;
  highlightLinks: boolean;
  showFloat: boolean;
  floatColor: string | undefined;
}

/** The diagnostics nest with every field decided; `undefined` at the top level means dormant. */
export interface ResolvedDiagnostics {
  panel: boolean;
}

/** Everything `setup()` runs on, read once. */
export interface ResolvedSchedulingConfig {
  /** Always present — the nest is enabled by default (§11). */
  dependencies: ResolvedDependencies;
  autoSchedule: ResolvedAutoSchedule;
  /** `undefined` when the nest was omitted: dormant, exactly as a chart without the feature enabled. */
  calendars: ResolvedCalendars | undefined;
  /** `undefined` when the nest was omitted. */
  criticalPath: ResolvedCriticalPath | undefined;
  /** `undefined` when the nest was omitted. */
  diagnostics: ResolvedDiagnostics | undefined;
}

/* ------------------------------------------------------------------ *
 * Field readers — an unusable value is exactly the default
 * ------------------------------------------------------------------ */

function bool(value: unknown, fallback: boolean): boolean {
  return typeof value === "boolean" ? value : fallback;
}

/** A finite number ≥ 0, or the default. */
function dayCount(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : fallback;
}

/** A non-empty string, or `undefined`. */
function color(value: unknown): string | undefined {
  return typeof value === "string" && value !== "" ? value : undefined;
}

const LINK_TYPES: readonly LinkType[] = ["FS", "SS", "FF", "SF"];
const EDITOR_SECTIONS: readonly CalendarEditorSection[] = ["days", "hours", "periods", "assign"];

function resolveDependencies(raw: DependenciesConfig | undefined): ResolvedDependencies {
  const nest = raw ?? {};
  const style = typeof nest.linkStyle === "object" && nest.linkStyle !== null ? nest.linkStyle : {};
  const dash = style.dash;
  const arrowHead = style.arrowHead;
  const typeColors: Partial<Record<LinkType, string>> = {};
  const rawColors =
    typeof nest.typeColors === "object" && nest.typeColors !== null ? nest.typeColors : {};
  for (const type of LINK_TYPES) {
    const entry = color(rawColors[type]);
    if (entry !== undefined) typeColors[type] = entry;
  }
  return {
    allowLinkCreate: bool(nest.allowLinkCreate, true),
    routingStyle: nest.routingStyle === "straight" ? "straight" : "elbow",
    defaultLinkType: LINK_TYPES.includes(nest.defaultLinkType as LinkType)
      ? (nest.defaultLinkType as LinkType)
      : "FS",
    defaultLag:
      typeof nest.defaultLag === "number" && Number.isFinite(nest.defaultLag)
        ? nest.defaultLag
        : undefined,
    showLinks: bool(nest.showLinks, true),
    linkStyle: {
      width:
        typeof style.width === "number" && Number.isFinite(style.width) && style.width > 0
          ? style.width
          : 1.5,
      dash:
        Array.isArray(dash) && dash.every((n) => typeof n === "number" && Number.isFinite(n))
          ? [...dash]
          : undefined,
      arrowHead: arrowHead === "open" || arrowHead === "none" ? arrowHead : "filled",
    },
    typeColors,
    linkEditing: bool(nest.linkEditing, false),
    highlightPaths: bool(nest.highlightPaths, false),
    inspector: bool(nest.inspector, false),
    highlightDropTargets: bool(nest.highlightDropTargets, false),
    highlightConflicts: bool(nest.highlightConflicts, false),
    conflictColor: color(nest.conflictColor) ?? "#dc2626",
    highlightDriving: bool(nest.highlightDriving, false),
    cullLines: bool(nest.cullLines, false),
    avoidBars: bool(nest.avoidBars, false),
  };
}

function resolveAutoSchedule(raw: AutoScheduleConfig | undefined): ResolvedAutoSchedule {
  const nest = raw ?? {};
  return {
    // Propagation is opt-in. A first-time user dragging one bar and watching three
    // others move reads it as the chart corrupting itself.
    enabled: nest.enabled === true,
    modeColumn: nest.modeColumn === true,
  };
}

function resolveEditor(
  raw: CalendarsConfig["editor"],
): readonly CalendarEditorSection[] | undefined {
  if (raw === true) return EDITOR_SECTIONS;
  if (typeof raw !== "object" || raw === null) return undefined;
  const listed = raw.sections;
  if (!Array.isArray(listed)) return EDITOR_SECTIONS;
  const sections = EDITOR_SECTIONS.filter((section) => listed.includes(section));
  return sections.length === 0 ? undefined : sections;
}

function resolveCalendars(raw: CalendarsConfig | undefined): ResolvedCalendars | undefined {
  if (raw === undefined) return undefined;
  const nest = typeof raw === "object" && raw !== null ? raw : {};
  const listed = Array.isArray(nest.calendars) ? nest.calendars : [];
  return {
    calendars: listed.filter(isUsableCalendarInit),
    shadeCalendar:
      typeof nest.shadeCalendar === "string" || typeof nest.shadeCalendar === "number"
        ? nest.shadeCalendar
        : undefined,
    scheduling: bool(nest.scheduling, true),
    editor: resolveEditor(nest.editor),
  };
}

/** A usable registry definition has a string/number `id` and an array `workingDays` (§1.2). */
export function isUsableCalendarInit(candidate: unknown): candidate is CalendarInit {
  if (typeof candidate !== "object" || candidate === null) return false;
  const init = candidate as Partial<CalendarInit>;
  const id = init.id;
  if (typeof id !== "string" && typeof id !== "number") return false;
  return Array.isArray(init.workingDays);
}

function resolveCriticalPath(raw: CriticalPathConfig | undefined): ResolvedCriticalPath | undefined {
  if (raw === undefined) return undefined;
  const nest = typeof raw === "object" && raw !== null ? raw : {};
  return {
    enabled: bool(nest.enabled, true),
    thresholdDays: dayCount(nest.thresholdDays, 0),
    nearCriticalDays: dayCount(nest.nearCriticalDays, 0),
    criticalColor: color(nest.criticalColor),
    nearCriticalColor: color(nest.nearCriticalColor),
    negativeFloatColor: color(nest.negativeFloatColor),
    highlightBars: bool(nest.highlightBars, true),
    highlightLinks: bool(nest.highlightLinks, true),
    showFloat: bool(nest.showFloat, false),
    floatColor: color(nest.floatColor),
  };
}

function resolveDiagnostics(raw: DiagnosticsConfig | undefined): ResolvedDiagnostics | undefined {
  if (raw === undefined) return undefined;
  const nest = typeof raw === "object" && raw !== null ? raw : {};
  return { panel: nest.panel === true };
}

/** Reads every nest once, applying the §11 presence semantics and per-field fallbacks. */
export function resolveConfig(raw: SchedulingConfig): ResolvedSchedulingConfig {
  return {
    dependencies: resolveDependencies(raw.dependencies),
    autoSchedule: resolveAutoSchedule(raw.autoSchedule),
    calendars: resolveCalendars(raw.calendars),
    criticalPath: resolveCriticalPath(raw.criticalPath),
    diagnostics: resolveDiagnostics(raw.diagnostics),
  };
}
