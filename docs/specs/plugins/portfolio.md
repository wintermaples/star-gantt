# Plugin: portfolio (`stargantt.portfolio`)

Package: `@stargantt/plugin-portfolio` — Layer 8.
Status: normative.

## Purpose

The multi-project surface, in two feature areas sharing one plugin. **Portfolio**: a ranked grouping hierarchy (initiative > program > project) laid over the task store, where a project node binds to one task id whose subtree is the project — per-project collapse/expand, traffic-light health aggregation, goal/OKR roll-up, template duplication of a project subtree, portfolio-scoped row narrowing with saved views (through the interaction plugin's filter service), and cross-project task moves. **Dashboard**: a headless KPI aggregation service over the task store (progress summary, overdue list, burndown, per-assignee workload, status counts, milestone summary, goal and portfolio roll-ups with a schedule performance index, group-comparison bars, user-defined formula metrics), plus an opt-in widget panel that live-updates on data changes, supports direct task updates from its rows, and exports the whole dashboard as a PNG or PDF text report. The `nodes` / `goals` sets are store-shaped; the dashboard events are activity notifications. With no config the plugin registers both services over empty sets and changes nothing — no node, no filter, no panel, no DOM; rendered output is byte-identical.

## 1. Services

### 1.1 `stargantt.portfolio` → `PortfolioService`

Public types: `PortfolioNodeId`, `PortfolioNodeKind` (`"initiative" | "program" | "project"`), `PortfolioNodeInit`, `PortfolioNode`, `PortfolioTreeNode`, `PortfolioHealthStatus` (`"on-track" | "at-risk" | "late"`), `PortfolioHealth`, `PortfolioGoalId`, `PortfolioGoalInit`, `PortfolioGoal`, `PortfolioGoalProgress`, `DuplicateProjectOptions`, `PortfolioView`, `NodeNameArg`.

```ts
import type { Store } from "@stargantt/core";
import type { TaskId } from "@stargantt/plugin-data-store";

export interface PortfolioService {
  // --- stores ---
  /** The node set, definition order. A fresh snapshot array per observable set change. */
  readonly nodes: Store<readonly Readonly<PortfolioNode>[]>;
  /** The goal set, definition order. A fresh snapshot array per observable set change. */
  readonly goals: Store<readonly Readonly<PortfolioGoal>[]>;

  // --- methods ---
  defineNode(init: PortfolioNodeInit): PortfolioNodeId | undefined;
  removeNode(id: PortfolioNodeId): void;
  node(id: PortfolioNodeId): Readonly<PortfolioNode> | undefined;
  tree(): readonly PortfolioTreeNode[];
  projectOf(taskId: TaskId): Readonly<PortfolioNode> | undefined;
  tasksOf(id: PortfolioNodeId): readonly TaskId[];
  setProjectCollapsed(id: PortfolioNodeId, collapsed: boolean): void;
  collapseAllProjects(): void;
  expandAllProjects(): void;
  health(id: PortfolioNodeId, now?: number): PortfolioHealth | undefined;
  healthSummary(now?: number): readonly PortfolioHealth[];
  defineGoal(init: PortfolioGoalInit): PortfolioGoalId | undefined;
  removeGoal(id: PortfolioGoalId): void;
  goalProgress(id: PortfolioGoalId): PortfolioGoalProgress | undefined;
  duplicateProject(source: PortfolioNodeId | TaskId, options?: DuplicateProjectOptions): TaskId | undefined;
  moveTaskToProject(taskId: TaskId, target: PortfolioNodeId): boolean;
  applyPortfolioFilter(nodeIds: readonly PortfolioNodeId[] | null): void;
  portfolioFilter(): readonly PortfolioNodeId[] | null;
  savePortfolioView(name: string): void;
  applyPortfolioView(name: string): boolean;
  deletePortfolioView(name: string): boolean;
  portfolioViewNames(): string[];
}
```

Member count: 24 (2 stores + 22 methods). Design note: there are no list-accessor methods `nodes()` / `goals()` — the same-named stores subsume them (`service.nodes.get()` is the read). Store values are immutable snapshots in definition order; the initial value is the config-seeded set (seeding completes before the store's first value is observable), and every observable set change (define, replace, remove — including a remove's child re-parenting) publishes one fresh snapshot on that store. The stores carry no per-change `id` hint; a subscriber diffs `(next, prev)`.

### 1.2 `stargantt.dashboard` → `DashboardService`

Public types: `DashboardWidgetId` (the closed ten-member union `"summary" | "overdue" | "burndown" | "workload" | "status" | "milestones" | "goals" | "portfolio" | "groups" | "formulas"`), `ProgressSummary`, `OverdueEntry`, `StatusCounts`, `MilestoneEntry`, `WorkloadEntry`, `GroupProgressEntry`, `BurndownPoint`, `BurndownSeries`, `PortfolioStatusRow`, `GoalRollupEntry`, `DashboardFormulaInit`, `FormulaValue`, `TaskStatusPatch`, `DashboardModel`, `DashboardWidgetRenderContext`. `TaskStatusPatch.rag` is typed against the tracking plugin's `RagStatus` via `import type` (devDependency; type-only sibling import).

```ts
export interface DashboardService {
  open(): boolean;
  close(): void;
  isOpen(): boolean;
  refresh(): void;
  element(): HTMLElement | undefined;
  summary(now?: number): ProgressSummary;
  overdueTasks(now?: number): readonly OverdueEntry[];
  statusCounts(): StatusCounts;
  milestones(now?: number): readonly MilestoneEntry[];
  workload(): readonly WorkloadEntry[];
  groupComparison(): readonly GroupProgressEntry[];
  burndown(): BurndownSeries;
  goalRollups(): readonly GoalRollupEntry[];
  portfolioStatus(now?: number): readonly PortfolioStatusRow[];
  defineFormula(init: DashboardFormulaInit): string | undefined;
  removeFormula(id: string): boolean;
  formulaValues(): readonly FormulaValue[];
  updateTaskStatus(id: TaskId, patch: TaskStatusPatch): boolean;
  exportReport(format?: "png" | "pdf"): string | undefined;
}
```

Member count: 19 — no stores here (`dashboard/opened` / `closed` / `refreshed` are activity notifications, not state changes). Both services are always provided; the `dashboard` config nest gates only the panel's boot behavior, never the service's existence. Every `now?` parameter defaults to the current time; a non-finite `now` counts as absent. Unusable service arguments are silent no-ops, returning `undefined` / `false` where the signature has a return value (both services).

## 2. Portfolio behavior

### 2.1 The node hierarchy

The node set is plugin-local state, initialized from `config.nodes` and edited through the service — outside the transaction/patch/undo pipeline (the calendars-registry precedent). Ranks are fixed: initiative (0) > program (1) > project (2); a `parentId` is honored only when it names an already-defined node of strictly higher rank, otherwise the node is a root. `taskId` is kept on project nodes only; the task need not exist — an unbound or dangling project resolves to no tasks. A colliding `id` replaces its holder; an omitted `id` is generated unique in the set; an omitted `name` comes from the `nodeName` builder (1-based ordinal per kind); an unknown `kind` counts as absent (default `"project"`). Removing a node lifts its children to the removed node's parent when the rank rule still holds there, otherwise they become roots. Every observable set change sets the `nodes` store.

`tasksOf(id)` resolves fresh from the store at call time: a project yields its bound root task's subtree (root included, parent-before-child); a program or initiative yields the de-duplicated union over its project descendants in definition order. `projectOf(taskId)` walks the task's ancestor chain to the first project node whose bound root is hit (two projects binding one root: earliest-defined wins). Both are cycle-safe against corrupt parent links.

### 2.2 Project collapse/expand

`setProjectCollapsed(id, collapsed)` dispatches the retained public command `view/rowToggle { id: rootTaskId, expanded: !collapsed }` for a bound project whose root task exists — the same path a user's expander click takes, so the grid, chart, and ARIA mirror stay in sync. `collapseAllProjects()` / `expandAllProjects()` iterate the project nodes in definition order. Without the tree-grid plugin the dispatch reaches no runner and is a silent no-op (core command-bus semantics); no dependency edge exists or is needed — command dispatch needs no ordering.

### 2.3 Health aggregation

`health(id, now?)` (and `healthSummary(now?)`, one row per node in definition order) aggregates over `tasksOf(id)`, skipping summary-typed tasks and tasks without finite dates. Per task, with progress read as 0 when absent and clamped to 0..1: **late** — `end <= now` and `progress < 1`; **at-risk** — not late, `start <= now < end`, and `progress < (now − start) / (end − start)`; the aggregate `status` is `"late"` if any task is late, else `"at-risk"` if any is at risk, else `"on-track"` (strictly-worst-wins); `progress` is the duration-weighted mean (weight `max(1, end − start)` ms, 0 for an empty set). The status is a string paired with counts — a host UI that colors it also shows the text or counts (meaning never by color alone). Unknown ids return `undefined`.

### 2.4 Goals

The goal set mirrors the node set: plugin-local, config-seeded, service-edited, changes published on the `goals` store. A goal links portfolio nodes and/or task ids; `target` clamps to 0..1, default 1; an omitted `name` comes from the `goalName` builder. `goalProgress(id)` resolves the links fresh at call time — each node via `tasksOf`, each task id with its whole subtree — de-duplicates the union by task id, and reports the §2.3 duration-weighted mean, so store edits reflect into goal progress with no subscription. `achieved` requires `progress >= target` and at least one resolved task; a goal resolving to nothing reports progress 0 and is never achieved.

### 2.5 Template duplication

`duplicateProject(source, options?)` treats `source` first as a project node id, otherwise as a root task id. It deep-copies the source root's subtree under fresh store-unique ids — the copy's root becomes a new top-level task (`parentId: null`, appended after the existing roots) — together with every link internal to the subtree. Dates shift by `options.startAt − sourceRootStart` when `startAt` is finite; progress is cleared unless `keepProgress === true`; `type`, `calendarId`, `constraint`, and `meta` are copied (`orderKey` is not — the store assigns fresh sibling order); an omitted `name` comes from the `copyName` builder. The whole copy commits as **one transaction — one undo step** through `sdk/aggregate`'s `createTransactionBatcher` with origin prefix `"stargantt.portfolio/duplicate"` (the batcher's per-call `#<n>` suffix keeps a foreign transaction from absorbing another batch's patches): the head is one public `task/add` for the copy's root, the tail is the precomputed remaining `task/add` / `link/add` patches. When `source` was a project node, a new project node bound to the copy's root (same parent as the source) is defined and published on the `nodes` store; a raw task-id source defines no node. Unknown sources return `undefined` and change nothing.

### 2.6 Portfolio filter and saved views

`applyPortfolioFilter(nodeIds)` narrows the visible rows to the given nodes' tasks by writing a single `predicate` criteria wholesale through the interaction plugin's `stargantt.filter` service (`setCriteria({ predicate })`; `null` removes the narrowing via `setCriteria(null)`). The predicate consults a task-id set derived from `tasksOf` that is invalidated on `data.tasks` store notifications and rebuilt lazily, so the narrowing follows store edits without re-applying. The criteria write is wholesale — combining the portfolio narrowing with other criteria members is the host's affair. The filter service is optional and resolved late (Dependencies); without it the whole surface is a silent no-op (`applyPortfolioView` still returns its lookup result). Saved views live in memory for the instance's life, seeded from `config.views`, and cover the node-id narrowing only; empty/non-string names are a no-op on save, a same-named save replaces, `applyPortfolioView` returns `false` for unknown names, names list in insertion order. The narrowing is display state only — nothing is undoable.

### 2.7 Cross-project task move

`moveTaskToProject(taskId, target)` reparents the task (subtree follows implicitly) under the target project's bound root via one public `task/update { after: { parentId } }` — one undoable transaction. It returns `false` and changes nothing when the task or target root is unknown, the target is not a bound project node, or the target root lies inside the moved task's own subtree; moving a task already a direct child of the target root returns `true` without dispatching. Dates are kept — a structural move, not a reschedule. No drag-and-drop gesture exists for this; the service is the primitive a gesture would commit through.

## 3. Dashboard behavior

All aggregations read one flat store snapshot (tasks, assignments, resources) cached per data generation: invalidated on `data.tasks` store notifications (the always-fired, always-last burst member), rebuilt lazily at the next read. Unless a § says otherwise, aggregations skip summary-typed tasks, milestone-typed tasks (§3.2 summarizes them separately), and tasks without finite dates — the remaining tasks are the **leaf tasks**. Progress reads as 0 when absent, clamped 0..1; the duration weight is `max(1, end − start)` ms (§2.3's rule).

### 3.1 Summary, overdue, status, milestones

`summary(now?)` reports the leaf-task counts of `ProgressSummary`: completed at `progress >= 1`, overdue when `end <= now` while incomplete; `progress` is the duration-weighted mean; `milestoneCount` counts milestone-typed tasks separately. `overdueTasks(now?)` lists the overdue leaf tasks with `daysOverdue = max(1, ceil((now − end) / day))`, most-overdue first (ties by earlier end). `statusCounts()` buckets leaf tasks into not-started (progress 0 or absent), in-progress, completed. `milestones(now?)` lists every milestone-typed task with finite dates in date order (`date` = the task's start); `reached` is `progress >= 1`, `overdue` is unreached with the date passed. All states are strings/counts — the panel's donut and any host UI pair color with text.

### 3.2 Workload and group comparison

`workload()` aggregates the store's assignments: each assignment of a known, dated, non-summary task contributes `units × duration-in-days` person-days to its resource's row; rows carry the resource's store name (the raw id as text when unnamed) and sort largest first. `groupComparison()` buckets leaf tasks by a label — the `groupOf` hook when given, else the name of the task's first store assignment's resource — reporting each bucket's duration-weighted progress, sorted by label; a task whose label is empty, non-string, or from a throwing hook is left out. (Design note: no resource-plugin service is consumed — workload reads store assignments directly.)

### 3.3 Burndown and roll-ups

`burndown()` builds two remaining-task curves over the leaf set. **Planned**: starts at `(earliest start, leafCount)` and steps down one task per end date (equal dates collapsed), reaching 0 at the latest end. **Actual**: maps the tracking plugin's recorded progress snapshots — `progress.state.get().snapshots`, oldest first — to `{ date, remaining: max(0, snapshot.taskCount − snapshot.completedCount) }` per snapshot; empty without the tracking plugin or without snapshots.

`goalRollups()` and `portfolioStatus(now?)` are projections of the portfolio area (always composed — both areas live in this one plugin). `goalRollups()` maps every goal to its `goalProgress` result plus the goal's name. `portfolioStatus` reports one row per node in definition order: the node's health counts and traffic-light `status` verbatim from `health(id, now)`, `progress` as the weighted mean over the node's leaf tasks, and `spi` — earned value over planned value, each leaf task earning `weight × progress` and planning `weight × clamp((now − start)/(end − start), 0, 1)`; `undefined` while planned value is 0. (Design note: the roll-up is deliberately the self-computed schedule-only SPI plus the tracking-plugin progress integrations (§3.3 actual curve, §3.5 `rag`); no edge to `stargantt.evm` or `stargantt.cost` is declared and no cost measure is reported — extending `PortfolioStatusRow` with cost measures is future work.)

### 3.4 Formula cards

The formula set is plugin-local (config-seeded, service-edited), keyed by id; an init without a usable `evaluate` function returns `undefined` and defines nothing; an omitted `id` is generated, a colliding id replaces, an omitted `label` comes from the `formulaName` builder. Evaluation (`formulaValues()` and the formulas widget) runs each formula over the whole task snapshot (summaries included — `filter` decides scope): `filter` narrows, `evaluate` computes, `format` renders. Containment is per call, unlatched (the hooks run per data change, not per frame): a throwing `filter` matches nothing, a throwing or non-finite `evaluate` yields `value: undefined` with the `formulaError` text, a throwing `format` falls back to the default (up to 2 fraction digits). Formula edits refresh an open panel.

### 3.5 Direct task updates

`updateTaskStatus(id, patch)` is the panel's write path and a public primitive. A usable `progress` (non-finite ignored; clamped 0..1) commits one public `task/update { after: { progress } }` — one undoable transaction. A usable `rag` goes through the tracking plugin's `ProgressService.setRag` (that plugin's own single undo step) and is ignored when `stargantt.progress` does not resolve; the patch's `null` — `TaskStatusPatch`'s clear sentinel (`rag?: RagStatus | null`) — converts to `setRag(id, undefined)`, that signature's clear form. A patch supplying both commits two independent steps (separate concerns, separate owners). Returns `false`, changing nothing, for an unknown task or a patch with no usable field. The overdue widget's "Mark done" button commits `updateTaskStatus(id, { progress: 1 })` — exactly one undo step per press.

### 3.6 The panel

`open()` mounts one dialog overlay (`.sg-dashboard`, `role="dialog"`, labelled `panelTitle`) into the gantt root (`ctx.root` — centred over the whole widget, draggable across all of it) and returns `true`; while `stargantt.view` does not resolve it returns `false` and does nothing (no composed chart provider, no panel — the tracking.md precedent); already open is a no-op returning `true`. `close()` removes the panel and every listener it attached. The chrome comes from `sdk/dialog`'s `createDialog` (header band with title and close button, scrolling body, drag, 24×24 px resize grip, Escape, `pointerdown` containment, the `--sg-dialog-*` token family) with `width: "min(680px,92%)"`, `top: 16`, `maxHeight: "85%"`; the widget grid mounts inside `dialog.body`, its cards reading the `--sg-panel-*` token family.

The panel shows the configured widgets in order as cards in a responsive grid (≥ 720 px viewport assumed; no mobile layout). Canvas charts (status donut, burndown) carry `role="img"` labels **and** a text equivalent beside them; bar comparisons (workload, goals, groups) are DOM meters with the value as text and the `role="progressbar"` / `aria-valuenow` / `aria-valuemin="0"` / `aria-valuemax="100"` triad on the track, `aria-valuenow` being the same rounded percentage the bar's width encodes. A panel canvas backing store is sized to CSS pixels × `devicePixelRatio` and drawn in CSS coordinates over a matching scale — never CSS-upscaled from a smaller backing; the backing recomputes on panel resize and on `devicePixelRatio` change (a `matchMedia` resolution subscription owned via `ctx.own()`). The donut has an explicit square CSS size; the burndown tracks its card's width. The close button and every action button have ≥ 24×24 px hit areas. `open()` moves focus into the panel root and `close()` returns focus to the previously focused element; the `dashboard.open: true` boot path mounts on `lifecycle/ready` **without** moving focus (no user gesture; `close()` then restores nothing). `element()` hands out the root while open. Open/close emit `dashboard/opened` / `dashboard/closed`.

### 3.7 The `renderWidget` seam

`dashboard.renderWidget`, when supplied, is called once per configured widget on every render (initial and re-renders alike) with `host` — the card body the built-in `WIDGET_BODIES[widget]` would have filled, already carrying the card's title — and a `DashboardWidgetRenderContext` naming the widget, handing over the whole computed `DashboardModel`, and `markDone` (the §3.5 quick-complete). Returning without appending anything leaves an empty body — what the host asked for, not a fallback signal; only a throw falls back. The containment is the **latched** seam barrier (`sdk/dom` `latchedSeam`): the first throw is reported exactly once via `core/pluginError` (`error: { option: "renderWidget", cause }`), the body is emptied (partial DOM removed) and the built-in body fills it, and every later call for the instance's life declines without invoking the host function again — a close/reopen does not reset the latch. It replaces one standard widget's body in place; it adds no eleventh card and is not an extension point — the widget union stays closed (a `dashboard/widgets` extension point remains future work).

### 3.8 Live refresh and report export

While the panel is open, notifications of the `data.tasks` store and the portfolio `nodes` / `goals` stores schedule a re-render coalesced to one per animation frame (`sdk/frame`'s `createFrameScheduler` — the standard store-to-repaint coalescing point, with its own macrotask fallback), so a transaction burst repaints once; each re-render emits `dashboard/refreshed { cause: "data" }`. The subscription handlers only schedule — they never dispatch commands on the store's stack (the architecture ch. 1.1 re-entrancy rule). `refresh()` recomputes and re-renders synchronously with `cause: "api"` — but only while the panel is open; with it closed, `refresh()` recomputes nothing and emits nothing. Headless reads recompute from the cached snapshot at call time regardless of panel state.

`exportReport(format?)` flattens the configured widgets' current data to text lines (widget order preserved) through the same resolved catalog the panel uses — every line, including `burndownPlanned` / `burndownPoint` and `portfolioRow` lines, is translatable; no line is hardcoded English. `"png"` (default) draws the lines onto an offscreen canvas and returns its `image/png` data URL; it returns `undefined` while `stargantt.view` does not resolve (the same chart gate as `open()` — a composition with no chart exports no image) and when no document / 2D context is reachable (the document comes from the root the panel is hosted on, not the chart pane). `"pdf"` typesets the same lines into a minimal self-generated single-page PDF (built-in Helvetica, WinAnsi — characters outside Latin-1 replaced) returned as a `data:application/pdf;base64` URL; it needs no DOM and always succeeds. A data-driven report, not a pixel screenshot — chart pixels are the export plugin's domain.

## Extension points

None defined, none contributed. Everything visible the plugin causes goes through other plugins' public commands (`view/rowToggle`) and services (`stargantt.filter`); custom dashboard widget bodies are a config seam (§3.7), not an extension point.

## Commands

None owned. Dispatches: `view/rowToggle` (§2.2), `task/add` + appended patches under the `"stargantt.portfolio/duplicate"` origin prefix (§2.5), `task/update` (§2.7, §3.5).

## Events

- Emits `dashboard/opened: void`, `dashboard/closed: void`, `dashboard/refreshed: { cause: "data" | "api" }` — activity notifications, owned by this plugin.
- There are no `portfolio/nodesChanged` / `portfolio/goalsChanged` events — the `nodes` / `goals` stores are the change channels (§1.1).
- Subscribed: `lifecycle/ready` (the `dashboard.open: true` boot and late service resolution — see Dependencies). Store subscriptions: `data.tasks` (§2.6 predicate cache, §3 snapshot cache, §3.8 live refresh), plus the plugin's own `nodes` / `goals` stores for panel refresh.

## Config

Factory: `portfolio(config?: PortfolioConfig)`. Every field optional; `portfolio()` ≡ `portfolio({})`; unusable values silently fall back; resolved once at `setup()`.

```ts
export interface PortfolioConfig {
  nodes?: readonly PortfolioNodeInit[];
  goals?: readonly PortfolioGoalInit[];
  views?: Record<string, PortfolioView>;
  dashboard?: {
    open?: boolean;
    widgets?: readonly DashboardWidgetId[];
    formulas?: readonly DashboardFormulaInit[];
    groupOf?: (task: Readonly<Task>) => string | undefined;
    renderWidget?: (host: HTMLElement, ctx: DashboardWidgetRenderContext) => void;
  };
  messages?: Partial<PortfolioMessages>;
}
```

| Field | Default | Semantics |
|---|---|---|
| `nodes` / `goals` | `[]` | handed to `defineNode` / `defineGoal` in array order (a parent precedes its children to be honored); non-arrays ignored wholesale |
| `views` | `{}` | seeds the saved-view map; entries with an empty name or non-object value skipped; a non-array `nodeIds` counts as `null` |
| `dashboard.open` | `false` | opens the panel on `lifecycle/ready` (activation order is not layout order); focus untouched (§3.6) |
| `dashboard.widgets` | all ten, union declaration order | entries outside the union dropped (order preserved, duplicates allowed); a non-array keeps the default |
| `dashboard.formulas` | `[]` | handed to `defineFormula` in order |
| `dashboard.groupOf` | absent | §3.2; a non-function counts as absent |
| `dashboard.renderWidget` | absent | §3.7; a non-function counts as absent |
| `messages` | English defaults (below) | per-key shallow override, resolved once at `setup()` |

The task-scoped host hooks (`groupOf`, formula `filter` / `evaluate` / `format`) are contained per call, unlatched (§3.4); `renderWidget` is the one latched seam (§3.7).

## Messages

`PortfolioMessages` — one merged catalog (single top-level `messages` key), resolved once at setup with the shared catalog merge rules (`sdk/dom` `resolveCatalog`). Key count: 23 (3 portfolio-area keys + 20 dashboard-area keys). All builders are data/gesture-driven and guarded per call, unlatched — none runs per frame.

| Key | Kind | Default | From |
|---|---|---|---|
| `nodeName` | builder `(arg: NodeNameArg) => string` | `` `${Kind} ${ordinal}` `` (`"Initiative <n>"` / `"Program <n>"` / `"Project <n>"`) | portfolio |
| `goalName` | builder `(ordinal: number) => string` | `` `Goal ${ordinal}` `` | portfolio |
| `copyName` | builder `(sourceName: string) => string` | `` `${sourceName} (copy)` `` | portfolio |
| `panelTitle` | string | `"Dashboard"` | dashboard |
| `closeLabel` | string | `"Close"` | dashboard |
| `markDoneLabel` | string | `"Mark done"` | dashboard |
| `emptyLabel` | string | `"No data"` | dashboard |
| `statusNotStarted` | string | `"Not started"` | dashboard |
| `statusInProgress` | string | `"In progress"` | dashboard |
| `statusCompleted` | string | `"Completed"` | dashboard |
| `milestoneReached` | string | `"reached"` | dashboard |
| `milestonePending` | string | `"pending"` | dashboard |
| `milestoneOverdue` | string | `"overdue"` | dashboard |
| `reportTitle` | string | `"Dashboard report"` | dashboard |
| `formulaError` | string | `"—"` | dashboard |
| `widgetTitle` | builder `(widget: DashboardWidgetId) => string` | the widget's English title | dashboard |
| `summaryText` | builder `(summary: ProgressSummary) => string` | shipped default (see note below) | dashboard |
| `overdueLine` | builder `(entry: OverdueEntry) => string` | shipped default (see note below) | dashboard |
| `formulaName` | builder `(ordinal: number) => string` | `` `Metric ${ordinal}` `` | dashboard |
| `burndownPlanned` | builder `(taskCount: number) => string` | `` `${n} tasks planned` `` | dashboard |
| `burndownRemaining` | builder `(remaining: number) => string` | `` `${n} remaining at last snapshot` `` | dashboard |
| `portfolioRow` | builder `(row: PortfolioStatusRow) => string` | `"<name>: <pct>, <n> late[, SPI <x.xx>] (<status>)"` | dashboard |
| `burndownPoint` | builder `(point: BurndownPoint) => string` | `"<YYYY-MM-DD>: <n> remaining"` | dashboard |

Builder defaults not spelled out here are the shipped implementation's defaults (`internal/messages.ts`), pinned by its tests (the architecture ch. 1.4 silence rule).

## Internal modules

Directory = feature area; every area enters through `wire.ts`; every file ≤ 800 lines.

| Module | Content |
|---|---|
| `index.ts` | factory, two-service assembly, area wiring hand-off |
| `types.ts` | public types + the single `declare module "@stargantt/core"` site (2 services, 3 events) |
| `internal/messages.ts` | the merged 23-key `PortfolioMessages` catalog resolution (shared by both areas) |
| `internal/portfolio/wire.ts` | service assembly, the two stores, config seeding, `data.tasks` invalidation |
| `internal/portfolio/registry.ts` | node/goal sets, rank rules, id minting, name builders |
| `internal/portfolio/tree.ts` | `tree()` / `tasksOf` / `projectOf` resolution, cycle safety |
| `internal/portfolio/health.ts` | §2.3 health + §2.4 goal progress |
| `internal/portfolio/template.ts` | §2.5 duplication (batcher-based) |
| `internal/portfolio/filter.ts` | §2.6 predicate, saved views, late filter-service binding |
| `internal/dashboard/wire.ts` | service assembly, live-refresh scheduling, `open: true` boot |
| `internal/dashboard/model.ts` | `DashboardModel` assembly |
| `internal/dashboard/compute.ts` | every §3.1–§3.3 aggregation + SPI |
| `internal/dashboard/formulas.ts` | §3.4 formula set + evaluation |
| `internal/dashboard/panel.ts` | §3.6 panel, widget bodies, §3.7 seam |
| `internal/dashboard/canvas-backing.ts` | DPR-exact canvas backing (§3.6) |
| `internal/dashboard/export.ts` | §3.8 PNG/PDF report |

## Dependencies

`dependsOn` (hard): `data` (L1). `meta.optional` (provider *plugin* ids — the core's optional-lookup gate checks the providing plugin's id, not the service key; the tracking.md precedent): `stargantt.view` (L2 — the panel gate, §3.6), `stargantt.tracking` (L7 — the `stargantt.progress` service: burndown actual + `rag`, §3.3/§3.5), `stargantt.interaction` (L5 — the `stargantt.filter` service: the portfolio narrowing, §2.6). **Resolution timing** follows the scheduling.md §14 pattern: `meta.optional` does not influence startup order; every optional service is resolved at `lifecycle/ready` or per use, never latched at `setup()` (this plugin's tier can precede every optional provider's); an absent optional service leaves the consuming feature silently inert. Sibling types (`RagStatus`, filter criteria) arrive via `import type` (devDependencies). No resource-plugin edge exists (§3.2) and no tree-grid edge exists (§2.2 — command dispatch only).

No upward `ctx.use` edge exists. All edges point at Layers 1–7.

## Third-party surface

- **Consumable services:** `stargantt.portfolio` (`PortfolioService` — the node/goal stores plus the full hierarchy, health, goal, duplication, move, and filter/view surface) and `stargantt.dashboard` (`DashboardService` — every aggregation headlessly, the panel, formulas, `updateTaskStatus`, the report export).
- **Contributable extension points:** none defined. Custom dashboard widget bodies are supplied through `dashboard.renderWidget` (§3.7); custom metrics through `dashboard.formulas` / `defineFormula`.
- **Subscribable events:** `dashboard/refreshed`, `dashboard/opened`, `dashboard/closed`.
- **Reserved namespaces (documentation convention only):** the `dashboard/` event namespace, the `stargantt.portfolio` / `stargantt.dashboard` service IDs, the `"stargantt.portfolio/duplicate"` transaction-origin prefix, and the `.sg-dashboard` root class. Not enforced in core.
