# Plugin: resource (`stargantt.resource`)

Package: `@stargantt/plugin-resource` — Layer 7.
Status: normative.

## Purpose

Resource pool (people / equipment / material ledger with calendars, time off, bookings, optional store mirroring); assignment editing (grid column with chips, per-task editor dialog, chip drag between tasks); resource view (a bottom strip rebuilding the timeline along the resource axis: rows, segments, teams, overallocation, the lane-drag seam); utilization analysis (per-resource buckets, overload warnings on bars and in the grid, team/role rollups, demand-vs-supply trend, two panels); load chart (aggregate band + per-resource lanes + heatmap + CSV/PDF utilization reports, exported with images).

Core design: all time-bucket aggregation runs through ONE engine, `internal/engine/` (§2), over the `sdk/aggregate` types. Every bucketed view (band, lanes, heatmap, panels, reports, warning surfaces) is a read-only consumer of that engine. Scope note: the resource view's per-row analysis is a boundary sweep over concurrent assignment units — not bucket-shaped — and deliberately stays its own computation in `internal/view/model.ts`; only bucketed aggregation unifies. Lane dragging is contribution-borne: this plugin contributes a `LaneDragProvider` to interaction's `drag/lanes` point (§4.2), so no upward seam exists.

## 1. Services

### 1.1 `stargantt.resource-pool` → `ResourcePoolService`

Store-shaped: entry and booking changes are observed through the `resources` / `bookings` stores.

```ts
import type { Store } from "@stargantt/core";
import type { CalendarDef, ResourceId, TaskId } from "@stargantt/plugin-data-store";
import type { TimeRange } from "@stargantt/sdk"; // re-exported by this package

/** The three resource kinds the pool distinguishes (classification metadata only). */
export type ResourceKind = "person" | "equipment" | "material";

/** The two booking stages: a soft hold and a firm reservation. */
export type BookingState = "tentative" | "confirmed";

/** A per-resource working calendar: `CalendarDef` without the `id` (the calendar belongs to
 *  exactly one pool entry). Field semantics are the data store's, evaluated in UTC by the one
 *  shared working-time engine, `sdk/time`. */
export type ResourceWorkCalendar = Omit<CalendarDef, "id">;

/** One dated non-working range (vacation, sick leave, …) on a resource. Half-open. */
export interface ResourceTimeOff {
  /** Unique within the resource. Generated when the init omitted it. */
  readonly id: string;
  /** Epoch ms UTC, inclusive. */
  readonly start: number;
  /** Epoch ms UTC, exclusive. */
  readonly end: number;
  /** Free-form host label. Never interpreted by the plugin. */
  readonly reason?: string;
}

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
  /** Availability as a dimensionless full-time-equivalent rate (1 = full-time) — a multiplier,
   *  not a per-day quantity. Omitted or unusable = absent; consumers apply their own default. */
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

/** Filter for `entries()`. Members combine with AND. */
export interface ResourceFilter {
  kind?: ResourceKind;
  /** Keep entries carrying ALL the listed skills (exact match after trimming). */
  skills?: readonly string[];
  /** Keep entries whose name contains this text, case-insensitively. */
  text?: string;
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

/** A resolved booking as the service reports it. */
export interface ResourceBooking {
  readonly id: string;
  readonly resourceId: ResourceId;
  readonly taskId: TaskId | null;
  readonly start: number;
  readonly end: number;
  readonly state: BookingState;
  readonly units: number;
  /** The effective flag: the booking's override when given, else the resource's, at read time. */
  readonly billable: boolean;
  readonly note?: string;
}

/** Filter for `bookings()`. Members combine with AND. */
export interface BookingFilter {
  resourceId?: ResourceId;
  taskId?: TaskId;
  state?: BookingState;
}

export interface ResourcePoolService {
  /** The pool entries, in registration order. Set once per observable entry mutation
   *  (upsert / remove / skill / calendar / time-off edits); a config seed that loaded anything
   *  sets it once at setup; no-change mutations set nothing. The store carries no
   *  `ids`/`cause` hint: subscribers diff `(next, prev)`, the data-store precedent. */
  readonly resources: Store<readonly ResourcePoolEntry[]>;
  /** The bookings, in creation order. Set once per observable booking mutation (entry
   *  removal that deletes bookings sets both stores). */
  readonly bookings: Store<readonly ResourceBooking[]>;
  /** The entries matching `filter` (all when omitted), in registration order. */
  entries(filter?: ResourceFilter): readonly ResourcePoolEntry[];
  /** One entry, or `undefined` for an unknown id. */
  get(id: ResourceId): ResourcePoolEntry | undefined;
  /** Creates or updates an entry; returns its id, or `undefined` when the init is unusable
   *  (§3.1). On update, only members present on the init change. */
  upsert(init: ResourcePoolEntryInit): ResourceId | undefined;
  /** Removes an entry and its time off and bookings. Unknown id = no-op. */
  remove(id: ResourceId): void;
  /** Adds one skill tag. Unknown id, unusable tag, or an already-present tag = no-op. */
  addSkill(id: ResourceId, skill: string): void;
  /** Removes one skill tag. Unknown id or absent tag = no-op. */
  removeSkill(id: ResourceId, skill: string): void;
  /** Replaces the entry's calendar (`undefined` restores the default). Unknown id = no-op. */
  setCalendar(id: ResourceId, calendar: ResourceWorkCalendar | undefined): void;
  /** The entry's time-off ranges, sorted by start. Unknown id = empty list. */
  timeOff(id: ResourceId): readonly ResourceTimeOff[];
  /** Registers a time-off range; returns its id, or `undefined` when unusable (§3.1). */
  addTimeOff(id: ResourceId, init: ResourceTimeOffInit): string | undefined;
  /** Removes a time-off range. Unknown resource or range id = no-op. */
  removeTimeOff(id: ResourceId, timeOffId: string): void;
  /** Whether the instant falls in the resource's working time: calendar AND NOT time off.
   *  Unknown resource or non-finite time = `false`. */
  isWorking(id: ResourceId, epochMs: number): boolean;
  /** The resource's working intervals in half-open `[from, to)`: the calendar's intervals
   *  (the default Monday–Friday one when it has none) minus every time-off overlap at
   *  millisecond precision — clipped, merged, ascending; appends into `out` when given.
   *  Unknown resource or non-finite bounds append nothing. Pool POLICY is published only
   *  here: consumers never re-derive it from `get()` + `timeOff()`. */
  workingIntervals(id: ResourceId, from: number, to: number, out?: TimeRange[]): TimeRange[];
  /** The summed length of exactly the `workingIntervals` listing for the same arguments, ms —
   *  one listing read two ways, so the scalar and the intervals cannot disagree. */
  workingMs(id: ResourceId, from: number, to: number): number;
  /** The bookings matching `filter` (all when omitted), in creation order. See the naming
   *  note below the interface. */
  bookingsWhere(filter?: BookingFilter): readonly ResourceBooking[];
  /** Creates a booking; returns its id, or `undefined` when the init is unusable (§3.2). */
  book(init: ResourceBookingInit): string | undefined;
  /** Moves a booking between `tentative` and `confirmed`. Unknown id or same state = no-op. */
  setBookingState(id: string, state: BookingState): void;
  /** Deletes a booking. Unknown id = no-op. */
  cancelBooking(id: string): void;
}
```

Naming note: the `bookings` store owns the plain name, so the filtered accessor is `bookingsWhere(filter?)`; `entries(filter?)` pairs with the `resources` store.

Member count: 19 (2 stores + 17 methods).

### 1.2 `stargantt.utilization` → `UtilizationService`

Store-shaped; covers the utilization queries, the reports and heatmap, and the two load-chart strips (design notes below). Every query reads the §2 engine.

```ts
import type { Resource, ResourceId } from "@stargantt/plugin-data-store";

/** One aggregation bucket of a resource's utilization. */
export interface UtilizationBucket {
  /** Bucket start, epoch ms UTC, inclusive; clamped into the analysis range. */
  readonly start: number;
  /** Bucket end, epoch ms UTC, exclusive; clamped into the analysis range. */
  readonly end: number;
  /** Allocated effort, in milliseconds of working time (post-hook when a hook is configured). */
  readonly allocated: number;
  /** Available effort, in milliseconds of working time: `capacityRate × working ms` (post-hook). */
  readonly capacity: number;
  /** `allocated / capacity`, or `null` when the bucket has no capacity — a true utilization
   *  fraction at any bucket width. */
  readonly ratio: number | null;
  /** Whether `allocated > capacity × threshold + EPS` (EPS = 1e-6 ms — §2.4). */
  readonly overallocated: boolean;
}

/** One over-allocated resource, as `overallocations()` reports it. */
export interface OverallocationInfo {
  readonly resourceId: ResourceId;
  readonly name: string;
  /** The largest bucket ratio, or `null` when every over bucket has zero capacity. */
  readonly peakRatio: number | null;
  /** The over-allocated buckets only, in time order. */
  readonly buckets: readonly UtilizationBucket[];
}

/** Demand rolled up by role. Quantities are working ms over the analysis range. */
export interface RoleDemand {
  readonly role: string;
  readonly demand: number;
  readonly capacity: number;
  readonly ratio: number | null;
}

/** Capacity rolled up by team. Quantities are working ms over the analysis range. */
export interface TeamCapacitySummary {
  readonly team: string;
  readonly allocated: number;
  readonly capacity: number;
  /** `max(0, capacity − allocated)`. */
  readonly available: number;
  readonly resourceCount: number;
  /** Resources of the team with at least one over-allocated bucket in the range. */
  readonly overallocatedCount: number;
}

/** One bucket of the demand vs supply trend. */
export interface TrendPoint {
  readonly start: number;
  readonly end: number;
  /** Σ allocated working ms over the aggregated resources in the bucket. */
  readonly demand: number;
  /** Σ capacity working ms over the aggregated resources in the bucket. */
  readonly supply: number;
}

/** The eight aggregation widths (§2.2). */
export type UtilizationBucketUnit =
  | "minute" | "minute5" | "minute15" | "minute30" | "hour" | "day" | "week" | "month";

/** Range/bucket selector accepted by every query method. Every member optional. */
export interface UtilizationQuery {
  /** Analysis range start, epoch ms UTC. Omitted = config `range`, else the task extent. */
  start?: number;
  /** Analysis range end, epoch ms UTC, exclusive. Omitted = derived likewise. */
  end?: number;
  /** Bucket width. Omitted = the config `utilization.bucket` (default `"day"`). */
  bucket?: UtilizationBucketUnit;
}

/** One resource × bucket cell of the utilization report and the heatmap. The report cell
 *  omits the threshold verdict — overload on report surfaces is judged at threshold 1 (§2.4). */
export interface UtilizationReportCell {
  readonly start: number;
  readonly end: number;
  readonly allocated: number;
  readonly capacity: number;
  readonly ratio: number | null;
}

/** One resource row of the utilization report. */
export interface UtilizationReportRow {
  readonly resourceId: string | number;
  readonly resourceName: string;
  readonly cells: readonly UtilizationReportCell[];
}

/** The report's fixed column order. */
export type UtilizationReportColumn =
  | "resource" | "from" | "to" | "allocated" | "capacity" | "utilization";

/** Range/bucket selector of the report methods. The requested width is a starting point:
 *  the report path auto-coarsens it toward `"month"` to keep at most 200 columns (§2.5). */
export interface UtilizationReportOptions {
  start?: number;
  end?: number;
  bucket?: UtilizationBucketUnit;
}

/** The observable aggregation state. */
export interface UtilizationState {
  /** The default-query matrix: config range (else task extent) at the config bucket width,
   *  over the union roster (§2.3) — the series every warning surface reads. */
  readonly rows: readonly {
    readonly resourceId: ResourceId;
    readonly name: string;
    readonly buckets: readonly UtilizationBucket[];
  }[];
}

export interface UtilizationService {
  /** The current default-range aggregation. Satisfies the core Store contract; freshness
   *  follows the dirty-flag rules below the interface (the CriticalPathService pattern,
   *  scheduling.md §1.3), so an idle composition pays no aggregation work. */
  readonly state: Store<UtilizationState>;
  /** The resource's utilization buckets over the range. Unknown resource = empty list.
   *  Single-resource narrowing (normative): the engine runs over a ONE-ROW roster — only
   *  this resource is accrued, and the hooks are called for this resource's cells only. */
  utilization(resourceId: ResourceId, query?: UtilizationQuery): readonly UtilizationBucket[];
  /** Whether the resource has at least one over-allocated bucket in the range. */
  isOverallocated(resourceId: ResourceId, query?: UtilizationQuery): boolean;
  /** Every over-allocated resource in the range, in resource order; clean resources omitted. */
  overallocations(query?: UtilizationQuery): readonly OverallocationInfo[];
  /** Demand vs capacity rolled up by role, in first-appearance order (§3.4). */
  demandByRole(query?: UtilizationQuery): readonly RoleDemand[];
  /** Allocated / capacity / available rolled up by team, in first-appearance order (§3.4). */
  teamSummary(query?: UtilizationQuery): readonly TeamCapacitySummary[];
  /** Demand vs supply per bucket, optionally narrowed to one team and/or role (AND). */
  trend(query?: UtilizationQuery & { team?: string; role?: string }): readonly TrendPoint[];
  /** The per-resource × per-bucket matrix backing the heatmap and the exports (§3.6). */
  utilizationReport(options?: UtilizationReportOptions): readonly UtilizationReportRow[];
  /** The report as an RFC 4180 CSV string (§3.6). */
  utilizationReportCSV(options?: UtilizationReportOptions): string;
  /** The report as a paginated PDF document (§3.6). */
  utilizationReportPDF(options?: UtilizationReportOptions): Blob;
  /** Opens (or re-reads an open) load heatmap over the given range/width; no options = the
   *  whole plan extent at the config width (§3.6). Mounts nothing while `stargantt.view` is
   *  absent. */
  openHeatmap(options?: UtilizationReportOptions): void;
  /** Closes the heatmap panel; a no-op when it is not open. */
  closeHeatmap(): void;
  /** Opens (or re-opens) the team capacity summary panel (§3.5). */
  openSummaryPanel(): void;
  /** Closes the summary panel; a no-op when it is not open. */
  closeSummaryPanel(): void;
  /** Opens (or re-opens) the demand vs supply trend panel (§3.5). */
  openTrendPanel(): void;
  /** Closes the trend panel; a no-op when it is not open. */
  closeTrendPanel(): void;

  // --- the two load-chart strips ---
  /** Whether the aggregate band strip is currently shown. */
  bandVisible(): boolean;
  /** Shows or hides the aggregate band strip. Showing restores the height the READER last
   *  chose (divider drag/keystroke or a height setter), else re-derives the initial
   *  `--sg-load-chart-height` at that moment — a plugin-derived height is never replayed.
   *  Hiding remembers the occupied height and releases via height 0. No-op when already in
   *  the requested state; inert while `stargantt.view` is absent. */
  setBandVisible(visible: boolean): void;
  /** Whether the per-resource lanes strip is currently shown. */
  lanesVisible(): boolean;
  /** As `setBandVisible` for the lanes strip; a never-shown strip takes the height its
   *  resource roster implies at that moment (§3.6's roster formula). */
  setLanesVisible(visible: boolean): void;
  /** The aggregate band's current height in CSS px; `0` while hidden. */
  bandHeight(): number;
  /** Sets the band's height: a positive height on a hidden band
   *  shows it at exactly that height; `0` hides (a release, not a resize); on a visible band
   *  the height is dispatched to the layout, which clamps it. The applied height is reported
   *  through `view/bottomPaneResized`; non-finite or negative values are ignored. */
  setBandHeight(px: number): void;
  /** The lanes strip's current height in CSS px; `0` while hidden or with no resources. */
  lanesHeight(): number;
  /** As `setBandHeight` for the lanes strip. Counts as a manual resize: afterwards the
   *  roster formula never re-derives the strip's height again. */
  setLanesHeight(px: number): void;
}
```

Member count: 24 (the `state` store + 23 methods — 10 query members, 3 reports, 2 heatmap, 8 strip visibility/height).

**Freshness (normative — the CriticalPathService pattern, scheduling.md §1.3).** `state` wraps an internal writable store. Initial value: empty rows. Every `data.tasks` / `data.resources` / `data.assignments` store notification and every pool `resources`/`bookings` notification marks it dirty — a boolean write. The recompute (one engine build over the default query) runs and sets the store immediately within the notification when any warning surface is active per config (`warnings`, `column`, an open panel or strip) OR a subscriber exists; otherwise on demand at the next read (`state.get()`, any query member's default-range path, or a `subscribe()` made while dirty — recompute-before-answer, no immediate callback for the new subscriber). A composition with the `utilization` and `loadChart` nests dormant, no subscriber, and no reader pays a dirty-flag write per change and ZERO aggregation work.

**Design notes.** (1) The utilization reports and the heatmap live on `UtilizationService` — they read the same matrix as every other member here. (2) The eight strip members likewise live here: the four readers and the restore-last-height-else-derive show semantics have no equivalent through raw commands — a host cannot ask a strip's current height, and `view/setBottomPaneHeight` shows only at an explicit height, never at the natural one. Internally the setters dispatch `view/setBottomPaneHeight` and track applied heights through the contributions' `onResize` — the plugin's own dispatches never mark the lanes strip user-sized, so the reader-ownership rule is preserved; the view command remains available to hosts as the generic path beside them. (3) There is deliberately no resource-view service — its capability map is in §1.3.

### 1.3 Deliberate non-services

There is no assignment service, no resource-view service, and no load-chart service (architecture ch. 4.1). Capability map:

- **Assignment editing:** a task's assignments are read from the `data.assignments` store — the task-keyed grouped map (data-store.md); assign / unassign / set-units are the public `assignment/set` / `assignment/remove` commands (a pool-only resource is first mirrored with `resource/add`, §3.3); a host-programmatic move is a `set` + `remove` pair (two undo steps); the editor and lane-drop keep their one-transaction grain internally (§3.3); the choice universe (pool entries then store-only resources) is internal, derivable from the `resources` store plus `data.resources`.
- **Resource view:** panel visibility and height ride `view/setBottomPaneHeight` on the strip id (positive height shows at that height, 0 releases; the `--sg-rv-height` re-derivation is reachable only through `startOpen`, §3.4 — the command path always carries an explicit height). There are deliberately no `open()`/`isOpen()`/`height()` members, unlike the load-chart strips (§1.2): the view's state stays externally observable through the retained `resourceView/toggled` and `view/bottomPaneResized` events, so the reader capability survives without service members. The lane seam (`laneAt` / `laneOfTask` / `highlightLane` / `reassign`) is the `drag/lanes` contribution (§4.2); a `rows()` readout is deliberately absent (the row model is derivable from the public `data` stores and the pool store).
- **Load chart:** every capability lives on `UtilizationService` (§1.2 — reports, heatmap, and the eight strip members).

## 2. The unified aggregation engine (internal/engine — normative)

The engine is headless: pure functions with no DOM and no service reference, unit-testable in plain Node (the scheduling.md §13 engine discipline; lint-enforced import scan). One implementation; every consumer (§3) reads it.

### 2.1 Interface

```ts
import type { ResourceBucketInput, TimeRange } from "@stargantt/sdk";

/** One roster resource as the engine consumes it. */
export interface EngineResource<R = unknown> {
  id: string | number;
  name: string;
  /** Dimensionless FTE rate: `capacity ?? 1` resolved upstream, guarded — a non-finite or
   *  non-positive stored capacity reads as 1, never as itself (one strict uniform rule for
   *  every surface). */
  capacityRate: number;
  /** The resource's working intervals inside [from, to): clipped, merged, ascending
   *  (ResourcePoolService.workingIntervals for pool-known resources; the sdk/time
   *  DEFAULT_WORKWEEK full-day listing for every other — §2.3). */
  workingIntervals(from: number, to: number, out?: TimeRange[]): TimeRange[];
  /** The host object the hooks receive as `input.resource`. */
  source: R;
}

/** One demand interval on a resource: an assignment projected onto its task's span.
 *  Milestones and non-positive spans are excluded upstream. */
export interface DemandInterval {
  start: number;
  end: number;
  units: number;
}

export interface EngineHooks<R> {
  /** Adjusts one cell's allocated working time; the returned finite number (ms) replaces the
   *  baseline. Both hooks always see the BUILT-IN baselines (order-independent). */
  resourceLoad?: (input: ResourceBucketInput<R>) => number;
  /** Adjusts one cell's available working time; same shape and containment. */
  resourceCapacity?: (input: ResourceBucketInput<R>) => number;
  /** Receives the FIRST throw of each hook per build; later throws of the same build are
   *  swallowed; a later build reports again (per-call, unlatched, per-build reporting; the
   *  failing cell keeps its built-in value, non-finite results fall back silently, no cell
   *  is ever omitted). */
  onError?: (where: "resourceLoad" | "resourceCapacity", error: unknown) => void;
}

/** Everything one build needs. */
export interface BucketInput<R = unknown> {
  /** Row membership and order (§2.3: each consumer supplies its own roster). */
  resources: readonly EngineResource<R>[];
  /** Demand intervals per resource, keyed by `String(id)`. */
  demands: ReadonlyMap<string, readonly DemandInterval[]>;
  /** The resolved half-open analysis range, epoch ms (range RESOLUTION is caller policy — §2.5). */
  start: number;
  end: number;
  /** Requested width. The engine never narrows it. */
  bucket: UtilizationBucketUnit;
  /** Edge policy at the range bounds (§2.2): `"clamped"` clips the first and last bucket to
   *  the range (the utilization query surfaces' rule); `"aligned"` keeps every bucket at its
   *  full grid width, the range bounds falling inside the edge buckets (the load-chart
   *  surfaces' rule). */
  edges: "aligned" | "clamped";
  /** Weekday week buckets start on: 0 = Sunday … 6 = Saturday (serving both the utilization
   *  `weekStart` name map and the timeline's `firstDayOfWeek`). */
  weekStartDay: number;
  /** Over-allocation threshold; a cell is over when `allocated > capacity × threshold + EPS`,
   *  EPS = 1e-6 ms (§2.4). Default 1. */
  threshold?: number;
  /** Column bound: the engine coarsens the width one step at a time toward `"month"` while the
   *  grid would exceed it, month accepted even when still over (the coarsening ladder).
   *  Absent = no coarsening (the 8192-bucket grid cap of §2.2 still applies). */
  maxColumns?: number;
  hooks?: EngineHooks<R>;
}

/** One cell of the matrix. */
export interface UtilizationCell {
  start: number;
  end: number;
  /** The row resource's working ms inside the bucket (pre-rate; also the hooks' `workingMs`). */
  workingMs: number;
  /** Post-hook allocated working ms. */
  allocated: number;
  /** Post-hook available working ms (`capacityRate × workingMs` built-in). */
  capacity: number;
  /** `allocated / capacity`, `null` at capacity 0. */
  ratio: number | null;
  /** `allocated > capacity × threshold + EPS` (EPS = 1e-6 ms), from the post-hook numbers. */
  overallocated: boolean;
}

export interface UtilizationMatrixRow<R = unknown> {
  resource: EngineResource<R>;
  cells: readonly UtilizationCell[];
}

export interface UtilizationMatrix<R = unknown> {
  /** The effective width after coarsening. */
  bucket: UtilizationBucketUnit;
  rows: readonly UtilizationMatrixRow<R>[];
}

/** THE unified engine entry: one build = one matrix. */
export declare function computeUtilization<R>(input: BucketInput<R>): UtilizationMatrix<R>;
```

### 2.2 Grid rules

`"month"` walks the UTC calendar; `"week"` steps by seven days from the `weekStartDay` anchor; every other width is a fixed span aligned to the UTC epoch (`"day"` 86 400 000 ms, `"hour"` 3 600 000, `"minute30"` 1 800 000, `"minute15"` 900 000, `"minute5"` 300 000, `"minute"` 60 000) — each divides a day evenly, so a narrower grid nests inside the wider ones. The grid enumerates the buckets intersecting the range; what happens at the range bounds is the `edges` input: under `"clamped"` the first and last bucket are clipped to the range, under `"aligned"` every bucket keeps its full grid width and the bounds fall inside the edge buckets. At most 8192 buckets are generated per build whatever the width.

### 2.3 Working time and rosters

A cell accrues both numbers over the WORKING MILLISECONDS inside its bucket: `capacity = capacityRate × Σ|working intervals ∩ bucket|`; `allocated = Σ over the resource's demands of units × |demand ∩ working intervals ∩ bucket|`. A demand overlapping only non-working time contributes nothing. The accrual is a scatter/gather sweep (per-resource indexed runs, day-contained interval pieces, reused scratch buffers, sub-day boundary cuts) — a frame-budget implementation. Its rules for sub-day grids: the interval window is requested over the day-aligned span containing the buckets, and under a sub-day width intervals are cut at every bucket boundary before accrual; `workingDays` per cell counts distinct UTC days inside its own bucket (1/0 for sub-day buckets). Working intervals come from the surface that owns their policy: `ResourcePoolService.workingIntervals` for pool-known resources (defaulting, degradation, and time-off subtraction already applied), the shared `sdk/time` `DEFAULT_WORKWEEK` full-day listing for every other resource. Per-resource interval windows are cached across builds and invalidated wholesale on the pool `resources` store notification and by nothing else (a task edit cannot move working time).

Rosters are CALLER policy, per surface: the utilization query surfaces aggregate the union of pool entries (pool order) then store-only resources (store order), keyed by string id, names store-first; the load-chart surfaces (band Σ, lanes, heatmap, reports) row over the store resources honoring the `loadChart.resources` allowlist (allowlist order, unknown and duplicate ids dropped) — zero rows when the store has none (no task-count fallback in the matrix).

### 2.4 Hooks, threshold, epsilon

The engine is hook-pair-agnostic: whichever pair a build's `BucketInput.hooks` carries applies at the one choke point every cell passes before becoming public — after accrual, before ratios — through ONE reused `ResourceBucketInput` instance per build, fields rewritten per call (`resource`, `resourceId`, `resourceName`, `capacityRate`, `bucketStart`, `bucketEnd`, `workingMs`, `workingDays`, `allocated`, `capacity` — the `sdk/aggregate` type); a re-entrant build takes its own instance; both hooks always see the built-in baselines (order-independent). TWO per-consumer pairs exist, deliberately (§2.6 item 3): the `utilization` nest's pair feeds the utilization query surfaces, rollups, trend, warning glyph, column, and panels, with `input.resource` = the pool entry when the pool knows the resource, else the store `Resource`; the `loadChart` nest's pair feeds the matrix behind the lanes, heatmap, reports, and — whenever either of its two hooks is configured — the band's Σ mode, with `input.resource` always the store `Resource`. One host function configured on both nests may legitimately return different numbers to each; reconciling the two surfaces is the host's business.

`ratio` and `overallocated` compute from the post-hook numbers. The overload rule is uniform: `allocated > capacity × threshold + EPS` with **EPS = 1e-6 ms**. Design rationale: the engine's single accumulation order can shift figures by up to the float reorder error (measured ≈ 6e-8 ms — §2.6 item 1); 1e-6 sits comfortably above every accumulated reorder artifact while staying six orders of magnitude below the 1 ms scheduling quantum, and exactly-at-capacity cells read not-over on every surface. A zero-capacity cell is over-allocated once its allocation exceeds the epsilon, at any threshold. Utilization surfaces judge at the config `utilization.threshold`; load-chart surfaces (heatmap `!` cells, over-fill segments, report semantics) judge at threshold 1.

### 2.5 Caller policies (outside the engine)

Range resolution: the utilization query path aligns `[start, end)` outward to UTC day boundaries and clamps to 3660 days, falling from query → config `utilization.range` (both members required) → task extent; the report/heatmap path resolves member-wise (each unusable bound replaced by its derived task-extent bound; a usable-but-unordered pair gets the same member-wise treatment; still unordered or no extent ⇒ empty matrix); the strips build only the buckets intersecting the viewport. Edge policy per caller (§2.2): the utilization query surfaces pass `edges: "clamped"`; every load-chart surface (band Σ, lanes, heatmap, reports) passes `edges: "aligned"`. Coarsening: the heatmap and reports pass `maxColumns: 200`; the strips and Σ-mode band pass none (coarsening is a caller policy; the strips' alignment with the timeline is never coarsened away). Single-resource queries (`utilization(id)` / `isOverallocated(id)`) hand the engine a one-row roster — hooks run for that resource only (§1.2's narrowing).

Memo (per-consumer instances, not a shared cache): `engine/memo.ts` is a one-entry-memo HELPER; the only instance lives in `internal/load-chart/wire.ts`, where the Σ-mode band and the lanes need the same matrix in the same frame. Within that instance the key is (bucket, start, end, weekStartDay) — sufficient because the instance's roster (the allowlisted store rows), demands recency, hook pair (the `loadChart` nest's), threshold (1), and edge policy (`"aligned"`) are constants of that one consumer between invalidations; the entry is invalidated on data/pool notifications and at frame boundaries, so no result outlives its frame and the hooks observe at most one call per (resource, bucket) per frame. Heatmap/report builds at other ranges or coarsened widths, and every utilization-side build, bypass the memo (the memo is deliberately not a general cache), so no consumer can ever be served a matrix built under another consumer's roster, hooks, threshold, or edges.

### 2.6 Unification design notes (normative)

Where the load-chart surfaces and the utilization query surfaces could reasonably differ, the resolved rule is fixed here, item by item:

1. **Accumulation order.** The engine has ONE float accumulation order: the per-interval scatter/gather sweep — each interval accrues the sum of the units of the demands covering it, times the interval's working length (Σᵢ (Σ_d units_d) × lenᵢ, plus exact clamped partial-overlap terms). A per-demand order (units × Σᵢ lenᵢ) is equal exactly only for binary64-representable `units`; for non-dyadic `units` the two orders differ by up to the measured reorder error (≈ 6e-8 ms at plan magnitudes). Overload VERDICTS are protected against that shift by the §2.4 epsilon, which exceeds it by more than an order of magnitude.
2. **Overload epsilon.** The unified verdict is `allocated > capacity × threshold + 1e-6 ms` on every surface (§2.4): an epsilon of 1e-9 would sit BELOW the item-1 reorder error and let reordering flip exactly-at-capacity verdicts, while 1e-6 clears that error comfortably and stays far below the 1 ms scheduling quantum. A cell over by less than 1e-6 ms reads not-overloaded — below any observable magnitude.
3. **Two independent hook pairs.** A host may configure `resourceLoad`/`resourceCapacity` on the `loadChart` nest AND on the `utilization` nest separately, each receiving its own `resource` object (always the store `Resource` on the load-chart side, the pool entry when pool-known on the utilization side), Σ mode engaging from the load-chart pair only, and the two surfaces free to disagree. Hooks are per-build `BucketInput` members, so each consumer passes its own configured pair (§2.4, §6.4/§6.5). Both hook pairs are kept, one per consumer — a single shared pair would force-flip Σ mode and the warning surfaces for a host that configures only one side.
4. **Two week-start sources.** Utilization queries pass the config `weekStart` mapping; load-chart surfaces pass the timeline's `firstDayOfWeek()` (read late/optionally; 1 when the view plugin is absent). The two surfaces may bucket weeks differently — deliberate.
5. **Bucket widths.** All eight widths serve every surface.
6. **Band-level `load` / `capacity` functions and the task-count fallback.** These shape only the band's own bars; they are band-consumer behavior (§3.6), outside the engine.
7. **Bucket-edge policy.** The two edge rules are deliberately NOT unified — clipping edge buckets would move the utilization figures, and full-width edge buckets are what the heatmap/report grids assume — so the explicit `edges` input carries the policy (§2.1/§2.2): the load-chart surfaces run under `"aligned"`, the utilization query surfaces under `"clamped"` (§2.5).
8. **Demand projection filters.** Demand projection is CALLER policy (upstream of the engine), and the two sides filter differently, deliberately: the load-chart projection admits only demands with `units > 0` (non-positive and NaN units excluded); the utilization projection skips non-finite or inverted spans and exactly-zero units, while negative and non-finite units pass into the accrual. The engine itself accrues whatever demands it is handed.

## 3. Behavior

### 3.1 Pool (internal/pool)

Entry resolution, kinds, calendar semantics, and time off: create requires a usable trimmed `name`; per-member normalization and update rules as documented on the init type; `remove` cascades time off and bookings; the default calendar is `sdk/time`'s `DEFAULT_WORKWEEK`; calendar evaluation is UTC through `sdk/time` (first duplicate exception date wins; member-wise degradation); time-off inits need finite `start < end` and a fresh id; ranges overlap freely, half-open; `isWorking` / `workingIntervals` / `workingMs` are the three consistent-by-construction surfaces and the ONLY published pool policy.

**Store sync (`pool.syncToStore`, default false).** With the flag on, pool entries mirror ONE-WAY into the data store (`id`/`name`/`capacity` only) by dispatching `resource/add` / `resource/update` / `resource/remove`, reconciled after the seed load and after every entry mutation; only ids the mirror added are ever removed; existing store ids are adopted, not duplicated. Origin: `stargantt.resource/pool-sync`. Stated limitation (the undo-divergence window): undoing a mirror transaction reverts only the store copy until the next pool mutation reconciles; hosts composing undo-redo are advised to treat `stargantt.resource/pool-sync` transactions accordingly.

### 3.2 Bookings

A booking is a dated hold independent of assignments; init usability as typed; `units` default 1; `billable` resolves booking-override-else-entry at read time; bookings may overlap each other and non-working time (the pool records, it does not arbitrate); `setBookingState` transitions both directions; `cancelBooking` deletes. All observable through the `bookings` store.

### 3.3 Assignment editing (internal/assign)

**Grid column** (`assign.column` not `false`): ONE read-only `grid/columns` contribution — id `"resource.resources"`, header `assignColumnHeader`, width `assign.columnWidth`; no `setValue`/`editor`/`compare`. Cell layout: the open-editor `<button>` (`.sg-ra-open`, `aria-label` `openEditorLabel`) first and unclippable, then one `.sg-ra-chip` per assignment in store order (text `chipLabel`, 24 px shrink floor, trailing clip); the cell's `title` carries the comma-joined `getValue` text. Without the tree-grid plugin the contribution is inert.

**Editor**: clicking the cell or its button opens the dialog (`role="dialog"`, labelled `editorTitle`) anchored at the cell — placement: clamped into the root box on both axes, flips above when the space above is larger, `max-height` = root minus 16 px with internal scrolling; Apply/Cancel never scroll away. One row per choice (checkbox + name + percent input; percent = `round(units × 100)`, committed values finite > 0, clamp at 1000; unusable text ignored with a stored-value write-back on blur and commit). Commit diffs the desired set against the current assignments and lands as ONE transaction / one undo step via `sdk/aggregate`'s `createTransactionBatcher`, origin `stargantt.resource/assign-apply`; a pool-only added resource is mirrored (`resource/add`, the three fields) inside the same transaction. Cancel (`Escape`, outside pointerdown, disposal) dispatches nothing. Names resolve store-first, then pool, then the raw id. Tokens `--sg-ra-editor-bg/-fg/-border`, `--sg-ra-chip-bg`, `--sg-ra-drop-outline` with their documented fallback chains.

**Drag reassign** (`assign.dragReassign` not `false`): chips are native HTML5 drag sources; dropping on another task's cell of this column performs the move (target set before source removal, units carried, same-task/unknown/no-assignment = no-op) as one transaction (the batcher, same origin family). Keyboard-only equivalent: unassign in one editor, assign in the other.

### 3.4 Resource view (internal/view)

One `view/bottomPanes` strip, `stargantt.resource-view:panel` at `order: -1` — above the load chart's total (0) and lanes (1), so a reader sees chart, resource view, total, lanes top to bottom, and a lane drag travels the shortest distance. Contributed with the `view` nest present; height 0 unless `startOpen` (release semantics — no reserved height, no divider, no painted pixel); shown at the reader's last height, else `--sg-rv-height` (fallback 200) re-derived at that moment; `resizable` per config with divider label `resizeLabel`. Layout, DOM classes (`.sg-resource-view*` family), the gutter-hosted name column with the zero-width-gutter in-body fallback, the header band, team bands, opaque lanes, the one `pointer-events: none` track, token chains (`--sg-rv-*` over core tokens over light literals), scroll mirroring, and the rAF-coalesced update triggers (`data.tasks`, pool `resources`, `view/scrolled`, `timeline.zoomLevel`, `lifecycle/ready`, `onResize`) complete the strip.

Rows are the internalized choice universe (pool entries then store-only resources); capacity resolves store-entry → pool-entry → 1; segments (one per assignment of a positive-duration task, `[start, end)`, x via `tToX` minus scroll, 2 px width floor) carry `segmentLabel` text; overallocation per row is the boundary sweep over concurrent Σ`units` against capacity (small float tolerance), marked with `--over` modifiers, `data-over`, and label text — never color alone. Teams group per config (first-listed team claims a doubly-claimed resource; unclaimed fall under `ungroupedTeam`; usable-name/empty-members renders an empty group), header text `teamSummary`, numbers through the locale. `projectOf` (default: `task.meta.project` when a non-empty string) attributes segments; it and the three builders are latched barriers.

**Toggling and `resourceView/toggled`.** Visibility rides the strip height: `view/setBottomPaneHeight { id: "stargantt.resource-view:panel", height }` with a positive height shows, 0 releases. The plugin observes applied heights through the contribution's `onResize` and emits `resourceView/toggled { open, cause: "api" }` (official catalog) on every shown↔hidden transition; the boot state emits nothing. Hiding empties the strip and forgets lane geometry.

**Lane seam** — see §4.2 (`drag/lanes`): `laneAt` (root-relative y, latest-completed-paint geometry, `undefined` off-lane/on headers/while hidden), `laneOfTask` (`undefined` on none or more than one), `highlightLane` (`--target` marks), and `reassign` are closures of the contribution. `reassign(taskId, from, to)` moves the assignment with its rate in ONE transaction via the batcher, origin `stargantt.resource/reassign`: head `assignment/set` on the target (or `resource/add` mirror when pool-only; or `assignment/remove` as head when the target-side change would produce no patch), target set before source removal, string-form id matching, silent no-op for same/unknown/unassigned cases; independent of panel visibility.

### 3.5 Utilization surfaces (internal/utilization)

**Warning glyph** (`utilization.warnings`, default true): one `taskbars/overlays` renderer painting, per warned task (a task with an assignment to a resource with an over bucket overlapping the task's span — default range, config width, the `utilization` nest's hook pair and threshold, §2.4), a filled warning triangle (≈11 px, apex up) with a white `!`, centered 8 px right of `bar.x + bar.width + bar.gutterEnd`; skipped under 12 px bar height. Token `--sg-ru-warning` (`#c62828`). The renderer reads only the cached warning set derived from the `state` recompute — no aggregation per bar per frame.

**Grid column** (`utilization.column`, default true): one read-only `grid/columns` contribution — id `"resource.overallocation"`, header `utilizationColumnHeader`, width 140. Warned cells show `overallocatedCell` (default `⚠ Over: <names>`, resource order) in `--sg-ru-warning` at normal weight, with the same text as `title`; other cells empty, no `title`.

**Summary and trend panels**: `sdk/dialog` dialogs hosted by the gantt root — summary (`.sg-ru-panel.sg-ru-summary`, `top: 24`, min 260 / max `min(320px, 92%)`, `max-height: 70%`) lists `teamCardLine` per team then `roleTitle` + `roleLine` per role; trend (`.sg-ru-panel.sg-ru-trend`, cascaded `top: 72` / `offsetX: 48`, min 320 / max `min(360px, 92%)`) draws the 280×120 `role="img"` canvas (demand solid `--sg-ru-demand` `#1d4ed8`, supply dashed `--sg-ru-supply` `#2e7d32`) named by `trendLabel`, with the text legend. Opened by config (`summaryPanel` / `trendPanel`) or the service; both may be open at once; content re-renders on the data/pool notifications. Roles: `utilization.role(entry)` → first skill tag → kind (store-only resources roleless and omitted from role rollups). Teams: no accessor = one team named `defaultTeamName` covering everyone; with one, `undefined`-teamed entries and store-only resources are omitted from team rollups.

### 3.6 Load chart (internal/load-chart)

Two `view/bottomPanes` strips (with the `loadChart` nest present): the aggregate band `stargantt.load-chart:total` (`order: 0`) and the lanes strip `stargantt.load-chart:lanes` (`order: 1`); both OFF by default (contributed at height 0), shown per config `total` / `lanes`, through the §1.2 strip members (`setBandVisible` / `setLanesVisible` / the height setters), or via a raw `view/setBottomPaneHeight` dispatch; `resizable` per config with the two divider labels. Heights: band initial `--sg-load-chart-height` (64); lanes initial `min(--sg-load-lanes-height (96), laneCount × --sg-load-lane-height (28))`, roster-tracked until the reader (or a host height dispatch) sizes it, then theirs for the instance's life; tokens read once at setup. Rendering sits inside the `{ pane, gutter, body, trailing }` columns, with own-body observation and the standard view-mode behavior. **Rendering substrate (design note):** the band and lanes plots are canvas-rendered so the live strips and the export `auxiliarySurfaces` tile routine share one drawing pipeline; per-lane accessible DOM proxies (`.sg-load-lanes__lane`, `tabindex`, labels) exist beside the canvas, so the a11y surface is complete. Restyling for the plotted bars/lines is therefore token-only (`--sg-load-*`); no per-bar DOM classes exist. Container/strip/axis/label class names are stable public surface.

**Band**: per-bucket Σ`units` bars over active tasks plus the Σ`capacity ?? 1` line (per-run segments); bucket per `loadChart.bucket` with `"auto"` resolved against zoom density (the coarsening ladder; never sub-hour), week start from the timeline's `firstDayOfWeek()`; `resources` allowlist narrows bars, line, and hook inputs alike; overload segments above the line take `--sg-load-over-fill` plus the non-color hatch; task-count fallback when the store has neither resources nor assignments and no custom `load`; the step-first y-scale (magnitude-aligned in Σ mode via `durationUnitMs`), `axisLabels` (gutter labels + gridlines, in-plot fallback), `valueLabels` (top-gutter labels, width-fit omission), and the `bandLabel` accessible name with its `valueKind` discriminator complete the band. **Σ mode**: whenever `loadChart.resourceLoad` or `loadChart.resourceCapacity` is configured (§6.5; the `utilization` nest's pair never engages it), the band sums the §2 matrix per bucket (working-ms values, `duration`-formatted labels; zero summed capacity draws no line; zero rows revert to the built-in path including the fallback), overriding the band-level `load`/`capacity` functions; one matrix build per frame is shared with the lanes (§2.5's memo instance).

**Lanes**: one histogram lane per roster resource on the band's own (uncoarsened) bucket grid over the visible span, cells read from the post-hook matrix; `laneScale` `"ratio"` (default; shared ceiling `max(1, largest ratio)`, 100 % mark aligned) / `"shared"` / `"auto"`; run merging, pixel snapping, 2 px / 1 px lane padding, separator, zebra, the dashed stepped per-bucket reference line (`--sg-load-lane-reference`, ≥ 3:1), `laneValueLabels` (percent under ratio, `duration` text under absolute scales, width-fit), gutter-hosted names with the in-plot fallback, vertical scrolling with `tabindex="0"`, reveal-on-selection via the optional `selection` service (instant under `reducedMotion()`), and the `lanesLabel` / `laneLabel` accessible names complete the strip.

**Heatmap** (opened per §1.2): the corner-slot card (`.sg-load-heatmap`, `role="region"` labelled `heatmapTitle`) in the chart pane's claimed corner (§4.2 slot), positioned via that corner's `--sg-safe-*` pair, pane-relative caps (≈ 60 % height, ≤ ≈ 520 px width); `role="table"` grid, 16×16 cells shaded `--sg-load-fill` at opacity `min(1, ratio)` (`null` ratio: 1 when allocated > 0), over cells with the `--over` modifier + 2 px `--sg-load-over-fill` outline + `!` glyph; cell `aria-label`/`title` from `heatmapCellLabel`; re-opened options re-read the matrix (no options = whole-extent default); refresh on data and zoom notifications, rAF-batched.

**Reports** (§1.2 members): `utilizationReport` returns the coarsened matrix rows; the CSV is RFC 4180 with `reportColumnHeader` over the fixed order `resource, from, to, allocated, capacity, utilization`, inclusive ISO bucket stamps (day resolution at day-or-wider, minute below), `duration`-formatted allocated/capacity, ratio to ≤ 4 decimals; the PDF is the self-contained A4-landscape base-14-Helvetica table (Latin-1 with `?` replacement, ellipsized names), returned as a Blob. Saving is the host's `downloadFile` one-liner (`sdk/dom`).

**Export surface**: one `export/auxiliarySurfaces` contribution, `side: "bottom"`, aggregate band only, registered with the `loadChart` nest present; height 0 while the band is hidden (export-image drops height-0 surfaces — the exported image reproduces the screen); `drawTile`/`drawTileSVG` redraw FROM DATA through the very band pipeline (bucketing, allowlist, custom functions, Σ mode, fallback, the step-first projection over the exported span's own maximum). Inert without the export plugin; typed via `import type` from `@stargantt/plugin-export` (devDependency).

## 4. Extension points

### 4.1 Defined by this plugin

None.

### 4.2 Contributed by this plugin

| Target | Contribution | Order / slot / condition |
|---|---|---|
| `view/bottomPanes` | resource-view panel strip (§3.4) | id `stargantt.resource-view:panel`, `order: -1`; `view` nest present; height 0 unless `startOpen`; divider label `resizeLabel` |
| `view/bottomPanes` | aggregate load band (§3.6) | id `stargantt.load-chart:total`, `order: 0`; `loadChart` nest present; height 0 unless `total`; divider label `bandResizeLabel` |
| `view/bottomPanes` | resource lanes strip (§3.6) | id `stargantt.load-chart:lanes`, `order: 1`; `loadChart` nest present; height 0 unless `lanes` (roster formula); divider label `lanesResizeLabel` |
| `taskbars/overlays` | overload warning glyph (§3.5) | `utilization` nest present and `warnings` not `false` |
| `grid/columns` | Resources column (§3.3) | id `"resource.resources"`; `assign` nest present and `column` not `false` |
| `grid/columns` | Overallocation column (§3.5) | id `"resource.overallocation"`; `utilization` nest present and `column` not `false` |
| `export/auxiliarySurfaces` | the band's bottom surface (§3.6) | `loadChart` nest present; height follows band visibility |
| `drag/lanes` | one `LaneDragProvider` (§3.4) — `laneAt` / `reassign` / `highlightLane` / `laneOfTask` closures over the panel's lane geometry and write path | `view` nest present; interaction.md §3's contribution type, arrived via `import type` (devDependency). interaction.md names this plugin the official contributor; with no contribution, `dragEdit.resourceDrag` stays inert (interaction's rule). |
| `overlay-corner` (slot group) | heatmap card corner | `ctx.claimSlot("overlay-corner", "top-right", ["top-left", "top-right", "bottom-left", "bottom-right"])`, claimed at setup with the `loadChart` nest present. Top-right is also the filter toolbar's requested corner; under `claimSlot` arbitration a `{ granted: false, alternative }` answer moves the card to the granted alternative corner via that corner's `--sg-safe-*` pair (the scheduling diagnostics-panel precedent); no free alternative keeps the requested corner (the registry already emitted the warning-level report). Concrete outcome under the shipped preset order with every official corner claimant enabled (stated, so the default is deterministic and documented): scheduling holds top-left (diagnostics), interaction holds top-right (filter toolbar) and bottom-right (zoom toolbar; tree-grid's legend already competes there), so the heatmap receives `alternative: "bottom-left"` — the only free corner — and renders there. |

Strip-order note: the three `view/bottomPanes` orders −1 / 0 / 1 stack resource view above the band above the lanes; `order` here is the panes contribution's own stacking field (view.md), not a `claimOrder` scope, so no registry collision arises. This plugin claims nothing in `renderer/layers`. `grid/columns`, `taskbars/overlays`, and `export/auxiliarySurfaces` contribution types arrive via `import type` from their defining packages (devDependencies).

## 5. Commands and events

**Commands:** none of its own. Assignment and mirror writes are public data commands (§3.3's origins); strip heights ride the view plugin's `view/setBottomPaneHeight` — dispatched internally by the §1.2 strip members, or directly by hosts.

**Events:**

- Emits `resourceView/toggled { open: boolean; cause: "api" }` — an activity notification (official catalog; §3.4's emission rule).
- There are no `resourcePool/changed` / `resourcePool/bookingsChanged` events — the `resources` / `bookings` stores are the change channels (§1.1).
- Consumes the input/notification events `view/scrolled` (strip horizontal follow; vertical ignored) and `view/bottomPaneResized` (strip height bookkeeping via `onResize`/event), and — store-shaped — `data.tasks` / `data.resources` / `data.assignments` (repaints, cache drops, the §1.2 dirty mark), pool `resources` (interval-cache wholesale invalidation), `timeline.zoomLevel` (re-bucketing under `"auto"`, strip repaint), `SelectionService.state` late/optionally (lane reveal).

## 6. Config

Factory: `resource(config?: ResourceConfig)`. Each feature = one nested config group. **Presence semantics (normative):** every nest omitted leaves its feature DORMANT — no strip, no column, no glyph, no panel, no claim for that feature — while the two services stay provided (`resource-pool` over an empty pool; `utilization` computing over whatever data exists). Passing a nest (even `{}`) enables it with the defaults below. Unusable values silently fall back; config is read once at `setup()`. A single top-level `messages?: Partial<ResourceMessages>` covers every feature (§7).

### 6.1 `pool` — 3 fields

| Field | Type | Default | Semantics |
|---|---|---|---|
| `resources` | `readonly ResourcePoolEntryInit[]` | `[]` | Entries loaded at setup, in order; unusable inits dropped. |
| `bookings` | `readonly ResourceBookingInit[]` | `[]` | Bookings loaded after `resources`. |
| `syncToStore` | `boolean` | `false` | One-way mirror into the data store (§3.1); inert without effect on the pool itself. |

### 6.2 `assign` — 3 fields

| Field | Type | Default | Semantics |
|---|---|---|---|
| `column` | `boolean` | `true` | Contribute the Resources grid column (§3.3). |
| `columnWidth` | `number` | `160` | Column width, px; unusable values fall back. |
| `dragReassign` | `boolean` | `true` | Chip drag between tasks (§3.3). |

### 6.3 `view` — 4 fields

| Field | Type | Default | Semantics |
|---|---|---|---|
| `startOpen` | `boolean` | `false` | Strip contributed at height 0 unless true (§3.4). |
| `resizable` | `boolean` | `true` | Divider on the strip's top edge. |
| `teams` | `readonly ResourceViewTeam[]` | none | Team grouping; `{ name?, members? }`, unusable-name entries dropped, empty member lists render empty groups. |
| `projectOf` | `(task: Task) => string \| null \| undefined` | `task.meta.project` when a non-empty string | Segment project attribution; latched barrier. |

### 6.4 `utilization` — 12 fields

| Field | Type | Default | Semantics |
|---|---|---|---|
| `bucket` | `UtilizationBucketUnit` | `"day"` | Default width of the utilization queries and warning surfaces. |
| `weekStart` | `"monday" \| "sunday"` | `"monday"` | Week-bucket anchor of the utilization query surfaces (independent of the timeline header). |
| `threshold` | `number` | `1` | Over-allocation threshold ratio (§2.4). |
| `warnings` | `boolean` | `true` | The task-bar warning glyph (§3.5). |
| `column` | `boolean` | `true` | The Overallocation grid column (§3.5). |
| `summaryPanel` | `boolean` | `false` | Open the team capacity panel at setup. |
| `trendPanel` | `boolean` | `false` | Open the demand-vs-supply panel at setup. |
| `role` | `(entry: ResourcePoolEntry) => string \| undefined` | first skill tag, else kind | Role accessor; latched barrier. |
| `team` | `(entry: ResourcePoolEntry) => string \| undefined` | one team named `defaultTeamName` | Team accessor; latched barrier. |
| `range` | `{ start?: number; end?: number }` | task extent | Fixed default analysis range (both members required to be usable as a pair). |
| `resourceLoad` | `(input: ResourceBucketInput<ResourcePoolEntry \| Resource>) => number` | none | Per-cell allocated-time hook of the UTILIZATION surfaces — queries, rollups, trend, warning glyph, Overallocation column, both panels (§2.4). `input.resource` is the pool entry when the pool knows the resource, else the store `Resource`. Never engages Σ mode. Design note: both hook pairs are kept, one per consumer nest — this nest's and §6.5's (§2.6 item 3). |
| `resourceCapacity` | same shape | none | The utilization-side per-cell capacity hook; same containment, reach, and resource object. |

### 6.5 `loadChart` — 14 fields

| Field | Type | Default | Semantics |
|---|---|---|---|
| `bucket` | `UtilizationBucketUnit \| "auto"` | `"day"` | Band/lanes/heatmap/report width; `"auto"` follows zoom density (never sub-hour); unusable values fall back to `"day"`, not `"auto"`. |
| `resources` | `(string \| number)[]` | all store resources | Allowlist over bars, line, matrix rows, and hook inputs (§2.3). |
| `axisLabels` | `boolean` | `false` | Y-axis tick labels + gridlines (§3.6). |
| `valueLabels` | `boolean` | `false` | Per-bar numeric labels, width-fit. |
| `load` | `(input: LoadChartBucketInput) => number` | Σ`units` over active tasks | Band-bar override (band only; ignored in Σ mode; suppresses the task-count fallback). `LoadChartBucketInput = { tasks; resources; assignments; bucketStart; bucketEnd }`, allowlist-narrowed. |
| `capacity` | `(input: LoadChartBucketInput) => number \| null` | Σ`capacity ?? 1` | Capacity-line override (band only; `null` = no line there; ignored in Σ mode). |
| `resourceLoad` | `(input: ResourceBucketInput<Resource>) => number` | none | Per-cell allocated-time hook of the LOAD-CHART surfaces — lanes, heatmap, reports, and (its presence, or `resourceCapacity`'s, being the trigger) the band's Σ mode (§2.4, §3.6). `input.resource` is always the store `Resource` (§2.6 item 3). |
| `resourceCapacity` | `(input: ResourceBucketInput<Resource>) => number` | none | The load-chart-side per-cell capacity hook; same containment, reach, and Σ-mode trigger. |
| `heatmap` | `boolean` | `false` | Open the heatmap at setup. |
| `lanes` | `boolean` | `false` | Show the lanes strip from the start. |
| `total` | `boolean` | `false` | Show the aggregate band from the start. |
| `laneScale` | `"ratio" \| "shared" \| "auto"` | `"ratio"` | Lane scaling (§3.6). |
| `laneValueLabels` | `boolean` | `false` | Per-run lane value labels. |
| `resizable` | `boolean` | `true` | Dividers on both strips. |

## 7. Messages

`ResourceMessages` — one merged catalog (single top-level `messages` key), resolved once at setup with the shared catalog merge rules (`sdk/dom` `resolveCatalog`). Latched builders (per-cell/per-frame paths): `chipLabel`, `teamSummary`, `rowLabel`, `segmentLabel`, `overallocatedCell`, `teamCardLine`, `roleLine`, `trendLabel`, `heatmapCellLabel`, `laneLabel`, `duration` (all per-cell/per-frame paths). `bandResizeLabel` / `lanesResizeLabel` / `resizeLabel` are divider accessible names: an empty or blank override falls back to the default rather than suppressing it (a focusable separator is never unnamed); every other string member accepts `""` as suppression.

One catalog covers the four message-bearing areas — **37 keys**. Shared keys: `closeLabel` (`"Close"`) serves every close button of this plugin's panels, and `duration` is the plugin's ONE duration formatter, routed through the `internal/engine` consumers to every built-in duration-embedding text. The two column headers are area-prefixed (`assignColumnHeader` / `utilizationColumnHeader`). The pool area contributes no keys (it renders nothing).

| Key | Area | Default |
|---|---|---|
| `assignColumnHeader` | assign | `"Resources"` |
| `editorTitle` | assign | `"Assign resources"` |
| `emptyChoices` | assign | `"No resources available"` |
| `applyLabel` | assign | `"Apply"` |
| `cancelLabel` | assign | `"Cancel"` |
| `openEditorLabel` | assign | `"Edit resource assignments"` |
| `chipLabel` | assign | builder `({ name, unitsPercent }) =>` the name alone at 100 %, `` `${name} ${unitsPercent}%` `` otherwise |
| `unitsInputLabel` | assign | builder `(name) => "Allocation percent for <name>"` |
| `assignToggleLabel` | assign | builder `(name) => "Assign <name>"` |
| `panelLabel` | view | `"Resource view"` |
| `ungroupedTeam` | view | `"Other resources"` |
| `resizeLabel` | view | `"Resize resource view"` |
| `teamSummary` | view | builder; `"{name}: {memberCount} members, capacity {capacity}, peak load {peak}, free {free}"` + `", {overloadedMembers} overallocated"` when positive |
| `rowLabel` | view | builder; the name, plus `" (overallocated)"` when over |
| `segmentLabel` | view | builder; task name + `" {percent}%"` (non-100 %) + `" [{project}]"` + `" (over)"` |
| `utilizationColumnHeader` | utilization | `"Overallocation"` |
| `overallocatedCell` | utilization | builder `({ resources }) => "⚠ Over: <names>"` |
| `summaryTitle` | utilization | `"Team capacity"` |
| `teamCardLine` | utilization | builder; `"{team}: {duration(allocated)} allocated of {duration(capacity)}, {duration(available)} free"` + `" ({overallocatedCount} overallocated)"` when positive |
| `roleTitle` | utilization | `"Demand by role"` |
| `roleLine` | utilization | builder; `"{role}: {duration(demand)} demand of {duration(capacity)} capacity"` |
| `trendTitle` | utilization | `"Demand vs supply"` |
| `trendLabel` | utilization | builder; `"Demand vs supply, {bucketCount} buckets: peak demand {duration(peakDemand)}, peak supply {duration(peakSupply)}."` |
| `demandLegend` | utilization | `"Demand"` |
| `supplyLegend` | utilization | `"Supply"` |
| `closeLabel` | utilization + loadChart | `"Close"` |
| `defaultTeamName` | utilization | `"All resources"` |
| `duration` | utilization + loadChart | builder `(ms) => auto-magnitude duration` (`"1.5d"` / `"4h"` / `"30m"` / `"12s"` — the sdk formatter) |
| `bandLabel` | loadChart | builder over `LoadChartBandLabelInput` (with the `valueKind`/`fallback` discriminators); normative wordings: `"Resource load chart, {bucketCount} buckets from {start} to {end}: peak load {peakLoad} of capacity {peakCapacity}, {overloadedBuckets} overloaded."` / no-capacity form / `"…peak of {peakLoad} active tasks."` fallback form |
| `lanesLabel` | loadChart | builder `({ laneCount }) => "Resource load by resource, {laneCount} resources."` |
| `laneLabel` | loadChart | builder over `LoadChartLaneLabelInput`; `"{resourceName}, {bucketCount} buckets from {start} to {end}: peak load {peakLoad} of capacity {capacity}, {overloadedBuckets} overloaded."` (`peakLoad` per `valueKind`) |
| `bandResizeLabel` | loadChart | `"Resize load chart band"` |
| `lanesResizeLabel` | loadChart | `"Resize resource lanes"` |
| `heatmapTitle` | loadChart | `"Load heatmap"` |
| `heatmapCellLabel` | loadChart | builder over `LoadChartHeatmapCellInput`; `"{resourceName}, {from} – {to}: load {allocated} of capacity {capacity}"` (+ `", overloaded"`), durations through `duration`, inclusive bucket stamps |
| `reportTitle` | loadChart | `"Resource utilization report"` |
| `reportColumnHeader` | loadChart | builder `(column: UtilizationReportColumn) => "Resource" / "From" / "To" / "Allocated" / "Capacity" / "Utilization"` |

The label-input types (`LoadChartBandLabelInput`, `LoadChartLaneLabelInput`, `LoadChartHeatmapCellInput`, `ResourceViewTeamSummaryInput`, `ResourceViewRowLabelInput`, `ResourceViewSegmentLabelInput`, `ResourceViewTeam`) are public types of this package.

## 8. Internal modules

Directory = feature area; every file ≤ 800 lines; every area enters through `wire.ts`. The `engine/` subtree is headless — no DOM, no service reference, no `internal/` import; enforced by the architecture lint's import scan so vitest targets it in plain Node.

| Directory | Files | Content |
|---|---|---|
| root (4) | `index.ts`, `types.ts`, `config.ts`, `internal/messages.ts` | factory, wiring, the corner-slot claim; the single declaration-merging site; nest resolution; the 37-key catalog + resolver |
| `engine/` (6) | `compute.ts` | `computeUtilization` — the accrual sweep, hooks, seal |
| | `buckets.ts` | the eight grids, epoch alignment, `"auto"` resolution, the coarsening ladder, the 8192 cap |
| | `working-time.ts` | the per-resource interval windows, day-contained splitting, sub-day cuts, the default-calendar listing |
| | `range.ts` | the two range-resolution policies + task extent |
| | `rollups.ts` | trend / role / team folds, `peakRatio`, `overlaps` |
| | `memo.ts` | the one-entry memo HELPER; instantiated per consumer — the only instance is `internal/load-chart/wire.ts`'s (§2.5) |
| `internal/pool/` (6) | `wire.ts`, `pool.ts`, `calendar.ts`, `bookings.ts`, `sync.ts`, `service.ts` | wiring; entry normalization + skills + time off; calendar evaluation over sdk/time; bookings; the store mirror; the store-shaped service |
| `internal/assign/` (7) | `wire.ts`, `model.ts`, `cell.ts`, `editor.ts`, `placement.ts`, `style.ts`, `commit.ts` | wiring + column contribution; choices/diff model; cell/chips; the editor dialog; anchored placement; tokens; the one-transaction commit + drag drop (batcher-based) |
| `internal/view/` (5) | `wire.ts`, `model.ts`, `panel.ts`, `lanes.ts`, `reassign.ts` | wiring + strip contribution + toggled event; row/sweep/team model; the strip DOM; lane geometry; the `drag/lanes` provider + `reassign` |
| `internal/utilization/` (7) | `wire.ts`, `warnings.ts`, `column.ts`, `panels.ts`, `service.ts`, `roster.ts`, `empty-report.ts` | wiring + service assembly + the §1.2 freshness store; warned-task set + bar overlay; the grid column; the two dialogs |
| `internal/load-chart/` (10) | `wire.ts`, `band.ts`, `band-view.ts`, `axis.ts`, `lanes-model.ts`, `lanes-view.ts`, `geometry.ts`, `heatmap.ts`, `report-csv.ts`, `report-pdf.ts` | wiring + the two strip contributions + Σ-mode seam; band aggregation + fallback; band DOM; the step-first y-scale + labels; lane model over the matrix; lane DOM; shared strip geometry; the heatmap card; the CSV/PDF writers; the export surface |

## 9. Dependencies

`dependsOn` (hard): `data` (L1) — the only indispensable edge (rosters, assignments, task spans; the pool alone is even data-free, but the plugin as a unit reads the store everywhere). All chart-surface edges follow the scheduling.md §14 optional-inert pattern: `view` (L2 — bottomPanes strips, chart pane, timeline t↔x, theme tokens, dialogs' gating) is optional; absent, every strip, column consumer, glyph, panel, and the heatmap stay silently inert (no `core/pluginError`) while both services — pool ledger, working-time surfaces, utilization queries, reports — keep working headless (`dataStore() + resource()` computes utilization and serializes reports in plain Node). `meta.optional`: `stargantt.view`, `stargantt.tree-grid`, `stargantt.task-bars`, `stargantt.interaction`, `stargantt.export`. Resolution timing per the §14 rule: the corner-slot claim at setup; strip/column/overlay contribution bodies and every optional service resolved at `lifecycle/ready` or per use, never latched at setup (composition order must not change what the numbers mean).

Also optional (late lookup): `selection` (interaction, L5 — lane reveal-on-selection; absent, off). No scheduling-calendars edge exists (pool calendars are id-less `ResourceWorkCalendar`s evaluated through `sdk/time`), and no tracking edge exists in this direction — it is tracking that optionally consumes `stargantt.resource-pool` for cost rates (tracking.md §8); resource consumes nothing from tracking. No upward `ctx.use` edge exists; upward integration is contribution-borne (`drag/lanes`, `export/auxiliarySurfaces`, `grid/columns`, `taskbars/overlays`, `view/bottomPanes`).

## 10. Third-party surface

- **Consumable services:** `stargantt.resource-pool` (`ResourcePoolService` — entry/booking stores, ledger mutation, the three working-time surfaces that publish pool policy), `stargantt.utilization` (`UtilizationService` — the aggregation store, per-resource buckets, rollups, trend, reports, heatmap/panels).
- **Contributable extension points:** none defined by this plugin. The points it contributes to (`view/bottomPanes`, `taskbars/overlays`, `grid/columns`, `export/auxiliarySurfaces`, `drag/lanes`) remain public points of their defining plugins, open to third parties alongside resource's contributions. There is no assignment, resource-view, or load-chart service; the data and write paths remain reachable per §1.3's capability map.
- **Subscribable events:** `resourceView/toggled`. Pool and aggregation state are observed via the stores.
- **Config-function seams:** the two per-consumer hook pairs `utilization.resourceLoad` / `resourceCapacity` and `loadChart.resourceLoad` / `resourceCapacity` (§2.4 containment; per-side resource objects), `loadChart.load` / `capacity` (band-only), `view.projectOf`, `utilization.role` / `team`, and every message builder — foreign code under the recorded latch/unlatch classifications (§7).
- **Transaction origins (documentation convention):** `stargantt.resource/pool-sync`, `stargantt.resource/assign-apply`, `stargantt.resource/reassign` — hosts recognize this plugin's writes by them (each batcher-suffixed `#<n>` per commit).
- **Reserved namespaces / slots (documentation convention only):** the `stargantt.resource-pool` / `stargantt.utilization` service IDs; the bottom-pane strip ids `stargantt.resource-view:panel`, `stargantt.load-chart:total`, `stargantt.load-chart:lanes`; the grid-column ids `resource.resources` / `resource.overallocation`; the `overlay-corner` `top-right` claim (a third party claiming an occupied corner receives `SlotGrant.alternative` — architecture ch. 1.2); the `--sg-rv-*` / `--sg-load-*` / `--sg-ru-*` / `--sg-ra-*` token families and the stable `.sg-resource-view*` / `.sg-load-chart*` / `.sg-load-lanes*` / `.sg-load-heatmap*` / `.sg-ra-*` class names (restyling surface). Not enforced in core beyond slot-registry conflict reporting.
- **Hardening:** hooks and builders contained per §2.4/§7; store snapshots immutable per the core store contract; every query member side-effect-free; `reassign` and the editor commit are single transactions through the public command surface — no back-door APIs.
