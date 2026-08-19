// docs/specs/plugins/resource.md §7
/**
 * `ResourceMessages` — the plugin's single merged message catalog.
 *
 * 37 keys, merged from the sub-area catalogs of resource-assign (9), resource-view (6),
 * resource-utilization (13) and load-chart (11). Two collisions were MERGED (identical role and
 * default on both sides): `closeLabel` (utilization + load-chart, `"Close"`) and `duration`
 * (utilization + load-chart — the plugin's ONE duration formatter, routed through every built-in
 * duration-embedding text). One collision was prefixed on both sides by feature area:
 * `columnHeader` → `assignColumnHeader` / `utilizationColumnHeader`. resource-pool contributed no
 * catalog (it renders nothing).
 *
 * Resolution is `sdk/dom`'s `resolveCatalog`: per-key shallow override, a key of the wrong kind is
 * ignored, the empty string is usable and taken verbatim, and a throwing builder is reported once
 * (latched for the life of the catalog) and answered by the built-in default from then on — a
 * "latched" behavior that matters for the builder members actually invoked per-cell / per-frame:
 * `chipLabel`, `teamSummary`, `rowLabel`, `segmentLabel`, `overallocatedCell`, `teamCardLine`,
 * `roleLine`, `trendLabel`, `heatmapCellLabel`, `laneLabel`, `duration`; the assignment-editor
 * builders (`chipLabel`, `unitsInputLabel`, `assignToggleLabel`) are gesture-driven and never
 * notice the latch in practice.
 *
 * `bandResizeLabel` / `lanesResizeLabel` / `resizeLabel` are divider accessible names — a
 * focusable separator is never unnamed — so an empty or blank override falls back to the built-in
 * default instead of suppressing it, unlike every other string member (which accepts `""` as
 * suppression, per `resolveCatalog`'s ordinary rule). `resolveMessages` below applies that one
 * adjustment on top of `resolveCatalog`.
 *
 * Duration seam: `bandLabel`, `laneLabel`, `heatmapCellLabel` (load-chart) and `teamCardLine`,
 * `roleLine`, `trendLabel` (utilization) embed a working-time duration and print it through the
 * catalog's own `duration` member rather than formatting it themselves. Overriding `duration`
 * alone does not retroactively change those six builders' *already-built* closures —
 * `bindDuration` (below) is the seam that re-binds them. A builder the host replaced wholesale is
 * left exactly as given: it never consulted the seam to begin with.
 */
import { MS_DAY, MS_MINUTE, formatDurationMs, resolveCatalog } from "@stargantt/sdk";

/* ------------------------------------------------------------------ *
 * Small argument shapes the builders below need
 * ------------------------------------------------------------------ */

/** Arguments of the `chipLabel` builder: one assignment chip's resource name and allocation. */
export interface ChipLabelParts {
  /** The assigned resource's display name. */
  name: string;
  /** The assignment's allocation, as a rounded percent (100 = full-time). */
  unitsPercent: number;
}

/** The input handed to the `teamSummary` message builder: one team's aggregate numbers. */
export interface ResourceViewTeamSummaryInput {
  name: string;
  memberCount: number;
  /** Sum of the members' capacities (1 = one full-time equivalent). */
  capacity: number;
  /** Largest concurrent sum of the members' assignment units anywhere in the data. */
  peak: number;
  /** `capacity - peak`; negative when the team as a whole is overbooked. */
  free: number;
  /** Number of members whose own peak exceeds their own capacity. */
  overloadedMembers: number;
}

/** The input handed to the `rowLabel` message builder: one resource row's summary. */
export interface ResourceViewRowLabelInput {
  name: string;
  capacity: number;
  peak: number;
  /** `true` when the resource's peak concurrent allocation exceeds its capacity. */
  over: boolean;
}

/** The input handed to the `segmentLabel` message builder: one task segment on a row. */
export interface ResourceViewSegmentLabelInput {
  taskName: string;
  /** The assignment's allocation as a rounded percent (100 = full-time). */
  unitsPercent: number;
  /** The task's project attribution, or `null` when it has none. */
  project: string | null;
  /** `true` when the segment overlaps one of its row's overallocation windows. */
  over: boolean;
}

/** Arguments of the `overallocatedCell` builder: the names of the task's over-allocated resources. */
export interface OverallocatedCellParts {
  resources: readonly string[];
}

/**
 * Arguments of the `teamCardLine` builder: one team's capacity rollup. Mirrors the shape
 * `internal/engine/rollups.ts` produces; declared here so this catalog does not depend on that
 * module. All quantities are working milliseconds over the analysis range.
 */
export interface TeamCardLineParts {
  team: string;
  allocated: number;
  capacity: number;
  /** `max(0, capacity − allocated)`. */
  available: number;
  resourceCount: number;
  /** Team members with at least one over-allocated bucket in the range. */
  overallocatedCount: number;
}

/**
 * Arguments of the `roleLine` builder: one role's demand rollup. Mirrors the shape
 * `internal/engine/rollups.ts` produces; declared here so this catalog does not depend on that
 * module.
 */
export interface RoleLineParts {
  role: string;
  demand: number;
  capacity: number;
  ratio: number | null;
}

/** Arguments of the `trendLabel` builder: the demand-vs-supply trend graph's summary numbers. */
export interface TrendLabelParts {
  bucketCount: number;
  rangeStart: number;
  rangeEnd: number;
  peakDemand: number;
  peakSupply: number;
}

/**
 * The input handed to the `bandLabel` builder: a summary of the currently rendered band.
 *
 * `rangeStart` / `rangeEnd` bound the rendered buckets as epoch milliseconds (half-open),
 * `bucketCount` is the number of rendered buckets, `peakLoad` is the largest bar value,
 * `peakCapacity` is the largest capacity-line value (`null` when no capacity line is drawn
 * anywhere in the range), `overloadedBuckets` counts buckets whose bar exceeds their capacity,
 * `valueKind` says what the two peaks measure, and `fallback` is `true` when the task-count
 * fallback mode is active.
 */
export interface LoadChartBandLabelInput {
  rangeStart: number;
  rangeEnd: number;
  bucketCount: number;
  peakLoad: number;
  peakCapacity: number | null;
  overloadedBuckets: number;
  fallback: boolean;
  /**
   * What `peakLoad` and `peakCapacity` measure, so a wholesale replacement of this text can make
   * the same distinction the built-in wording does without guessing at the band's configuration:
   *
   * - `"durationMs"` — milliseconds of working time, because the band is summing the per-resource
   *   load matrix. Render them through the `duration` catalog member, never as a raw number.
   * - `"units"` — dimensionless numbers: sums of assigned units, or a plain count of active tasks
   *   when `fallback` is `true`.
   */
  valueKind: "units" | "durationMs";
}

/** The input handed to the `lanesLabel` builder: how many resource lanes are rendered. */
export interface LoadChartLanesLabelInput {
  laneCount: number;
}

/**
 * The input handed to the `laneLabel` builder: a summary of one rendered resource lane.
 *
 * `resourceName` names the lane's resource, `rangeStart` / `rangeEnd` bound the rendered buckets
 * as epoch milliseconds (half-open), `bucketCount` is the number of rendered buckets, `peakLoad`
 * is the lane's largest bar value, `valueKind` says what that value measures, `capacity` is the
 * resource's dimensionless capacity rate (1 for full-time), and `overloadedBuckets` counts the
 * lane's buckets whose load exceeds their own capacity.
 */
export interface LoadChartLaneLabelInput {
  resourceName: string;
  rangeStart: number;
  rangeEnd: number;
  bucketCount: number;
  peakLoad: number;
  capacity: number;
  overloadedBuckets: number;
  /**
   * What `peakLoad` measures, which follows the active lane scale — so a wholesale replacement of
   * this text can make the same distinction the built-in wording does without guessing at the
   * configured scale:
   *
   * - `"ratio"` — a utilization fraction of the resource's own capacity (1 = 100 %), what the
   *   ratio lane scale draws. Render it as a plain number.
   * - `"durationMs"` — milliseconds of working time, what the absolute lane scales draw. Render it
   *   through the `duration` catalog member, never as a raw number.
   *
   * `capacity` is a dimensionless rate either way, so it is unaffected.
   */
  valueKind: "ratio" | "durationMs";
}

/**
 * The input handed to the `heatmapCellLabel` builder: one resource × bucket cell plus its
 * resource's name.
 *
 * `start` / `end` bound the bucket as epoch milliseconds (half-open); `allocated` / `capacity`
 * accrue over the **working milliseconds** inside the bucket (effort, not a rate); `ratio` is
 * `allocated / capacity`, or `null` when the bucket has no capacity. Flattened from
 * `UtilizationReportCell` (that type belongs to the report engine, not this catalog) rather than
 * extending across a module this file does not depend on.
 */
export interface LoadChartHeatmapCellInput {
  readonly start: number;
  readonly end: number;
  readonly allocated: number;
  readonly capacity: number;
  readonly ratio: number | null;
  readonly resourceName: string;
}

/**
 * The utilization report's fixed column order: the resource name, the bucket's first and
 * inclusive last ISO day (or minute, for sub-day buckets), the allocated load, the capacity, and
 * the utilization ratio.
 */
export type UtilizationReportColumn =
  | "resource"
  | "from"
  | "to"
  | "allocated"
  | "capacity"
  | "utilization";

/** docs/specs/plugins/resource.md §7 — the CSV header row and PDF table header share this order. */
export const REPORT_COLUMNS: readonly UtilizationReportColumn[] = [
  "resource",
  "from",
  "to",
  "allocated",
  "capacity",
  "utilization",
];

const REPORT_HEADERS: Record<UtilizationReportColumn, string> = {
  resource: "Resource",
  from: "From",
  to: "To",
  allocated: "Allocated",
  capacity: "Capacity",
  utilization: "Utilization",
};

/** Formats a working-time duration given in milliseconds. */
export type DurationFormat = (ms: number) => string;

/* ------------------------------------------------------------------ *
 * The catalog
 * ------------------------------------------------------------------ */

/** Every user-visible string this plugin can show. */
export interface ResourceMessages {
  /* --- resource-assign (9, `columnHeader` renamed `assignColumnHeader`) --------------------- */
  /** Header of the contributed Resources grid column. Default `"Resources"`. */
  assignColumnHeader: string;
  /** Accessible name of the assignment editor dialog. Default `"Assign resources"`. */
  editorTitle: string;
  /** Text shown in the editor when there is no resource to offer. Default `"No resources available"`. */
  emptyChoices: string;
  /** Label of the editor's commit button. Default `"Apply"`. */
  applyLabel: string;
  /** Label of the editor's cancel button. Default `"Cancel"`. */
  cancelLabel: string;
  /** Accessible label of the per-cell open-editor button. Default `"Edit resource assignments"`. */
  openEditorLabel: string;
  /**
   * Text of one assignment chip. The default shows the name alone at 100% allocation and
   * `"<name> <percent>%"` otherwise.
   */
  chipLabel: (parts: ChipLabelParts) => string;
  /** Accessible label of a choice row's percent input. Default `"Allocation percent for <name>"`. */
  unitsInputLabel: (name: string) => string;
  /** Accessible label of a choice row's checkbox. Default `"Assign <name>"`. */
  assignToggleLabel: (name: string) => string;

  /* --- resource-view (6) ----------------------------------------------------------------------- */
  /** Accessible name (`aria-label`) of the resource-view panel, also its visible header text. */
  panelLabel: string;
  /** Header of the trailing group collecting resources no configured team claims. */
  ungroupedTeam: string;
  /**
   * Accessible name of the divider that resizes a strip. Shared by the resource-view panel's own
   * divider; the load-chart band and lanes strips have their own two members below. An empty or
   * blank override falls back to the default.
   */
  resizeLabel: string;
  /** Builds a team group's header text. */
  teamSummary: (input: ResourceViewTeamSummaryInput) => string;
  /** Builds a resource row's name-column text. */
  rowLabel: (input: ResourceViewRowLabelInput) => string;
  /** Builds a task segment's text. */
  segmentLabel: (input: ResourceViewSegmentLabelInput) => string;

  /* --- resource-utilization (13, `columnHeader` renamed `utilizationColumnHeader`) ------------- */
  /** Header of the contributed Overallocation grid column. Default `"Overallocation"`. */
  utilizationColumnHeader: string;
  /**
   * Text of a warning cell, given the names of the task's over-allocated resources. The default
   * is `"⚠ Over: "` followed by the comma-joined names.
   */
  overallocatedCell: (input: OverallocatedCellParts) => string;
  /** Heading of the team capacity summary panel. Default `"Team capacity"`. */
  summaryTitle: string;
  /**
   * Text of one team card of the summary panel. The default reads
   * `"<team>: <allocated> allocated of <capacity>, <available> free"`, appending
   * `" (<n> overallocated)"` when the team has over-allocated members. Each quantity is a
   * working-time duration rendered by the `duration` member.
   */
  teamCardLine: (input: TeamCardLineParts) => string;
  /** Heading of the summary panel's demand-by-role section. Default `"Demand by role"`. */
  roleTitle: string;
  /**
   * Text of one role row of the summary panel. The default reads
   * `"<role>: <demand> demand of <capacity> capacity"`, both quantities rendered by the
   * `duration` member.
   */
  roleLine: (input: RoleLineParts) => string;
  /** Heading of the trend panel. Default `"Demand vs supply"`. */
  trendTitle: string;
  /**
   * Accessible name of the trend graph. The default reads
   * `"Demand vs supply, <n> buckets: peak demand <d>, peak supply <s>."`, both peaks rendered by
   * the `duration` member.
   */
  trendLabel: (input: TrendLabelParts) => string;
  /** Legend text of the trend's demand line. Default `"Demand"`. */
  demandLegend: string;
  /** Legend text of the trend's supply line. Default `"Supply"`. */
  supplyLegend: string;
  /**
   * Accessible label of a panel's close button — shared by the utilization panels and the
   * load-chart heatmap card (identical role and default on both sides). Default `"Close"`.
   */
  closeLabel: string;
  /** Team name used when no team accessor is configured. Default `"All resources"`. */
  defaultTeamName: string;
  /**
   * Formats a working-time duration, given in milliseconds, for display — the plugin's ONE
   * duration formatter, merged from resource-utilization and load-chart. Every built-in text that
   * embeds a duration calls this resolved member, so replacing this one key re-skins them all; a
   * wholesale-replaced sibling builder simply never consults it. The default picks its unit from
   * the magnitude: `"1.5d"`, `"4h"`, `"30m"`, `"12s"` (the sdk formatter).
   */
  duration: DurationFormat;

  /* --- load-chart (11) --------------------------------------------------------------------------- */
  /** Builds the accessible name (`aria-label`) of the load-chart band. */
  bandLabel: (input: LoadChartBandLabelInput) => string;
  /**
   * Builds the accessible name of the resource-lane strip as a whole, from the number of lanes it
   * currently holds.
   */
  lanesLabel: (input: LoadChartLanesLabelInput) => string;
  /**
   * Builds one resource lane's accessible name from that lane's own rendered numbers, so a screen
   * reader hears what is on screen.
   */
  laneLabel: (input: LoadChartLaneLabelInput) => string;
  /**
   * Accessible name of the divider that resizes the aggregate load band. Default
   * `"Resize load chart band"`; an empty or blank override falls back to it.
   */
  bandResizeLabel: string;
  /**
   * Accessible name of the divider that resizes the resource-lane strip. Default
   * `"Resize resource lanes"`; an empty or blank override falls back to it.
   */
  lanesResizeLabel: string;
  /** Heading and accessible name of the load heatmap panel. Default `"Load heatmap"`. */
  heatmapTitle: string;
  /**
   * Accessible label / title of one heatmap cell. Durations go through the `duration` member; the
   * bucket stamps use inclusive ISO stamps at day resolution for day-or-wider buckets, minute
   * resolution below.
   */
  heatmapCellLabel: (input: LoadChartHeatmapCellInput) => string;
  /** Title line of the exported PDF report. Default `"Resource utilization report"`. */
  reportTitle: string;
  /**
   * Header text of one report column, used for the CSV header row and the PDF table header.
   */
  reportColumnHeader: (column: UtilizationReportColumn) => string;
}

/* ------------------------------------------------------------------ *
 * Duration-embedding builders — the duration seam
 * ------------------------------------------------------------------ */

/**
 * The six built-in builders that print a working-time quantity through the resolved `duration`
 * member, keyed by catalog key. `bindDuration` rebuilds exactly these from a new formatter,
 * leaving every other member (including a host-replaced one of these six) untouched.
 */
type DurationTextKey =
  | "bandLabel"
  | "laneLabel"
  | "heatmapCellLabel"
  | "teamCardLine"
  | "roleLine"
  | "trendLabel";

const DURATION_TEXT_KEYS: readonly DurationTextKey[] = [
  "bandLabel",
  "laneLabel",
  "heatmapCellLabel",
  "teamCardLine",
  "roleLine",
  "trendLabel",
];

/**
 * The built-in duration-embedding builders this module has produced, so `bindDuration` recognizes
 * its own closures however often the catalog is rebuilt, and never overwrites one the host
 * supplied.
 */
const BUILT_IN_DURATION_TEXTS = new WeakSet<object>();

function marked<F extends object>(fn: F): F {
  BUILT_IN_DURATION_TEXTS.add(fn);
  return fn;
}

/** The locale `DEFAULT_MESSAGES` is built with — also what `bindDuration` rebuilds against. */
const DEFAULT_LOCALE = "en-US";

/* ------------------------------------------------------------------ *
 * Default catalog construction
 * ------------------------------------------------------------------ */

/**
 * Builds the built-in English catalog, bound to one locale's date/number formatting and one
 * `duration` formatter. `duration` is the resolved catalog member every built-in duration-
 * embedding text routes through; it becomes this catalog's own `duration` member too, so a caller
 * that wants the duration seam to agree everywhere passes the same formatter it means to publish
 * as `duration`.
 *
 * Omitting `messages` (or passing `{}`) to the plugin config reproduces this wording byte for
 * byte, given `createDefaultMessages("en-US", <the sdk duration formatter>)`.
 */
export function createDefaultMessages(locale: string, duration: DurationFormat): ResourceMessages {
  const dateFormat = new Intl.DateTimeFormat(locale, {
    year: "numeric",
    month: "short",
    day: "numeric",
    timeZone: "UTC",
  });
  // The same stamp with a time of day, used only where the buckets being described are narrower
  // than a day.
  const dateTimeFormat = new Intl.DateTimeFormat(locale, {
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    timeZone: "UTC",
  });
  /**
   * The formatter matching a bucket width of `widthMs` — day resolution at a day or wider, minute
   * resolution below it. A width that is not a positive finite number reads as day resolution.
   */
  const stampsFor = (widthMs: number): Intl.DateTimeFormat =>
    widthMs > 0 && widthMs < MS_DAY ? dateTimeFormat : dateFormat;
  /** The bucket's inclusive last point: one day back at day resolution, one minute below it. */
  const inclusiveEnd = (start: number, end: number): number =>
    Math.max(start, end - (end - start < MS_DAY ? MS_MINUTE : MS_DAY));
  const numberFormat = new Intl.NumberFormat(locale);
  // teamSummary/segmentLabel round to 2 decimals rather than the load-chart side's whole-number
  // default.
  const teamNumberFormat = new Intl.NumberFormat(locale, { maximumFractionDigits: 2 });

  const bandLabel = marked((input: LoadChartBandLabelInput): string => {
    const stamps = stampsFor((input.rangeEnd - input.rangeStart) / input.bucketCount);
    const start = stamps.format(input.rangeStart);
    const end = stamps.format(input.rangeEnd);
    if (input.fallback) {
      const peak = numberFormat.format(input.peakLoad);
      return `Resource load chart, ${input.bucketCount} buckets from ${start} to ${end}: peak of ${peak} active tasks.`;
    }
    const value = input.valueKind === "durationMs" ? duration : (n: number): string => numberFormat.format(n);
    const peakLoad = value(input.peakLoad);
    if (input.peakCapacity === null) {
      return `Resource load chart, ${input.bucketCount} buckets from ${start} to ${end}: peak load ${peakLoad}.`;
    }
    const peakCapacity = value(input.peakCapacity);
    return `Resource load chart, ${input.bucketCount} buckets from ${start} to ${end}: peak load ${peakLoad} of capacity ${peakCapacity}, ${input.overloadedBuckets} overloaded.`;
  });

  const lanesLabel = (input: LoadChartLanesLabelInput): string =>
    `Resource load by resource, ${input.laneCount} resources.`;

  const laneLabel = marked((input: LoadChartLaneLabelInput): string => {
    const stamps = stampsFor((input.rangeEnd - input.rangeStart) / input.bucketCount);
    const start = stamps.format(input.rangeStart);
    const end = stamps.format(input.rangeEnd);
    const peakLoad =
      input.valueKind === "ratio" ? numberFormat.format(input.peakLoad) : duration(input.peakLoad);
    const capacity = numberFormat.format(input.capacity);
    return `${input.resourceName}, ${input.bucketCount} buckets from ${start} to ${end}: peak load ${peakLoad} of capacity ${capacity}, ${input.overloadedBuckets} overloaded.`;
  });

  const heatmapCellLabel = marked((input: LoadChartHeatmapCellInput): string => {
    const stamps = stampsFor(input.end - input.start);
    const from = stamps.format(input.start);
    const to = stamps.format(inclusiveEnd(input.start, input.end));
    const allocated = duration(input.allocated);
    const capacity = duration(input.capacity);
    const over = input.allocated > input.capacity ? ", overloaded" : "";
    return `${input.resourceName}, ${from} – ${to}: load ${allocated} of capacity ${capacity}${over}`;
  });

  const teamSummary = (input: ResourceViewTeamSummaryInput): string => {
    const base =
      `${input.name}: ${teamNumberFormat.format(input.memberCount)} members, ` +
      `capacity ${teamNumberFormat.format(input.capacity)}, peak load ${teamNumberFormat.format(input.peak)}, ` +
      `free ${teamNumberFormat.format(input.free)}`;
    return input.overloadedMembers > 0
      ? `${base}, ${teamNumberFormat.format(input.overloadedMembers)} overallocated`
      : base;
  };

  const rowLabel = (input: ResourceViewRowLabelInput): string =>
    input.over ? `${input.name} (overallocated)` : input.name;

  const segmentLabel = (input: ResourceViewSegmentLabelInput): string => {
    let text = input.taskName;
    if (input.unitsPercent !== 100) text += ` ${teamNumberFormat.format(input.unitsPercent)}%`;
    if (input.project !== null) text += ` [${input.project}]`;
    if (input.over) text += " (over)";
    return text;
  };

  const teamCardLine = marked(
    (t: TeamCardLineParts): string =>
      `${t.team}: ${duration(t.allocated)} allocated of ${duration(t.capacity)}, ` +
      `${duration(t.available)} free` +
      (t.overallocatedCount > 0 ? ` (${String(t.overallocatedCount)} overallocated)` : ""),
  );

  const roleLine = marked(
    (r: RoleLineParts): string => `${r.role}: ${duration(r.demand)} demand of ${duration(r.capacity)} capacity`,
  );

  const trendLabel = marked(
    (i: TrendLabelParts): string =>
      `Demand vs supply, ${String(i.bucketCount)} buckets: ` +
      `peak demand ${duration(i.peakDemand)}, peak supply ${duration(i.peakSupply)}.`,
  );

  return {
    assignColumnHeader: "Resources",
    editorTitle: "Assign resources",
    emptyChoices: "No resources available",
    applyLabel: "Apply",
    cancelLabel: "Cancel",
    openEditorLabel: "Edit resource assignments",
    chipLabel: ({ name, unitsPercent }) => (unitsPercent === 100 ? name : `${name} ${unitsPercent}%`),
    unitsInputLabel: (name) => `Allocation percent for ${name}`,
    assignToggleLabel: (name) => `Assign ${name}`,

    panelLabel: "Resource view",
    ungroupedTeam: "Other resources",
    resizeLabel: "Resize resource view",
    teamSummary,
    rowLabel,
    segmentLabel,

    utilizationColumnHeader: "Overallocation",
    overallocatedCell: ({ resources }) => `⚠ Over: ${resources.join(", ")}`,
    summaryTitle: "Team capacity",
    teamCardLine,
    roleTitle: "Demand by role",
    roleLine,
    trendTitle: "Demand vs supply",
    trendLabel,
    demandLegend: "Demand",
    supplyLegend: "Supply",
    closeLabel: "Close",
    defaultTeamName: "All resources",
    duration,

    bandLabel,
    lanesLabel,
    laneLabel,
    bandResizeLabel: "Resize load chart band",
    lanesResizeLabel: "Resize resource lanes",
    heatmapTitle: "Load heatmap",
    heatmapCellLabel,
    reportTitle: "Resource utilization report",
    reportColumnHeader: (column) => REPORT_HEADERS[column] ?? column,
  };
}

/** The built-in English catalog, `en-US`-formatted, with the sdk duration formatter. */
const DEFAULT_MESSAGES: ResourceMessages = createDefaultMessages(DEFAULT_LOCALE, (ms) => formatDurationMs(ms));

/** The key set of the catalog, in declaration order — the count the spec pins at 37. */
export const RESOURCE_MESSAGE_KEYS = Object.keys(DEFAULT_MESSAGES) as readonly (keyof ResourceMessages)[];

/** Divider keys whose accessible name never suppresses to empty. */
const DIVIDER_LABEL_KEYS = ["resizeLabel", "bandResizeLabel", "lanesResizeLabel"] as const;

/**
 * Resolves the host's per-key overrides against the built-in defaults (§7), via `sdk/dom`'s
 * `resolveCatalog`, then re-applies the divider-label rule: an override that is a blank (empty or
 * whitespace-only) string for `resizeLabel` / `bandResizeLabel` / `lanesResizeLabel` falls back to
 * the built-in default instead of suppressing the name — the one place this catalog's resolution
 * differs from `resolveCatalog`'s ordinary "`""` is a usable suppression" rule.
 */
export function resolveMessages(
  overrides: Partial<ResourceMessages> | undefined,
  onFault: (key: keyof ResourceMessages & string, error: unknown) => void,
): ResourceMessages {
  const resolved = resolveCatalog(DEFAULT_MESSAGES, overrides, onFault);
  for (const key of DIVIDER_LABEL_KEYS) {
    const supplied = overrides?.[key];
    if (typeof supplied === "string" && supplied.trim() === "") {
      resolved[key] = DEFAULT_MESSAGES[key];
    }
  }
  return resolved;
}

/**
 * Re-binds the six built-in duration-embedding builders (`bandLabel`, `laneLabel`,
 * `heatmapCellLabel`, `teamCardLine`, `roleLine`, `trendLabel`) to `duration`, leaving every other
 * member — and any of those six the host replaced wholesale — exactly as given.
 *
 * Intended use is after `resolveMessages`: `bindDuration(resolved, resolved.duration)` makes the
 * date/duration-embedding builders agree with whatever `duration` ended up being (host override or
 * default), without touching a builder the host replaced individually. The date-embedding builders
 * are always rebuilt against `DEFAULT_LOCALE` ("en-US"); `resolveMessages` carries no locale
 * parameter of its own; a host wanting a different locale for these six builds its own catalog with
 * `createDefaultMessages` instead.
 */
export function bindDuration(messages: ResourceMessages, duration: DurationFormat): ResourceMessages {
  const rebuilt = createDefaultMessages(DEFAULT_LOCALE, duration);
  const out = { ...messages };
  for (const key of DURATION_TEXT_KEYS) {
    if (BUILT_IN_DURATION_TEXTS.has(messages[key])) {
      (out as Record<DurationTextKey, unknown>)[key] = rebuilt[key];
    }
  }
  return out;
}

export { DEFAULT_MESSAGES };
