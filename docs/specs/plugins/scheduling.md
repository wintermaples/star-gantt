# Plugin: scheduling (`stargantt.scheduling`)

Package: `@stargantt/plugin-scheduling` — Layer 6.
Status: normative.

## Purpose

Dependency links (painting, routing, creation by pointer and keyboard, selection/deletion, inspector); the headless auto-scheduling engine (topological forward propagation, back-clamp, eight built-in constraint types, three effort modes, schedule modes, status-date reschedule, cycle rejection); working calendars (registry, task assignment, non-working shading, editor); CPM analysis (critical path, float, classification, highlights); the schedule diagnostics panel.

Core design: one package with a strict internal boundary — `engine/` is a headless scheduling engine that never touches the DOM or any UI service (vitest targets it directly), and the four `internal/` areas carry the UI. Working-time arithmetic has exactly one implementation, `sdk/time` (§2.2); snapping's working-time and stand-down integration is carried by interaction-owned extension points (§4), never by upward service edges.

## 1. Services

### 1.1 `stargantt.scheduler` → `SchedulerService`

The auto-schedule engine service. It is stateless with respect to the store (pure functions over a `ReadonlyDataView`), so the store shape does not apply to it.

```ts
import type {
  Link, LinkId, Patch, ReadonlyDataView, TaskId,
} from "@stargantt/plugin-data-store";

/** The two scheduling modes a task can be in (§2.4). */
export type TaskScheduleMode = "auto" | "manual";

/** The three effort-accounting modes a task can declare under `meta.effortMode` (§2.5). */
export type EffortMode = "fixed-duration" | "fixed-work" | "fixed-units";

export interface SchedulerService {
  /** Differential forward propagation from the changed set; never a full recompute (§2.1). */
  schedule(view: ReadonlyDataView, changed: ReadonlySet<TaskId>): Patch[];
  /** As `schedule`, deferred off the current frame; identical result over the same inputs.
   *  The view stays unchanged until the promise settles. After dispose every still-pending
   *  call resolves with []. The deferral timer is owned via ctx.own(). */
  scheduleAsync(view: ReadonlyDataView, changed: ReadonlySet<TaskId>): Promise<Patch[]>;
  /** Backward pass (latest start/finish per task). Engine-own semantics:
   *  cycle members keep their stored dates (unlike sdk/cpm's latestTimes, which omits
   *  them — the critical-path analysis of §7 reads sdk/cpm, not this member). */
  latestTimes(view: ReadonlyDataView): ReadonlyMap<TaskId, { latestStart: number; latestFinish: number }>;
  /** Cycle detection used in the will phase of link/add (§2.7): the link-id chain the
   *  candidate would close into a cycle, or undefined when it closes none. */
  detectCycle(view: ReadonlyDataView, candidate: Link): readonly LinkId[] | undefined;
  /** Dry run of `schedule/reschedule` — the exact patches the command would apply (§2.6).
   *  Nothing is applied, dispatched or emitted; unusable status dates return []. */
  previewReschedule(statusDate: number): Patch[];
  /** The task's scheduling mode; unknown ids read as "auto" (§2.4). */
  taskScheduleMode(id: TaskId): TaskScheduleMode;
  /** Whether this scheduler propagates automatically: exactly the resolved
   *  `autoSchedule.enabled` value, constant for the instance lifetime, side-effect-free.
   *  Published so other reconcilers can stand down (§4.2). */
  propagationEnabled(): boolean;
}
```

Member count: 7. (The per-transaction projection is engine-internal, `engine/projection.ts` — deliberately not a service member.)

### 1.2 `stargantt.calendars` → `CalendarsService`

Store-shaped: the registry list and the shade selection are read from the `state` store.

```ts
import type { CalendarDef, CalendarId, TaskId } from "@stargantt/plugin-data-store";
import type { TimeRange } from "@stargantt/sdk"; // re-exported by this package

/** A registry calendar: a CalendarDef plus registry-only metadata. */
export interface CalendarInit extends CalendarDef {
  /** Human-readable name shown by editors and pickers. Defaults to String(id). */
  name?: string;
  /** Marks the project-default calendar: used for tasks without a calendarId, shaded when
   *  `calendars.shadeCalendar` is omitted, and the snap/workingTime default (§4.1). At most
   *  one entry should carry it; when several do, the first registered wins. */
  isDefault?: boolean;
}

/** Input of the regionCalendar builder (weekend pattern + holiday list → CalendarInit). */
export interface RegionCalendarInit {
  id: CalendarId;
  name?: string;
  isDefault?: boolean;
  /** Weekly non-working days, 0 = Sunday … 6 = Saturday (UTC). Defaults to [0, 6]. */
  weekend?: readonly number[];
  /** Holiday dates, "YYYY-MM-DD" (UTC). Each becomes a non-working exception. */
  holidays?: readonly string[];
  /** Optional working windows, [startMs, endMs) in ms from UTC midnight, forwarded verbatim. */
  workingHours?: [number, number][];
}

/** Pure builder; unusable weekend entries and malformed dates are dropped. Package export. */
export declare function regionCalendar(init: RegionCalendarInit): CalendarInit;

/** A special period: one working-time designation over an inclusive "YYYY-MM-DD" range. */
export interface CalendarExceptionRange {
  from: string;                    // first day (UTC), included
  to: string;                      // last day (UTC), included
  working: boolean;                // overrides the weekly pattern for those days
  hours?: [number, number][];      // ms from UTC midnight; omitted, a working day keeps the calendar's own windows
}

export interface CalendarsState {
  /** The registry's calendars, in registration order. */
  readonly calendars: readonly Readonly<CalendarInit>[];
  /** The calendar currently shaded in the chart body, or undefined for none. */
  readonly shadeCalendar: CalendarId | undefined;
}

export interface CalendarsService {
  /** Set exactly once per registry edit gesture — the eight announcing mutators:
   *  define, remove, setWorkingDays, setWorkingHours, setException, removeException,
   *  setExceptionRange, removeExceptionRange (a special period is ONE set however
   *  many days it covers). setShadeCalendar ALSO sets the store — the state carries
   *  shadeCalendar as an observable component, so a shade change
   *  publishes too. assignTask sets nothing here (it is a
   *  task/update transaction and notifies through the data stores). */
  readonly state: Store<CalendarsState>;
  /** Resolves an id: the registry first, then the data store's calendars. undefined when
   *  neither knows the id or when id is undefined. Registry calendars shadow store
   *  calendars with the same id. */
  resolve(id: CalendarId | undefined): Readonly<CalendarDef> | undefined;
  /** Adds or replaces a registry calendar. An unusable definition is ignored (no-op). */
  define(calendar: CalendarInit): void;
  /** Removes a registry calendar. Unknown ids are a no-op. */
  remove(id: CalendarId): void;
  /** Replaces a registry calendar's weekly working days (0–6, UTC). Unusable input: no-op. */
  setWorkingDays(id: CalendarId, workingDays: readonly number[]): void;
  /** Replaces a registry calendar's intra-day windows (ms from UTC midnight). An empty
   *  list clears them (day-granular again). Unusable input: no-op. */
  setWorkingHours(id: CalendarId, workingHours: readonly (readonly [number, number])[]): void;
  /** Applies one designation to every UTC day of the inclusive range — equivalent to
   *  setException per day, replacing whatever those days carried. Unknown id, malformed or
   *  inverted range, or a range over 4000 days (sdk/time MAX_SKIPPED_DAYS): refused whole. */
  setExceptionRange(id: CalendarId, range: CalendarExceptionRange): void;
  /** Removes every exception dated inside the inclusive [from, to]. Unknown id, malformed
   *  or inverted range, or a range covering no exception: no-op. */
  removeExceptionRange(id: CalendarId, from: string, to: string): void;
  /** Adds or replaces one date's exception ("YYYY-MM-DD", UTC). Unusable input: no-op. */
  setException(id: CalendarId, exception: { date: string; working: boolean; hours?: [number, number][] }): void;
  /** Removes one date's exception. Unknown date/id: no-op. */
  removeException(id: CalendarId, date: string): void;
  /** The calendar a task is effectively on: its calendarId resolved via resolve(), else the
   *  registry's default calendar, else undefined. */
  effectiveCalendar(taskId: TaskId): Readonly<CalendarDef> | undefined;
  /** Assigns (or, with undefined, clears) a task's calendar by dispatching task/update —
   *  transactional and undoable like any other task edit. Unknown task: no-op. */
  assignTask(taskId: TaskId, calendarId: CalendarId | undefined): void;
  /** Working-time queries — thin id-resolving wrappers over sdk/time (§2.2); the engine's
   *  invariants hold. Unresolvable-calendar defaults follow the "no calendar,
   *  no rest days" policy: everything is working time. */
  isWorkingDay(calendar: CalendarId | Readonly<CalendarDef> | undefined, t: number): boolean;
  isWorkingInstant(calendar: CalendarId | Readonly<CalendarDef> | undefined, t: number): boolean;
  /** Working intervals intersecting half-open [from, to), clipped, merged, ascending.
   *  Empty when the calendar cannot be resolved. */
  workingIntervals(calendar: CalendarId | Readonly<CalendarDef> | undefined, from: number, to: number): readonly TimeRange[];
  /** Working ms counted in [from, to); 0 when to <= from. Unresolvable: to − from clamped ≥ 0. */
  workingMsBetween(calendar: CalendarId | Readonly<CalendarDef> | undefined, from: number, to: number): number;
  /** The instant workingMs of working time after start. Unresolvable: start + workingMs. */
  addWorkingMs(calendar: CalendarId | Readonly<CalendarDef> | undefined, start: number, workingMs: number): number;
  /** The inverse of addWorkingMs. Unresolvable: end − workingMs. */
  subtractWorkingMs(calendar: CalendarId | Readonly<CalendarDef> | undefined, end: number, workingMs: number): number;
  /** First working instant at or after t. Unresolvable: t unchanged. */
  nextWorkingStart(calendar: CalendarId | Readonly<CalendarDef> | undefined, t: number): number;
  /** Last instant at or before t that can close working time. Unresolvable: t unchanged. */
  previousWorkingEnd(calendar: CalendarId | Readonly<CalendarDef> | undefined, t: number): number;
  /** The millisecond-precise non-working complement of [from, to) — whole non-working days
   *  AND intra-day gaps — clipped, merged, ascending. Empty when unresolvable. */
  nonWorkingRanges(calendar: CalendarId | Readonly<CalendarDef> | undefined, from: number, to: number): readonly TimeRange[];
  /** Changes which calendar is shaded; undefined turns shading off. Sets the state store
   *  and repaints on change. */
  setShadeCalendar(id: CalendarId | undefined): void;
  /** Opens the editor (only when `calendars.editor` mounted a panel — §6.3). */
  openEditor(id?: CalendarId): void;
  /** Closes the editor. No-op when it is not open. */
  closeEditor(): void;
}
```

Member count: 24 (the `state` store + 23 methods). Naming note: the public member is `nonWorkingRanges` even though the underlying `sdk/time` operation is `nonWorkingIntervals`; the divergence is deliberate and is not a consistency defect to be "fixed". The service is provided unconditionally — with the `calendars` config nest omitted it serves an empty registry and changes nothing on screen or in the schedule. Registry semantics: registry edits are OUTSIDE the transaction/patch/undo pipeline (`assignTask` is the one exception); a usable definition has a string/number `id` and an array `workingDays`; `workingDays` entries outside integer 0–6 are dropped; exception entries without a `"YYYY-MM-DD"` date string and boolean `working` are dropped; window values are milliseconds from UTC midnight; `setExceptionRange` expands to one exception entry per UTC day (no range is persisted) and is refused whole rather than applied in part; a bulk `load()` (observed through the `data.tasks` store with no transaction) re-evaluates shading and never touches the registry.

### 1.3 `stargantt.critical-path` → `CriticalPathService`

Store-shaped: the lazily-cached analysis is read from the `analysis` store, with shorthand readers beside it. Consumed by the export plugin (the print critical veil, optional edge) and by third parties; tracking computes its own baseline/slip deltas via `sdk/cpm` and declares no edge.

```ts
/** Which criticality class a task falls in. */
export type Criticality = "critical" | "nearCritical" | "negativeFloat";

/** A task's slack, in milliseconds of elapsed time. */
export interface TaskFloat {
  /** How far the finish can slip without moving the project finish; negative when the
   *  current dates already violate a successor requirement. */
  totalFloat: number;
  /** How far the finish can slip without moving any successor's current dates. */
  freeFloat: number;
}

/** One maximal chain of critical tasks connected by critical links. */
export interface CriticalPath {
  /** Member tasks, ordered by start date (ties by id order of discovery). */
  tasks: readonly TaskId[];
  /** The critical links joining the member tasks. */
  links: readonly LinkId[];
}

/** The full result of one analysis pass. */
export interface CriticalPathAnalysis {
  /** Float per analyzable task (summaries and cycle members carry no entry — §7.1). */
  floats: ReadonlyMap<TaskId, TaskFloat>;
  /** Criticality class per classified task; tasks above every threshold have no entry. */
  classes: ReadonlyMap<TaskId, Criticality>;
  /** Links whose both endpoints are critical/negative-float and whose own slack is within
   *  the critical threshold. */
  criticalLinks: ReadonlySet<LinkId>;
  /** Every parallel critical path, ordered by earliest member start. */
  paths: readonly CriticalPath[];
}

export interface CriticalPathService {
  /** The current analysis. Satisfies the core Store contract (get/subscribe); freshness
   *  follows the dirty-flag rules stated below the interface — a lazy recompute
   *  adapted to the store shape, so an idle composition pays no CPM work. */
  readonly analysis: Store<CriticalPathAnalysis>;
  /** Shorthand for analysis.get().floats.get(id). */
  floatOf(id: TaskId): TaskFloat | undefined;
  /** Shorthand for analysis.get().classes.get(id) — undefined means "not critical". */
  criticalityOf(id: TaskId): Criticality | undefined;
  /** Shorthand for analysis.get().paths. */
  paths(): readonly CriticalPath[];
}
```

Member count: 4 (3 shorthand methods + the store). The service is provided unconditionally; the `criticalPath` config nest gates only the visuals (§7.3).

**Freshness (normative).** The `analysis` property is this plugin's own object satisfying the core `Store` contract, wrapping an internal writable store:

1. The store's initial value is the empty analysis (all four collections empty).
2. Every `data.tasks` notification marks the analysis **dirty** — a boolean write, nothing more.
3. The recompute — one O(tasks + links) pass, never per frame — runs and `set`s the internal store (clearing the flag) at exactly two kinds of moment: **immediately within the data notification** when any §7.3 visual is active per config OR the store has at least one live subscriber; otherwise **on demand**, at the next read — `analysis.get()`, any of the three shorthand members, or a `subscribe()` made while dirty — which recomputes and sets before answering, so no caller ever observes a stale value. For a `subscribe()` made while dirty, the recompute and its `set` complete before the new subscription is registered, so the newcomer receives no immediate callback (the core's no-callback-on-subscribe contract holds).
4. The internal `set` follows the core store contract (synchronous notification with `(next, prev)`), so a demand-triggered recompute notifies existing subscribers at that set — subscribers therefore observe exactly one fresh analysis per data change that anything consumed.
5. Consequence (reconciling §11's dormancy): a composition with the `criticalPath` nest omitted, no subscriber, and no reader pays a dirty-flag write per transaction and **zero** CPM work.

### 1.4 Deliberate non-service

There is no schedule-diagnostics service (architecture ch. 4.1: the panel is internal). The orphan/lead detection rules live inside `internal/diagnostics/` and reach users only through the opt-in panel (§8); the report shapes are not public API.

## 2. The scheduling engine (normative)

The engine is headless: pure functions over `ReadonlyDataView` returning `Patch[]`, unit-testable in plain Node.

### 2.1 Propagation

**When it runs.** Only while `autoSchedule.enabled` is `true`, and only for transactions whose `origin === "user"`: only a direct user edit starts a derivation chain — undo-redo's `"history"` replays, and any other custom origin, already carry their final patches, and re-deriving over them would overwrite the very state being reproduced. The hook is `data/willApplyTransaction`: follow-on patches are appended into the SAME transaction, so an edit and its consequences are one atomic apply and one undo step.

Origin design note: the engine dispatches no transaction of its own — its output is always appended into the seeding user transaction — so no scheduler origin string exists. Every dispatch this plugin makes — `schedule/reschedule`'s head `task/update`, `schedule/setTaskMode`'s `task/update`, `CalendarsService.assignTask`'s `task/update` — deliberately carries the default origin `"user"`: that is precisely what makes them will-hook-processed, propagated, and undoable (the reschedule folding of §2.6 depends on it); a custom origin prefix is deliberately not used.

**What seeds it.** A `task/update` patch seeds the forward closure only when it changes a scheduling input: `start`, `end`, `parentId`, `constraint`, `calendarId`, or the `scheduleMode` meta key — the complete set the engine reads. The patch seeds when one of them is named by `clears`, or appears in `after` holding a value different from `before` (`constraint` compared by `type` and `date`, `meta` only through the `scheduleMode` key, the rest by `===`). A progress drag, a rename, a foreign `meta` write, and a write-back that changes nothing propagate nothing — and neither do the `meta.work` follow-ons of §2.5. `task/add` and `task/remove` always seed the task and its parent; `link/add` / `link/remove` / `link/update` seed the link's SOURCE (a `link/update` — retype or re-lag — is classified exactly as a fresh edge: the projection replaces the stored link and the forward closure reaches the target along the surviving edge); resource and assignment ops seed nothing. Seeding decides when the engine runs, never what it computes.

**Forward pass.** Differential topological propagation from the seed set — never a full recompute. For each derived task the pass computes two bounds separately and never converts one into the other: a **start-side** bound (the maximum over `FS`/`SS` predecessors together with any `earliestStart` constraint bound) and an **end-side** bound (the maximum over `FF`/`SF` predecessors). Per link with `lag` (elapsed ms, negative = lead, absent = 0):

| Type | Bound imposed on the target | Anchor |
|---|---|---|
| `FS` | `source.end + lag ≤ target.start` | start |
| `SS` | `source.start + lag ≤ target.start` | start |
| `FF` | `source.end + lag ≤ target.end` | end |
| `SF` | `source.start + lag ≤ target.end` | end |

The task is placed from the end-side bound when that placement starts no earlier than the start-side bound, and from the start-side bound otherwise (a later start yields a later end, so the start-side placement still satisfies the end-side bound — the early-side-wins rule restated for two anchors). Landing an end on working time is the mirror of landing a start (`sdk/time` `landWorkingEnd`): an end already at a working instant, or exactly at the close of a working interval, stays; an end inside a non-working gap moves FORWARD to the next working interval's start, never backwards. Summary tasks roll up to `min(child.start)` / `max(child.end)` of their children, expressed as patches in the same transaction. The observable guarantee: repeating an edit that seeds the same closure yields the same dates every time (placements are fixed points).

**Duration model.** Everything that repositions a task goes through one `DurationModel` pair `endFor(start)` / `startFor(end)`. Against a calendar with usable working hours the two are separated by working time (`addWorkingMs` / `subtractWorkingMs`); otherwise by a fixed elapsed duration. Duration is always derived (`end − start`), never stored.

### 2.2 Working time — `sdk/time` is the sole implementation

Normative: every working-time computation in this plugin — boundary placement, measurement, add/subtract, interval listing, `landWorkingEnd`, the UTC date-key family — is imported from `sdk/time`. This plugin re-implements no calendar arithmetic. One helper with no direct `sdk/time` counterpart lives inside the engine: `previousWorkingDayTime` (the back-clamp's day-granular backward landing, in `engine/engine.ts`) — it is composed entirely from `sdk/time` primitives and is not a reimplementation. The engine's invariants apply verbatim (sdk.md): half-open `[start, end)` ranges; a working day without usable intra-day windows is working for the whole day; exceptions override `workingDays`, an exception's `hours` override the calendar's windows, first duplicate date wins; walks are bounded (`MAX_SKIPPED_DAYS = 4000`) and degrade to the input instant or elapsed arithmetic instead of throwing.

Consequences: a task's duration is interpreted as working time when its calendar declares usable `workingHours` windows — a task pushed across non-working hours lengthens in elapsed terms while preserving its working duration; non-working skips resolve at working-interval granularity; a calendar without usable windows keeps day granularity; a calendar with no working time at all hits the walk bound and the task is placed on the unmodified instant — `schedule()` returns normally and never throws for it (a data error made visible in the result, not a scheduling failure).

**Calendar resolution.** The engine resolves a task's effective calendar through the plugin's internal registry resolution — registry first, then the data store, then the registry default (`CalendarsService.effectiveCalendar`'s rule). The official registry reflection is engine-internal: the two duration rules — working-duration preservation with anchor-held landing for a windowed calendar, elapsed-span preservation for a day-granular one — are simply the engine's own §2.1/§2.2 behavior over the resolved calendar (the `schedule/propagationRule` point of §3.1 exists purely for third parties). Every engine pass — propagation, back-clamp, effort — resolves through the same internal resolution, so a registry-only calendar constrains all of them uniformly.

### 2.3 Constraints

Eight built-in constraint types (`ConstraintType` is data-store's open union). Bounds are expressed through the task's own duration model (§2.1); a dateless constraint of a date-bearing type bounds nothing.

- **`ASAP`** — an intentional no-op: exactly what the unconstrained forward pass computes. Implementation comments state the equivalence.
- **`SNET`** — early-side: `earliestStart = date`.
- **`FNLT`** — late-side: `latestEnd = date`; enforced by the back-clamp pass below.
- **`ALAP`** — late-side: as late as the successors' constraints permit; back-clamp pass.
- **`SNLT`** — start no later than date; late-side: `latestEnd = endFor(date)`.
- **`FNET`** — finish no earlier than date; early-side: `earliestStart = startFor(date)`.
- **`MSO`** — must start on date; both sides: `earliestStart = date`, `latestEnd = endFor(date)`.
- **`MFO`** — must finish on date; both sides: `earliestStart = startFor(date)`, `latestEnd = date`.

**Back-clamp.** After the normal forward pass, a second pass pulls each `ALAP`/`FNLT` (and late-side `SNLT`/`MSO`/`MFO`) task late-ward to its upper bound, propagating the pull through its successors' constraints. Where an early-side bound (SNET, or a dependency's earliest start) conflicts with a late-side one, **the early side wins** — an `MSO`/`MFO` pin degrades to its early-side half rather than violating the graph. The back-clamp is not coupled to `latestTimes()` and introduces no backward-pass architecture.

**Custom types** are resolved through `schedule/constraintBounds` (§3.1) and clamp exactly as the corresponding built-in side would; contributions are consulted only for types outside the eight built-ins.

### 2.4 Schedule modes — `task.meta.scheduleMode`

A task is **manually scheduled** when `task.meta.scheduleMode === "manual"`; every other shape (absent `meta`, absent key, any other value) is **automatic** — the default. The key is claimed via `ctx.claimKey("task.meta", "scheduleMode")` and rides the ordinary patch/undo pipeline; no store change exists.

Engine semantics (unconditional, not behind config): a manual task is never moved by any pass — not by forward propagation, not by the back-clamp, not by a reschedule — but still participates as a fixed predecessor (its current dates drive its successors' bounds) and still rolls up into its parent. A manual **summary** keeps its own dates instead of rolling up from its children.

Surface: `taskScheduleMode(id)` reads the mode (`"auto"` for unknown ids); the `schedule/setTaskMode` command switches it through one undoable `task/update` (unrelated `meta` keys preserved; switching to `"auto"` removes the key, and an emptied `meta` is removed via `clears`; unusable ids/modes and no-op switches are silently ignored). Indicator: `autoSchedule.modeColumn: true` contributes one read-only `grid/columns` column — id `"scheduling.mode"`, width 64, header/cells from the `modeColumnHeader` / `modeAuto` / `modeManual` catalog keys. Without the tree-grid plugin the contribution is inert.

### 2.5 Effort modes — `task.meta.effortMode` / `task.meta.work`

Opt-in per task through two claimed meta keys (`ctx.claimKey("task.meta", "effortMode")`, `ctx.claimKey("task.meta", "work")`):

- `effortMode` — one of the three `EffortMode` strings; any other value (or absence) disables effort accounting for the task.
- `work` — milliseconds of working time; usable when a finite number ≥ 0, otherwise treated as absent.

Units are the sum of the task's assignment `units`. The maintained invariant is `work = duration × units`, with duration measured as **working time** against a calendar with usable working hours (`workingMsBetween(cal, start, end)`) and **elapsed time** (`end − start`) otherwise. Inside each user transaction, after each patch (the view projected to reflect it first):

- **`"fixed-work"`** — an assignment add/remove/update on the task re-derives its duration, `duration = work / units`, and moves its **end** accordingly: `end = addWorkingMs(cal, start, duration)` with working hours, `start + duration` otherwise. `work` never changes; no patch when the end would not move.
- **`"fixed-duration"`** — an assignment change re-derives `meta.work = duration × units`; dates never move; no patch when the value would not change.
- **`"fixed-units"`** — a date change (a `task/update` naming `start` or `end`) re-derives `meta.work`; assignments are never edited by the engine (in no mode does the engine write assignments).
- A **`"fixed-duration"`** task whose dates are edited anyway also re-derives `meta.work` — the user overrode the fixed side; the invariant is restored through work, never through assignments.

Mode-transition and termination rules, exact: each trigger yields at most one follow-on `task/update`, appended to the same transaction (one undo step). A follow-on never triggers another — a meta-only `task/update` (which is what a work write is) names neither `start` nor `end` and is classified inert, and a `"fixed-work"` end follow-on is inert under its own mode's rules (only assignment changes trigger fixed-work). Non-positive units, unusable work values, or absent `meta` produce nothing. Within one transaction, assignment unit deltas accumulate per task, so a second assignment patch for the same task computes from the sum the first already shifted, while the assignment indexes themselves are read pre-transaction. Follow-ons run only while propagation is enabled and only for `origin === "user"` transactions.

### 2.6 Status-date reschedule

`schedule/reschedule { statusDate }` recomputes the incomplete work against `statusDate` (epoch ms; non-finite values are ignored). With `p` the task's `progress` clamped to `[0, 1]` (unusable values read as 0):

- **summaries** (tasks with children), **manual** tasks, and **complete** tasks (`p >= 1`) never move;
- an **unstarted** candidate (`p === 0`) whose start lies before the status date moves bodily to start at the first working instant at or after the status date, keeping its working duration (`endFor(start)`);
- an **in-progress** candidate (`0 < p < 1`) keeps its start — completed work stays where it happened — and its end is pushed out so the remaining working duration, `(1 − p) × total working duration` (working ms with working hours, elapsed otherwise), fits at or after the status date; a task whose end already leaves that room is untouched.

Dependencies stay honored: an unstarted candidate reachable through link edges from another candidate is not patched directly but handed to the follow-on propagation with a **status-date floor** — it lands at its dependency-derived position or the status date, whichever is later, shifted bodily so its span is preserved (a `schedule/propagationRule` claim is floored the same way). In-progress candidates always patch directly. With propagation disabled every candidate patches directly and downstream tasks do not follow.

The whole run — direct moves, floored placements, ordinary downstream propagation, and effort follow-ons — is one transaction (one undo step), built by dispatching the plan's first patch as a `task/update` and folding the rest in during `data/willApplyTransaction`; the transaction label is therefore the data-store's `task/update` label. A run that would move nothing dispatches nothing. When another will-handler cancels the transaction, the whole plan is dropped — never partially applied, never leaked into a later transaction — and the drop is reported through `core/pluginError` naming this plugin and the number of dropped patches. Cancellation detection: commitment is observed through `data/didApplyTransaction`, the settle signal (data-store.md "Apply flow" — it fires exactly once per APPLIED transaction, never for a cancelled or failed one). The command marks the dispatch in flight, dispatches the head `task/update` synchronously, and checks on return whether the settle signal fired for it; no signal means the plan was dropped, and the report is emitted. (The settle signal cannot fire for a cancelled apply, which is what makes this edge sound.) `previewReschedule(statusDate)` returns the exact patch list the command would apply, computing and mutating nothing else.

### 2.7 Cycle rejection — `schedule/cycleRejected`

Unconditional: cycle rejection is a validity guard on the data, not a schedule derivation, so it is NOT gated on `autoSchedule.enabled` — turning propagation off never makes the store accept data the enabled engine would reject. On `data/willApplyTransaction` of a user-origin transaction carrying a `link/add` patch whose edge would close a dependency cycle (`detectCycle`), the transaction is **cancelled in the will phase** and `schedule/cycleRejected` is emitted.

- **Payload:** `{ chain: readonly LinkId[] }` — the ids of the existing links that, together with the refused edge, would form the cycle.
- **When it fires:** once per refused transaction, synchronously during the will phase, after the cancellation.
- **What is rolled back:** nothing needs rolling back — a will-phase cancellation means the transaction never applies: no patch reaches the store, no store notification fires, no `data/didApplyTransaction` is emitted, and no undo entry is recorded. The refused link simply never exists.

A `link/update` cannot re-endpoint an edge (data-store.md) and therefore cannot close a cycle; it is never rejected here. `schedule/cycleRejected` is a surviving hook event of the official catalog (`tools/official-events.mjs`).

### 2.8 Internal machinery

`scheduleAsync` resolves with exactly what `schedule` returns over the same inputs, computed after yielding the current macrotask (§1.1). The engine memoizes topological orders per (node set, hierarchy flag) and drops the memo on every `data.tasks` store notification; the memo is consulted only for passes over the store's own stable view object — a foreign view or a per-transaction projection always recomputes. Pure optimization; results are defined to be identical with and without it.

## 3. Extension points

### 3.1 Defined by this plugin

| Point | Strategy | Contribution type | Semantics |
|---|---|---|---|
| `schedule/constraintBounds` | first | `ConstraintBoundsContribution` | Maps a custom constraint type to time bounds. Consulted only for types outside the eight built-ins (§2.3); the first non-`undefined` answer wins over declining contributions; if every contribution declines, the constraint is ignored (the task schedules as unconstrained). Returned bounds feed the same clamping machinery as the built-ins (`earliestStart` as an early-side bound, `latestEnd` as a late-side bound including the back-clamp and the early-side-wins rule). |
| `schedule/propagationRule` | first | `PropagationRuleContribution` | A per-task propagation rule replacing the built-in date derivation for the tasks it claims. Consulted for every task the engine derives dates for; a claim's returned dates replace the built-in proposal before constraint clamping; unclaimed tasks use the built-in rule. The point remains public even though the official registry-calendar reflection is engine-internal (§2.2); it exists purely for third parties. |

```ts
/** Time bounds a constraint places on a task, epoch ms. Either or both members;
 *  an absent member imposes no bound on that side. */
export interface ConstraintBounds {
  earliestStart?: number;
  latestEnd?: number;
}

export type ConstraintBoundsContribution = (
  task: Readonly<Task>,
  ctx: {
    readonly view: ReadonlyDataView;
    readonly constraint: { readonly type: ConstraintType; readonly date?: number };
  },
) => ConstraintBounds | undefined;

export type PropagationRuleContribution = (
  task: Readonly<Task>,
  ctx: {
    readonly view: ReadonlyDataView;
    /** The dates the built-in derivation would assign. */
    readonly proposed: { readonly start: number; readonly end: number };
    /** Which side of `proposed` the engine pinned: "end" while an FF/SF relation is
     *  being applied, "start" otherwise (FS/SS, a constraint date, a summary roll-up).
     *  A rule that recomputes the span from its own duration holds the anchored side
     *  still and moves the other, or its placement will not be a fixed point.
     *  Ignoring the anchor is allowed. */
    readonly anchor: "start" | "end";
  },
) => { start: number; end: number } | undefined;
```

Both points compose with the `first` strategy over declining contributions: registration order, first non-`undefined` result; built-in behavior when all decline. A throwing contribution is reported (`core/pluginError`) and treated as declining.

### 3.2 Contributed by this plugin

| Target | Contribution | Order / slot / condition |
|---|---|---|
| `renderer/layers` | non-working shading (background band) | `ctx.claimOrder("renderer/layers", "stargantt.scheduling:shading", 8)` — under view's grid-lines (10) and every figure element. Draws only while a shade calendar resolves (§6.2). |
| `renderer/layers` | critical-path free-float bars | `ctx.claimOrder("renderer/layers", "stargantt.scheduling:cp-float", 56)` — one above `view:today-line` (55), since `claimOrder` rejects duplicate `(scope, order)` pairs (see view.md); 56 keeps the float bars below the task bars (60) — ground, not figure — while fixing them deterministically above the today line, whatever the composition order. Registered only under `criticalPath.showFloat`. |
| `renderer/layers` | dependency link lines (main band) | `ctx.claimOrder("renderer/layers", "stargantt.scheduling:links", 69)` — one below interaction's selection layer (`stargantt.interaction:selection`, 70): the link lines paint UNDER the selection frame, deterministically, whatever the composition order. The full stack: bars 60 < tracking actual bars 62 < progress line 65 < link lines 69 < selection frame 70 < CP link emphasis 72 < focus box 75 < bar decorations 80 (the tracking overlays at 62/65 stay below the lines). |
| `renderer/layers` | critical-link emphasis strokes | `ctx.claimOrder("renderer/layers", "stargantt.scheduling:cp-links", 72)` — above the link lines. Registered only while `criticalPath` visuals and `highlightLinks` are on. |
| `renderer/layers` | connector ports + link rubber band + drop ring (overlay band) | `ctx.claimOrder("renderer/layers", "stargantt.scheduling:ports", 110)` — above interaction's drag preview (100). |
| `renderer/hitTest` | one `HitTester` answering `kind: "port"` (cursor `"crosshair"`) for the 24×24 port targets while link creation is on, and `kind: "link"` (cursor `"pointer"` under `linkEditing`, `"default"` otherwise) for the routed lines while `showLinks` is on | first-strategy point; declines everything else. |
| `taskbars/endGutter` | one contribution `{ id, end: "both", size: 17, active() }` — the port clearance (§5.1); `active()` answers `true` exactly while `dependencies.allowLinkCreate` is not `false` | reduce point (per-end maximum). |
| `taskbars/style` | one provider returning `{ color }` for classified critical/near-critical/negative-float tasks, `undefined` otherwise | only while `criticalPath` visuals and `highlightBars` are on. |
| `taskbars/overlays` | one renderer: 2 px class-color outline inside classified bars (the color-independent cue) + the warning glyph on negative-float bars (§7.3) | only while `criticalPath` visuals and `highlightBars` are on. |
| `grid/columns` | the read-only schedule-mode column (§2.4) | only under `autoSchedule.modeColumn: true`. |
| `keys/bindings` | the `Alt+L` two-step link-creation chord (§5.6); the `Delete` / `Backspace` / `Escape` link-editing bindings, each guarded by a `when` that holds only while a link is selected (§5.4) | chord contributed only while `allowLinkCreate` is not `false`; editing bindings only under `linkEditing: true`. Buffered and inert without the a11y plugin. |
| `sidepanel/fields` | the dependency-inspector section (§5.7) | only under `dependencies.inspector: true`; without the interaction plugin the contribution has no consumer and nothing runs. |
| `snap/workingTime` | one `WorkingTimeProvider` (§4.1) | unconditional. |
| `snap/pushGuards` | one `PushGuard` (§4.2) | unconditional. |
| `overlay-corner` (slot group) | diagnostics panel toggle, `ctx.claimSlot("overlay-corner", "top-left", ["top-left", "top-right", "bottom-left", "bottom-right"])` (deliberately opposite the filter toolbar's top-right) | only under `diagnostics.panel: true`. |

Collision cross-check: against every claim in the corpus — view 10/55, task-bars 60/80, interaction 70/100, a11y 75, tracking 50/62/65 — the five orders 8 / 56 / 69 / 72 / 110 collide with nothing. Contribution types for the upward points (`snap/*`, `sidepanel/fields`, `keys/bindings`, `taskbars/*`, `grid/columns`) arrive via `import type` from the defining packages (devDependencies where the provider is not a hard dependency — the type-only exemption).

## 4. Integration with interaction (the dependency inversion)

Snapping's working-time and stand-down needs are served through the interaction-owned extension points of interaction.md §3, never by an upward service edge. This plugin is the official contributor to both points; scheduling consumes interaction's Layer-5 services only downward (§14).

### 4.1 `snap/workingTime` — the official `WorkingTimeProvider`

One provider, registered unconditionally at setup, backed by `CalendarsService`'s registry. `boundaries(calendar?)` resolves the calendar reference exactly as interaction.md §3 specifies:

- **A named `calendar` id** resolves only when it is a member of the registry — `state.get().calendars` contains an entry with that id. An id the registry does not contain returns `undefined` (dates then pass through unchanged on interaction's side), even when the data store knows the id: a reference whose meaning the registry never declared is deliberately refused.
- **An omitted reference** resolves to the registry's default calendar — the first entry whose `isDefault === true`. No default → `undefined`.

The returned `WorkingBoundaries` members delegate to `sdk/time` over the resolved definition: `isWorkingInstant`, `nextWorkingStart`, `previousWorkingEnd` — at whatever granularity the calendar declares (whole days, or sub-day windows when it has them). Walks are bounded on this side (`MAX_SKIPPED_DAYS`); a walk that gives up returns its argument, satisfying interaction.md's provider contract.

**Freshness (the dovetail).** Interaction calls `boundaries()` on every working-time adjustment and never caches the result across adjustments; caching is this provider's job. The provider caches the resolved `WorkingBoundaries` per calendar reference and invalidates the cache on every `CalendarsService.state` set, so a registry edit is visible to the very next adjustment. (Because `setShadeCalendar` also sets the state store, shade changes over-invalidate the cache; this is safe and deliberate, not a bug.) The provider never throws; an unresolvable reference is `undefined`, never an error. (Interaction's structural guard treats a contribution missing `boundaries` as absent; this provider always carries it.)

### 4.2 `snap/pushGuards` — the official propagation stand-down guard

One guard, registered unconditionally at setup: `() => propagationEnabled()` — it returns the resolved `autoSchedule.enabled` value, constant for the instance lifetime. Interaction's `pushSuccessors` pass stands down while any composed guard returns `true`, so with this plugin composed and propagation ON the push-out pass yields to the engine (which reconciles the same dependencies in the same transaction), and with propagation OFF (`enabled: false`, the default) the guard returns `false` and the pass runs. The guard reads a captured constant and cannot throw; interaction's throw-means-stand-down rule is therefore never exercised by the official contribution.

Tuning note (record-only, not normative): with propagation on, the push-out pass stands down and the engine's downstream cascade is appended only at COMMIT time — during a bar drag the preview shows the dragged bar alone, so dependent tasks jump at release without having been foreshadowed. A preview affordance for the pending cascade (e.g. extending interaction's `dependencyPreview` outlines to the propagated positions) is future polish; nothing in this spec forecloses it.

### 4.3 The link gesture and the reserved `link-drag` state

The port drag, link selection press, and hover emphasis ride the PUBLIC input stream — `pointer/barDown` / `pointer/barMove` / `pointer/barUp` / `pointer/background` / `pointer/barHover` — exactly as interaction.md §11 sanctions for any plugin ("third-party plugins may still subscribe to them for their own gestures"). No competition with the gesture arbiter arises: the arbiter starts no gesture for a `pointer/barDown` whose hit kind is `"port"` or `"link"` (interaction.md §1.2/§1.3 — such presses are only offered to selection/tooltip/context-menu per their own hit-kind filters, which decline them). Design note: interaction.md's reserved `link-drag` arbiter state remains unreachable — the link wiring is this plugin's own gesture session over the public events, not a change to interaction's machine; the reserved state stays as the seam for a possible future internalization. This plugin attaches no document-level raw pointer listeners.

Pointer-identity and cancellation: only the pointer that started the port drag advances or finishes it; a `pointer/barUp` whose raw event is a `pointercancel` abandons it (band cleared, nothing dispatched).

## 5. Dependency links (internal/links)

Config fields in §11.1.

### 5.1 Ports, clearance, anchor inset

While `allowLinkCreate` is on (the default), the port pass walks the visible rows and paints both connector ports of every bar whose task `hasOwnBar(id)` answers `true` (a collapsed summary under `"hidden"`/`"split"` carries none; `barRect` alone is not consulted for port placement — it deliberately reports rolled-up spans for line anchoring). Ports are permanent, not hover-revealed. Constants (published, shared with task-bars' 20 px label offset by deliberate coupling — any change to gap or diameter changes both specs in the same revision):

- Port gap **9** CSS px, disc **8** CSS px across (radius 4): the painted disc occupies bar edge + 9 … + 17, measured outward along the bar's axis.
- Port clearance = anchor inset = **17** CSS px (gap + diameter, derived, never restated).
- Hit target **24×24** CSS px centred on the disc, transparent, allowed to overlap the bar and label band; the port and resize-handle hit bands stay disjoint (asserted in geometry unit tests). Hit kind `"port"`, cursor `"crosshair"`.

While link creation is enabled, a link's anchors are inset outward by the clearance at both ends before routing, so the route stops tangent to the disc's outer edge and the arrowhead sits outside it — separation, not z-order, preserves the direction cue (the line and port tokens may resolve to the same color). With `allowLinkCreate: false`: no ports, zero inset, no `taskbars/endGutter` contribution active, no rubber band, no `link/add` from this plugin, no keyboard chord (the option disables link creation as a whole, not one modality); existing lines still draw and still answer `kind: "link"` hits; both layer claims stay registered.

### 5.2 Creation

A `pointer/barDown` on a port starts the drag; `pointer/barMove` tracks the rubber band; `pointer/barUp` completes or abandons. A completed drag dispatches one `link/add`; the type (FS/SS/FF/SF) is always derived from which bar ends were connected — the derivation is total, so `defaultLinkType` is never consulted on the pointer path. `defaultLag` fills `lag` on both creation paths. A release over the drag's own source, or over a task the source already links to (one link per ordered pair — the store's rule), creates nothing; the reverse direction is a different pair and is offered normally. A link that would close a cycle is rejected in the will phase (§2.7), not here. Link type stays visually undifferentiated (FS/SS/FF/SF differ only in which ends the route attaches to, per `sdk/cpm`'s `linkAnchors` table).

### 5.3 Routing, style, visibility

- `routingStyle` `"elbow"` (default; orthogonal segments) or `"straight"` (one segment, source anchor to target anchor). Arrowhead, colors, and hit test are unchanged either way.
- `showLinks: false` paints no line and answers no `kind: "link"` hit; store, ports, creation paths, and `link/*` commands unaffected.
- `linkStyle`: `width` (CSS px, default 1.5), `dash` (canvas pattern, default solid), `arrowHead` (`"filled"` default / `"open"` / `"none"`). Unusable values drop field by field.
- `typeColors`: a CSS color per link type; entries win over the shared token for that type's lines (arrowhead included); non-string and empty entries ignored; configuration, not theme.
- Color precedence per line, strongest first: **selected (§5.4) > conflicting (§5.5) > emphasized (§5.5) > driving (§5.5) > per-type entry > `--sg-link-line` / fallback**. Width contributions are additive (base + emphasis 1.5 px + driving 1.5 px + selected 1.5 px).
- `cullLines: true`: a routed line wholly outside the horizontal window padded by 8 CSS px is skipped by the paint pass; hit testing unaffected; an unknown (non-positive) viewport width culls nothing.
- `avoidBars: true` (elbow only): interior segments crossing a foreign task bar are nudged 4 CSS px clear of the nearer side; best-effort and bounded — at most three passes; obstacle collection walks the bars of the rows the route's vertical span crosses, and a span crossing more than 64 rows ABORTS the collection, the route falling back to the plain unadjusted output (an aborted collection, not a truncated obstacle set); a layout the passes cannot resolve likewise degrades to the plain route. The link's own two bars are never obstacles. The approach-direction invariant is checked after adjustment; a broken route is rebuilt as the six-point between-rows form and re-adjusted (skipped when the row gap is under 8 CSS px — twice the margin), and a still-broken rebuild degrades to the plain route. Anchors and the arrowhead's approach never move.

Theme tokens (read at paint time via `theme.get(token) || FALLBACK` through the view plugin's theme service; a theme change repaints via the renderer's own layer invalidation, no subscription here):

| Token | Painted element | Fallback |
|---|---|---|
| `--sg-link-line` | dependency line + arrowhead | `#78716c` |
| `--sg-link-port` | connector-port discs | `#78716c` |
| `--sg-link-band` | link-drag rubber band; selected-line accent | `#0f766e` |
| `--sg-link-emphasis` | emphasized links under `highlightPaths` | `#1d4ed8` |
| `--sg-link-driving` | driving links under `highlightDriving` | `#44403c` |

The emphasis and driving fallbacks are deliberately distinct from the band color, so an emphasized line never reads as a selected one. The line and port tokens stay separate even though their fallbacks coincide: a host may tint the interactive ports without restyling the arrows. `--sg-link-line` covers the whole arrow, head included — no separate arrowhead token exists.

### 5.4 Link selection and deletion (`linkEditing`)

`false` (default): links are non-interactive (`kind: "link"` hits report the `default` cursor). `true`: link hits report the `pointer` cursor; a `pointer/barDown` whose hit is a link selects it (plugin-local state, deliberately not the task `SelectionService`, whose id space is tasks); the selected line draws in `--sg-link-band` and 1.5 px thicker (color plus width). A press on anything else or a `pointer/background` press deselects. `Delete` / `Backspace` remove the selected link via one `link/remove` (one undo step), announced through the focus service; `Escape` deselects; each binding's `when` holds only while a link is selected, so unrelated presses fall through. A `SelectionService.state` notification reporting a NON-EMPTY task selection clears the link selection (both selections claim Delete; with tasks visibly selected, Delete never destroys an invisible link); an empty selection changes nothing. A data change that leaves the selected id naming no stored link clears the selection.

### 5.5 Emphasis, conflicts, driving, drop ring

- **`highlightPaths`** (`true` only): the emphasized set is the hovered line (`pointer/barHover` with a `kind: "link"` hit) plus, while tasks are selected, every link reachable from a selected task transitively upstream and downstream. Emphasized links draw in `--sg-link-emphasis` AND 1.5 px thicker; while the set is non-empty every link outside it (arrowhead included) draws at alpha 0.35, except conflicting links, which never dim; an empty set dims nothing. Repaint only when the set changed; a data change drops the hover. The selection is re-read lazily per event (late optional lookup), so the emphasis also recomputes on data changes against the current selection.
- **`highlightConflicts`** (`true` only): millisecond-exact comparison over the STORED dates (no scheduler consulted — works identically with propagation absent, disabled, or active). Required time = the source end the type names (`FS`/`FF`: finish; `SS`/`SF`: start) plus `lag`; actual time = the target end the type names (`FS`/`SS`: start; `FF`/`SF`: end). Actual strictly earlier than required → drawn in `conflictColor` (default `#dc2626`) AND dashed `[4, 3]` (overriding `linkStyle.dash` for that line).
- **`highlightDriving`** (`true` only): actual time equal to required → drawn in `--sg-link-driving` AND 1.5 px thicker; ties all read as driving.
- **`highlightDropTargets`** (`true` only): during a link drag, the port the release would connect to — resolved by the same rules the release uses (different task, not already linked from the source, within horizontal drop reach; the port hit or else the nearer bar half), so the ring never promises a link the drop would refuse — is ringed by a 2 px stroke in `--sg-link-band`, 3 px outside the disc radius, redrawn with the band each frame.

### 5.6 Keyboard link creation (`Alt+L`)

A two-step chord contributed to `keys/bindings` while `allowLinkCreate` is not `false`, operating on the a11y plugin's row focus. First press: marks the focused task as the pending link source (plugin-local, nothing dispatched). Second press on a different task: dispatches the same `link/add` a completed port drag would, with `type = defaultLinkType` (FS when omitted — the keyboard path names no bar ends) and `lag = defaultLag`; the ordinary pipeline applies, cycle rejection included. Second press on the same task: cancels. Second press on a task the source is already linked to: nothing dispatched, pending state cleared, and the refusal is announced — "`<source>` is already linked to `<target>`". Each step announces through `FocusService.announce` (marking, creating, cancelling, refusing). The pending state clears silently on any data change, so it never dangles across a data replacement. Without the a11y plugin the bindings have no consumer; the pointer path is unaffected.

### 5.7 Dependency inspector (`inspector`)

`true` contributes one `sidepanel/fields` section (interaction.md's contribution type, mounted once on `lifecycle/ready`). For a single selected task (empty and multiple selections disable it): a read-only link list — predecessors first, then successors — each line formatted by `incomingLink` / `outgoingLink` (lag shown in days); one static editor row — link picker, type selector (FS/SS/FF/SF), lag field (days; unparsable input resets to the stored value), remove button — wired exactly once through `ctx.own()`-registered listeners (re-renders repopulate, never re-register). Remove dispatches one `link/remove`; retype/re-lag dispatches one `link/update` carrying id, type, and lag — one transaction, one undo step, id and endpoints preserved; an emptied or zeroed lag field dispatches `lag: 0` (the store normalizes it absent). Both paths announce (`linkRemoved` / `linkUpdated`).

### 5.8 Repaint wiring

Both link layers are invalidated from the `data.tasks`, `rows.rows`, and `timeline.zoomLevel` store subscriptions, so lines and ports track data, row, and zoom changes. Bar geometry is read exclusively through `TaskBarsService` (`barRect` for line anchors — including a collapsed summary's rolled-up span; `hasOwnBar` for ports); this plugin restates no bar-geometry constant.

## 6. Working calendars (internal/calendars)

### 6.1 Registry and queries

§1.2 is the surface. All time arithmetic is UTC; every working-time answer delegates to `sdk/time` after resolving the first argument via `resolve()` (registry first, then store). `nonWorkingRanges` is intra-day precise and clipped to the query range; for a calendar without windows it equals the whole-day answer at midnight-aligned bounds. One range buffer is reused per shading paint (the engine's `out` parameter); the pass allocates nothing else per frame.

### 6.2 Non-working shading (layer order 8)

The layer shades the non-working stretches of the shade calendar across the full viewport height in `--sg-calendar-nonworking` (fallback `rgba(220, 38, 38, 0.08)` — ground, not figure, below every bar and grid color). The shade calendar is `calendars.shadeCalendar` when configured, else the registry default; no shade calendar resolved → the pass draws nothing, so the default composition is byte-identical to a chart without the feature. The shaded set is the service's own `nonWorkingRanges` over the visible span: whole non-working days, exception days, and sub-day gaps whenever the calendar declares intra-day windows.

**Minimum-band-width guard (normative, stated here in full).** This section is the guard's normative home for this pass (view.md does not carry it). One rule, three regimes, one threshold — no second threshold exists for sub-day bands:

1. **Pass gate:** while a day column is under 3 CSS px wide, the whole pass draws nothing.
2. **Per-band gate:** a span that is not whole-day-aligned is drawn only while its on-screen width (`pxPerMs × (end − start)`) is at least 3 CSS px; a narrower sub-day band is omitted entirely — never widened to a minimum width, never merged into a neighbour.
3. **Whole-day alignment, judged per end (with the clipped-edge exemption):** a band's start qualifies by falling on a UTC midnight — tested with a positive modulo against `MS_DAY` (equivalently `start === startOfUtcDay(start)`), so pre-1970 instants classify correctly — or by equaling the query's `from`; its end qualifies by falling on a UTC midnight or by equaling the query's `to`. A band counts as whole-day exactly when **both** ends qualify; one clipped end does not excuse the other (a band whose start equals `from` but whose end is an unaligned intra-day instant is still intra-day). The engine clips edge bands to the query, so a partially visible non-working day loses its midnight alignment through clipping alone; the exemption keeps that viewport-edge sliver drawn, and only genuinely intra-day bands can be suppressed.
4. **Degrade target:** whole-day-aligned spans are always drawn (subject to gate 1), so below the per-band threshold the picture degrades to exactly the day-granular shading.

For a day-granular calendar the output renders byte-identically to the whole-day-column picture; committed screenshot baselines of day-only compositions do not move. Rects clip to the viewport.

### 6.3 The working-calendar editor (`calendars.editor`)

Mounted only when `editor` names at least one section, as a hidden draggable dialog built by `sdk/dialog`'s `createDialog` and appended to the gantt root, opened by `openEditor()` (which moves keyboard focus into it). Chrome and placement: titled draggable header, scrolling body, resize grip, pointer containment, Escape-to-close, `--sg-dialog-*` theming; opens centred near the top edge — `top: 16px`, `width: min(460px, 92%)` between `min-width: min(380px, 92%)` and `max-width: min(560px, 92%)`, `max-height: 82%`, all root-relative (satisfying the ≥ 720×540 floor without a special case). It is not a corner-slot overlay.

Above the sections sits a calendar picker over the registry; everything below edits the picked calendar. Sections always render in the canonical order `days → hours → periods → assign`, whatever order the config listed:

| Section | Edits | Through |
|---|---|---|
| `"days"` | the weekly pattern, seven checkboxes | `setWorkingDays` |
| `"hours"` | intra-day windows: one editable `[start, end)` row each, plus add and clear | `setWorkingHours` |
| `"periods"` | an inclusive from/to range with a working/non-working designation and optional hours; the exception list with per-row remove; the single-date add form | `setExceptionRange` / `removeExceptionRange` / `setException` / `removeException` |
| `"assign"` | putting the selected tasks on this calendar, or back on the default | `assignTask` |

`editor: true` is every section; `{ sections: [...] }` is those sections (unknown entries dropped; nothing usable → no panel); `false` / omitted mounts nothing. The `"assign"` section renders nothing when `stargantt.selection` is not composed (read per gesture, never latched at setup). Layout on the 8 px grid, controls 28 px tall, one thought per row; an exception day states its designation in words (`"Non-working"` / `"Working (calendar hours)"` / `"Working 06:00–14:00"`), never by glyph alone; a window row with missing/unparseable/backwards bounds is dropped from the committed list while its row stays visible; a period is refused whole and the panel says why. A polite live region (`role="status"`, built once, text-only rewrites) states what the last edit did (the `status*` catalog builders). Registry edits repaint the shading immediately and stay outside undo; task assignment is undoable. All controls are native form elements, labelled from the catalog; the dialog is `ctx.own()`-registered. Default config renders nothing; screenshot baselines hold.

## 7. Critical path (internal/critical-path)

### 7.1 Float quantification

Inputs are the store's current dates and `sdk/cpm` (`latestTimes`, `linkSlack`, `linkAnchors`) over the analyzable tasks and links — NOT `SchedulerService.latestTimes()`, whose engine-own cycle handling differs (§1.1). Per task: `totalFloat = latestFinish − end`. `freeFloat` is the minimum over outgoing links of the link's slack under its type and lag (FS: `succ.start − lag − end`; SS: `succ.start − lag − start`; FF: `succ.end − lag − end`; SF: `succ.end − lag − start` — `sdk/cpm`'s shared algebra); a task with no outgoing link has `freeFloat = projectFinish − end` (project finish = max end over analyzable tasks). Floats are elapsed milliseconds; day thresholds use the fixed 86,400,000 ms day — calendars deliberately play no part in float quantification (floats are elapsed time). Excluded from analysis entirely (no floats entry, never classified, never on a path): summary tasks (their dates are rollups), and tasks the `sdk/cpm` backward pass omits as cycle members (or reachable only through one). Milestones participate as ordinary zero-duration tasks.

### 7.2 Classification and paths

With `criticalMs = thresholdDays·day` and `nearMs = nearCriticalDays·day`: `totalFloat < 0` → `"negativeFloat"`; else `totalFloat ≤ criticalMs` → `"critical"`; else if `nearMs > 0` and `totalFloat ≤ criticalMs + nearMs` → `"nearCritical"`; else unclassified. A link is critical when both endpoints are `"critical"` or `"negativeFloat"` and its own slack is ≤ `criticalMs`. The critical paths are the connected components of the undirected graph over critical/negative-float tasks and critical links; a critical task on no critical link is a singleton path; near-critical tasks are never path members — a project with three independent zero-float chains reports three paths.

### 7.3 Painting

All visuals exist only while the `criticalPath` nest is present and `enabled` is not `false`; each has its own switch. Colors resolve per field, fresh each paint: the config value when a usable non-empty string, else the theme token, else the fallback:

| Config field | Token | Fallback |
|---|---|---|
| `criticalColor` | `--sg-critical-bar` | `#c62828` |
| `nearCriticalColor` | `--sg-near-critical-bar` | `#ef6c00` |
| `negativeFloatColor` | `--sg-negative-float` | `#7f1d1d` |
| `floatColor` | `--sg-critical-float` | `rgba(96, 125, 139, 0.3)` |

- **Bars** (`highlightBars`): the style provider recolors classified bars with the class color; the overlay renderer strokes a 2 px outline just inside the bar box in the same color (the color-independent cue); negative-float bars additionally get a filled warning triangle with a bang cut-out at the bar's left inside edge, sized to the bar height, drawn in the class color over a white halo. The style provider declines unclassified tasks, so other providers and `task.meta.color` still apply to them.
- **Links** (`highlightLinks`): the order-72 layer draws a 2.5 px elbow polyline in the critical color between the endpoint anchors the link type dictates (`TaskBarsService.barRect`), culled to the viewport. The route is this area's own simple elbow; pixel coincidence with §5's routing is not contracted, and the layer draws whether or not the links UI is showing.
- **Free-float bars** (`showFloat`, order 56): for each visible task with `freeFloat > 0`, a slim bar (one third of the bar height, floored at 4 CSS px, vertically centred) in the float color from the bar's right edge extending `freeFloat · pxPerMs` px, closed by a 1 px end tick flush at the band's outer end, spanning the full bar height inset 2 px top and bottom — deliberately taller than the float strip — painted below the task bars in a translucent ground color. The layer walks only the visible row range (rows service, resolved late and optionally).

While any visual is active, the `data.tasks` notification triggers the immediate recompute of §1.3 AND invalidates the renderer's `main` layer, so the visuals track edits within the same frame budget; the per-bar style/overlay callbacks and per-frame layer draws only read the current store value. No message catalog: the warning glyph is iconography, not text.

## 8. Schedule diagnostics (internal/diagnostics)

DCMA-style structural audit, fully internal (no service — §1.4). Detection rules:

- **Orphans:** a non-summary task with no incoming and no outgoing link (summaries are neither reported nor counted; milestones participate; a link counts as a connection regardless of its quality).
- **Leads:** a link whose `lag` is a finite number strictly below 0, whatever its type; a missing or non-finite lag counts as 0 and is never reported.

The report recomputes lazily per data change (one O(tasks + links) pass, never per frame); ordering is deterministic — orphans by task start ascending (ties by store insertion order), leads in store link order.

**Panel** (`diagnostics.panel: true`): on `lifecycle/ready`, one `.sg-diagnostics` root mounts in the chart pane at the claimed top-left corner slot, positioned `top: calc(var(--sg-safe-top, 0px) + 8px); left: calc(var(--sg-safe-left, 0px) + 8px)`, styled inline with `--sg-bg` / `--sg-fg` / `--sg-muted-fg` / `--sg-grid-line` token `var()` fallbacks. A native toggle `<button>` (`sg-diagnostics-button`, `aria-haspopup="true"`, `aria-expanded` current, ≥ 24×24 target) whose text is `button(issueCount)`; a dropdown (`sg-diagnostics-panel`, `role="group"`, `aria-label` = `panelLabel`) with one heading + `<ul>` per non-empty category — orphan items show the task name verbatim, lead items show `leadItem(sourceName, targetName, lagDays)` with `lagDays` = lag / 86,400,000 rounded to at most two decimals; `noIssues` when empty; internal scroll past 320 px. Escape and outside presses close (one `ctx.own()`-registered document-level `pointerdown`). On every data change the button text re-derives and an open list rebuilds; refreshes are coalesced to one per animation frame (`sdk/frame`), reading the lazily recomputed report so an edit burst costs one recompute and one rebuild. Slot grant: the top-left claim passes all four corners as candidates; a `{ granted: false, alternative }` answer moves the panel to the granted alternative corner, positioning through that corner's `--sg-safe-*` variable pair (the filter-toolbar four-corner precedent); with no free alternative the panel keeps its requested corner (the registry has already emitted the warning-level report). No responsive collapse (the ≥ 720×540 floor).

## 9. Commands

(Architecture ch. 4.3: `schedule/*` = 2.)

| Command | Payload | Behavior |
|---|---|---|
| `schedule/reschedule` | `{ statusDate: number }` | §2.6 — one transaction, one undo step; non-finite dates ignored. |
| `schedule/setTaskMode` | `{ id: TaskId; mode: TaskScheduleMode }` | §2.4 — one undoable `task/update`; unusable arguments and no-op switches silently ignored. |

## 10. Events

- **Emits `schedule/cycleRejected` `{ chain: readonly LinkId[] }`** — the surviving hook (§2.7; official catalog).
- **Consumes** the hooks `data/willApplyTransaction` (propagation, effort follow-ons, reschedule folding, cycle rejection) and `data/didApplyTransaction` (the reschedule cancellation detection — §2.6), and the input streams `pointer/barDown` / `pointer/barMove` / `pointer/barUp` / `pointer/background` / `pointer/barHover` (the link gesture and hover emphasis — §4.3).
- **Store subscriptions:** `data.tasks` (repaints, topo-memo drop, the CP dirty-mark/conditional recompute of §1.3, diagnostics recompute, pending-source/selection hygiene), `rows.rows` (link repaint), `timeline.zoomLevel` (link repaint), `SelectionService.state` late/optionally (path emphasis, link-selection disarm, inspector, editor assign).
- Registry changes are observed via store subscription on `CalendarsService.state` (§1.2); there is no `calendars/changed` event.

## 11. Config

Factory: `scheduling(config?: SchedulingConfig)`. Each feature = one nested config group. **Presence semantics (normative):** the `dependencies` nest is ENABLED with the defaults below when omitted. The `calendars`, `criticalPath`, and `diagnostics` nests leave their features DORMANT when omitted (no registry seed, no shading, no CP visuals, no panel); passing the nest (even `{}`) enables the feature with the defaults below. The `autoSchedule` nest needs no presence gating: the engine service is always provided and its two fields default as listed (composed, propagation off). All three services are provided unconditionally. Unusable field values silently fall back to their defaults; everything is read once at `setup()`. A single top-level `messages?: Partial<SchedulingMessages>` covers every feature (one catalog per plugin — §12).

### 11.1 `dependencies` (enabled by default) — 16 fields

| Field | Type | Default | Semantics |
|---|---|---|---|
| `allowLinkCreate` | `boolean` | `true` | Ports on every visible own-bar, port drag, keyboard chord, 17 px end-gutter reservation. `false` removes link creation as a whole (§5.1). |
| `routingStyle` | `"elbow" \| "straight"` | `"elbow"` | Line routing (§5.3). |
| `defaultLinkType` | `LinkType` | `"FS"` | Keyboard path only; the pointer path always derives the type from the connected ends. |
| `defaultLag` | `number` (ms) | none | Fills `lag` on both creation paths; negative = lead. |
| `showLinks` | `boolean` | `true` | `false`: no line painted, no `"link"` hit; everything else unaffected. |
| `linkStyle` | `{ width?; dash?; arrowHead? }` | `width` 1.5, solid, `"filled"` | Field-by-field drop of unusable values (§5.3). |
| `typeColors` | `Partial<Record<LinkType, string>>` | `{}` | Per-type line color; non-string/empty entries ignored. |
| `linkEditing` | `boolean` | `false` | Click-to-select a line; Delete/Backspace remove; Escape deselects (§5.4). |
| `highlightPaths` | `boolean` | `false` | Hover + selection dependency-path emphasis, dual-encoded, 0.35 dim (§5.5). |
| `inspector` | `boolean` | `false` | The side-panel dependency inspector (§5.7). |
| `highlightDropTargets` | `boolean` | `false` | Drop-candidate ring during a link drag (§5.5). |
| `highlightConflicts` | `boolean` | `false` | Negative-slack links drawn in `conflictColor` and dashed `[4, 3]` (§5.5). |
| `conflictColor` | `string` | `"#dc2626"` | The conflict warning color. |
| `highlightDriving` | `boolean` | `false` | Zero-slack links thicker in `--sg-link-driving` (§5.5). |
| `cullLines` | `boolean` | `false` | Skip drawing lines wholly outside the horizontal window (+8 px pad). |
| `avoidBars` | `boolean` | `false` | Elbow routes detour around intervening bars, 4 px margin, bounded (§5.3). |

### 11.2 `autoSchedule` — 2 fields

| Field | Type | Default | Semantics |
|---|---|---|---|
| `enabled` | `boolean` | `false` | `true`: edits propagate along links and summaries roll up, inside the edit's own transaction (§2.1). `false` (the default): the service stays fully functional for direct calls, no propagation, no rollup, no effort follow-on — and cycle rejection is UNAFFECTED (§2.7). Published through `propagationEnabled()` and the `snap/pushGuards` guard (§4.2). |
| `modeColumn` | `boolean` | `false` | `true` contributes the read-only schedule-mode grid column (§2.4). |

### 11.3 `calendars` (dormant when omitted) — 4 fields

| Field | Type | Default | Semantics |
|---|---|---|---|
| `calendars` | `readonly CalendarInit[]` | `[]` | Initial registry, registered in order at setup; unusable entries ignored. |
| `shadeCalendar` | `CalendarId` | the registry default | Which calendar's non-working time is shaded (§6.2). |
| `scheduling` | `boolean` | `true` | Whether registry calendars are reflected into automatic scheduling (§2.2's internal resolution). `false`: the engine resolves against the data store alone. |
| `editor` | `boolean \| { sections?: readonly ("days" \| "hours" \| "periods" \| "assign")[] }` | `false` | Whether the editor is mounted and which sections it carries (§6.3). |

### 11.4 `criticalPath` (dormant when omitted) — 10 fields

| Field | Type | Default | Semantics |
|---|---|---|---|
| `enabled` | `boolean` | `true` | Master switch for all visuals; the analysis service works either way. |
| `thresholdDays` | `number` | `0` | Total float at or below this many fixed days counts as critical. |
| `nearCriticalDays` | `number` | `0` | Width of the near-critical band; 0 turns the class off. |
| `criticalColor` | `string` | token/fallback (§7.3) | Critical bar / outline / link color override. |
| `nearCriticalColor` | `string` | token/fallback | Near-critical bar / outline color override. |
| `negativeFloatColor` | `string` | token/fallback | Negative-float bar / outline color override. |
| `highlightBars` | `boolean` | `true` | Recolor + outline classified bars (§7.3). |
| `highlightLinks` | `boolean` | `true` | Critical-link emphasis strokes (order 72). |
| `showFloat` | `boolean` | `false` | Free-float extension bars (order 56). |
| `floatColor` | `string` | token/fallback | Free-float bar fill override. |

Thresholds that are not finite numbers ≥ 0, colors that are not non-empty strings, and non-boolean booleans are ignored; day fields convert with the fixed 86,400,000 ms day.

### 11.5 `diagnostics` — 1 field

| Field | Type | Default | Semantics |
|---|---|---|---|
| `panel` | `boolean` | `false` | Mounts the findings panel (§8); counts as `false` unless exactly `true`. The detection machinery has no other public outlet (§1.4). |

## 12. Messages

`SchedulingMessages` — one merged catalog (single top-level `messages` key), resolved once at setup by per-key shallow override with the shared catalog merge rules (`sdk/dom` `resolveCatalog`): a key of the wrong kind is ignored, the empty string is usable and taken verbatim, and a throwing builder is reported (`core/pluginError`) and answered by the built-in default for that call (all builders here are gesture-driven and stay unlatched). The critical-path area contributes no keys.

One catalog covers the four message-bearing areas — auto-schedule (3 keys), dependencies (10), calendars (43), diagnostics (6): **62 keys**. No key names collide, so nothing is prefixed:

| Key | Area | Default |
|---|---|---|
| `modeColumnHeader` | auto-schedule | `"Mode"` |
| `modeAuto` | auto-schedule | `"Auto"` |
| `modeManual` | auto-schedule | `"Manual"` |
| `inspectorLabel` | dependencies | `"Dependencies"` |
| `noLinks` | dependencies | `"None"` |
| `linkPickerLabel` | dependencies | `"Link"` |
| `typeLabel` | dependencies | `"Type"` |
| `lagLabel` | dependencies | `"Lag (days)"` |
| `removeLink` | dependencies | `"Remove"` |
| `incomingLink` | dependencies | builder `(p: { name; type; lagDays }) => string`; `"← <name> (<type>)"`, plus `", +<lag>d"` / `", <lag>d"` for non-zero lag (sign only when positive) |
| `outgoingLink` | dependencies | builder; `"→ <name> (<type>[, ±<lag>d])"` — same lag suffix rule |
| `linkRemoved` | dependencies | `"Link removed"` |
| `linkUpdated` | dependencies | `"Link updated"` |
| `editorTitle` | calendars | `"Working calendar"` |
| `calendarLabel` | calendars | `"Calendar"` |
| `dateLabel` | calendars | `"Date"` |
| `workingLabel` | calendars | `"Working"` |
| `addException` | calendars | `"Add exception"` |
| `removeException` | calendars | builder `(date) => "Remove exception <date>"` |
| `workingDaysLegend` | calendars | `"Working days"` |
| `close` | calendars | `"Close"` |
| `empty` | calendars | `"No calendars defined"` |
| `hoursLegend` | calendars | `"Working hours"` |
| `noWindows` | calendars | `"No windows — a working day counts in full."` |
| `addWindow` | calendars | `"Add window"` |
| `clearWindows` | calendars | `"Clear windows"` |
| `removeWindow` | calendars | builder `(w: { from; to }) => "Remove working window <from> to <to>"` |
| `windowStartLabel` | calendars | `"Working window start"` |
| `windowEndLabel` | calendars | `"Working window end"` |
| `removeButton` | calendars | `"Remove"` |
| `periodsLegend` | calendars | `"Special period"` |
| `fromLabel` | calendars | `"From"` |
| `toLabel` | calendars | `"To"` |
| `periodKindLabel` | calendars | `"These days are"` |
| `periodWorking` | calendars | `"Working"` |
| `periodNonWorking` | calendars | `"Non-working"` |
| `periodHoursLabel` | calendars | `"Only these hours"` |
| `applyPeriod` | calendars | `"Apply period"` |
| `removePeriod` | calendars | `"Remove period"` |
| `exceptionNonWorking` | calendars | `"Non-working"` |
| `exceptionWorkingDefault` | calendars | `"Working (calendar hours)"` |
| `exceptionWorkingHours` | calendars | builder `(windows) => "Working <windows>"` |
| `assignLegend` | calendars | `"Task calendar"` |
| `assignSelected` | calendars | `"Put selected tasks on it"` |
| `unassignSelected` | calendars | `"Back to the default"` |
| `statusWorkingDays` | calendars | builder; `"Working days: <d1, d2, …>."`, or `"No working day left — every day of this calendar is non-working."` for an empty list |
| `statusWorkingHours` | calendars | builder; `"<n> working window(s) applied."`, or `"Working hours cleared — every working day counts in full."` at 0 |
| `statusPeriodApplied` | calendars | builder; `"<days> day(s) from <from> set working/non-working."` |
| `statusPeriodRemoved` | calendars | builder; `"<n> exception day(s) removed."`, or `"No exception day falls in that period."` at 0 |
| `statusPeriodInvalid` | calendars | `"Pick both dates first; the period cannot end before it starts."` |
| `statusWindowInvalid` | calendars | `"Those hours end before they start."` |
| `statusExceptionAdded` | calendars | builder `(date) => "Exception on <date> added."` |
| `statusExceptionRemoved` | calendars | builder `(date) => "Exception on <date> removed."` |
| `statusAssigned` | calendars | builder `(a: { count; calendar }) => "<count> task(s) now on <calendar>."` |
| `statusUnassigned` | calendars | builder `(count) => "<count> task(s) back on the default calendar."` |
| `statusNoSelection` | calendars | `"Select one or more tasks first."` |
| `button` | diagnostics | builder `(issueCount) => "Diagnostics (<issueCount>)"` |
| `panelLabel` | diagnostics | `"Schedule diagnostics"` |
| `orphanHeading` | diagnostics | builder `(count) => "Unlinked tasks (<count>)"` |
| `leadHeading` | diagnostics | builder `(count) => "Leads — negative lag (<count>)"` |
| `noIssues` | diagnostics | `"No issues found"` |
| `leadItem` | diagnostics | builder `(sourceName, targetName, lagDays) => "<sourceName> → <targetName> (lag <lagDays>d)"` |

Plural forms in the calendar status builders use the plain English `s` suffix (`n === 1` → none). The transaction labels the reschedule and mode commands surface in undo UI are the data-store's (`taskUpdate`), not members here.

## 13. Internal modules

Directory = internal area; every file ≤ 800 lines (architecture ch. 6). The `engine/` subtree is headless: it imports only `@stargantt/plugin-data-store` (types + published helpers), `@stargantt/sdk` (`sdk/time`), and its own files — no DOM, no view/task-bars/tree-grid/interaction reference, no `internal/` import; enforced in CI (the architecture lint's import scan) so vitest targets it directly in plain Node.

| Directory | Files | Content |
|---|---|---|
| root (4) | `index.ts`, `types.ts`, `config.ts`, `internal/messages.ts` | factory, wiring, the two snap-point contributions and all claims; the single declaration-merging site; config resolution; the 62-key catalog + resolver |
| `engine/` (12) | `engine.ts` | forward pass, back-clamp, duration models including the working-hours variant (`modelFor`), summary rollup |
| | `graph.ts` | link/child indexes, forward closure, topological order, cycle detection (`topoOrder` / `detectCycle` live here) |
| | `links.ts` | per-link bound/latest-end/latest-finish algebra, the elapsed `DurationModel` only (the working-hours model is `engine.ts`'s `modelFor`) |
| | `topo-cache.ts` | the §2.8 topological-order memo |
| | `seeds.ts` | the §2.1 seeding classification |
| | `projection.ts` | per-transaction view projection for the will-hook walk |
| | `effort.ts` | the §2.5 effort tri-state |
| | `reschedule.ts` | the §2.6 planner, status-date floor, preview |
| | `constraints.ts` | the eight built-ins + `schedule/constraintBounds` / `schedule/propagationRule` composition |
| | `modes.ts` | `scheduleMode` / manual-task predicates |
| | `service.ts` | `SchedulerService` assembly, `scheduleAsync`, the `previewReschedule` orchestration |
| | `types.ts` | engine-internal shared types (`Times`, hooks, plan shapes) |
| `internal/calendars/` (6) | `wire.ts`, `registry.ts`, `service.ts`, `shading.ts`, `editor.ts`, `working-time-provider.ts` | registry state + validation; `CalendarsService` + `regionCalendar`; the order-8 layer (§6.2); the editor; the §4.1 `snap/workingTime` provider |
| `internal/links/` (13) | `wire.ts` (the area entry — every area uses `wire.ts`), `geometry.ts`, `routes.ts`, `avoid.ts`, `paint.ts`, `style.ts`, `emphasis.ts`, `analysis.ts`, `pairs.ts`, `hit.ts`, `link-drag.ts`, `keyboard-link.ts`, `inspector.ts` | area wiring; port/anchor constants; elbow/straight routing; `avoidBars`; line/port/band painting; color/width precedence; path emphasis; conflict/driving classification; ordered-pair rules; the hit tester; the port-drag session; the `Alt+L` chord; the side-panel inspector |
| `internal/critical-path/` (6) | `wire.ts`, `analysis.ts`, `service.ts`, `colors.ts`, `paint.ts`, `overlays.ts` | area wiring + config; the §7.1/§7.2 analysis over `sdk/cpm`; the store-shaped service; the token/config color resolution; the two layers 56 / 72; the style provider + outline/glyph overlay |
| `internal/diagnostics/` (4) | `wire.ts`, `diagnose.ts`, `panel.ts`, `types.ts` | wiring; the orphan/lead pass; the corner panel; internal report shapes |
| `internal/mode-column.ts` (1) | | the `grid/columns` mode column |

## 14. Dependencies

`dependsOn` (hard): `data` (L1) — the only edge the plugin cannot function without; the engine and every recording path ride it. All chart-surface edges are **optional with inert degradation**: `view` (L2 — layers, hit test, theme tokens, timeline t↔x) and `task-bars` (L4 — bar geometry, `hasOwnBar`, end gutter, style/overlay points) are resolved via `ctx.useOptional`; when absent, every UI area (shading, links, critical-path visuals, diagnostics panel) stays inert while the engine, services, commands, and snap-point contributions keep working. This keeps the headless composition (§13's engine acceptance: `dataStore() + scheduling()` with no DOM and no chart plugin) valid. `meta.optional` lists the chart providers (`stargantt.view`, `stargantt.task-bars`, `stargantt.tree-grid`, `stargantt.interaction`, `stargantt.a11y`). **Resolution timing (normative):** `meta.optional` does not influence startup order — the core tiers plugins by `dependsOn` alone, so scheduling's `setup()` runs before any chart provider's. Every optional service is therefore resolved at `lifecycle/ready` (which fires after every plugin's setup) or per-use — never latched into a variable at `setup()`. Area wiring that registers layer claims, subscriptions, or DOM against a chart service does so inside its `lifecycle/ready` handler; the claims themselves (`claimOrder`/`claimSlot`) are made at setup (arbitration is registration-ordered) while the contribution bodies re-resolve services when invoked. An absent optional service leaves the consuming area **silently inert** — no `core/pluginError` (that channel is reserved for foreign-code faults); the same rule applies uniformly to every area. Also optional (late lookup, never latched at setup): `rows` (tree-grid, L3 — visible-row walks for ports and float bars; absent, those passes stay inert), `selection` (interaction, L5 — path emphasis, link-selection disarm, inspector gating, editor assign section), `focus` (a11y, L5 — link announcements and the keyboard chord's focus source; absent, those paths are silent/unavailable). Sibling types arrive via `import type` (devDependencies; no reverse edge exists from view/task-bars/a11y to scheduling, so no build-graph cycle).

Per internal area: `engine/` consumes `data` only (plus `sdk/time`) and is view-free (lint-enforced, §13); `internal/calendars/` consumes `data` + `view` (shading) + optional `selection`; `internal/links/` consumes `data` + `view` + `task-bars` + optional `rows` / `selection` / `focus`; `internal/critical-path/` consumes `data` + `view` + `task-bars` + optional `rows`; `internal/diagnostics/` consumes `data` + `view` (panel host).

No upward `ctx.use` edge exists (architecture ch. 5 / `lint-deps.mjs`). Upper-layer integration is inverted or contribution-borne: interaction reaches this plugin's working time and stand-down through its OWN `snap/workingTime` / `snap/pushGuards` points, which this plugin contributes into (§4); export (L8) consumes `stargantt.critical-path` downward (the print critical veil; tracking computes its own deltas via `sdk/cpm` and declares no edge).

## 15. Third-party surface

- **Consumable services:** `stargantt.scheduler` (`SchedulerService` — differential scheduling, backward pass, cycle detection, reschedule preview, task modes, the propagation flag), `stargantt.calendars` (`CalendarsService` — registry store, working-time queries, task assignment, shading, editor), `stargantt.critical-path` (`CriticalPathService` — the analysis store plus shorthand readers; the export plugin's print critical veil is its first official consumer; tracking computes deltas via `sdk/cpm` and declares no edge).
- **Contributable extension points (with merge strategy):** `schedule/constraintBounds` (first — supply bounds for custom constraint types) and `schedule/propagationRule` (first — replace the per-task date derivation); full contribution types in §3.1. Both remain public and accept third-party contributions on equal terms — the official calendars reflection being engine-internal (§2.2) closes nothing: a third-party calendar system plugs into `schedule/propagationRule` on equal terms, and a third-party working-time engine contributes to interaction's `snap/workingTime` beside (or instead of) this plugin's provider.
- **Subscribable events:** `schedule/cycleRejected`. Calendar, analysis, and mode state are observed via store subscription (`CalendarsService.state`, `CriticalPathService.analysis`, the `data` stores).
- **Commands:** `schedule/reschedule` and `schedule/setTaskMode` are publicly emittable; `link/add` / `link/update` / `link/remove` (data-store's) are the public mutation path for links and gain cycle rejection automatically.
- **`task.meta` bag:** this plugin claims `scheduleMode`, `effortMode`, and `work` via `ctx.claimKey("task.meta", …)`; third parties reading or writing them get exactly the §2.4/§2.5 semantics, patch/undo-integrated.
- **Reserved namespaces (documentation convention only):** the `schedule/` event, command, and extension-point namespaces; the `stargantt.scheduler` / `stargantt.calendars` / `stargantt.critical-path` service IDs; the `stargantt.scheduling:*` keys in the `renderer/layers` order scope; the claimed `task.meta` keys above; the `overlay-corner` slot `top-left` (diagnostics). Not enforced in core — conflicts surface through the arbitration registries.
- **Hardening:** host-supplied functions (message builders, extension-point contributions) are foreign code — every call is guarded by the core error boundary (report via `core/pluginError`; builders answer with the default, contributions are treated as declining). Store snapshots handed out (`CalendarsState`, `CriticalPathAnalysis` maps/sets) are immutable snapshots per the core store contract. `detectCycle`, `schedule`, `previewReschedule`, and every calendar query are side-effect-free. No back-door APIs: everything above is reachable through the public core surface only.
