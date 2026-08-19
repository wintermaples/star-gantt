# Plugin: tree-grid (`stargantt.tree-grid`)

Package: `@stargantt/plugin-tree-grid` — Layer 3.
Status: normative.

## Purpose

The left-pane tree grid (virtual scrolling, Fenwick variable row heights, column management, cell editing, sorting, WBS, outline editing); the standard field columns (status / priority / assignee, etc. — 9 columns + templates, stored under `task.meta.taskFields`); conditional formatting (rule evaluation, bar recoloring via the taskbars points, legend). The row set, column widths, and sort state are store-shaped.

Public types: `ColumnDef` (`id`, `header`, `width?`, `render`, `getValue`, `setValue?`, `editable?`, `editor?`, `compare?`, `weight?` — built-ins weight 0, omitted 100), `ColumnEditor`, `CellRenderer`, `ColumnLayoutConfig`, `InsertPosition`, `SelectOption` (the `selectEditor` choice shape), `RowHeightContribution`, `ResolvedRowHeight` (tree-grid); `TaskStatus`, `TaskPriority`, `TaskFieldValues`, `TaskFieldsPatch`, `TaskTemplate`, `DurationUnit`, `TaskFieldsColumnId` (task-fields); `ConditionOperator`, `FieldCondition`, `AllCondition`, `AnyCondition`, `NotCondition`, `Condition`, `ConditionalFormatStyle`, `ConditionalFormatRule`, `OverdueOptions`, `ProgressStatusColors` (conditional-format). The bundled editor factories `selectEditor(choices)` and `dateEditor()` remain package exports.

## Services

### `stargantt.rows` → `RowsService`

The row model service, store-shaped.

```ts
import type { Store } from "@stargantt/core";

/** Snapshot of the visible row set — names the visible rows so subscribers can diff. */
export interface RowsSnapshot {
  /** The visible rows' task ids, in row order (collapsed subtrees omitted, zero-height rows included). */
  readonly taskIds: readonly TaskId[];
  /** Total content height in CSS px — the value the vertical `renderer/contentExtent` contribution measures. */
  readonly totalHeight: number;
}

export interface RowsService {
  // --- methods ---
  rowCount(): number;
  taskIdAt(row: number): TaskId | undefined;
  rowOf(id: TaskId): number | undefined;
  rowHeight(row: number): number;
  /** The `rows/height` resolution for one task, row or no row; `0` = hidden (the filter shape);
   *  `undefined` only for an id the store does not know. */
  resolvedHeightOf(id: TaskId): number | undefined;
  yOf(row: number): number;      // row index → y   (O(log n))
  rowAtY(y: number): number;     // scrollTop → row (O(log n))
  totalHeight(): number;
  isExpanded(id: TaskId): boolean;

  // --- store ---
  /** The visible row set. Set once per change — expand/collapse, sort reorder,
   *  data-driven reflow, `view/rowsInvalidate`, `view/expandToLevel` (an
   *  ineffective invalidation still notifies once over an unchanged snapshot). */
  readonly rows: Store<RowsSnapshot>;
}
```

Member count: 10 (9 methods + 1 store). `resolvedHeightOf` is load-bearing (task-bars' split rows, filtering).

### `stargantt.grid` → `GridService`

Display-state reflection plus the two display-state stores.

```ts
export interface GridSortState {
  columnId: string;
  /** The column's visible header label, ready for a live-region announcement. */
  header: string;
  direction: "ascending" | "descending";
}

export interface GridService {
  // --- methods (display state only; never writes to the store; class toggling in place) ---
  setSelected(ids: ReadonlySet<TaskId>): void;
  setFocused(id: TaskId | undefined): void;

  // --- stores ---
  /** Composed column id → current width in CSS px. Map contents: before the first header
   *  layout, only columns with a declared `ColumnDef.width` have an entry (their declared
   *  value); a width-less column has NO entry (absent, i.e. `get(id)` = `undefined`) until
   *  the first header measurement, after which every displayed column has an entry with its
   *  laid-out width. During a resize drag the store is set at most once per animation frame
   *  (a cadence applied by the emitter — store dispatch itself never coalesces). */
  readonly columnWidths: Store<ReadonlyMap<string, number>>;
  /** The active sort, or `null` when no column is sorted (the sort cycle's "off" step). */
  readonly sort: Store<GridSortState | null>;
}
```

Member count: 4 (2 methods + 2 stores).

### Internalized features

Task-field columns and conditional formatting are **features of this plugin**, not separate services (architecture ch. 4.1: exactly 22 services). The field columns/panel/bar decorations run from the `taskFields` config nest, and the rule engine + bar recoloring + legend run from the `conditionalFormat` nest. Consequence, stated deliberately: there are no public runtime mutators for these features (no `setFields`, `setAssignees`, `applyTemplate`, `createFromTemplate`, `setRules`, `setPriorityColors`, …) — field values are edited through the grid/panel UI or written by the host via the public `task/update` / `assignment/*` commands (`task.meta.taskFields` storage, claimed via `ctx.claimKey("task.meta", "taskFields")`), and formatting rules are configuration-time.

## Extension points

- **Defines:**
  - `grid/columns` (collect, contribution type `ColumnDef`, result `ColumnDef[]`) — display order is weight-sorted (built-ins 0, omitted 100, ties keep contribution order); collect performs no de-duplication; the editing/sorting/resize rules apply per composed column. Remains a public collect point even though the task-fields and custom-fields columns are internalized.
  - `rows/height` (reduce, contribution type `RowHeightContribution`, result `ResolvedRowHeight`) — default height → contributions may override; a resolved `0` hides the row geometrically in **both panes** (not materialized in the grid, not painted in the chart), while `rowCount()`, row indexes, `yOf`, `rowAtY`, and `totalHeight()` are all unchanged — the row keeps its place in the model; only its paint disappears.
- **Contributes:**
  - `renderer/contentExtent` — vertical extent, `measure()` = `totalHeight()` at call time.
  - `renderer/rowGeometry` — one `RowGeometryProvider` (view.md; `first` strategy) backed by the `RowsService` internals: `rowCount` / `rowAtY` / `yOf` / `rowHeight` answered from the same row model the service publishes, resolved live per call. This is the sanctioned downward channel through which the view plugin's grid-lines / row-stripes / row-hover passes paint without any upward row-model dependency. Per the point's contract, this plugin invalidates the view's `background` layer whenever its row geometry changes (row set, heights, expansion, sort).
  - `view/panes` — the grid pane: `{ id: "stargantt.tree-grid", side: "left", order: 0, initialWidth: config.paneWidth, minWidth: 120, label: messages.paneResizeLabel, onResize, mount }`.
  - `taskbars/style` — one `BarStyleProvider` (the conditional-format rule engine; registered unconditionally, answers `undefined` for tasks it does not color; resolution order per task: `rules` in order → `overdue` → `priorityColors`; theme-token color references resolved at draw time; latched fault barrier).
  - `taskbars/overlays` — up to two `BarOverlayRenderer`s: the task-fields renderer (status glyph / deadline warning / assignee avatars; contributed only when at least one `show*` flag is on; end decorations place outside the bar's resolved `gutterEnd`) and the conditional-format renderer (progress status coloring clipped to the bar's rounded outline + overdue warning icon; contributed only when `overdue` icon or `progress` is configured).
  - `sidepanel/fields` — one contribution (`id: "stargantt.tree-grid"`) when `taskFields.detailFields` is enabled; buffered by the core when no side-panel point owner is composed.
- **Claims:** `ctx.claimKey("task.meta", "taskFields")`; when the legend is enabled, `ctx.claimSlot("overlay-corner", "bottom-right", ["top-left", "top-right", "bottom-left", "bottom-right"])` (the conditional-format legend's corner; the legend positions via the `--sg-safe-*` variables on `chartPaneElement()`).

## Commands

None writes view state to the data store except through ordinary transactions:

| Command | Payload | Behavior |
|---|---|---|
| `view/rowToggle` | `{ id, expanded? }` | expand/collapse one branch; display state, not undoable |
| `view/rowsInvalidate` | `void` | marks flattening + `rows/height` resolution stale; one `rows` store set |
| `view/dropIndicator` | `{ y, depth } \| null` | 2px insertion line at viewport-local `y`, inset by `depth`; `null` / non-finite hides |
| `view/editStart` | `{ id, columnId? }` | public path into inline edit; omitted `columnId` = first editable column; every unusable argument = no-op |
| `view/rowIndent` | `{ id }` | child of immediately preceding sibling, one `task/update` transaction; first child / unknown = no-op |
| `view/rowOutdent` | `{ id }` | sibling of current parent; root / unknown = no-op |
| `view/rowInsert` | `{ id?, position?, name? }` | one `task/add` transaction; `position` `"above" \| "below" \| "child"` (default `"child"`); dates via `timeline.gridCellAt` with the leaf exception and empty-store rules; name defaults to `messages.newTaskName` |
| `view/expandToLevel` | `{ level }` | rows of depth ≤ level visible; display state; one `rows` store set when anything changed |

Dispatches `task/update` (inline edits, outline editing, field edits) and `task/add` (row insert, templates) — all mutations go through the public data-store commands.

## Events

- Emits the grid input stream: `grid/rowPointerDown` `{ id, row, ctrlKey, metaKey, shiftKey, button, pointerId, x, y, clientX, clientY }`, `grid/rowPointerMove` `{ pointerId, x, y, clientX, clientY, altKey, ctrlKey, metaKey, shiftKey }`, `grid/rowPointerUp` `{ pointerId, x, y, clientX, clientY, cancelled }` (exactly one per press), `grid/rowContextMenu` `{ id, row, x, y }`, `grid/backgroundContextMenu` `{ x, y }`. Exceptions: the expand toggle and presses inside an open inline editor emit nothing.
- There are no `rows/changed` / `grid/columnWidthsChanged` / `grid/sortChanged` events — the `rows.rows`, `grid.columnWidths`, and `grid.sort` stores are the change channels, as specified above.

## Scroll synchronization (normative)

The shared vertical viewport goes through the view plugin's `viewport` store as the **single source of truth**:

- A user scroll originating in the grid pane (the consumed vertical wheel, with `normalizeWheelDelta` unit resolution and the `wheelSpeedFactor()` multiplier) is applied by calling `ViewService.scrollTo({ scrollTop })`. The grid never moves its own vertical offset directly.
- The grid follows chart-side scrolls (and its own, round-tripped) by subscribing to `ViewService.viewport` and repainting its materialized rows from the store value.
- **The `view/scrolled` event is emitted by the view plugin only; this plugin never emits it.** Both panes are held inside the same scrollable range by view's vertical clamp (fed by this plugin's `renderer/contentExtent` contribution), so neither can reach a position the other cannot follow.
- The grid body's **horizontal** offset stays native and private to the grid: it is not published through the viewport store or any event.

## Config

Factory: `treeGrid(config?: TreeGridConfig)`. All fields optional; unusable values silently fall back; resolved once at `setup()`.

```ts
treeGrid({
  messages?, rowHeight?, paneWidth?, indent?, readOnly?, columns?, formatDate?, formatProgress?,
  columnLayout?, cellRenderers?, rowClass?, wbs?, collapsedBadge?, outlineEditing?, collation?,
  taskFields?: { columns?, showStatusOnBars?, showDeadlineWarnings?, showAssigneeAvatars?,
                 detailFields?, durationUnit?, idNumbering?, autoRecordCompletion?, templates? },
  conditionalFormat?: { rules?, priorityColors?, overdue?, progress?, legend?, now? },
})
```

**Nest activation (normative).** The `taskFields` and `conditionalFormat` nests are opt-in: a nest omitted means that whole feature is dormant (no columns, no overlays, no panel section, no style provider effect, no legend). A nest present — even `{}` — enables the feature with the per-field defaults below.

Top level (15 fields):

| Field | Type | Default | Semantics |
|---|---|---|---|
| `messages` | `Partial<TreeGridMessages>` | English defaults | per-key shallow override |
| `rowHeight` | `number` | `28` | default row height (finite, > 0) |
| `paneWidth` | `number` | `580` | grid pane's `initialWidth`; dividers/resize owned by view |
| `indent` | `number` | `16` | per-level inset of the tree column (finite, ≥ 0; saturates on deep trees) |
| `readOnly` | `boolean` | `false` | every composed column behaves as `editable: false` |
| `columns` | `ColumnDef[]` | built-in Name / Start / End / Progress | present = replaces the built-ins (empty array legal: none); unusable entries skipped |
| `formatDate` | `(t: number) => string` | ISO `YYYY-MM-DD` UTC | built-in start/end cells only; called only with finite instants; latched fault barrier |
| `formatProgress` | `(p: number) => string` | `` `${Math.round(p * 100)}%` `` | built-in progress cell; `p` unclamped |
| `columnLayout` | `{ hidden?: string[]; order?: string[] }` | none | display-only hiding/reordering; unknown ids ignored |
| `cellRenderers` | `Record<string, (el, task) => void>` | none | per-column paint override; latched fault barrier, falls back to the column's `render` |
| `rowClass` | `(task) => string \| undefined` | none | extra per-row class tokens; re-evaluated per paint; latched barrier |
| `wbs` | `boolean` | `false` | prepends the read-only WBS code column (id `wbs`, width 70, sortable, `title` = full code; never hosts the tree indentation) |
| `collapsedBadge` | `boolean` | `false` | hidden-descendant count badge after the tree column's content |
| `outlineEditing` | `boolean` | `false` | binds Tab/Shift+Tab to indent/outdent in the pane (with the Escape exit rule) |
| `collation` | `boolean \| { locales?, options? }` | off | `Intl.Collator`-backed `compare` for the built-in name column |

`taskFields` nest (9 fields; its message keys live in the plugin-wide catalog):

| Field | Type | Default | Semantics |
|---|---|---|---|
| `columns` | `readonly TaskFieldsColumnId[]` | `["status", "priority", "deadline"]` | which of the 9 field columns to contribute (`id`, `status`, `priority`, `tags`, `assignees`, `deadline`, `actualStart`, `actualEnd`, `duration`), in order; `[]` = none |
| `showStatusOnBars` | `boolean` | `true` | status glyph inside each bar's left end |
| `showDeadlineWarnings` | `boolean` | `true` | warning triangle right of an overdue task's bar (outside the resolved end gutter) |
| `showAssigneeAvatars` | `boolean` | `true` | up to three assignee initials after the bar + `+n` |
| `detailFields` | `boolean` | `true` | contribute the editing section to `sidepanel/fields` |
| `durationUnit` | `"days" \| "hours" \| "weeks"` | `"days"` | duration column unit (`d`/`h`/`w` suffixes accepted on edit) |
| `idNumbering` | `{ prefix?, start?, minDigits? }` | `{ prefix: "", start: 1, minDigits: 1 }` | automatic sequence-ID shape; a stored `customId` always wins |
| `autoRecordCompletion` | `boolean` | `true` | status → `done` auto-stamps `actualEnd` inside the same transaction (`data/willApplyTransaction` append path) |
| `templates` | `Readonly<Record<string, TaskTemplate>>` | `{}` | named field/name/duration bundles; the application path is the context-menu template insert flow (see interaction.md) |

`conditionalFormat` nest (6 fields; its message keys live in the plugin-wide catalog):

| Field | Type | Default | Semantics |
|---|---|---|---|
| `rules` | `ConditionalFormatRule[]` | `[]` | first matching rule wins; malformed conditions evaluate `false`; unusable entries dropped |
| `priorityColors` | `Record<string, string>` | `{}` | `task.meta.priority` → color |
| `overdue` | `boolean \| OverdueOptions` | off | when on: bar color default `"#c53030"`, `icon` default `true` (with the midnight repaint timer) |
| `progress` | `boolean \| ProgressStatusColors` | off | status wash over the progress portion; defaults `behind: "rgba(197, 48, 48, 0.35)"`, `onTrack: "var(--sg-bar-fill, #0f766e)"`, `complete: "rgba(47, 133, 90, 0.35)"`; clipped to the bar's rounded outline |
| `legend` | `boolean` | `false` | mounts `.sg-cf-legend` in the claimed bottom-right corner slot; entries derive at config time |
| `now` | `() => number` | `Date.now` | clock for overdue / expected-progress checks (tests) |

Every color may be a literal or a theme-token reference (`"--sg-x"` / `"var(--sg-x, fallback)"`), resolved at draw time through `stargantt.theme`; an unresolvable color applies no color and reports one `core/pluginError` per distinct offending string, latched.

## Messages

`TreeGridMessages` — one merged catalog of **40 keys** covering the grid, the task-fields feature, and the conditional-format feature. Two related-key notes: `newTaskName` is the `view/rowInsert` default task name, while the template-driven insert's fallback name is the separate key `templateTaskName`; and the single key `noneOption` (default `"—"`) serves both the task-fields panel selects and the custom-field select-column editor (see data-store.md).

| Key | Default | Origin / where |
|---|---|---|
| `nameColumn` | `"Name"` | tree-grid — built-in column header |
| `startColumn` | `"Start"` | tree-grid — built-in column header |
| `endColumn` | `"End"` | tree-grid — built-in column header |
| `progressColumn` | `"Progress"` | tree-grid — built-in column header |
| `wbsColumn` | `"WBS"` | tree-grid — WBS column header |
| `newTaskName` | `"New task"` | tree-grid — `view/rowInsert` default task name |
| `paneResizeLabel` | `"Resize pane"` | tree-grid — grid-pane divider accessible name (blank falls back) |
| `idColumn` | `"ID"` | task-fields — column header |
| `statusColumn` | `"Status"` | task-fields — column header |
| `priorityColumn` | `"Priority"` | task-fields — column header |
| `tagsColumn` | `"Tags"` | task-fields — column header |
| `assigneesColumn` | `"Assignees"` | task-fields — column header |
| `deadlineColumn` | `"Deadline"` | task-fields — column header |
| `actualStartColumn` | `"Actual start"` | task-fields — column header |
| `actualEndColumn` | `"Actual end"` | task-fields — column header |
| `durationColumn` | `"Duration"` | task-fields — column header |
| `statusNotStarted` | `"Not started"` | task-fields — status label |
| `statusInProgress` | `"In progress"` | task-fields — status label |
| `statusDone` | `"Done"` | task-fields — status label |
| `statusOnHold` | `"On hold"` | task-fields — status label |
| `priorityHigh` | `"High"` | task-fields — priority label |
| `priorityMedium` | `"Medium"` | task-fields — priority label |
| `priorityLow` | `"Low"` | task-fields — priority label |
| `fieldsSection` | `"Task fields"` | task-fields — panel section heading |
| `statusLabel` | `"Status"` | task-fields — panel field label |
| `priorityLabel` | `"Priority"` | task-fields — panel field label |
| `tagsLabel` | `"Tags"` | task-fields — panel field label |
| `tagsPlaceholder` | `"tag1, tag2"` | task-fields — panel placeholder |
| `deadlineLabel` | `"Deadline"` | task-fields — panel field label |
| `actualStartLabel` | `"Actual start"` | task-fields — panel field label |
| `actualEndLabel` | `"Actual end"` | task-fields — panel field label |
| `notesLabel` | `"Notes"` | task-fields — panel field label |
| `notesPlaceholder` | `"Add a note"` | task-fields — panel placeholder |
| `noneOption` | `"—"` | task-fields + custom fields — "no value" option of panel selects and the select-column editor |
| `templateTaskName` | `"New task"` | task-fields — template-insert fallback name |
| `legendOverdue` | `"Overdue"` | conditional-format — legend entry |
| `legendPriority` | builder `(arg: { priority: string }) => string`; default output `Priority <priority>` | conditional-format — legend entry **builder** (the catalog's only builder; latched containment on throw, per-build) |
| `legendProgressBehind` | `"Behind schedule"` | conditional-format — legend entry |
| `legendProgressOnTrack` | `"On track"` | conditional-format — legend entry |
| `legendProgressComplete` | `"Complete"` | conditional-format — legend entry |

All keys resolved once at `setup()` by per-key shallow override. Rule `legend` labels, field labels/options supplied by the host, and cell contents (ISO dates, percentages) are data/formatting, not catalog members.

## Internal modules

| Directory | Files | Content |
|---|---|---|
| root + `internal/` (24) | `index`, `types`, `internal/{column-order, column-track, column-view, columns, dom-walk, dom, edit-session, editors, fenwick, frame-throttle, grid-body, grid-header, grid-scroll, height-watch, outline, overflow-cue, pane, row-model, tokens, tree-column, value-diff, wbs}` | pane, virtualized body/header, row model + Fenwick tree, edit sessions, bundled editors, sorting, WBS, outline commands, overflow cue |
| `internal/task-fields/` (10) | `index`, `types`, `{auto-complete, columns, duration, fields, overlays, panel, sequence, templates}` | field storage/validation, the 9 columns, bar overlays, side-panel section, sequence IDs, templates, completion auto-record (message keys resolve through the plugin-wide catalog) |
| `internal/upward.ts` | typing shim for upward extension-point contributions: `taskbars/*` contribution types come via type-only imports from `@stargantt/plugin-task-bars` (devDependency; the type-only-import exemption of architecture ch. 5); the `sidepanel/fields` shape is declared structurally (the point owner is the interaction plugin; the contribution is buffered when it is absent) |
| `internal/messages.ts` | the 40-key consolidated catalog + resolver, extracted from `index.ts` to keep it under the 800-line cap |
| `internal/conditional-format/` (8) | `index`, `types`, `{color, conditions, config, legend, overlay, style}` | condition engine, color resolution + latches, style provider, overlay renderer, legend |
| `internal/custom-fields-columns.ts` (1) | `custom-fields-columns` | builds one `ColumnDef` per resolved field (via the consumed `stargantt.fields` service), ids `customfields-<key>`, with the per-type cell/edit/sort table |

## Dependencies

hard: `data`, `view` (services `stargantt.data`, `stargantt.view`, `stargantt.timeline` for insert dating, `stargantt.theme` for tokens). optional: `fields` (the custom-field column supply: this plugin builds the columns from `FieldsService.definitions()` and writes through `setValue`).

## Third-party surface

- **Consumable services:** `stargantt.rows` (`RowsService`) and `stargantt.grid` (`GridService`) — row geometry, expansion state, the row-set store, column-width / sort stores, selection/focus reflection (`setSelected` / `setFocused`).
- **Contributable extension points (merge strategy + contribution type):** `grid/columns` (collect, `ColumnDef` — third parties add grid columns with full editing/sorting/resize behavior; remains a public collect point even though the task-fields and custom-fields columns are internalized), `rows/height` (reduce, `RowHeightContribution` — override per-task row heights; resolving 0 hides the row geometrically). This plugin's `renderer/rowGeometry` contribution does not close that point either: it is a `first`-strategy point owned by view, and a composition using a third-party row model instead of this plugin contributes its own `RowGeometryProvider` there on equal terms.
- **Subscribable events:** the `grid/*` input stream — `grid/rowPointerDown` / `grid/rowPointerMove` / `grid/rowPointerUp` (3) plus `grid/rowContextMenu` and `grid/backgroundContextMenu` (2).
- **Commands:** the eight row-related `view/*` commands listed above are publicly emittable.
- **Reserved namespaces (documentation convention only):** the `grid/` and `rows/` event and extension-point namespaces; the `stargantt.rows` / `stargantt.grid` service IDs; the claimed `task.meta` key `taskFields` and the `overlay-corner` slot `bottom-right` (legend). Not enforced in core.
