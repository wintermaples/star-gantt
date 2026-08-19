# Plugin: interaction (`stargantt.interaction`)

Package: `@stargantt/plugin-interaction` — Layer 5.
Status: normative. Design note: interaction is deliberately ONE package with internal feature directories, not a family of plugins.

## Purpose

All pointer and keyboard interaction: selection (single / multi / rubber-band / delete confirmation), drag-and-drop editing (bar move / resize / progress / row D&D / lane D&D), snapping (rounding / working days / alignment / successor push), tooltips, context menu, zoom UI, clipboard, filter/search, edit dialog, side panel.

Core design — **unified pointer state machine**: rather than each feature (selection, drag editing, tooltip, context menu) subscribing to the `pointer/*` events individually and competing with the others, all pointer interpretation is concentrated in a single internal gesture arbiter (`internal/gesture/arbiter.ts`). Click / drag-start / hover interpretation is decided in one place and dispatched internally to each feature module. Of the drag → snap → scheduler 3-stage chain, the first two stages are internalized.

## 1. Gesture arbiter state machine (normative)

### 1.1 Constants

| Constant | Value |
|---|---|
| Drag-start threshold | `Math.hypot(dx, dy) > 3` CSS px (`DRAG_THRESHOLD_PX = 3`) |
| Deferred-collapse slop | 3 CSS px (`COLLAPSE_SLOP_PX = 3`, same metric) |
| Cancelled capture | a `pointer/barUp` whose raw `event.type === "pointercancel"` |
| Auto-scroll edge zone | 32 px (`AUTO_SCROLL_ZONE_PX`), max 20 px/frame (`AUTO_SCROLL_MAX_PX`) |
| Drag-tooltip gap | 8 px above the dragged bar (`DRAG_TOOLTIP_GAP_PX`) |
| Keyboard progress step | 0.1 (`PROGRESS_STEP`), clamped 0..1, rounded to 1e-10 |
| Double-activation window (edit dialog) | two presses of the same task ≤ 400 ms apart, no selection modifier |
| Menu press | secondary button, or Ctrl + primary button |

Pointer-identity rule: only the pointer that started a gesture may advance or finish it; events from any other `pointerId` are ignored by that gesture. A move with `buttons === 0` abandons the gesture (a release lost outside the window).

Gesture-scoped coalescing: the **date and progress drag paths** stamp a per-gesture `coalesceKey` (minted at press time from a random module nonce + counter, never derived from the task) on every `task/move` / `task/setProgress` command they dispatch, so history merges the whole drag into one undo entry while two drags of the same task stay two entries. A row drop's `task/update` carries NO coalesce key (one drop = one entry; the payload has no such field), and the click-move placement deliberately carries none either (one click is one edit and one undo entry).

### 1.2 States (9)

| State | Meaning |
|---|---|
| `idle` | No gesture, no hover candidate, no menu. |
| `hover` | Pointer resting over a bar; tooltip hover machinery armed (only under `tooltip.trigger` `"hover"`/`"both"`). |
| `pressing` | A press recorded, threshold not yet exceeded. Carries the press surface (bar body / handle / progress strip / grid row), the armed drag gesture (if the press is editable: non-summary task, hit kind `bar`/`handle`/`progress`), and selection's deferred-collapse bookkeeping. |
| `dragging-bar` | A date gesture (`move` / `resize-start` / `resize-end`, the mode follows which handle was grabbed; a middle tie resolves to start) or a progress gesture, past the threshold. |
| `dragging-row` | A vertical row drag (reorder / re-parent), from either surface. |
| `dragging-lane` | A vertical resource-lane drag (reassignment through the composed `drag/lanes` provider — §3). Unreachable in a composition with no `drag/lanes` contribution. |
| `rubber-band` | A background drag painting a selection rectangle (`"multi"` mode only). |
| `link-drag` | Reserved — no input can enter this state. The dependency port/link gestures are the scheduling plugin's own gesture session over the public input stream (scheduling.md §4.3); this state exists as the seam for a possible future internalization. A `pointer/barDown` whose hit kind is `"link"`, a port kind, or any other kind outside `bar`/`handle`/`progress` starts no arbiter gesture and is only offered to selection/tooltip/context-menu per their own hit-kind filters. |
| `context` | The context menu is open (chart pane or grid pane mount). |

### 1.3 Transition tables — every state × input

Inputs are the 10 input-stream events: `pointer/barHover`, `pointer/barDown`, `pointer/barMove`, `pointer/barUp`, `pointer/background`, `grid/rowPointerDown`, `grid/rowPointerMove`, `grid/rowPointerUp`, `grid/rowContextMenu`, `grid/backgroundContextMenu`. "Notified" names the internal feature module(s) the arbiter dispatches to. A cell marked **ignored** is explicitly a no-op. Escape (a keyboard event, outside the pointer family) is listed per state after the tables.

#### `idle`

| Input | Transition | Notified / effect |
|---|---|---|
| `pointer/barHover` | → `hover` | tooltip (hover trigger: arm show timer, `showDelay`; same-bar samples never re-arm) |
| `pointer/barDown` | menu press → `context`; else primary press → `pressing` | context-menu (menu press: open at hit; otherwise: close — no-op here). selection (hit kind `"bar"` only: immediate replace, Ctrl/Cmd toggle, Shift range from anchor; unmodified press inside a multi-selection defers the collapse). drag (arm gesture for `bar`/`handle`/`progress` hits on a non-summary task the store knows; summaries never start a gesture). tooltip (click trigger: show for the hit). edit-dialog (double-activation counting). |
| `pointer/barMove` | ignored | (not emitted outside a renderer-owned gesture) |
| `pointer/barUp` | ignored | |
| `pointer/background` | menu press → `context`; else `"multi"` mode → `rubber-band`; else → `idle` | context-menu (menu press: open with background target). selection (`"multi"`: rubber-band `begin(x, y)`; also drops any pending deferred collapse). drag (click-move: a press on empty chart space while a task is picked up places it — `task/move` to the clicked instant, duration kept, snapped unless Alt, one undo entry, no `coalesceKey`, pick-up forgotten; a picked-up task that is unknown to the store or has become a summary places nothing). tooltip (suppress). Note: the click-move placement and the rubber-band begin are not exclusive — in `"multi"` mode with an armed pick-up both happen on the same press. |
| `grid/rowPointerDown` | → `pressing` (grid surface) | selection (press semantics identical to a bar-body press; a grid-row press additionally reveals the task's bar when `revealSelected` is on). drag (row-drag press armed when `dragEdit.rowDrag` is on, `button === 0`, and no gesture is running). edit-dialog (double-activation counting). |
| `grid/rowPointerMove` | ignored | (no armed press) |
| `grid/rowPointerUp` | ignored | |
| `grid/rowContextMenu` | → `context` | context-menu (open at row target, mounted in the grid pane; no opening press event) |
| `grid/backgroundContextMenu` | → `context` | context-menu (open with grid-background target — the blank area below the last row) |

Escape in `idle`: selection's opt-in `clearOnEscape` shortcut clears a non-empty selection; drag's click-move pick-up (if armed) is forgotten; a visible tooltip is hidden and the dismissal sticks to its tracked target (see §6.4a). State stays `idle`.

#### `hover`

| Input | Transition | Notified / effect |
|---|---|---|
| `pointer/barHover` | → `hover` | tooltip (same bar: no re-arm; different bar: retarget, timers per `showDelay`/`hideDelay`; leaving all bars returns to `idle` when the hide delay elapses) |
| `pointer/barDown` | as `idle` (menu press → `context`, else → `pressing`) | as `idle`; tooltip additionally records the press as a hover dismissal for that bar — only leaving the bar or a fresh `pointer/barDown` lifts it |
| `pointer/barMove` | → `idle` | tooltip (suppress — defensive; the renderer emits `barMove` only during a gesture) |
| `pointer/barUp` | ignored | |
| `pointer/background` | as `idle` | as `idle`; tooltip suppressed |
| `grid/rowPointerDown` | as `idle` → `pressing` (grid surface) | as `idle` |
| `grid/rowPointerMove` | ignored | |
| `grid/rowPointerUp` | ignored | |
| `grid/rowContextMenu` | → `context` | as `idle` |
| `grid/backgroundContextMenu` | → `context` | as `idle` |

Escape in `hover`: as `idle` — in particular the tooltip dismissal sticks to the hovered bar, so continued hovering does not re-show it (§6.4a).

#### `pressing`

| Input | Transition | Notified / effect |
|---|---|---|
| `pointer/barHover` | ignored | (the renderer suppresses hover sampling while it owns a capture) |
| `pointer/barDown` | ignored | (a gesture is already armed) |
| `pointer/barMove` | `buttons === 0` → `idle` (abandon). ≤ 3 px → `pressing` (hold). > 3 px, bar surface: body-move press with vertical component strictly dominant (`|dy| > |dx|`) and the task has its own row — `resourceDrag` on and the composed `drag/lanes` provider resolves a lane for the bar → `dragging-lane`; else `rowDrag` on → `dragging-row`; otherwise (handle, progress, horizontal dominance, in-row child of a `collapsedSummary: "split"` parent) → `dragging-bar` | drag (axis decision, first proposal). selection (deferred collapse discarded past the slop — a drag never collapses the selection it started from). tooltip (suppress). |
| `pointer/barUp` | → `idle` | Click resolution. selection (deferred collapse applies only on a release in place — same pointer, ≤ 3 px, not a cancelled capture; every other ending drops it). drag (click-move: a body press released without dragging and not cancelled arms the pick-up; a release on a different task disarms a surviving pick-up). edit-dialog (no counting here — activations are counted on the presses (the two downs); the second press of the same task within 400 ms already dispatched `edit-dialog/open` at `pointer/barDown`). |
| `pointer/background` | ignored | (cannot occur — the renderer's capture routes the whole press stream through `pointer/barMove`/`barUp`) |
| `grid/rowPointerDown` | ignored | (non-primary buttons never arm; a second pointer never arms) |
| `grid/rowPointerMove` | grid surface, same pointer, > 3 px in **any** direction (no dominance test — the grid has no horizontal date edit to compete with), the store knows the pressed task (`getTask(press.id) !== undefined`), and the task has its own row → `dragging-row`; else `pressing` | drag (starts the row gesture, immediately proposes the drop gap) |
| `grid/rowPointerUp` | → `idle` (grid surface press cleared) | No feature acts here (selection already applied at down; double-activation counted at down — `grid/rowPointerUp` carries no task id, so release-side counting is not expressible). |
| `grid/rowContextMenu` | → `context` | context-menu (the press bookkeeping of this state is dropped) |
| `grid/backgroundContextMenu` | → `context` | context-menu (same) |

Escape in `pressing`: → `idle`. The armed gesture, a pending grid press, a deferred collapse, and a click-move pick-up are all dropped; nothing is dispatched.

#### `dragging-bar`

| Input | Transition | Notified / effect |
|---|---|---|
| `pointer/barHover` | ignored | (not emitted during a gesture) |
| `pointer/barDown` | ignored | |
| `pointer/barMove` | same pointer: → `dragging-bar` (`buttons === 0` → `idle`, abandon — nothing further is dispatched and nothing is reverted: live dispatches stand as dispatched, exactly as on Escape); other pointer: ignored | drag — per move (frame-coalesced when `frameSync`): date proposal = origin displaced by the client-x delta in ms; unsnapped range drives the ghost, snapped range is the commit target; Alt held bypasses the snap service for that move; `minDuration` clamps resizes (floor never wider than the task's own duration); `liveUpdate` dispatches the snapped proposal per move under the gesture's `coalesceKey`; progress gesture: fraction from pointer x inside the bar, clamped 0..1, painted nothing — `liveUpdate` commits per move. Auto-scroll (edge zone sets a per-frame velocity; scrolling shifts the press origin so the delta arithmetic covers it). Drag tooltip (commit dates, anchored above the bar). Dependency preview (direct successors outlined, displaced by the same delta). Origin extension held for the drag (`renderer/contentExtent` reports the unsnapped reach). Overlay repaint every move. |
| `pointer/barUp` | same pointer: → `idle`; other pointer: ignored | drag — cancelled capture: abandon (nothing committed, machinery settled, pick-up disarmed). Release: progress → `task/setProgress` commit of the final fraction; date → commit of the release move's snapped proposal (skipped when equal to what this gesture already dispatched); multi-drag peers move by the same committed displacement in the same transaction key; committed bar revealed. All per-drag machinery settled (auto-scroll stops, drag tooltip hides, preview cleared, drop indicator cleared, origin hold released). |
| `pointer/background` | ignored | (cannot occur during the capture) |
| `grid/rowPointerDown` | ignored | (a running gesture owns the pointer) |
| `grid/rowPointerMove` | ignored | (not a row gesture) |
| `grid/rowPointerUp` | ignored | |
| `grid/rowContextMenu` | ignored | (the grid pane cannot press while the chart pane holds the capture) |
| `grid/backgroundContextMenu` | ignored | |

Escape in `dragging-bar`: → `idle`. The drag is abandoned; the task keeps whatever the store holds (live dispatches stand as dispatched; the undo entry the gesture opened reverts them), the ghost is repainted away, machinery settled.

#### `dragging-row`

| Input | Transition | Notified / effect |
|---|---|---|
| `pointer/barHover` | ignored | |
| `pointer/barDown` | ignored | |
| `pointer/barMove` | bar-originated row drag, same pointer: → `dragging-row` (`buttons === 0` → `idle`, abandon); other pointer: ignored | drag (row module): the pointer's y names a drop gap between rows; `view/dropIndicator { y, depth }` marks it (2 px insertion line, depth-inset); a gap the plan refuses — the task's own gap, a descendant of the dragged branch, unusable keys — shows no mark. Horizontal client-x movement asks for a re-parent (depth change) at the same gap. |
| `pointer/barUp` | same pointer: → `idle`; other: ignored | drag: cancelled capture → abandon (indicator cleared, nothing written). Release: `commitRowDrop` — one transaction writing the new sibling position and, when the gap belongs to one, the new parent; a refused drop commits nothing. Indicator always cleared. |
| `pointer/background` | ignored | |
| `grid/rowPointerDown` | ignored | |
| `grid/rowPointerMove` | grid-originated row drag, same pointer: → `dragging-row`; other: ignored | drag (same row module — `updateRowDrop` on the shared state machine) |
| `grid/rowPointerUp` | grid-originated, same pointer: → `idle`; other: ignored | drag: `e.cancelled` → abandon; else `commitRowDrop` at the release position. Indicator cleared either way. |
| `grid/rowContextMenu` | ignored | (the capture owns the pointer) |
| `grid/backgroundContextMenu` | ignored | |

Escape in `dragging-row`: → `idle`. Abandon: indicator cleared, nothing written; a grid press that had not yet become a drag is also dropped so it cannot turn into one after Escape.

#### `dragging-lane`

| Input | Transition | Notified / effect |
|---|---|---|
| `pointer/barHover` | ignored | |
| `pointer/barDown` | ignored | |
| `pointer/barMove` | same pointer: → `dragging-lane` (`buttons === 0` → `idle`, abandon); other: ignored | drag (lane module): the composed `drag/lanes` provider is asked which lane the root-relative y falls in (`laneAt(y)`); the provider marks that lane as the drop target via `highlightLane` (source lane and no-lane show no mark; a provider without the member drives the drag unmarked). |
| `pointer/barUp` | same pointer: → `idle`; other: ignored | drag: cancelled capture → abandon (lane mark cleared, nothing written). Release: a drop on another resource's lane reassigns the task through the provider's own write path (`reassign(id, from, to)` — the provider owns how the change is recorded and undone); a drop on no lane or the source lane commits nothing. Mark always cleared. |
| `pointer/background` | ignored | |
| `grid/rowPointerDown` | ignored | |
| `grid/rowPointerMove` | ignored | |
| `grid/rowPointerUp` | ignored | |
| `grid/rowContextMenu` | ignored | |
| `grid/backgroundContextMenu` | ignored | |

Escape in `dragging-lane`: → `idle`. Abandon: lane mark cleared, nothing written.

#### `rubber-band`

| Input | Transition | Notified / effect |
|---|---|---|
| `pointer/barHover` | ignored | |
| `pointer/barDown` | ignored | (cannot occur during the capture) |
| `pointer/barMove` | no hit: → `rubber-band`; with a hit: ignored (not the background-started gesture) | selection (rectangle extended to `(x, y)`, overlay repaint each move) |
| `pointer/barUp` | no hit: → `idle`; with a hit: ignored | selection: cancelled capture → abandon (rectangle disappears, selection untouched). Release: the rectangle finalizes on the up event's own coordinates; every visible bar it intersects is caught, in row order; Ctrl/Cmd on the release makes the result additive (union with the current selection), otherwise it replaces. |
| `pointer/background` | ignored | (cannot occur mid-gesture) |
| `grid/rowPointerDown` | ignored | |
| `grid/rowPointerMove` | ignored | |
| `grid/rowPointerUp` | ignored | |
| `grid/rowContextMenu` | ignored | |
| `grid/backgroundContextMenu` | ignored | |

Escape in `rubber-band`: → `idle`. Abandons exactly as a cancelled capture: rectangle disappears, selection untouched; the eventual `pointer/barUp` finds no gesture and is a no-op.

#### `link-drag` (reserved)

Every input is unreachable in this state — nothing can enter it (see the state table above). The state exists in the arbiter's type so the dependency port/link gestures could later be internalized without re-shaping the machine; today, port/link hit kinds fall through the arbiter as in `idle`'s `pointer/barDown` row and are handled by the scheduling plugin's own gesture session (scheduling.md §4.3).

#### `context` (menu open)

| Input | Transition | Notified / effect |
|---|---|---|
| `pointer/barHover` | ignored | (hover never closes an open menu) |
| `pointer/barDown` | close, then process as from `idle`: menu press → `context` (re-open at the new hit); else → `pressing` | context-menu (close, optionally re-open); then the `idle` row's selection/drag/tooltip/edit-dialog dispatches |
| `pointer/barMove` | → `idle` | context-menu (close — the anchor is about to move under the menu) |
| `pointer/barUp` | ignored | |
| `pointer/background` | close, then process as from `idle`: menu press → `context` (re-open, background target); else `"multi"` → `rubber-band`, else → `idle` | context-menu (close, optionally re-open); then the `idle` row's dispatches |
| `grid/rowPointerDown` | → `context` (menu stays open — the context menu does not consume this event; the menu widget's own document-level outside-press listener is what closes it when the press lands outside the menu, after which the machine is effectively in the `idle` handling of that press) | selection / drag / edit-dialog as in `idle` |
| `grid/rowPointerMove` | ignored | |
| `grid/rowPointerUp` | ignored | |
| `grid/rowContextMenu` | close → `context` (re-open at the row, grid-pane mount) | contextMenu |
| `grid/backgroundContextMenu` | close → `context` (re-open, grid-background target) | contextMenu |

Additional `context` exits (not input-stream events): `view/scrolled` closes (viewport-local anchor invalidated); a data change (a `data` store notification) closes and drops a pending link source whose task no longer exists; the menu widget itself closes on Escape, on activation of an entry (entry `run` fires after the close), on an outside press (document-level `pointerdown`), and on focus leaving the menu. Menu keyboard handling (roving arrows, Home/End, Enter/Space, Escape) is the menu widget's own and marks its keydowns `defaultPrevented`, which keeps the a11y plugin's `keys/bindings` dispatcher away (the claimed-stroke guard, a11y.md).

## 2. Services

### 2.1 `stargantt.selection` → `SelectionService`

Store-shaped. Effective-change rule: the store is set when the resulting `taskIds` set **or** the `anchor` differs from the current state; the chart repaint and grid re-mark run only when the id set moved (nothing rendered depends on the anchor). Because the state carries the anchor as an observable component, an anchor-only press (e.g. an unmodified press on an already-selected task establishing a new Shift-range origin) publishes too; subscribers never observe a stale anchor. A press that changes neither component publishes nothing.

```ts
export interface SelectionState {
  /** Snapshot set of the selected task ids. */
  readonly taskIds: ReadonlySet<TaskId>;
  /** The anchor row of Shift-range extension: the task of the most recent
   *  non-Shift press or Ctrl/Cmd toggle. Programmatic select()/toggle()/clear()
   *  leave it unchanged (only press paths move the anchor). */
  readonly anchor?: TaskId;
}

export interface SelectionService {
  readonly state: Store<SelectionState>;
  /** Replaces the selection with exactly the given ids. Duplicates ignored;
   *  an empty list is equivalent to clear(). When `selection.revealSelected`
   *  is on, reveals the first id's bar. */
  select(ids: readonly TaskId[]): void;
  /** Toggles one task's membership, leaving the rest untouched — the
   *  programmatic twin of Ctrl-click / Ctrl+Space. */
  toggle(id: TaskId): void;
  /** Deselects everything. */
  clear(): void;
  /** Scrolls the chart horizontally by the minimum amount that brings the
   *  task's bar on screen (already-visible bars never move
   *  the chart; small edge gap; a bar too wide to fit shows its start;
   *  vertical position untouched). Works regardless of `revealSelected` —
   *  see the design note below. */
  reveal(id: TaskId): void;
  /** The configured selection mode; never changes over the instance lifetime. */
  mode(): "single" | "multi" | "none";
  /** Confirmation-gated bulk delete of the current selection: built-in dialog
   *  or the `confirmDelete` hook; one `task/remove` transaction for the whole
   *  set (single undo); no-op while empty, while a confirmation is in flight,
   *  or without a data store. */
  deleteSelected(): void;
}
```

Design notes: the selected set is read as `state.get().taskIds`; `toggle` and `reveal` are conveniences over existing behavior (Ctrl-click toggling; the reveal path), and `anchor` is exposed read-only in the state.

**Design note: `reveal()` is ungated.** `revealSelected` governs only the AUTOMATIC reveals (the grid-row press path and the `select()` path); the direct `reveal(id)` call works regardless of the config — an explicit request outranks a default-behavior switch.

### 2.2 `stargantt.snap` → `SnapService`

Pure-function service (no store — the rule is configuration, not state). Consumed by the internal drag/click-move/keyboard-edit paths and by the scheduling plugin.

```ts
export interface SnapService {
  /** Rounds an instant to the nearest boundary of the unit in effect.
   *  Halfway rounds to the later boundary; returns the instant unchanged when
   *  nothing is being rounded (e.g. a zoom level with no header rows) and for
   *  a non-finite instant. */
  snap(t: number): number;
  /** How far one keyboard step from `t` moves, in ms, signed. Forwards: the
   *  length of the unit containing `t`; backwards: minus the length of the
   *  unit before it (step forward + back returns to the boundary). Months and
   *  years are measured against `t`. Falls back to one UTC day when nothing
   *  is being rounded. */
  step(t: number, direction: 1 | -1): number;
}
```

Rule-application pipeline: an in-tolerance task-edge alignment (when `alignToTasks` is on) replaces the rounding rule entirely for that instant; otherwise the base rounding of the configured unit (or the custom `rule`) applies; the working-time adjustment (when `workingDays` is on) runs LAST, so its answer is final. Working-time probes come from the interaction-owned `snap/workingTime` extension point (§3) — the dependency inversion that keeps this plugin free of any upward calendar-service edge; the boundary-selection arithmetic (in-place acceptance including the exclusive-end clause, nearest-boundary move, forward tie, give-up-in-place for all-non-working calendars) stays in this plugin.

`pushSuccessors` (when on): on `data/willApplyTransaction`, for a transaction whose `origin === "user"` only, the push-out pass computes the forward pushes the edit forces on dependent tasks (FS/SS/FF/SF lower bounds, deficit-exact moves, duration preserved, cascade bounded by the 1000-per-task re-push cap, projection via the data-store's public `mergeTaskUpdate`) and APPENDS the extra patches to the same transaction — one atomic apply, one undo entry, no separate commands. The stand-down check is the `snap/pushGuards` extension point (§3): the pass stands down while any composed guard suppresses it, and runs when none is contributed.

The `snap` nest is enabled when omitted (§6 presence semantics); the unsnapped behavior (drags commit unrounded, keyboard steps fall back to one UTC day) is reached only with an explicit `snap: { enabled: false }`, or when the active zoom level defines no scale rows to round against.

### 2.3 `stargantt.filter` → `FilterService`

Store-shaped. The service ID is `stargantt.filter` (architecture.md ch. 4.1: `selection`, `snap`, and `filter` are provided by interaction).

```ts
export interface FilterState {
  /** The incremental search text ("" when none). */
  readonly query: string;
  /** The structured criteria, or null when none. */
  readonly criteria: Readonly<FilterCriteria> | null;
  /** Whether any filtering is in effect. */
  readonly active: boolean;
  /** Number of matching tasks. */
  readonly matchCount: number;
}

export interface FilterService {
  readonly state: Store<FilterState>;
  setQuery(text: string): void;
  setCriteria(criteria: FilterCriteria | null): void;
  /** Clears query and criteria in one step. */
  clear(): void;
  /** Whether the task passes the current filter (true when inactive). */
  isTaskVisible(id: TaskId): boolean;
  /** Named views (in-memory, not persisted). */
  saveView(name: string): void;
  applyView(name: string): boolean;
  deleteView(name: string): boolean;
  viewNames(): string[];
}
```

Design note: the four state readers (`query`, `criteria`, `active`, `matchCount`) are members of the `state` value, not methods. Public types: `FilterCriteria` (`text`, `resources`, `types`, `progressMin`, `progressMax`, `startFrom`, `startTo`, `endFrom`, `endTo`, `fields`, `predicate`), `FilterView`, and `FilterFieldDef` (`id`, `label`, `value(task)`). Row hiding stays entirely public: matching is applied through the `rows/height` contribution (a hidden row's height overrides to 0) plus `view/rowsInvalidate`.

### 2.4 Deliberate non-services

There is no clipboard service and no zoom-controls service. Clipboard operations are the `clipboard/*` commands; zoom stepping goes through the view plugin's `timeline/zoomIn` / `timeline/zoomOut` commands and the `stargantt.timeline` service (the toolbar's fit / today / selection jumps are internal).

## 3. Extension points

### Defined by this plugin

| Point | Strategy | Contribution type | Semantics |
|---|---|---|---|
| `tooltip/content` | first | `TooltipContentProvider = (hit: Readonly<HitResult>) => TooltipContent \| undefined` where `TooltipContent = string \| HTMLElement` | First non-`undefined` answer wins; the config `tooltip.content` provider is the fallback consulted only when the composed point declines. |
| `contextmenu/items` | collect | `ContextMenuItemProvider = (target: Readonly<ContextMenuTarget>) => readonly ContextMenuItem[] \| undefined` | Contributed entries appear after the built-in (or config-replaced) entries. `ContextMenuItem = { id: string; label: string; disabled?: boolean; separatorBefore?: boolean; run(target): void }` (the menu closes before `run`). `ContextMenuTarget` is the union: `{ kind: "hit"; hitKind: string; id: string \| number; x; y }` (hit kinds `"bar"` / `"handle"` / `"link"` / third-party, plus `"row"` for grid rows), `{ kind: "background"; x; y }`, `{ kind: "gridBackground"; x; y }`. |
| `sidepanel/fields` | collect | `SidePanelFieldContribution = { id: string; mount(host: HTMLElement): SidePanelFieldHandle \| void }`, `SidePanelFieldHandle = { update(selectedTasks: readonly Readonly<Task>[]): void }` | Read exactly once, when the pane mounts on `lifecycle/ready`; later contributions are never mounted. Sections stay in the DOM for every selection state; `update` runs on every panel refresh. tree-grid's `taskFields.detailFields` section contributes here, typing its contribution structurally or via `import type` from `@stargantt/plugin-interaction` (devDependency, the type-only exemption of architecture ch. 5). |
| `snap/workingTime` | first | `WorkingTimeProvider` (below) | The working-time authority for `snap.workingDays` — the ch. 5-sanctioned dependency inversion. The official contributor is the scheduling plugin (scheduling.md §4.1). First registered contribution wins; with none, `workingDays` is inert and dates pass through unchanged. |
| `snap/pushGuards` | collect | `PushGuard = () => boolean` | Stand-down predicates for the `pushSuccessors` pass, OR-combined: the pass stands down while ANY guard returns `true` — order-independent, hence deterministic. The official contributor is the scheduling plugin (a guard reporting whether its propagation is on — scheduling.md §4.2). No contributions → the pass runs. A throwing guard is reported (`core/pluginError`) and treated as `true` — STAND DOWN (conservative reading: a reconciler that cannot be interrogated is assumed to be propagating, so the pass never races it). Design note (a consequence of the dependency inversion): the ONLY stand-down channel is a `pushGuards` contribution — a composed third-party scheduler that contributes no guard is treated as non-propagating and the push-out pass runs. The official scheduling plugin contributes its guard unconditionally, so official compositions are unaffected. |
| `drag/lanes` | first | `LaneDragProvider` (below) | The lane-drag resolution seam. The official contributor is the resource plugin (resource.md §4.2). First registered contribution wins; with none, `dragEdit.resourceDrag` behaves as off and `dragging-lane` is never entered. |

Contribution types of the two provider points (normative — shaped to carry exactly what the consuming paths need):

```ts
/** snap/workingTime — the three working-time probes plus calendar-reference resolution. */
export interface WorkingBoundaries {
  /** Whether t is working time (working day AND inside a working window; a
   *  working day with no declared window is working for its whole length). */
  isWorkingInstant(t: number): boolean;
  /** First working instant at or after t (t itself when already acceptable). */
  nextWorkingStart(t: number): number;
  /** Last instant at or before t that can close working time. */
  previousWorkingEnd(t: number): number;
}
export interface WorkingTimeProvider {
  /** The probes for one calendar reference: `calendar` names a specific
   *  calendar, omitted means the provider's default calendar. Returns
   *  undefined when the reference does not resolve (unknown configured id, no
   *  default) — dates then pass through unchanged.
   *  Freshness contract (normative): interaction MUST call `boundaries()` on
   *  EVERY working-time adjustment — a returned `WorkingBoundaries` is used
   *  for that one adjustment and never cached across adjustments or gestures.
   *  Providers may cache internally and are responsible for their own
   *  invalidation. Probe walks are bounded on the provider side (the working-time
   *  engine's 4000-day cap): a walk that gives up returns its argument. */
  boundaries(calendar?: CalendarId): WorkingBoundaries | undefined;
}

/** drag/lanes — the lane-drag seam. */
export interface LaneBox {
  resourceId: string;
  /** Top of the lane, relative to the gantt root's inner top edge. */
  y: number;
  height: number;
}
export interface LaneDragProvider {
  /** The lane at a root-relative y, or undefined when none is there — in
   *  particular always undefined while no lane layout is showing. */
  laneAt(y: number): LaneBox | undefined;
  /** Reassigns the task from one resource to another through the provider's
   *  own write path (the provider owns recording and undo). */
  reassign(taskId: TaskId, fromResourceId: string, toResourceId: string): void;
  /** Marks the lane a drop would land in, or clears with null. Optional: a
   *  provider without it drives the drag unmarked. */
  highlightLane?(resourceId: string | null): void;
  /** The lane the task is currently on, or undefined when on none / on more
   *  than one. Optional: absent, interaction falls back to asking laneAt
   *  about the bar's own centre. */
  laneOfTask?(taskId: TaskId): LaneBox | undefined;
}
```

Both provider points are structurally guarded: a contribution missing a required member (`laneAt`/`reassign`; `boundaries`) is treated as absent — the feature stays inert instead of throwing.

### Contributed by this plugin

| Target | Contribution | Order / slot (arbitrated in code) |
|---|---|---|
| `renderer/layers` | selection box + rubber-band rectangle (one layer) | `ctx.claimOrder("renderer/layers", "stargantt.interaction:selection", 70)` (just above task-bars at 60, same canvas band) |
| `renderer/layers` | drag preview (ghost band, dependency-preview outlines) | `ctx.claimOrder("renderer/layers", "stargantt.interaction:drag-preview", 100)` (bottom of the overlay canvas band) |
| `renderer/contentExtent` | horizontal extension during a date drag: the unsnapped proposal's reach plus one viewport of slack, never less than the committed reach | — |
| `view/panes` | side panel, `side: "right"`, `order: 0`, `initialWidth: 280`, `minWidth: 200`, divider label from `panelPaneResizeLabel` | — |
| `keys/bindings` | the 10 chords of §5 (buffered and inert without the a11y plugin) | — |
| `rows/height` | filter row hiding: a filtered-out task's row height overrides to 0 | — |
| `overlay-corner` (slot group) | filter toolbar (search box + Filter button), when enabled | `ctx.claimSlot("overlay-corner", "top-right", ["top-left", "top-right", "bottom-left", "bottom-right"])` — top-right, 8 px margin |
| `overlay-corner` (slot group) | zoom toolbar, when enabled | `ctx.claimSlot("overlay-corner", <zoomControls.position>, [all four])` — default bottom-right, 12 px margin |

Corner-slot arbitration note (informational): top-right is requested by both the filter toolbar and the resource plugin's heatmap overlay (perf-tools also defaults there), and bottom-right by both the zoom toolbar and tree-grid's conditional-format legend. These are arbitrated in code by `claimSlot` (architecture.md ch. 1.2): the FIRST claimant of a `(group, slot)` occupies it; a later claimant receives `{ granted: false, alternative }` (the lexicographically smallest free known slot) plus a warning-level `core/pluginError`, and may follow the proposal or not. Registration order therefore decides placement — in `presetStandard()` that is the preset's plugin composition order, which is what makes the shipped default deterministic.

## 4. Commands

| Command | Payload | Behavior |
|---|---|---|
| `clipboard/copy` | `void` | Captures the selected tasks (grid fields per `clipboard.fields`, TSV encoding) into the internal clipboard; mirrors to the system clipboard where allowed when `systemClipboard` is on; announces `copied(count)`. |
| `clipboard/paste` | optional payload (an explicit transfer to paste instead of the held one) | Creates tasks from the held (or given) transfer, one transaction; announces `pasted(count)`. |
| `clipboard/duplicate` | `void` | Copy + paste of the selection in one step, one transaction; announces `duplicated(count)`. |
| `edit-dialog/open` | `{ id: TaskId }` | Opens the modal edit dialog for the task; unknown id is a no-op. |

Native clipboard events (`copy` / `paste` on the chart root, default on via `systemClipboard`): skipped while the event target is a text-entry element; `text/plain` TSV.

## 5. `keys/bindings` contributions (chord table)

All chords act on the focused task (via `stargantt.focus`, resolved late/optionally; without the a11y plugin the contributions stay buffered and inert). Summary tasks are a declared no-op. The edit chords consult `SnapService.step`/`snap` (falling back to one UTC day); they have no Alt bypass. Each committed edit is announced through the focus channel (`edited` / `progressEdited` builders).

| # | Chord | Action | Feature |
|---|---|---|---|
| 1 | `Ctrl+ArrowRight` | move focused task forward one snap step | dragEdit |
| 2 | `Ctrl+ArrowLeft` | move focused task backward one snap step | dragEdit |
| 3 | `Ctrl+Shift+ArrowRight` | resize-end: extend end one step | dragEdit |
| 4 | `Ctrl+Shift+ArrowLeft` | resize-end: shrink end one step (min-duration clamped) | dragEdit |
| 5 | `Ctrl+Alt+ArrowRight` | resize-start: shrink start one step (min-duration clamped) | dragEdit |
| 6 | `Ctrl+Alt+ArrowLeft` | resize-start: extend start one step | dragEdit |
| 7 | `Ctrl+Shift+ArrowUp` | progress +0.1 (clamped 0..1) | dragEdit |
| 8 | `Ctrl+Shift+ArrowDown` | progress −0.1 (clamped 0..1) | dragEdit |
| 9 | `Ctrl+D` | duplicate selection (`when`: selection non-empty) | clipboard |
| 10 | `Meta+D` | duplicate selection (`when`: selection non-empty) | clipboard |

## 6. Config

Factory: `interaction(config?: InteractionConfig)`. Each feature = one nested config group. **Presence semantics (normative):** the four always-on groups — `selection`, `dragEdit`, `snap`, `tooltip` — are ENABLED with the defaults below when their nest is omitted. The six opt-in groups — `contextMenu`, `zoomControls`, `clipboard`, `filterSearch`, `editDialog`, `sidePanel` — are DISABLED when their nest is omitted; passing the nest (even `{}`) enables the feature with the defaults below. Unusable field values silently fall back to their defaults. A single top-level `messages?: Partial<InteractionMessages>` covers every feature (one catalog per plugin — see §8).

### 6.1 `selection` (enabled by default) — 4 fields

| Field | Type | Default | Semantics |
|---|---|---|---|
| `mode` | `"single" \| "multi" \| "none"` | `"single"` | `"single"`: press replaces. `"multi"`: adds Ctrl/Cmd toggle, Shift range (composed row order, hidden rows skipped, off-screen anchor works), rubber-band, deferred collapse (3 px slop). `"none"`: pointer selection off; the service stays live. |
| `shortcuts` | `{ selectAll?: boolean; clearOnEscape?: boolean; deleteSelected?: boolean }` | all `false` | Ctrl/Cmd+A select-all (`"multi"` only; whole store, else visible bars); Escape clears (rubber-band cancel takes priority); Delete opens the bulk-delete confirmation. Never fire from text-entry targets. |
| `confirmDelete` | `(req: { ids: ReadonlySet<TaskId>; count: number }) => boolean \| Promise<boolean>` | built-in dialog | Replaces the built-in confirmation; pending promise blocks further requests; throw/reject cancels and reports a plugin error. |
| `revealSelected` | `boolean` | `true` | Selecting scrolls the bar into view (grid-row press and service `select()` paths only; bar presses, rubber-band, select-all, clear never reveal). Minimal scroll, edge gap, too-wide bars show their start, vertical untouched. |

### 6.2 `dragEdit` (enabled by default) — 11 fields

| Field | Type | Default | Semantics |
|---|---|---|---|
| `enabled` | `boolean` | `true` | `false`: no pointer gestures, no key-binding contributions — the read-only-composition switch. |
| `liveUpdate` | `boolean` | `false` | `true`: every move dispatches the snapped proposal (one undo step via `coalesceKey`); ghost drawn either way. |
| `dragTooltip` | `boolean` | `false` | Tooltip follows a date drag with the commit dates, above the bar (8 px gap), wording via the `dragTooltip` message. |
| `minDuration` | `number` (ms) | none (0) | Resize floor; never wider than the task's own current duration; moves unaffected. Non-positive/non-finite ignored. |
| `rowDrag` | `boolean` | `false` | Vertical-dominant body drags become row drags (reorder + re-parent, insertion line, own-descendant refusal); enables the grid-surface row drag too. |
| `clickMove` | `boolean` | `false` | Two-click move: body click picks up, background click places (snapped, Alt bypasses, duration kept, one undo entry); Escape / completed drag / cancelled capture / release on another task disarm. WCAG 2.2 dragging-movements alternative. |
| `multiDrag` | `boolean` | `false` | A move drag inside the multi-selection carries the peers by the same committed displacement (summaries excepted), one undo step. |
| `autoScroll` | `boolean` | `false` | 32 px edge zone, velocity up to 20 px/frame, proposal follows the scrolled distance; stops at range end / zone exit / drag end. |
| `dependencyPreview` | `boolean` | `false` | Direct successors outlined (dashed, no fill), displaced by the drag delta; successor set fixed at press. Nothing dispatched by the preview. |
| `resourceDrag` | `boolean` | `false` | Vertical-dominant body drags become lane drags when a `drag/lanes` provider is composed and resolves a lane for the bar (provider-driven mark + reassignment; own lane / no lane / Escape commit nothing). Without a provider, behaves exactly as off. |
| `frameSync` | `boolean` | `false` | Moves coalesced to one per animation frame; the release path never waits on a frame. |

### 6.3 `snap` (enabled by default) — 6 fields

| Field | Type | Default | Semantics |
|---|---|---|---|
| `enabled` | `boolean` | `true` | `false`: drags commit unrounded, keyboard steps fall back to one UTC day, `SnapService.snap`/`step` become the identity/one-day fallbacks, and the `workingDays`/`alignToTasks`/`pushSuccessors` passes are all inert (§2.2). |
| `unit` | `"scale" \| "year" \| "month" \| "week" \| "day" \| "hour" \| number` | `"scale"` | `"scale"` follows the finest timeline header row; a unit name fixes it; a positive number is a plain ms grid. Unusable values → default. |
| `rule` | `(base: SnapRuleContext) => SnapRule` | built-in | Custom rule; `SnapRule = { snap(t); step?(t, dir) }` (omitted `step` keeps built-in calendar stepping); `SnapRuleContext = { unit(); snap(t); step(t, dir) }`, all live-evaluated so a custom rule follows zoom changes. |
| `workingDays` | `boolean \| { calendar?: CalendarId }` | off | A rounded date landing in non-working time is displaced per the working-time rules; `true` uses the provider's default calendar, the object form names one (an unresolvable id = no adjustment). Inert without a `snap/workingTime` contribution (§3; the scheduling plugin contributes one). |
| `alignToTasks` | `boolean \| { tolerancePx?: number }` | off | An edited date within tolerance of another task's edge snaps to it exactly (replacing the rounding rule for that instant); default tolerance 8 px (`DEFAULT_ALIGN_TOLERANCE_PX`). |
| `pushSuccessors` | `boolean` | off | An edit that breaks a dependency link pushes the successors out by appending patches to the same transaction on `data/willApplyTransaction` (user-origin transactions only; §2.2). Stands down while any `snap/pushGuards` contribution suppresses it. |

### 6.4 `tooltip` (enabled by default) — 4 fields

| Field | Type | Default | Semantics |
|---|---|---|---|
| `content` | `TooltipContentProvider \| null` | built-in provider (task name + start/end dates) | A function replaces the built-in fallback; `null` removes it. `tooltip/content` contributions always take precedence. |
| `trigger` | `"click" \| "hover" \| "both"` | `"click"` | `"click"`: show on bar pointer-down. `"hover"`: show on rest, hide on leave, per the delays. `"both"`: down shows immediately, hover after the delay. |
| `showDelay` | `number` (ms) | `300` | Hover dwell before show. Non-negative finite only. |
| `hideDelay` | `number` (ms) | `100` | Linger after the pointer leaves. Non-negative finite only. |

#### 6.4a Tooltip behavior (normative)

- **Hoverable (WCAG 1.4.13):** for `trigger` `"hover"` / `"both"` the tooltip panel is itself a pointer target: entering it cancels the pending hover-end hide (the one armed when the pointer left the bar toward the panel), and leaving it re-arms the same `hideDelay`. Every other hide trigger (Escape, scroll, gesture suppression, freshness) bypasses the grace period and hides even while the panel is hovered. A click-triggered panel is deliberately NOT a pointer target (it persists until dismissed, and a hoverable panel could swallow a press).
- **Dismissible (WCAG 1.4.13):** `Escape` on the owner document hides a shown tooltip AND sticks the dismissal to the tracked target, so continued same-bar hover samples do not re-arm the show timer — only leaving the bar or a fresh `pointer/barDown` lifts the dismissal. The listener neither prevents default nor stops propagation, so other Escape consumers (the drag cancel) run independently.
- **Focus-driven display:** an effective keyboard focus placement (the a11y plugin's focus store) shows the same content a press on that bar would, anchored at the focused bar's bottom-left corner (content coordinates converted to viewport-local; the below-right panel offset clears the bar). All lookups (`task-bars` geometry, viewport) are resolved lazily per event, never latched. DOM focus leaving the chart root dismisses a focus-shown tooltip ONLY — pointer-shown tooltips stay. Without the a11y plugin the feature is simply never invoked.
- **Freshness:** while a tooltip is visible, every data change (the `tasks` store subscription) re-runs the content resolution for its anchor hit — a non-`undefined` result replaces the content in place (no flicker), `undefined` (task deleted, dataset reloaded) hides it. A resting chart with no visible tooltip resolves nothing.

### 6.5 `contextMenu` (disabled when omitted) — 2 fields

| Field | Type | Default | Semantics |
|---|---|---|---|
| `items` | `ContextMenuItemProvider \| null` | built-in entries | Built-ins: insert / duplicate / delete / link-from / link-to / cancel-link. A function replaces them; `null` removes them (point contributions still shown, always after). |
| `insertMode` | `"child" \| "sibling"` | `"child"` | Where "Insert task" files the new task relative to the pressed one; new task spans one grid cell of the current zoom, starts at the pressed date (background) or the pressed task's start; a collapsed parent expands. Grid blank-area press appends a top-level task through the grid's own insert command. |

### 6.6 `zoomControls` (disabled when omitted) — 7 fields

| Field | Type | Default | Semantics |
|---|---|---|---|
| `levels` | `string[]` | the six built-in levels, coarsest first (`"year"` … `"hour"`) | The ladder the slider and ± buttons step; non-strings skipped, duplicates dropped, unknown ids tolerated (activating does nothing). Resolved against the composed `timeline/zoomLevels`; stepping activates through the `stargantt.timeline` service with the anchored-ladder behavior. |
| `slider` | `boolean` | `true` | Zoom slider shown. |
| `zoomButtons` | `boolean` | `true` | + / − buttons shown. |
| `fitButton` | `boolean` | `true` | Fit-to-project button. |
| `todayButton` | `boolean` | `true` | Jump-to-today button. |
| `selectionButton` | `boolean` | `true` | Jump-to-selection button (centers the first selected task; no-op without a selection). |
| `position` | `"top-left" \| "top-right" \| "bottom-left" \| "bottom-right"` | `"bottom-right"` | The claimed corner slot, 12 px margin. |

### 6.7 `clipboard` (disabled when omitted) — 2 fields

| Field | Type | Default | Semantics |
|---|---|---|---|
| `fields` | `readonly ("name" \| "start" \| "end" \| "progress")[]` | `["name", "start", "end", "progress"]` | TSV column order; unknown entries dropped; empty/unusable list restores the default. |
| `systemClipboard` | `boolean` | `true` | Wires native `copy`/`paste` on the chart and mirrors programmatic copies where the browser allows; `false` keeps only commands. |

### 6.8 `filterSearch` (disabled when omitted) — 4 fields

| Field | Type | Default | Semantics |
|---|---|---|---|
| `searchBox` | `boolean` | `false` | Incremental search box with match counter in the claimed top-right corner. |
| `filterPanel` | `boolean` | `false` | Filter button + checkbox value-list panel per filterable field. |
| `fields` | `FilterFieldDef[]` | built-ins: assigned resource, task type | Replaces the built-in filterable fields; empty array = none. |
| `views` | `Record<string, FilterView>` | `{}` | Named filter views available from the start; in-memory only. |

### 6.9 `editDialog` (disabled when omitted) — 2 fields

| Field | Type | Default | Semantics |
|---|---|---|---|
| `openOnDoubleClick` | `boolean` | `true` | Double activation (two presses of the same task — row or bar — ≤ 400 ms, no selection modifier) opens the dialog; `false` leaves `edit-dialog/open` the only way in. |
| `renderBody` | `(host: HTMLElement, ctx: EditDialogRenderContext) => void` | built-in form (name / start / end / progress, with validation + rejection messages) | Custom body; called with an empty body element on every render (open, and again after a rejected Save); first throw reports, falls back to the built-in form for the instance lifetime; non-function ignored. |

`EditDialogRenderContext`:

```ts
export type EditDialogField = "name" | "start" | "end" | "progress";
/** The dialog's working values, as raw text: dates are "YYYY-MM-DD" (UTC, the
 *  native date-input form), progress is the decimal 0..1 fraction spelled out. */
export type EditDialogDraft = Record<EditDialogField, string>;

export interface EditDialogRenderContext {
  /** The task being edited, re-read from the store at open. */
  readonly task: Readonly<Task>;
  /** The current draft values, including edits not yet committed. */
  readonly draft: Readonly<EditDialogDraft>;
  /** Per-field rejection cause text from the last rejected Save; every member
   *  is undefined while nothing has been rejected. */
  readonly invalid: Readonly<Record<EditDialogField, string | undefined>>;
  /** Writes one draft field. Re-validates nothing; validation runs on commit. */
  setField(field: EditDialogField, value: string): void;
  /** Validates and commits, closing on success. Same single-dispatch path as Save. */
  commit(): void;
  /** Closes without dispatching. */
  cancel(): void;
}
```

### 6.10 `sidePanel` (disabled when omitted) — 2 fields

| Field | Type | Default | Semantics |
|---|---|---|---|
| `formatDate` | `(t: number) => string` | none | Adds a read-only formatted line per date field (inputs keep native `YYYY-MM-DD` UTC editing). Called only with finite instants; first throw reports and latches off. |
| `renderBody` | `(host: HTMLElement, ctx: SidePanelRenderContext) => void` | built-in body (empty / multi / detail states, four editable fields, dependencies and resources read-outs) | Whole-body seam; pane chrome, divider, selection-following, and command dispatch stay built in; first throw reports and falls back to the built-in body for the instance lifetime. `SidePanelRenderContext`: `selected`, `task`, `links`, `assignments`, `messages`, `invalid`, `commit(field, value)` (never call `commit` synchronously from inside `renderBody`). |

**Accessible-name guard.** The pane divider is a focusable `role="separator"` and must always carry an accessible name (WCAG 4.1.2). The §8 catalog rule stays uniform (an empty-string `panelPaneResizeLabel` override is taken verbatim for the visible label), but the divider's `aria-label` falls back to the built-in default whenever the resolved string is empty — a consumption-site guard.

## 7. Events

- Consumes the input streams `pointer/barHover` / `barDown` / `barMove` / `barUp` / `background`, `grid/rowPointerDown` / `rowPointerMove` / `rowPointerUp`, `grid/rowContextMenu`, `grid/backgroundContextMenu`, plus `view/scrolled` (menu close, tooltip reposition/suppress) — the gesture arbiter is the primary consumer.
- Consumes the hook event `data/willApplyTransaction` (official catalog, hook events): the §2.2 `pushSuccessors` pass appends its patches there.
- Emits no `selection/changed` / `filter/changed` events — selection and filter changes are observed via store subscriptions on `SelectionService` / `FilterService`.
- Emits no events of its own. `core/pluginError` is used for host-hook faults (throwing confirm hooks, message builders, render seams).

## 8. Messages

`InteractionMessages` — one merged catalog (single top-level `messages` config key), resolved once at setup by per-key shallow override: a key of the wrong kind (non-string for a label, non-function for a builder) is ignored, the empty string is usable and taken verbatim, and a throwing builder is reported as a plugin error and answered by the built-in default for that call.

One catalog covers all ten feature areas — **58 keys**. The edit-dialog and side-panel field/error keys are prefixed (`dialog*` / `panel*`) so the two features stay independently overridable:

| Key | Feature | Default |
|---|---|---|
| `deleteConfirmTitle` | selection | builder: `"Delete 1 task?"` for one, `"Delete <count> tasks?"` otherwise |
| `deleteConfirmButton` | selection | `"Delete"` |
| `deleteCancelButton` | selection | `"Cancel"` |
| `edited` | dragEdit | builder: `"<name>, <YYYY-MM-DD> – <YYYY-MM-DD>"` (a single template — the name, `", "`, then the period as ISO UTC days around a spaced U+2013 en dash) |
| `progressEdited` | dragEdit | builder: `"<name>, <round(progress × 100)>%"` |
| `dragTooltip` | dragEdit | builder: `"<YYYY-MM-DD> – <YYYY-MM-DD>"` (same ISO-day rendering, no name) |
| `copied` | clipboard | builder: `"Copied <n> task"` + `"s"` unless n = 1 |
| `pasted` | clipboard | builder: `"Pasted <n> task"` + `"s"` unless n = 1 |
| `duplicated` | clipboard | builder: `"Duplicated <n> task"` + `"s"` unless n = 1 |
| `menuLabel` | contextMenu | `"Context menu"` |
| `insertTask` | contextMenu | `"Insert task"` |
| `duplicateTask` | contextMenu | `"Duplicate task"` |
| `deleteTask` | contextMenu | `"Delete task"` |
| `linkFrom` | contextMenu | `"Start link from here"` |
| `linkTo` | contextMenu | `"Link here from source"` |
| `cancelLink` | contextMenu | `"Cancel link"` |
| `newTaskName` | contextMenu | `"New task"` |
| `toolbar` | zoomControls | `"Zoom controls"` |
| `zoomIn` | zoomControls | `"Zoom in"` |
| `zoomOut` | zoomControls | `"Zoom out"` |
| `zoomSlider` | zoomControls | `"Zoom level"` |
| `fit` | zoomControls | `"Fit"` |
| `today` | zoomControls | `"Today"` |
| `selection` | zoomControls | `"Selected task"` |
| `searchPlaceholder` | filterSearch | `"Search tasks"` |
| `searchLabel` | filterSearch | `"Search tasks"` |
| `filterButton` | filterSearch | `"Filter"` |
| `filterPanelLabel` | filterSearch | `"Filters"` |
| `clearFilters` | filterSearch | `"Clear filters"` |
| `matchCount` | filterSearch | builder: `"<count> matches"` |
| `dialogTitle` | editDialog | `"Edit task"` |
| `dialogSave` | editDialog | `"Save"` |
| `dialogCancel` | editDialog | `"Cancel"` |
| `dialogNameLabel` | editDialog | `"Name"` |
| `dialogStartLabel` | editDialog | `"Start"` |
| `dialogEndLabel` | editDialog | `"End"` |
| `dialogProgressLabel` | editDialog | `"Progress"` |
| `dialogEditRejected` | editDialog | builder: `"<label>: invalid value, edit not applied"` |
| `dialogErrorInvalidDate` | editDialog | `"Enter a valid date (YYYY-MM-DD)"` |
| `dialogErrorDateOrder` | editDialog | `"End date must be after the start date"` |
| `dialogErrorProgressRange` | editDialog | `"Progress must be a number between 0 and 1"` |
| `panelNameLabel` | sidePanel | `"Name"` |
| `panelStartLabel` | sidePanel | `"Start"` |
| `panelEndLabel` | sidePanel | `"End"` |
| `panelProgressLabel` | sidePanel | `"Progress"` |
| `dependenciesLabel` | sidePanel | `"Dependencies"` |
| `resourcesLabel` | sidePanel | `"Resources"` |
| `noSelection` | sidePanel | `"No task selected"` |
| `noDependencies` | sidePanel | `"None"` |
| `multiSelection` | sidePanel | builder: `"<count> tasks selected"` |
| `incomingLink` | sidePanel | builder: `"← <name> (<type>)"` |
| `outgoingLink` | sidePanel | builder: `"→ <name> (<type>)"` |
| `assignment` | sidePanel | builder: `"<name> × <units>"` |
| `panelEditRejected` | sidePanel | builder: `"<label>: invalid value, edit not applied"` |
| `panelErrorInvalidDate` | sidePanel | `"Enter a valid date (YYYY-MM-DD)"` |
| `panelErrorDateOrder` | sidePanel | `"End date must be after the start date"` |
| `panelErrorProgressRange` | sidePanel | `"Progress must be a number between 0 and 1"` |
| `panelPaneResizeLabel` | sidePanel | `"Resize pane"` |

The snap and tooltip features carry no message keys.

## 9. Internal modules

`internal/gesture/` (arbiter + auto-scroll + ghost + frame), `internal/selection/` (9), `internal/drag/` (row-drag / lane-drag / keyboard / drag-tooltip, split by gesture kind), `internal/snap/` (5), `internal/tooltip/` (5), `internal/context-menu/` (4), `internal/zoom/` (3), `internal/clipboard/` (4), `internal/filter/` (5), `internal/edit-dialog/` (5), `internal/side-panel/` (4). Every file ≤ 800 lines (architecture ch. 6).

## 10. Dependencies

hard (all strictly lower layers): `data` (L1), `view` (L2), `rows` (L3), `task-bars` (L4). optional (same-layer, late lookup): `focus` — `ctx.useOptional("stargantt.focus")` at use time, never at `setup()` (the a11y plugin starts later); carries the §5 chord edits and their announcements, the keyboard-edit announcements, and the tooltip focus-follow (§6.4a). Absent, those paths are inert/silent.

No upward edges exist (architecture ch. 5 / `lint-deps.mjs`). Upper-layer integration is inverted onto the three interaction-OWNED extension points of §3: the scheduling plugin contributes `snap/workingTime` and `snap/pushGuards`; the resource plugin contributes `drag/lanes`. Cooperation with undo-redo is command-borne only (`coalesceKey` rides the dispatched commands) — no service edge.

## 11. Third-party surface

- **Consumable services:** `stargantt.selection` (`SelectionService`), `stargantt.snap` (`SnapService`), `stargantt.filter` (`FilterService`) — exactly as specified in §2.
- **Contributable extension points (with merge strategy):** `tooltip/content` (first), `contextmenu/items` (collect), `sidepanel/fields` (collect), `snap/workingTime` (first), `snap/pushGuards` (collect), `drag/lanes` (first) — types in §3; all accept third-party contributions on equal terms (a third-party working-time engine or lane view plugs in exactly where the official scheduling / resource plugins do).
- **Subscribable events:** none of its own; selection and filter changes are observed via store subscription. The `pointer/*` and `grid/*` input events themselves remain public — third-party plugins may still subscribe to them for their own gestures; the arbiter internalizes only the official plugins' former competition.
- **Commands:** `clipboard/copy` / `clipboard/paste` / `clipboard/duplicate` / `edit-dialog/open` are publicly emittable.
- **Keys:** third parties contribute to `keys/bindings` (defined by the a11y plugin, last-wins) and may override any chord in §5.
- **Reserved namespaces (documentation convention only):** the `tooltip/`, `contextmenu/`, `sidepanel/`, `snap/`, `drag/` extension-point namespaces; the `clipboard/`, `edit-dialog/` command namespaces; the `stargantt.selection` / `stargantt.snap` / `stargantt.filter` service IDs; the `renderer/layers` order keys and `overlay-corner` slots claimed in §3. Not enforced in core — conflicts surface through the arbitration registries.
- **Hardening rules:** host-supplied functions (confirm hooks, message builders, content/item providers, render seams, snap rules) are foreign code — every call is guarded (report via `core/pluginError`, fall back per the rules of §6); throw-latching applies exactly where §6 says it latches (`formatDate`, the `renderBody` seams). Store snapshots handed out (`SelectionState.taskIds`, filter criteria) are immutable snapshots per the core store contract. No back-door APIs: everything above is reachable through the public core surface only.
