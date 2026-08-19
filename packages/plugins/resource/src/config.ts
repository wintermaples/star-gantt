// docs/specs/plugins/resource.md §6
/**
 * `ResourceConfig` — the five configuration nests, one per feature area
 * (`pool`, `assign`, `view`, `utilization`, `loadChart`), plus a single top-level `messages`
 * field, and their resolution.
 *
 * **Presence semantics (§6, normative).** Every nest omitted leaves its feature DORMANT — no
 * strip, no column, no glyph, no panel, no claim for that feature — while the two services stay
 * provided regardless (`stargantt.resource-pool` over an empty pool; `stargantt.utilization`
 * computing over whatever data exists). Passing a nest, even `{}`, enables it with the defaults
 * documented below.
 *
 * Every unusable field value silently falls back to its default, and
 * everything is read once at `setup()`, so a later mutation of the host's object cannot change a
 * running chart.
 */
import type { Assignment, CalendarDef, Resource, ResourceId, Task, TaskId } from "@stargantt/plugin-data-store";
import type { ResourceBucketInput } from "@stargantt/sdk";
import type { ResourceMessages } from "./internal/messages";
import type { UtilizationBucketUnit } from "./internal/engine/buckets";

/* ------------------------------------------------------------------ *
 * Resource-pool types (§1.1) — declared here, types only, no behavior. This file is the
 * canonical declaration site for the pool's public shapes; `internal/pool/` (`pool.ts`,
 * `calendar.ts`, `bookings.ts`, `guards.ts`) imports them from here. Transcribed verbatim from the
 * spec's §1.1 code block.
 * ------------------------------------------------------------------ */

/** The three resource kinds the pool distinguishes (classification metadata only). */
export type ResourceKind = "person" | "equipment" | "material";

/** The two booking stages: a soft hold and a firm reservation. */
export type BookingState = "tentative" | "confirmed";

/**
 * A per-resource working calendar: `CalendarDef` without the `id` (the calendar belongs to
 * exactly one pool entry). Field semantics are the data store's, evaluated in UTC by the one
 * shared working-time engine, `sdk/time`.
 */
export type ResourceWorkCalendar = Omit<CalendarDef, "id">;

/** Input shape for registering a time-off range. */
export interface ResourceTimeOffInit {
  id?: string;
  start?: number;
  end?: number;
  reason?: string;
}

/** Input shape for creating or updating a pool entry. Every member optional. */
export interface ResourcePoolEntryInit {
  /** Omitted on create, one is generated. Given, upsert targets that identity. */
  id?: ResourceId;
  /** Display name. An entry that would end up without a usable name is dropped / not applied. */
  name?: string;
  /** Default `"person"`. */
  kind?: ResourceKind;
  /**
   * Availability as a dimensionless full-time-equivalent rate (1 = full-time) — a multiplier, not
   * a per-day quantity. Omitted or unusable = absent; consumers apply their own default.
   */
  capacity?: number;
  /** Free-form skill tags. Normalized: non-empty strings, trimmed, deduplicated, order kept. */
  skills?: readonly string[];
  /** Per-resource working calendar. Omitted = the default calendar (§3.1). */
  calendar?: ResourceWorkCalendar;
  /** Initial time-off ranges. */
  timeOff?: readonly ResourceTimeOffInit[];
  /** Cost per hour in the host's currency. Non-finite or negative values ignored. */
  costRate?: number;
  /** Whether work by this resource is billed. Default `true`. */
  billable?: boolean;
}

/** A resolved pool entry as the service reports it. */
export interface ResourcePoolEntry {
  readonly id: ResourceId;
  readonly name: string;
  readonly kind: ResourceKind;
  /** Dimensionless FTE rate; absent when never set or unusable — never defaulted to 1 here. */
  readonly capacity?: number;
  readonly skills: readonly string[];
  readonly calendar?: Readonly<ResourceWorkCalendar>;
  readonly costRate?: number;
  readonly billable: boolean;
}

/** Input shape for creating a booking. */
export interface ResourceBookingInit {
  /** Omitted, one is generated. A given id already in use makes the init unusable. */
  id?: string;
  /** Must name a pool entry, else the init is unusable. */
  resourceId?: ResourceId;
  /** Optional link to a task. Never validated against the data store. */
  taskId?: TaskId;
  /** Epoch ms UTC, inclusive. Required in practice (finite, `< end`). */
  start?: number;
  /** Epoch ms UTC, exclusive. Required in practice (finite, `> start`). */
  end?: number;
  /** Default `"tentative"`. */
  state?: BookingState;
  /** Allocation rate over the range; 1 = full-time. Default 1; unusable values fall back. */
  units?: number;
  /** Per-booking billable override. Omitted, the resource's own flag applies. */
  billable?: boolean;
  /** Free-form host note. */
  note?: string;
}

/* ------------------------------------------------------------------ *
 * resource-view / load-chart shared input types the config surface references (§6.3 / §6.5)
 * ------------------------------------------------------------------ */

/**
 * A resource-view team: display name plus member ids. A team without a usable (non-empty) name is
 * dropped; ids the view does not know are ignored; an empty member list renders an empty group.
 */
export interface ResourceViewTeam {
  name?: string;
  members?: readonly (string | number)[];
}

/**
 * Per-bucket input handed to the load-chart band's `load` / `capacity` overrides — the band-only
 * hook shape, distinct from `ResourceBucketInput` (the per-resource cell shape `resourceLoad` /
 * `resourceCapacity` use everywhere else in this plugin). `bucketStart` / `bucketEnd` bound the
 * bucket as epoch milliseconds (half-open: start inclusive, end exclusive); `tasks` / `resources`
 * / `assignments` are already allowlist-narrowed.
 */
export interface LoadChartBucketInput {
  tasks: readonly Task[];
  resources: readonly Resource[];
  assignments: readonly Assignment[];
  bucketStart: number;
  bucketEnd: number;
}

/* ------------------------------------------------------------------ *
 * Raw config (what the host passes) — §6.1 through §6.5
 * ------------------------------------------------------------------ */

/** §6.1 — the resource pool. Presence-gated like every other nest (§6); the service is provided
 *  either way, over an empty pool when this nest is omitted. */
export interface ResourcePoolConfig {
  /** Entries loaded at setup, in order; unusable inits dropped. Default `[]`. */
  resources?: readonly ResourcePoolEntryInit[];
  /** Bookings loaded after `resources`. Default `[]`. */
  bookings?: readonly ResourceBookingInit[];
  /** One-way mirror into the data store (§3.1); inert without effect on the pool itself. Default `false`. */
  syncToStore?: boolean;
}

/** §6.2 — the assignment grid column and editor. */
export interface ResourceAssignConfig {
  /** Contribute the Resources grid column (§3.3). Default `true`. */
  column?: boolean;
  /** Column width, px; unusable values fall back. Default `160`. */
  columnWidth?: number;
  /** Chip drag between tasks (§3.3). Default `true`. */
  dragReassign?: boolean;
}

/** §6.3 — the resource-view bottom strip. */
export interface ResourceViewConfig {
  /** Strip contributed at height 0 unless true (§3.4). Default `false`. */
  startOpen?: boolean;
  /** Divider on the strip's top edge. Default `true`. */
  resizable?: boolean;
  /** Team grouping; unusable-name entries dropped, empty member lists render empty groups. */
  teams?: readonly ResourceViewTeam[];
  /**
   * Segment project attribution; latched barrier. Omitted, the built-in rule reads
   * `task.meta.project` when it is a non-empty string.
   */
  projectOf?: (task: Task) => string | null | undefined;
}

/** §6.4 — utilization analysis: warnings, the Overallocation column, the two panels. */
export interface ResourceUtilizationConfig {
  /** Default width of the utilization queries and warning surfaces. Default `"day"`. */
  bucket?: UtilizationBucketUnit;
  /** Week-bucket anchor of the utilization query surfaces, independent of the timeline header.
   *  Default `"monday"`. */
  weekStart?: "monday" | "sunday";
  /** Over-allocation threshold ratio (§2.4). Default `1`. */
  threshold?: number;
  /** The task-bar warning glyph (§3.5). Default `true`. */
  warnings?: boolean;
  /** The Overallocation grid column (§3.5). Default `true`. */
  column?: boolean;
  /** Open the team capacity panel at setup. Default `false`. */
  summaryPanel?: boolean;
  /** Open the demand-vs-supply panel at setup. Default `false`. */
  trendPanel?: boolean;
  /** Role accessor; latched barrier. Omitted, the role is the entry's first skill tag, else its
   *  kind. */
  role?: (entry: ResourcePoolEntry) => string | undefined;
  /** Team accessor; latched barrier. Omitted, every resource is grouped into one team named by
   *  the `defaultTeamName` message. */
  team?: (entry: ResourcePoolEntry) => string | undefined;
  /** Fixed default analysis range (both members required to be usable as a pair). Omitted, the
   *  task extent is used. */
  range?: { start?: number; end?: number };
  /**
   * Per-cell allocated-time hook of the UTILIZATION surfaces — queries, rollups, trend, warning
   * glyph, Overallocation column, both panels (§2.4). `input.resource` is the pool entry when the
   * pool knows the resource, else the store `Resource`. Never engages Σ mode.
   */
  resourceLoad?: (input: ResourceBucketInput<ResourcePoolEntry | Resource>) => number;
  /** The utilization-side per-cell capacity hook; same containment, reach, and resource object as
   *  `resourceLoad`. */
  resourceCapacity?: (input: ResourceBucketInput<ResourcePoolEntry | Resource>) => number;
}

/** §6.5 — the load chart: aggregate band, per-resource lanes, heatmap, reports. */
export interface LoadChartConfig {
  /** Band/lanes/heatmap/report width; `"auto"` follows zoom density (never sub-hour); unusable
   *  values fall back to `"day"`, not `"auto"`. Default `"day"`. */
  bucket?: UtilizationBucketUnit | "auto";
  /** Allowlist over bars, line, matrix rows, and hook inputs (§2.3). Default: all store resources. */
  resources?: readonly (string | number)[];
  /** Y-axis tick labels + gridlines (§3.6). Default `false`. */
  axisLabels?: boolean;
  /** Per-bar numeric labels, width-fit. Default `false`. */
  valueLabels?: boolean;
  /** Band-bar override (band only; ignored in Σ mode; suppresses the task-count fallback).
   *  Default: Σ `units` over active tasks. */
  load?: (input: LoadChartBucketInput) => number;
  /** Capacity-line override (band only; `null` = no line there; ignored in Σ mode). Default: Σ
   *  `capacity ?? 1`. */
  capacity?: (input: LoadChartBucketInput) => number | null;
  /**
   * Per-cell allocated-time hook of the LOAD-CHART surfaces — lanes, heatmap, reports, and (its
   * presence, or `resourceCapacity`'s, being the trigger) the band's Σ mode (§2.4, §3.6).
   * `input.resource` is always the store `Resource`.
   */
  resourceLoad?: (input: ResourceBucketInput<Resource>) => number;
  /** The load-chart-side per-cell capacity hook; same containment, reach, and Σ-mode trigger. */
  resourceCapacity?: (input: ResourceBucketInput<Resource>) => number;
  /** Open the heatmap at setup. Default `false`. */
  heatmap?: boolean;
  /** Show the lanes strip from the start. Default `false`. */
  lanes?: boolean;
  /** Show the aggregate band from the start. Default `false`. */
  total?: boolean;
  /** Lane scaling (§3.6). Default `"ratio"`. */
  laneScale?: "ratio" | "shared" | "auto";
  /** Per-run lane value labels. Default `false`. */
  laneValueLabels?: boolean;
  /** Dividers on both strips. Default `true`. */
  resizable?: boolean;
}

/** Options for the resource plugin. */
export interface ResourceConfig {
  /** The resource pool (§6.1). Dormant when omitted. */
  pool?: ResourcePoolConfig;
  /** The assignment grid column and editor (§6.2). Dormant when omitted. */
  assign?: ResourceAssignConfig;
  /** The resource-view bottom strip (§6.3). Dormant when omitted. */
  view?: ResourceViewConfig;
  /** Utilization analysis (§6.4). Dormant when omitted. */
  utilization?: ResourceUtilizationConfig;
  /** The load chart (§6.5). Dormant when omitted. */
  loadChart?: LoadChartConfig;
  /** Per-key replacements for the plugin's single merged catalog (§7). */
  messages?: Partial<ResourceMessages>;
}

/* ------------------------------------------------------------------ *
 * Resolved config (what the plugin runs on)
 * ------------------------------------------------------------------ */

/** The pool nest with every field decided; `undefined` at the top level means dormant. */
export interface ResolvedResourcePool {
  resources: readonly ResourcePoolEntryInit[];
  bookings: readonly ResourceBookingInit[];
  syncToStore: boolean;
}

/** The assign nest with every field decided; `undefined` at the top level means dormant. */
export interface ResolvedResourceAssign {
  column: boolean;
  columnWidth: number;
  dragReassign: boolean;
}

/** The view nest with every field decided; `undefined` at the top level means dormant. */
export interface ResolvedResourceView {
  startOpen: boolean;
  resizable: boolean;
  teams: readonly ResourceViewTeam[];
  projectOf: (task: Task) => string | null | undefined;
}

/** The utilization nest with every field decided; `undefined` at the top level means dormant. */
export interface ResolvedResourceUtilization {
  bucket: UtilizationBucketUnit;
  weekStart: "monday" | "sunday";
  threshold: number;
  warnings: boolean;
  column: boolean;
  summaryPanel: boolean;
  trendPanel: boolean;
  /** Always decided: the built-in "first skill tag, else kind" rule needs nothing beyond the
   *  entry itself, so — unlike `team` — this field never stays `undefined`. */
  role: (entry: ResourcePoolEntry) => string | undefined;
  /**
   * `undefined` when the host supplied no usable accessor: its built-in default names the team
   * from the resolved message catalog's `defaultTeamName` (host-overridable via `messages`),
   * which config resolution does not have access to. The consumer (`internal/engine/rollups.ts`)
   * applies that default by reading the resolved messages when this is `undefined`.
   */
  team: ((entry: ResourcePoolEntry) => string | undefined) | undefined;
  range: { start: number; end: number } | undefined;
  resourceLoad: ((input: ResourceBucketInput<ResourcePoolEntry | Resource>) => number) | undefined;
  resourceCapacity: ((input: ResourceBucketInput<ResourcePoolEntry | Resource>) => number) | undefined;
}

/** The load-chart nest with every field decided; `undefined` at the top level means dormant. */
export interface ResolvedLoadChart {
  bucket: UtilizationBucketUnit | "auto";
  resources: readonly (string | number)[];
  axisLabels: boolean;
  valueLabels: boolean;
  load: ((input: LoadChartBucketInput) => number) | undefined;
  capacity: ((input: LoadChartBucketInput) => number | null) | undefined;
  resourceLoad: ((input: ResourceBucketInput<Resource>) => number) | undefined;
  resourceCapacity: ((input: ResourceBucketInput<Resource>) => number) | undefined;
  heatmap: boolean;
  lanes: boolean;
  total: boolean;
  laneScale: "ratio" | "shared" | "auto";
  laneValueLabels: boolean;
  resizable: boolean;
}

/** Everything `setup()` runs on, read once. `undefined` nests are dormant (§6). */
export interface ResolvedResourceConfig {
  pool: ResolvedResourcePool | undefined;
  assign: ResolvedResourceAssign | undefined;
  view: ResolvedResourceView | undefined;
  utilization: ResolvedResourceUtilization | undefined;
  loadChart: ResolvedLoadChart | undefined;
}

/* ------------------------------------------------------------------ *
 * Field readers — an unusable value is exactly the default
 * ------------------------------------------------------------------ */

function bool(value: unknown, fallback: boolean): boolean {
  return typeof value === "boolean" ? value : fallback;
}

/** A finite number, or the default. */
function finiteNumber(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

/** A finite number strictly greater than zero, or the default. */
function positiveNumber(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : fallback;
}

function asFunction<F>(value: unknown): F | undefined {
  return typeof value === "function" ? (value as F) : undefined;
}

const BUCKET_UNITS: readonly UtilizationBucketUnit[] = [
  "minute",
  "minute5",
  "minute15",
  "minute30",
  "hour",
  "day",
  "week",
  "month",
];

function bucketUnit(value: unknown, fallback: UtilizationBucketUnit): UtilizationBucketUnit {
  return typeof value === "string" && (BUCKET_UNITS as readonly string[]).includes(value)
    ? (value as UtilizationBucketUnit)
    : fallback;
}

/** The load-chart `bucket` field: `"auto"`, a valid unit, or the `"day"` fallback — never `"auto"`
 *  as a silent fallback (§6.5). */
function loadChartBucket(value: unknown): UtilizationBucketUnit | "auto" {
  if (value === "auto") return "auto";
  return bucketUnit(value, "day");
}

function weekStart(value: unknown): "monday" | "sunday" {
  return value === "sunday" ? "sunday" : "monday";
}

function laneScale(value: unknown): "ratio" | "shared" | "auto" {
  return value === "shared" || value === "auto" ? value : "ratio";
}

function resourceIdList(value: unknown): readonly (string | number)[] {
  if (!Array.isArray(value)) return [];
  return (value as unknown[]).filter(
    (entry): entry is string | number => typeof entry === "string" || typeof entry === "number",
  );
}

/** A team whose `name` is a non-empty string, kept with its member list normalized to an array;
 *  everything else is dropped (§6.3). */
function resourceViewTeams(value: unknown): readonly ResourceViewTeam[] {
  if (!Array.isArray(value)) return [];
  const out: ResourceViewTeam[] = [];
  for (const candidate of value as unknown[]) {
    if (typeof candidate !== "object" || candidate === null) continue;
    const { name, members } = candidate as ResourceViewTeam;
    if (typeof name !== "string" || name.trim() === "") continue;
    out.push({ name, members: resourceIdList(members) });
  }
  return out;
}

/** The built-in `projectOf`: `task.meta.project` when it is a non-empty string. */
function defaultProjectOf(task: Task): string | null | undefined {
  const project = task.meta?.["project"];
  return typeof project === "string" && project !== "" ? project : undefined;
}

/** The built-in `role` accessor: the entry's first skill tag, else its kind. */
function defaultRole(entry: ResourcePoolEntry): string | undefined {
  return entry.skills[0] ?? entry.kind;
}

/** Both `start` and `end` must be usable for the pair to count — a lone finite member does not
 *  produce a half-open range (§6.4). */
function analysisRange(value: unknown): { start: number; end: number } | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const { start, end } = value as { start?: unknown; end?: unknown };
  if (typeof start !== "number" || !Number.isFinite(start)) return undefined;
  if (typeof end !== "number" || !Number.isFinite(end)) return undefined;
  return { start, end };
}

function resourcePoolEntryInits(value: unknown): readonly ResourcePoolEntryInit[] {
  // §6.1 — "unusable inits dropped" is the pool's own load-time normalization
  // (`internal/pool/pool.ts`); config resolution only guarantees the shape is an array.
  return Array.isArray(value) ? (value as readonly ResourcePoolEntryInit[]) : [];
}

function resourceBookingInits(value: unknown): readonly ResourceBookingInit[] {
  return Array.isArray(value) ? (value as readonly ResourceBookingInit[]) : [];
}

/* ------------------------------------------------------------------ *
 * Per-nest resolution
 * ------------------------------------------------------------------ */

function resolvePool(raw: ResourcePoolConfig | undefined): ResolvedResourcePool | undefined {
  if (raw === undefined) return undefined;
  const nest = typeof raw === "object" && raw !== null ? raw : {};
  return {
    resources: resourcePoolEntryInits(nest.resources),
    bookings: resourceBookingInits(nest.bookings),
    syncToStore: bool(nest.syncToStore, false),
  };
}

function resolveAssign(raw: ResourceAssignConfig | undefined): ResolvedResourceAssign | undefined {
  if (raw === undefined) return undefined;
  const nest = typeof raw === "object" && raw !== null ? raw : {};
  return {
    column: bool(nest.column, true),
    columnWidth: positiveNumber(nest.columnWidth, 160),
    dragReassign: bool(nest.dragReassign, true),
  };
}

function resolveView(raw: ResourceViewConfig | undefined): ResolvedResourceView | undefined {
  if (raw === undefined) return undefined;
  const nest = typeof raw === "object" && raw !== null ? raw : {};
  return {
    startOpen: bool(nest.startOpen, false),
    resizable: bool(nest.resizable, true),
    teams: resourceViewTeams(nest.teams),
    projectOf: asFunction<(task: Task) => string | null | undefined>(nest.projectOf) ?? defaultProjectOf,
  };
}

function resolveUtilization(
  raw: ResourceUtilizationConfig | undefined,
): ResolvedResourceUtilization | undefined {
  if (raw === undefined) return undefined;
  const nest = typeof raw === "object" && raw !== null ? raw : {};
  return {
    bucket: bucketUnit(nest.bucket, "day"),
    weekStart: weekStart(nest.weekStart),
    threshold: finiteNumber(nest.threshold, 1),
    warnings: bool(nest.warnings, true),
    column: bool(nest.column, true),
    summaryPanel: bool(nest.summaryPanel, false),
    trendPanel: bool(nest.trendPanel, false),
    role: asFunction<(entry: ResourcePoolEntry) => string | undefined>(nest.role) ?? defaultRole,
    team: asFunction<(entry: ResourcePoolEntry) => string | undefined>(nest.team),
    range: analysisRange(nest.range),
    resourceLoad: asFunction<(input: ResourceBucketInput<ResourcePoolEntry | Resource>) => number>(
      nest.resourceLoad,
    ),
    resourceCapacity: asFunction<(input: ResourceBucketInput<ResourcePoolEntry | Resource>) => number>(
      nest.resourceCapacity,
    ),
  };
}

function resolveLoadChart(raw: LoadChartConfig | undefined): ResolvedLoadChart | undefined {
  if (raw === undefined) return undefined;
  const nest = typeof raw === "object" && raw !== null ? raw : {};
  return {
    bucket: loadChartBucket(nest.bucket),
    resources: resourceIdList(nest.resources),
    axisLabels: bool(nest.axisLabels, false),
    valueLabels: bool(nest.valueLabels, false),
    load: asFunction<(input: LoadChartBucketInput) => number>(nest.load),
    capacity: asFunction<(input: LoadChartBucketInput) => number | null>(nest.capacity),
    resourceLoad: asFunction<(input: ResourceBucketInput<Resource>) => number>(nest.resourceLoad),
    resourceCapacity: asFunction<(input: ResourceBucketInput<Resource>) => number>(nest.resourceCapacity),
    heatmap: bool(nest.heatmap, false),
    lanes: bool(nest.lanes, false),
    total: bool(nest.total, false),
    laneScale: laneScale(nest.laneScale),
    laneValueLabels: bool(nest.laneValueLabels, false),
    resizable: bool(nest.resizable, true),
  };
}

/** Reads every nest once, applying the §6 presence semantics and per-field fallbacks. */
export function resolveConfig(raw: ResourceConfig): ResolvedResourceConfig {
  return {
    pool: resolvePool(raw.pool),
    assign: resolveAssign(raw.assign),
    view: resolveView(raw.view),
    utilization: resolveUtilization(raw.utilization),
    loadChart: resolveLoadChart(raw.loadChart),
  };
}
