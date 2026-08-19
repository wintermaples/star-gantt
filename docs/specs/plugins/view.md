# Plugin: view (`stargantt.view`)

Package: `@stargantt/plugin-view` — Layer 2.
Status: normative.

## Purpose

Canvas 3-layer rendering (background / main / overlay) + DOM overlays; fully virtualized scrolling; pane splitting (left / right / bottom, view modes); theming (CSS variables → Canvas color resolution, presets, forced colors); the timeline (t↔x, zoom, origin, header painting); background painting of grid lines and the today/status line. `viewport`, `viewMode`, `zoomLevel`, and the theme tokens are store-shaped.

Public types: `CanvasLayer`, `Viewport`, `InvalidateRect`, `LayerContribution`, `HitResult`, `HitTester`, `InsetRect`, `InsetContribution`, `ResolvedInsets`, `DomOverlayContribution`, `ContentExtentContribution` (renderer); `PaneContribution`, `BottomPaneElements`, `BottomPaneContribution`, `ViewMode` (panes); `ScaleUnit`, `ScaleRow`, `ZoomLevel`, `HeaderCell`, `ZoomLevelMetrics`, `GridCell` (timeline-scale); `ColorScheme`, `ThemePreset`, `SetPresetOptions`, `ThemeAuditEntry`, `PresetTokens`, plus the exported token/preset constants (`BUILT_IN_PRESETS`, `HIGH_CONTRAST_LIGHT`/`DARK`, `CANVAS_READ_TOKENS`, `NON_COLOR_CANVAS_TOKENS`, `RETIRED_TOKENS`, `FORCED_COLOR_TOKENS`) (theme); `StatusDateInput` (today-line).

## Services

### `stargantt.view` → `ViewService`

The renderer surface plus the view-mode state, store-shaped.

```ts
import type { Store } from "@stargantt/core";

export interface ViewService {
  // --- methods ---
  /** Marks a layer dirty for the next frame; with a rect and `dirtyRegions` on, repaint clips to the union. */
  invalidate(layer: CanvasLayer, rect?: InvalidateRect): void;
  /** Re-reads the reserved top/bottom inset bands; re-lays out only when they changed. */
  refreshInsets(): void;
  /** Base text direction, fixed at creation; `"ltr"` unless configured. */
  direction(): "ltr" | "rtl";
  /** Live `prefers-reduced-motion: reduce` state. */
  reducedMotion(): boolean;
  /** `measureText` advance width, cached per font-and-string pair (bounded LRU, dropped on DPR change). */
  textWidth(g: CanvasRenderingContext2D, text: string): number;
  /** Wraps direction-mixed text in a Unicode directional isolate; idempotent; non-string → `""`. */
  bidiIsolate(text: string, base?: "ltr" | "rtl"): string;
  /** ms from setup to first completed on-screen composite; `undefined` before it; latched after. */
  firstPaintMs(): number | undefined;
  /** Queues a layout read for the next pass; all reads run before all writes. */
  batchRead(fn: () => void): void;
  /** Queues a layout write for the next pass, after every queued read. */
  batchWrite(fn: () => void): void;
  /** Extrapolated near-future viewport, or `undefined` (prefetch off / at rest / stale samples). */
  predictedViewport(): Readonly<Viewport> | undefined;
  /** The chart pane's element (canvases' container); created at setup, stable for the lifetime. */
  chartPaneElement(): HTMLElement;
  /** The resolved wheel-scroll speed multiplier (default 1); shared-viewport panes read it here. */
  wheelSpeedFactor(): number;
  /** Programmatic scroll: instant, clamped like wheel input; a changed position emits `view/scrolled`. */
  scrollTo(target: { scrollLeft?: number; scrollTop?: number }): void;
  /** Draws the full layer composite for a caller-chosen virtual viewport (exporters/thumbnailers). */
  renderTo(g: CanvasRenderingContext2D, viewport: Readonly<Viewport>): void;

  // --- stores ---
  /** The virtual viewport. Set on every scroll and size/inset change, in the
   *  same pass that composites. The store value never carries `detail` (the
   *  progressive-rendering hint describes a paint pass, not the scroll state). */
  readonly viewport: Store<Readonly<Viewport>>;
  /** The view mode. Set exactly when a `view/setViewMode` dispatch actually changes the mode. */
  readonly viewMode: Store<ViewMode>;
}
```

Member count: 16 (14 methods + 2 stores).

### `stargantt.timeline` → `TimelineService`

The time-scale service, store-shaped.

```ts
export interface TimelineService {
  // --- methods ---
  tToX(t: number): number;
  xToT(x: number): number;
  readonly pxPerMs: number;
  /** Activates the level with this `ZoomLevel.id` (throws on unknown id; same-level = no-op).
   *  A finite `anchorTime` keeps that instant under the same viewport point (held by scrolling). */
  setZoomLevel(id: string, anchorTime?: number): void;
  /** Moves the instant at content x = 0; the view is scroll-compensated. */
  setOrigin(ms: number): void;
  /** Asks for room for an instant (drag-in-progress path); holds the extension until released.
   *  No-op with `autoExtendOrigin` off. */
  requestOriginExtension(t: number): void;
  /** Drops the hold; harmless without one. */
  releaseOriginExtension(): void;
  /** Every registered level's `{ id, pxPerDay }`, registration order; fresh snapshots per call. */
  levelMetrics(): readonly ZoomLevelMetrics[];
  /** The configured first weekday (0 = Sunday … 6 = Saturday), default 1; fixed per instance. */
  firstDayOfWeek(): 0 | 1 | 2 | 3 | 4 | 5 | 6;
  /** Calendar boundaries of a unit within `[fromMs, toMs)`, header-identical arithmetic;
   *  capped at 4096 boundaries. */
  unitBoundaries(unit: ScaleUnit, fromMs: number, toMs: number, step?: number, stepOffset?: number): readonly number[];
  /** Formats an instant with the chart's locale, display calendar, and display time zone. */
  formatDate(t: number, options?: Intl.DateTimeFormatOptions): string;
  /** The half-open span of the finest-row grid cell holding `t`, or `undefined`. */
  gridCellAt(t: number): GridCell | undefined;

  // --- store ---
  /** The active zoom level. */
  readonly zoomLevel: Store<Readonly<ZoomLevel>>;
}
```

Member count: 13 (12 members + 1 store).

Design note: the store carries the full `Readonly<ZoomLevel>`, not just the level id — a `Store<string>` would strip the active level's `pxPerDay` and `scales` from the public surface. The id is `zoomLevel.get().id`.

**Mapping-change notification (normative).** The store is set on **every** t↔x mapping change: a zoom-level change publishes the new level, and an **origin move** (`setOrigin`, the automatic extension) re-publishes the unchanged level object — stores perform no equality gating, so subscribers are still notified. A subscriber that only invalidates cached geometry treats every notification alike; one that must distinguish compares `next.id !== prev.id` (zoom) vs equal ids (origin move).

### `stargantt.theme` → `ThemeService`

Store-shaped theming.

```ts
/** The canvas-read token set mapped to its currently resolved values. */
export type ThemeTokens = Readonly<Record<string, string>>;

export interface ThemeService {
  // --- methods ---
  /** Current value of any CSS custom property on the chart root, trimmed; `""` when unset.
   *  Serves colors, font shorthands, and numeric px tokens alike (consumer parses).
   *  Precedence: forced-colors system palette > applied preset > computed style. */
  get(token: string): string;
  /** Contrast/step audit of the palette in force, one entry per documented relationship. */
  audit(): readonly ThemeAuditEntry[];
  /** Applies a named preset (or clears with `null`); `options.mode` `"replace"` (default) | `"merge"`.
   *  A preset naming a color scheme pins it while applied. Unknown names do nothing. */
  setPreset(name: string | null, options?: SetPresetOptions): void;
  /** The applied preset's name, or `null`. */
  preset(): string | null;
  /** Every applicable preset name: bundled (`"high-contrast"`, `"high-contrast-dark"`) + config presets. */
  presets(): readonly string[];
  /** Pins this chart's color scheme (`"auto"` hands it back to the page); mirrored onto `color-scheme`. */
  setColorScheme(scheme: ColorScheme): void;
  /** The pin in force: preset's > config/service pin > `"auto"`. */
  colorScheme(): ColorScheme;
  /** Re-reads every token, repaints, and notifies — the host's escape hatch for outside changes
   *  (ancestor attribute, stylesheet swap). Harmless when nothing changed (still notifies once). */
  refresh(): void;

  // --- store ---
  /** The canvas-read token snapshot (token names = `Object.keys(tokens.get())`). Set
   *  once per theme change — root `class`/`data-theme` mutation, `prefers-color-scheme` flip,
   *  preset/scheme application, forced-colors flip, `refresh()` — with the freshly re-read values,
   *  after the renderer's three layers are marked dirty. Canvases outside the renderer layers
   *  (none official — the timeline header is internal) repaint from this subscription. */
  readonly tokens: Store<ThemeTokens>;
}
```

Member count: 9 (8 methods + 1 store).

## Extension points

Defines 9 points. `renderer/rowGeometry` exists to preserve strict downward layering: the row-dependent background passes read row geometry contributed from above instead of consuming an upper-layer service.

| Point | Strategy | Contribution type | Result | Rules |
|---|---|---|---|---|
| `renderer/layers` | collect | `LayerContribution` `{ id, zIndex, draw }` | sorted into the 3 canvases | per-draw fault isolation; save/restore bracketing; order arbitrated via `ctx.claimOrder("renderer/layers", key, order)` (see claimOrder table below) |
| `renderer/hitTest` | first | `HitTester` | first non-`undefined` hit | a throwing tester = "no hit", falls through |
| `renderer/insets` | reduce | `InsetContribution` `{ side, order, size, placed? }` | `ResolvedInsets` (per-side **sum**, ordered strip) | `refreshInsets()` re-read; timeline header contributes the top strip internally |
| `renderer/domOverlays` | collect | `DomOverlayContribution` `{ id, mount }` | wrappers in content coordinates, scroll-aligned same-frame | `.sg-dom-overlays` / `.sg-dom-overlay-item` / `data-overlay-id` public surface; lazy creation |
| `renderer/contentExtent` | collect | `ContentExtentContribution` `{ id, measure }` | per-axis **max** at clamp time (never cached) | unbounded axis without contributions; re-clamp on shrink emits `view/scrolled` |
| `view/panes` | collect | `PaneContribution` | side panes around the chart pane | mounted on `lifecycle/ready`; divider ownership, clamps, a11y separators, collapse |
| `view/bottomPanes` | collect | `BottomPaneContribution` | full-width strips below the pane row | gutter/body/trailing column tracking; interactive floor `max(minHeight, 24)`; height 0 releases |
| `timeline/zoomLevels` | collect | `ZoomLevel` | the composed zoom ladder | config `zoomLevels` replaces only the built-in six |
| `renderer/rowGeometry` | first | `RowGeometryProvider` (below) | the composed row geometry, or none | consumed by the internal grid-lines module's row-dependent passes; no contribution → those passes silently draw nothing |

```ts
/** Contribution to `renderer/rowGeometry` (first). Exactly the members the
 *  row-dependent passes need — no more. */
export interface RowGeometryProvider {
  rowCount(): number;
  /** The row index under a content-space y; implementations clamp out-of-range queries
   *  to the nearest row. */
  rowAtY(y: number): number;
  /** Row index → content-space y of the row's top edge. */
  yOf(row: number): number;
  rowHeight(row: number): number;
}
```

**`renderer/rowGeometry` contract (normative).** The point is resolved at draw time, per pass (function-shaped members; results never cached across paints). When multiple providers are contributed, the first registered wins (the `first` strategy's ordinary composition rule); the others are never consulted. The horizontal-lines, row-stripes, and row-hover passes read row geometry exclusively through it; the stripe parity is derived from the provider's row indexes (so the chart pane's stripes line up with the grid pane's, which marks from the same index). Each member call is fault-isolated like every other contributed callback (a throw = that pass draws nothing this frame, reported once via `core/pluginError`). Because this plugin holds no reference to the provider's owner, **repaint responsibility is the contributor's**: whenever the contributed geometry changes (row set, heights, expansion, sort), the contributor invalidates this plugin's layers (`ViewService.invalidate("background")` — the official contributor, tree-grid, does this from its own row-model updates). The vertical passes never consult the point and are unaffected by its absence.

The grid-lines / today-line contributions to `renderer/layers` are internalized (the points themselves remain public and accept third-party contributions on equal terms).

## claimOrder registrations

Scope `"renderer/layers"`:

| Scope | Key | Order | Claimed by | Draws |
|---|---|---|---|---|
| `renderer/layers` | `view:grid-lines` | 10 | view (internal grid-lines module) | vertical/horizontal grid lines, stripes, shading (background canvas) |
| `renderer/layers` | `view:today-line` | 55 | view (internal today-line module) | today line + optional dashed status line (main canvas) |

Design note: `claimOrder` rejects duplicate `(scope, order)` pairs, so the critical-path free-float layer sits at 56, one above the today line's 55 (see scheduling.md).

(The task-bars claims — 60 and 80 — are in task-bars.md. `docs/specs/render-order.md` is generated from `host.orders("renderer/layers")`; this table is the plugin's declaration, not the registry of record.)

## Commands

| Command | Payload | Behavior |
|---|---|---|
| `timeline/zoomIn` | `{ anchorTime? }` | next finer registered level; no-op at the finest; anchor held by scrolling |
| `timeline/zoomOut` | `{ anchorTime? }` | next coarser level; no-op at the coarsest |
| `view/paneToggle` | `{ id, collapsed? }` | collapse/expand a `collapsible` pane; omitted `collapsed` toggles; unknown/non-collapsible = no-op |
| `view/setViewMode` | `{ mode: ViewMode }` | `"split" \| "grid" \| "gantt"`; unusable mode or inapplicable `"grid"` = silent no-op; an effective switch sets the `viewMode` store; with the focus-reanchoring guard |
| `view/setBottomPaneHeight` | `{ id, height }` | clamped to the pane's effective range; exactly 0 releases the strip; not undoable |

None is undoable (view state only).

## Events

- Emits the pointer input stream: `pointer/barDown` `{ hit, x, y, event }`, `pointer/barMove` `{ hit?, x, y, event }` (synchronous, never frame-batched), `pointer/barUp` `{ hit?, x, y, event }` (exactly once per gesture), `pointer/barHover` `{ hit?, x, y }` (once per frame at most), `pointer/background` `{ x, y, event }` (also starts a gesture).
- Emits `view/scrolled` `{ scrollTop, scrollLeft }` (retained input event; the viewport store is additionally set in the same pass) and `view/bottomPaneResized` `{ id, height }` (retained notification). **This plugin is the sole emitter of `view/scrolled`** — every scroll mutation, including one requested through `ViewService.scrollTo` by another plugin (the tree-grid pane's wheel path — see tree-grid.md "Scroll synchronization"), is announced from here and nowhere else.
- There are no `theme/changed` / `timeline/zoomChanged` / `view/modeChanged` events — the `theme.tokens`, `timeline.zoomLevel`, and `view.viewMode` stores are the change channels, as specified above.

## Config

Factory: `view(config?: ViewConfig)`. All fields optional; unusable values silently fall back to their defaults; everything is read once at `setup()` except fields documented as tracked live.

```ts
view({
  scroll?: { wheelSpeedFactor?, scrollbar? },
  direction?, progressive?, dirtyRegions?, prefetch?,
  panes?: { initialViewMode? },
  theme?: { preset?, presets?, forcedColors?, colorScheme?, diagnostics? },
  timeline?: { origin?, autoExtendOrigin?, initialZoom?, zoomLevels?, firstDayOfWeek?,
               headerRowRatio?, headerLabelPadding?, fiscalYearStartMonth?, headerCellFormat?,
               calendar?, displayTimeZone? },
  gridLines?: { vertical?, horizontal?, rowStripes?, nonWorkingDays?, nonWorkingHours?, zones?, rowHover? },
  todayLine?: { statusDate? } | false,
})
```

| Field | Type | Default | Semantics |
|---|---|---|---|
| `scroll.wheelSpeedFactor` | `number` | `1` | finite, positive; else ignored |
| `scroll.scrollbar` | `boolean` | `true` | both synthetic scrollbars |
| `direction` | `"ltr" \| "rtl"` | `"ltr"` | only the literal `"rtl"` flips; fixed at creation |
| `progressive` | `boolean` | `false` | `Viewport.detail` coarse/fine hint |
| `dirtyRegions` | `boolean` | `false` | rect-clipped repaints |
| `prefetch` | `boolean` | `false` | scroll prediction + warm pass |
| `panes.initialViewMode` | `ViewMode` | `"split"` | applied once after panes mount; `"grid"` ignored with no left pane |
| `theme.preset` | `string` | none applied | unknown name silently ignored |
| `theme.presets` | `Record<string, Record<string,string> \| ThemePreset>` | `{}` | bundled names replaceable; unusable entries dropped |
| `theme.forcedColors` | `boolean` | `false` | honor `(forced-colors: active)` |
| `theme.colorScheme` | `ColorScheme` | `"auto"` | per-chart pin |
| `theme.diagnostics` | `boolean` | `true` | retired-token + partial-palette setup warnings |
| `timeline.origin` | `number` (epoch ms) | start of the current UTC day | the instant at content x = 0 |
| `timeline.autoExtendOrigin` | `boolean` | `false` | follows data earlier than the origin both ways, floored at `origin` |
| `timeline.initialZoom` | `string` | first registered level | unknown id degrades to the default silently |
| `timeline.zoomLevels` | `ZoomLevel[]` | built-in `"day"`, `"week"`, `"hour"`, `"month"`, `"quarter"`, `"year"` | a non-empty array replaces the built-in six; contributed levels unaffected |
| `timeline.firstDayOfWeek` | `0…6` | `1` (Monday) | non-integer/out-of-range ignored |
| `timeline.headerRowRatio` | `number` | `0.5` | top row's fraction, open interval (0,1) |
| `timeline.headerLabelPadding` | `number` | `4` | CSS px, ≥ 0 |
| `timeline.fiscalYearStartMonth` | `number` | `1` (calendar years/quarters) | integer 2..12 enables fiscal periods on month/quarter/year levels |
| `timeline.headerCellFormat` | `(cell: HeaderCell) => string \| null \| undefined` | none | per-cell label hook; latched fault barrier |
| `timeline.calendar` | `string` | locale default (Gregorian) | Intl calendar id (wording only; boundaries stay Gregorian) |
| `timeline.displayTimeZone` | `string` | `"UTC"` | IANA zone for header boundaries/labels; data stays UTC epoch ms |
| `gridLines.vertical` | `boolean \| "none" \| "major" \| "both"` | `"major"` | `true` = `"both"`, `false` = `"none"` |
| `gridLines.horizontal` | `boolean` | `false` | row-separator lines (needs row geometry) |
| `gridLines.rowStripes` | `boolean` | `true` | alternating-row bands (`--sg-row-stripe-bg`) |
| `gridLines.nonWorkingDays` | `boolean \| { calendar?: CalendarId; weekend?: readonly number[] }` | on (`true`) | shading of non-working stretches; see calendar note below |
| `gridLines.nonWorkingHours` | `boolean` | `false` | off-hours hatch (needs intra-day windows — only a calendar named via `nonWorkingDays.calendar` can supply them, so with the weekend fallback the hatch never draws) |
| `gridLines.zones` | `readonly { start, end, color? }[]` | `[]` | highlight bands; `--`-prefixed colors resolve via theme tokens |
| `gridLines.rowHover` | `boolean` | `false` | hover row fill (`--sg-row-hover-bg`) |
| `todayLine` | `{ statusDate?: StatusDateInput } \| false` | enabled, no status line | `false` disables the today line outright; `statusDate` accepts epoch ms / `Date` / `Date.parse` string, drawn as a dashed second line, resolved once |

(`todayLine` accepts `| false` while `gridLines` does not — the gridLines passes are individually switchable through their own fields, so a wholesale `false` form is unnecessary there.)

Colors are NOT config: they stay CSS custom properties (`--sg-grid-line-minor/major`, `--sg-grid-nonworking`, `--sg-grid-offhours`, `--sg-grid-zone`, `--sg-row-stripe-bg`, `--sg-row-hover-bg`, `--sg-today-line` fallback `#ea580c`, `--sg-status-line` fallback `#2f6fd6`), read through the theme at paint time (the `theme.get(token) || FALLBACK` consumer pattern).

**Calendar source resolution (normative).** The shading passes resolve as follows: with `nonWorkingDays.calendar` **unset**, the pass always uses the built-in weekend fallback (`sdk/time` `DEFAULT_WORKWEEK` — Saturday/Sunday, UTC, whole days, or the configured `weekend` list); with an **explicit** calendar id, the `CalendarDef` is read from `stargantt.data` (`query().calendars`) and evaluated through the shared working-time engine in `sdk/time` — an id missing from the data store degrades silently to the same fallback. There is deliberately no "default calendar" concept at this layer.

**Row geometry (design note).** The horizontal / rowStripes / rowHover passes need row geometry, but service consumption is strictly downward-only: the geometry arrives through the `renderer/rowGeometry` extension point defined above (the lower layer defines, the upper layer contributes — the `view/panes` pattern). This plugin holds no reference to `stargantt.rows`, optional or otherwise. With no contribution the row-dependent passes silently draw nothing while the vertical passes are unaffected.

## Messages

`ViewMessages` has **no members**. The only English text this plugin emits is the two divider accessible-name terminal fallbacks, `"Resize pane"` (side dividers) and `"Resize panel"` (bottom dividers), reached only when a third-party contribution omits `label`; these are deliberately not catalog members (every official contributor supplies its own `label` from its own catalog — e.g. `TreeGridMessages.paneResizeLabel`). Theme diagnostics remain hardcoded English `console.warn` output (developer-facing, out of catalog scope).

## Internal modules

Directories group the plugin's functional areas:

| Directory | Files | Content |
|---|---|---|
| `internal/render/` (20) | `index` (module root), `batch`, `bidi`, `dirty`, `dom`, `frame`, `insets`, `layers`, `motion`, `overlays`, `perf`, `pointer`, `prefetch`, `progressive`, `safearea`, `scroll`, `scrollbars`, `sizing`, `text`, `types` (extracted for the 800-line cap) | canvases, composite, virtual scroll, synthetic scrollbars, pointer gestures, DOM overlays, safe area (`--sg-safe-*`), §6 extensions |
| `internal/panes/` (6) | `index`, `bottom-panes`, `bottom-region`, `divider` (extracted for the 800-line cap), `drag-owner`, `view-mode` | side panes, dividers, bottom region, view modes |
| `internal/theme/` (9) | `index`, `types`, `audit`, `diagnostics`, `forced-colors`, `media`, `presets`, `registry`, `scheme` | token cache, presets, scheme pin, forced colors, audit |
| `internal/timeline/` (12) | `index`, `export-contrib`, `header`, `header-labels`, `header-layout`, `header-lifecycle`, `header-options`, `levels`, `origin-guard`, `scale`, `zone`, `zoom` | header canvas, zoom ladder, calendar arithmetic, origin guard, display zone/calendar, header export band |
| `internal/grid-lines/` (2) | `index`, `shading` | line passes + working-time shading |
| `internal/today-line/` (2) | `index`, `status-date` | today line, status-date line, midnight rollover timer |

`internal/timeline/export-contrib.ts` contributes the timeline-header capture band to `export/auxiliarySurfaces` (the point is defined by the export plugin — see export.md §4; the contribution is buffered by the core when that plugin is not composed).

## Dependencies

hard: `data` (the today line and header use the date domain only; `autoExtendOrigin` follows the `data.tasks` store; grid-line shading reads `query().calendars`). Cross-references among the internal areas (timeline→theme, grid-lines→timeline, panes→render, …) are plain internal calls, not service edges. This plugin consumes no upper-layer service — row geometry arrives through the `renderer/rowGeometry` extension point (upper layers contribute into it; see the row-geometry note above).

## Third-party surface

- **Consumable services:** `stargantt.view` (`ViewService`), `stargantt.timeline` (`TimelineService`), `stargantt.theme` (`ThemeService`) — viewport/viewMode/zoomLevel/tokens stores, t↔x mapping, invalidation, scroll, text measurement, insets, theme control.
- **Contributable extension points (merge strategy + contribution type):** `renderer/layers` (collect, `LayerContribution` — custom Canvas layers; order via `ctx.claimOrder("renderer/layers", …)`), `renderer/hitTest` (first, `HitTester`), `renderer/insets` (reduce, `InsetContribution` → per-side sum), `renderer/domOverlays` (collect, `DomOverlayContribution` — HTML in content coordinates, kept scroll-aligned), `renderer/contentExtent` (collect, `ContentExtentContribution` → per-axis max), `renderer/rowGeometry` (first, `RowGeometryProvider` — supply the row geometry the grid-lines/stripes/hover passes paint from; the official contributor is tree-grid, but a composition with a third-party row model contributes here instead), `view/panes` (collect, `PaneContribution`), `view/bottomPanes` (collect, `BottomPaneContribution`), `timeline/zoomLevels` (collect, `ZoomLevel`). All accept third-party contributions; internalized official contributions (grid-lines, today-line) do not close the points — `renderer/layers` remains a public collect point.
- **Subscribable events:** the `pointer/*` input stream (`pointer/barHover`, `pointer/barDown`, `pointer/barMove`, `pointer/barUp`, `pointer/background` — 5), `view/scrolled`, `view/bottomPaneResized`.
- **Commands:** `timeline/zoomIn`, `timeline/zoomOut`, `view/paneToggle`, `view/setViewMode`, `view/setBottomPaneHeight` are publicly emittable.
- **Overlay corner slots:** corner-anchored overlays position against the published `--sg-safe-*` variables on `chartPaneElement()` and claim their corner via `ctx.claimSlot("overlay-corner", slot, candidates)`.
- **Reserved namespaces (documentation convention only):** `pointer/`, `view/`, `timeline/` event namespaces; `renderer/`, `view/`, `timeline/` extension-point scopes; the `renderer/layers` order scope and the `overlay-corner` slot group; the `stargantt.view` / `stargantt.timeline` / `stargantt.theme` service IDs. Not enforced in core.
