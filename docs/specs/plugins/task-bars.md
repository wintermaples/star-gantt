# Plugin: task-bars (`stargantt.task-bars`)

Package: `@stargantt/plugin-task-bars` — Layer 4.
Status: normative.

## Purpose

Canvas painting of the bar bodies (task / summary / milestone), hit testing (`"bar"` / `"handle"` / `"progress"` kinds, split-row decomposition, optional 24px target widening), label placement (left / right / inside, contrast measurement, backdrops), milestone shapes, task-split rendering (`collapsedSummary: "split"`), decoration bands (icons, avatars, replayed overlays), the bar-end gutter arbitration, the empty state, and the horizontal content extent. The service is a stateless geometry query surface, so the store shape does not apply to it; this plugin holds no store-shaped state and emits no events of its own.

Public types: `BarBox` (`id`, `x`, `y`, `width`, `height`, `gutterStart`, `gutterEnd`), `BarOverlayRenderer`, `EndGutterContribution`, `ResolvedEndGutter`, `BarStyle`, `BarStyleProvider`, `BarLabelProvider`, `LabelPlacement`, `MilestoneShape`, `BarPattern`, `BarPatternProvider`, `BarRenderArgs`, `BarRenderer`, `BarIcons`, `BarIconProvider`, `BarAvatar`, `BarAvatarProvider`, `CollapsedSummary`.

## Services

### `stargantt.task-bars` → `TaskBarsService`

The stateless geometry service.

```ts
export interface TaskBarsService {
  /** The box of the task's bar as of the latest composite, viewport-local CSS px, or `undefined`
   *  when the task has no visible bar (unknown, collapsed away, zero-height row, scrolled out). */
  barBoxOf(id: TaskId): Readonly<BarBox> | undefined;
  /** The boxes of every visible bar as of the latest composite, in row order, viewport-local;
   *  fresh snapshot array; under `collapsedSummary: "split"` reports the painted children's
   *  in-row boxes, never the parent's. */
  visibleBoxes(): ReadonlyArray<Readonly<BarBox & { id: TaskId }>>;
  /** On-demand geometry in content coordinates, from the current row model and time scale,
   *  visible or not; `undefined` for an unknown task, one hidden inside a collapsed branch,
   *  or one on a zero-height row. */
  barRect(id: TaskId): Readonly<BarBox> | undefined;
  /** Whether the task currently has a bar of its own on its own row — `false` for a collapsed
   *  summary under `"hidden"`/`"split"` and for a task the row model does not place; `true`
   *  otherwise, including bars scrolled out of view. Consult before anchoring decorations. */
  hasOwnBar(id: TaskId): boolean;
}
```

Member count: 4. No stores — the service is stateless geometry, and repaint-driving state lives in the `data` / `rows` / `view` stores this plugin itself subscribes to.

The bar-geometry rule is contractual: 4 CSS px vertical inset per side, minimum bar height 6 px (inset shrinks first), minimum width 2 px, ordered `tToX(start)`…`tToX(end)` span, summary box = ordinary rule (glyph differs), milestone box = height-sized square centred on `tToX(start)`, box vertically centred in its row band.

## Extension points

- **Defines:**
  - `taskbars/style` (first, contribution type `BarStyleProvider`, result `BarStyleProvider`) — the composite adopts the first non-`undefined` `BarStyle`; precedence over the bar's fill: style point > `task.meta.color` > type-driven theme token (`--sg-milestone-fill` / `--sg-summary-fill` / `--sg-bar-fill`). A throwing provider is latch-contained.
  - `taskbars/overlays` (collect, contribution type `BarOverlayRenderer`, result `BarOverlayRenderer[]`) — invoked per visible bar with that bar's `BarBox`; recorded during the bar pass and replayed in the decoration band, last per bar; geometry-only contributions that draw nothing remain legitimate; per-call fault isolation.
  - `taskbars/endGutter` (reduce, contribution type `EndGutterContribution`, result `ResolvedEndGutter`) — per bar end, the maximum `size` among active contributions covering that end (`"both"` covers both; `active()` read once per resolution); no/none-active contributions resolve 0; published on every reported `BarBox` as `gutterStart` / `gutterEnd`; clearance, not geometry — no hit zone or box member moves with it.
- **Claims:** `ctx.claimKey("task.meta", "color")` — this plugin owns the `task.meta.color` per-task fill override it reads in its style resolution.
- **Contributes:**
  - `renderer/layers` — two entries: the bar band and the bar-end decoration band (labels, icons, avatars, replayed overlays). Orders claimed via `claimOrder` (table below).
  - `renderer/hitTest` — one `HitTester` answering `"bar"` / `"handle"` / `"progress"` (the ±3 px strip on the progress boundary, with the 24 px-tall bottom band; handles win at bar edges; split rows classify against painted children in reverse paint order; `expandedHitArea` widening per config).
  - `renderer/contentExtent` — horizontal: the x of the last task end plus one viewport width of slack, measured at clamp time.

## claimOrder registrations

Scope `"renderer/layers"`:

| Scope | Key | Order | Draws |
|---|---|---|---|
| `renderer/layers` | `task-bars:bars` | 60 | bar bodies, progress track/fill, patterns, outline/bevel (main canvas) |
| `renderer/layers` | `task-bars:decorations` | 80 | labels + backdrops, icons, avatars, replayed `taskbars/overlays` — above dependency lines (70), below the drag preview (100) |

## Commands

None.

## Events

None. (Bar pointer input arrives via the `pointer/*` events emitted by the view plugin; this plugin contributes the hit tester those events are annotated with. This plugin subscribes to the `data.tasks`, `rows.rows`, `view.viewport`, `timeline.zoomLevel`, and `theme.tokens` stores for its repaints.)

## Config

Factory: `taskBars(config?: TaskBarsConfig)`. **Exactly 13 fields, flat** (`messages` included). All optional; unusable values are silently ignored; read once at `setup()`; a composition that sets none of them paints and hit-tests exactly per the defaults below. Every config-supplied function that runs in the paint loop or hit test is contained by a latched fault barrier (first throw → one `core/pluginError`, then the function declines for the instance's life, with the per-option fallback listed).

| # | Field | Type | Default | Semantics |
|---|---|---|---|---|
| 1 | `label` | `BarLabelProvider \| { text: BarLabelProvider; placement?: LabelPlacement }` | off | per-visible-bar label; bare provider draws at `"right"`; placement is chart-wide; empty/non-string = no label; latch → labels stop |
| 2 | `messages` | `Partial<TaskBarsMessages>` | English defaults | per-key shallow override, resolved once at `setup()` |
| 3 | `labelBackdrop` | `boolean \| { color?: string; padding?: number; radius?: number }` | `true` (inert until something is labelled) | halo behind `"left"`/`"right"` labels; defaults `color` = `--sg-bar-label-backdrop` (fallback `rgba(255, 255, 255, 0.82)`), `padding` 2, `radius` 3; `"inside"` labels never get one |
| 4 | `durationLabel` | `boolean \| { placement?: LabelPlacement }` | `false` | span in whole days, floor 1 (`"3d"`), default placement `"right"`; milestones draw none |
| 5 | `progressLabel` | `boolean \| { placement?: LabelPlacement }` | `false` | clamped whole-percent (`"40%"`), default placement `"inside"`, ordinary tasks only |
| 6 | `milestoneShape` | `MilestoneShape \| ((task) => MilestoneShape \| undefined)` | `"diamond"` | `"diamond" \| "triangle" \| "star" \| "square"`; same square box; non-diamond shapes hit-test as the full square; latch → built-in shape |
| 7 | `patternFill` | `boolean \| BarPatternProvider` | `false` | color-vision-safe textures (`"none" \| "diagonal" \| "cross" \| "dots"`); `true` = built-in mapping; clipped to the bar shape; latch → built-in mapping |
| 8 | `renderBar` | `BarRenderer` | none | replaces bar-body painting; called with `(g, { box, task, defaultPaint })`; hit testing/geometry never consult it; latch → `defaultPaint` |
| 9 | `barIcons` | `BarIconProvider` | none | `{ left?, right? }` glyphs inside the bar ends; skipped when width < 2 × height; milestones none; latch → stop |
| 10 | `avatar` | `BarAvatarProvider` | none | `{ initials?, color? }` disc on the bar's right end (radius `height/2 − 1`, fallback color `#5b6470`); initials fitted to the badge (grapheme-cluster truncation); latch → stop |
| 11 | `barRadius` | `number` | unset (token `--sg-bar-radius`, fallback `4px`) | finite ≥ 0 CSS px wins over the token; `0` is a value (square corners); ordinary bars only |
| 12 | `collapsedSummary` | `"range" \| "hidden" \| "split"` | `"range"` | what a collapsed summary row shows: own span glyph / nothing / its direct children's bars (one level, painted children editable horizontally, height-0 children excluded, `hasOwnBar` = `false` under `"hidden"`/`"split"`) |
| 13 | `expandedHitArea` | `boolean` | `false` | a miss retried against the bar's box widened to ≥ 24 CSS px per axis about its centre → `{ kind: "bar" }`; exact handle/progress zones never stolen; never crosses a row |

Colors are NOT config: they stay CSS custom properties read through `stargantt.theme` at paint time with the consumer pattern `theme.get(token) || FALLBACK` — `--sg-bar-fill` (`#0f766e`), `--sg-summary-fill` (`#44403c`), `--sg-milestone-fill` (`#292524`), `--sg-bar-track-alpha` (`0.22` — progress is one color at two opacities), `--sg-bar-label-fg` (`#1c1917`), `--sg-bar-label-font` (`12px system-ui, sans-serif` registered / `10px sans-serif` canvas fallback), `--sg-bar-inside-label-fg` (`#ffffff`, kept only while it clears 4.5:1 on the bar's resolved fill, else black/white), `--sg-bar-label-backdrop`, `--sg-bar-radius` (`4px`), `--sg-bar-stroke` (`transparent`), `--sg-bar-stroke-width` (`0px`), `--sg-bar-fill-bevel` (`0`). Label offset rule kept: outside labels start `max(20, gutter + 3)` CSS px past the bar edge; same-side labels lay out along the side in order host label → duration → progress with 20 px gaps.

**The empty state**: when `RowsService.rowCount()` is 0, one `.sg-empty` node (text = `messages.empty`) is mounted in the chart body (`ViewService.chartPaneElement()`), non-interactive, not hit-testable, removed the moment a row exists; no switch disables it.

## Messages

`TaskBarsMessages`:

| Key | Default | Where |
|---|---|---|
| `empty` | `"No tasks"` | the `.sg-empty` chart-body node shown while the composed row count is 0 |

Key count: 1. Plain string, resolved once at `setup()`. Bar label text is host-supplied data, never a catalog member.

## Internal modules

| File | Content |
|---|---|
| `index.ts` | factory, declaration merging, wiring |
| `types.ts` | public types |
| `internal/paint.ts` | bar-body painting (track/fill, patterns, radius, outline, bevel, `renderBar` hook) |
| `internal/layer.ts` | the two layer contributions (bars 60 / decorations 80) and the per-pass token reads |
| `internal/labels.ts` | label pipeline: placements, same-side layout, backdrops, contrast measurement |
| `internal/geometry.ts` | the contractual bar-geometry rule (Services chapter above) |
| `internal/hit.ts` | hit tester: bar/handle/progress zones, split-row decomposition, `expandedHitArea` |
| `internal/gutter.ts` | `taskbars/endGutter` reduction and `BarBox.gutterStart/End` publication |
| `internal/decor.ts` | icons, avatars, overlay replay in the decoration band |
| `internal/split.ts` | `collapsedSummary` presentations, split-row painting and child hit-testing |
| `internal/style.ts` | `taskbars/style` composite + `task.meta.color` + token fill resolution |
| `internal/empty-state.ts` | the `.sg-empty` node |
| `internal/extent.ts` | horizontal `renderer/contentExtent` contribution |
| `internal/service.ts` | `TaskBarsService` |
| `internal/options.ts` | config normalization + the latched option fault barriers |
| `internal/deps.ts` | narrow reader type aliases (`Pick<>` projections of the sibling services — `RowReader`, `TaskReader`, `TimeMapper`, `ThemeReader`, scroll offsets) imported by every internal module; contains no dependency-line coordination. The scheduling boundary goes through the public extension points only (`taskbars/endGutter` reservation + `TaskBarsService` geometry + `hasOwnBar`), with no scheduling-specific knowledge in this plugin. Bar-body painting is split across `paint.ts` + `paint-text.ts` (keeping every file under the 800-line cap), so the module count is 17 |

## Dependencies

hard: `data`, `view`, `rows` (consumed services: `stargantt.data`, `stargantt.view`, `stargantt.timeline`, `stargantt.theme`, `stargantt.rows` — five services across three providing plugins). task-bars sits in its own layer above tree-grid (architecture.md ch. 5: tree-grid is Layer 3, task-bars Layer 4), so the `rows` dependency is a strictly downward service reference.

## Third-party surface

- **Consumable services:** `stargantt.task-bars` (`TaskBarsService`) — bar rectangle / geometry queries (`barBoxOf`, `visibleBoxes`, `barRect`, `hasOwnBar`) for positioning custom overlays, routing lines, and hit logic without contributing a drawing callback.
- **Contributable extension points (merge strategy + contribution type):** `taskbars/style` (first, `BarStyleProvider` — restyle/recolor bars; answer `undefined` to yield), `taskbars/overlays` (collect, `BarOverlayRenderer` — draw badges/markers per visible bar, replayed last-per-bar in the decoration band), `taskbars/endGutter` (reduce, `EndGutterContribution` — reserve clearance outside bar ends; resolution = per-end maximum of active contributions). These are the same points the official tree-grid (task-fields / conditional-format decorations) and scheduling plugins use; third parties contribute on equal terms.
- **Subscribable events:** none of its own; bar interaction is observed via the view plugin's `pointer/*` stream (the `hit` payloads carry this plugin's `"bar"` / `"handle"` / `"progress"` kinds).
- **Order claims:** the two `renderer/layers` claims above (`task-bars:bars` 60, `task-bars:decorations` 80) are visible via `host.orders("renderer/layers")`; third parties claim their own keys/orders in the same scope.
- **Reserved namespaces (documentation convention only):** the `taskbars/` extension-point namespace, the `task-bars:*` keys in the `renderer/layers` order scope, the claimed `task.meta` key `color`, and the `stargantt.task-bars` service ID. Not enforced in core.
