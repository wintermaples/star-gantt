import { T0 } from "../../../lib/data";
import type { PluginDoc } from "../../types";

const DAY = 86_400_000;

// A five-day band inside the shared sample's own date window, so the overview and gridLines
// demos' zone lands on screen rather than off the right edge of the default day-zoom viewport.
const ZONE_START = T0 + 6 * DAY;
const ZONE_END = ZONE_START + 5 * DAY;

const doc: PluginDoc = {
  id: "stargantt.view",
  summary:
    "Owns everything on screen except the bars themselves: the three-canvas renderer, pane layout and dividers, theming, the timeline axis and header, and the background grid and today line.",
  overview: [
    "This is the biggest single package in the library: the renderer, pane layout, theming, the timeline axis and the background grid and today line all live here as one package, because they are never independent in practice. Ninety-plus cross-references between them (timeline reading theme's tokens, panes owning the renderer's row, grid-lines borrowing the timeline's calendar arithmetic) become ordinary internal function calls instead of service lookups across a plugin boundary. Config is ten fields on one factory, five of them nesting a whole feature area's config under its own name (`theme`, `timeline`, `gridLines`, `todayLine`, `panes`) and five staying flat because they are the renderer's own top-level options (`direction`, `progressive`, `dirtyRegions`, `prefetch`, `scroll`).",
    "It depends on nothing but `stargantt.data-store` — the today line and the header need the date domain, `autoExtendOrigin` follows the `data.tasks` store, and grid-line shading reads `query().calendars` — and it knows nothing about tasks as objects on a chart. Everything domain-shaped is a contribution: task-bars paints into `renderer/layers`, tree-grid supplies the row geometry the background passes need through `renderer/rowGeometry`, and the grid pane itself is a `view/panes` contribution like any third party's would be. Remove this plugin and nothing else has a canvas, a scroll viewport, a pane row or a coordinate system to draw into.",
    "Three canvases — background, main, overlay — composite once per frame from whatever registers a `renderer/layers` contribution; this plugin's own internal grid-lines and today-line modules use that same point rather than a private hook, at claimed orders 10 and 55 respectively, so a third party can slot painting between them on equal terms. Hit testing, insets, DOM overlays and horizontal content extent all work the identical way: this plugin owns the point, everyone — including its own internal modules — is a contributor.",
    "The library's store-first design lands hardest here: `viewport`, `viewMode`, the active `zoomLevel` and the theme's `tokens` are stores a subscriber reads and watches directly, rather than `view/modeChanged`, `timeline/zoomChanged` or `theme/changed` events. `view/scrolled` is a retained event alongside the `viewport` store, because a scroll is also an input a third party wants to react to as a discrete moment, not only as a state to poll.",
  ],
  whenYouNeedIt:
    "always. Nothing else in the library owns a canvas, a scroll viewport, a pane row or a coordinate system — task-bars, dependency lines, the grid pane and the timeline header all sit on services this plugin provides rather than any of them owning one itself.",
  demo: { preset: { treeGrid: { rowHeight: 30, paneWidth: 200 } } },
  // A bundled palette is the one option whose effect reaches every mark on the chart at once —
  // bars, header, gridlines, row stripes — which is the truest single-picture demonstration that
  // this plugin, not each of the things painting on top of it, is where colour actually comes from.
  overviewDemo: {
    kind: "configured",
    spec: {
      preset: {
        view: { theme: { preset: "high-contrast-dark" } },
        treeGrid: { rowHeight: 30, paneWidth: 200 },
      },
    },
    caption:
      "Bars, header, gridlines and row stripes all changed colour from one nested option, `theme.preset`, because none of the plugins painting them holds a colour of its own — every one of them asks this plugin for its palette.",
  },

  properties: [
    {
      name: "direction",
      prose: [
        "Flips the chart's base text direction. Set `\"rtl\"` and this plugin marks the chart pane `dir=\"rtl\"` (so its own DOM chrome — scrollbars, DOM overlays — mirrors the way any right-to-left web page does), sets each canvas context's text direction for shaped glyphs, flips which physical edge its own synthetic scrollbars and safe-area insets treat as the inline start, and reports `\"rtl\"` from `ViewService.direction()` for every other plugin to read.",
        "That report is the whole story past this plugin's own scrollbar and safe-area logic — no official plugin, including this one's own internal timeline header and grid-lines passes, currently reads `direction()` to mirror its geometry. Setting this option alone moves the DOM chrome and the text shaping and nothing else: the axis still runs left-to-right, the tree column still sits on the left, and bars still paint at ascending x for ascending time. A composition that wants a fully mirrored chart needs a third-party (or future official) plugin that consults the signal for its own geometry — this option is the report, not the mirror.",
        "It is fixed at setup — there is no runtime toggle. A chart that needs to switch direction live is rebuilt, the same as a language switch would be.",
      ],
      demo: {
        kind: "values",
        values: [
          { label: 'default ("ltr")', demo: {} },
          { label: '"rtl"', demo: { preset: { view: { direction: "rtl" } } } },
        ],
      },
    },
    {
      name: "scroll",
      prose: [
        "The two settings a host reaches for to change how the chart's own virtual scrolling feels, nested together because both answer the same underlying question — this plugin draws its own scroll affordance rather than relying on a native `scrollHeight` container, so it also owns the two things a browser's own scrollbar would otherwise decide for you.",
        "`scrollbar` turns the synthetic vertical and horizontal thumbs on or off together — there is no per-axis switch — and each one only appears while its own axis actually overflows the viewport. They float over the content and reserve no layout space, but on they do reserve a small strip in the pane's published safe area (`--sg-safe-*`) so a corner overlay never gets jumped the moment content starts to overflow; off, that reservation is given back. Turn this off for a host drawing its own scroll affordance — a minimap, an external slider bound to `ViewService.scrollTo` — that does not want this plugin's own thumb competing for the same pointer target along the content edge.",
        "`wheelSpeedFactor` is a flat multiplier on wheel deltas before they are clamped into the scrollable range, applied uniformly to both axes and every wheel event — there is no per-axis or per-device variant, so trackpad and mouse-wheel deltas are multiplied the same way. Non-finite or non-positive values are silently ignored and the factor falls back to 1. It changes nothing about a static chart: with no scroll gesture in flight, every value paints an identical screenshot, so its effect is only ever felt, tried by hand rather than judged by eye — 0.4 for a host that finds the default too twitchy on a high-resolution trackpad, 2–3 for one compensating for an unusually low-sensitivity wheel device.",
      ],
      demo: {
        kind: "values",
        values: [
          { label: "default (scrollbar: true, wheelSpeedFactor: 1)", demo: { height: 160 } },
          {
            label: "{ scrollbar: false }",
            demo: { height: 160, preset: { view: { scroll: { scrollbar: false } } } },
          },
        ],
      },
    },
    {
      name: "panes",
      prose: [
        'If a host dispatches `view/setViewMode` before the chart reaches ready — for example from code that runs immediately after `create()` — that dispatch is queued and wins over this option once panes exist: the deferred dispatch is the later intent. So a reader who sets `initialViewMode: "grid"` and still sees "split" on first paint is not looking at a bug; they are looking at a startup dispatch that beat the option to it. The other trap runs the other way: a typo here, like "grdi", never throws — it is a silent no-op, exactly like dispatching an unrecognised mode with `view/setViewMode`, so the chart simply stays on "split" and a misspelled value reads to the developer as "this option does nothing" rather than as the config error it actually is.',
        "The three modes trade the same real estate three ways. \"split\" is the familiar layout — grid, chart and any right-side pane sharing the row — and needless to set explicitly since it is also what happens if you configure nothing. \"grid\" hands the whole row to the table, worth reaching for when a reader's task right now is scanning or editing fields rather than reading a timeline; it is silently ignored if the composition has no left-side pane to grow into. \"gantt\" is the inverse: hide the grid and any side panel, and let the timeline take the full width — the mode worth defaulting to on a chart embedded specifically to show a schedule and nothing else.",
        "Because the switch is `display`-only and content never unmounts, starting in \"grid\" or \"gantt\" costs nothing extra at startup beyond what the hidden panes would have cost anyway — their `mount()` still runs, their listeners still attach. What you're really choosing is which parts of an already-built layout are visible on the first frame.",
      ],
      demo: {
        kind: "values",
        values: [
          { label: 'default ("split")', demo: {} },
          { label: '"grid"', demo: { preset: { view: { panes: { initialViewMode: "grid" } } } } },
          { label: '"gantt"', demo: { preset: { view: { panes: { initialViewMode: "gantt" } } } } },
        ],
      },
    },
    {
      name: "theme",
      prose: [
        "Most of theming needs no configuration at all: dark mode is plain CSS — a `prefers-color-scheme` media query or a `class`/`data-theme` attribute flip on the chart root — and this plugin re-reads and repaints without a single option set. This nest is for the cases past that: pinning one chart to a scheme regardless of what the page decides, switching between named palettes at runtime instead of only at build time, and making the canvas — which forced-colors mode cannot see, because it isn't DOM — follow a Windows High Contrast palette the way the rest of the page already does.",
        "`preset` applies a named palette as soon as the plugin activates, before the first paint, so there is no flash of the default look. The two bundled names (`\"high-contrast\"`, `\"high-contrast-dark\"`) are accessibility palettes tuned past the shipped theme's own contrast floor; anything else has to be registered first through `presets`, a map of additional named palettes — each entry either a flat `--sg-*` token map or `{ colorScheme?, tokens }` when the palette should also pin a scheme while active. A key that reuses a bundled name replaces it wholesale rather than merging into it, and a preset that leaves some canvas-read tokens untouched while leaving the scheme unpinned lets those tokens keep following the OS underneath an otherwise-fixed-looking palette.",
        "`colorScheme` outranks a preset's own scheme pin and follows a chart rather than the page: with nothing set, the chart follows whatever `color-scheme` the page has in force, which stops being correct the moment one chart needs to look different from its neighbours — a light-mode chart embedded in a dark-mode dashboard, a screenshot generator that always wants light output. A host that overrides tokens for a pinned chart has to write those overrides on a selector matching the chart element itself, since the pin re-declares tokens there and a `:root` rule sits below the more specific one.",
        "`forcedColors` and `diagnostics` are the two settings worth turning on early and rarely touching again: the first makes canvas-read tokens resolve to CSS system colours for as long as `(forced-colors: active)` matches, which is the only way a bitmap canvas can honour a Windows High Contrast session the way the surrounding DOM already does; the second logs two setup-time console warnings — a retired token still declared, a partial palette left unpinned — and changes no painted pixel, so it costs nothing to leave on besides a message that fires at most once per chart.",
      ],
      demo: {
        kind: "values",
        values: [
          { label: "default (none)", demo: {} },
          {
            label: '{ preset: "high-contrast-dark" }',
            demo: { preset: { view: { theme: { preset: "high-contrast-dark" } } } },
          },
          {
            label: '{ colorScheme: "dark" }',
            demo: { preset: { view: { theme: { colorScheme: "dark" } } } },
          },
        ],
      },
    },
    {
      name: "timeline",
      prose: [
        "`origin` is the instant placed at content x = 0 on first paint, defaulting to the start of the current UTC day — which is why a chart built from data starting \"today\" needs no configuration at all, by coincidence rather than any special-casing. Get it wrong and the symptom is a chart that opens on empty space, or one that opens mid-project with earlier tasks off to the left of a scrollbar the reader has no reason to move. `autoExtendOrigin` is the repair for the same failure mode when it happens after the fact: a dragged or newly loaded task starting earlier than the fixed origin otherwise lands at a negative content x no scroll gesture can reach, and with this on, the chart widens the floor to whichever is earlier, `origin` or the earliest task's UTC day, instead of only reporting the condition through `core/pluginError`.",
        "`initialZoom` picks which registered level is active on first paint, by id — the six built-ins or a level a third party contributed to `timeline/zoomLevels` — and decides only the opening density; the Ctrl+wheel gesture and the zoom commands are unconstrained by it afterward. `zoomLevels` replaces the six built-ins wholesale when given a non-empty array, for a project domain that does not fit calendar time cleanly (shift numbers, an irregular fiscal calendar); levels other plugins contribute through the extension point of the same name stack on top regardless. Once you supply this, `initialZoom` has to name one of your own ids — the built-in names mean nothing anymore unless you happen to reuse them.",
        "`firstDayOfWeek` is arithmetic only, not wording: it decides where a week cell's boundary falls, while the label text painted in that cell comes from the chart's `locale` alone and does not shift with it — a chart can validly want Monday-start weeks with Japanese labels. `fiscalYearStartMonth` reshapes the built-in month/quarter/year levels so their boundaries start on that calendar month instead of January; only integers 2 through 12 count as an explicit fiscal year, and a fiscal year cell is labelled with the calendar year it *starts* in, so an April 2026 fiscal year reads \"2026\" through to March 2027.",
        "`calendar` and `displayTimeZone` change wording and cell boundaries respectively, never what is stored: task dates stay UTC epoch milliseconds in the store regardless of either. `calendar` is an Intl calendar identifier (`\"japanese\"` for era-based years, `\"buddhist\"` for Thai solar years) for header labels and `TimelineService.formatDate`; `displayTimeZone` is an IANA zone name that shifts where the header's own cell boundaries fall, including the odd 23- or 25-hour days a daylight-saving transition produces at hour zoom. `unitBoundaries` and `formatDate` both follow the configured zone, so a tooltip built from either agrees with what the header paints.",
        "`headerRowRatio` and `headerLabelPadding` are the two purely cosmetic knobs: the first splits the header's fixed height between its coarse top row and fine bottom row (a number strictly between 0 and 1, default an even 0.5) and only applies to two-row header shapes — every built-in level is one, so it only stops applying once a custom `zoomLevels` entry departs from that shape. The second is the CSS-pixel gap kept between a label and its cell's edges, which governs how aggressively labels thin out as a zoom level gets tight. `headerCellFormat`, a per-cell label hook overriding a scale row's own `format`, is a latched fault barrier like every paint-loop callback here: the first throw is reported once and the hook then declines for the instance's life, falling back to the row's own formatting.",
      ],
      demo: {
        kind: "values",
        values: [
          { label: 'default ("day", calendar year, UTC)', demo: {} },
          { label: '{ initialZoom: "week" }', demo: { preset: { view: { timeline: { initialZoom: "week" } } } } },
          {
            label: "April fiscal year, quarter zoom",
            demo: { preset: { view: { timeline: { fiscalYearStartMonth: 4, initialZoom: "quarter" } } } },
          },
          {
            label: '"Asia/Tokyo" display zone, hour zoom',
            demo: { preset: { view: { timeline: { displayTimeZone: "Asia/Tokyo", initialZoom: "hour" } } } },
          },
        ],
      },
    },
    {
      name: "gridLines",
      prose: [
        "This plugin's internal grid-lines module paints the ground the rest of the chart is read against — vertical lines at the header's own time boundaries, horizontal lines at row edges, alternating row bands, and up to four kinds of background shading — all at claimed order 10, underneath every layer that carries meaning. `vertical` is the one most readers touch first and then rarely again: \"major\" (the default) draws one line per coarse header row, \"both\" adds the fine boundary too for a chart where the reader is expected to count days rather than skim months, and \"none\" is for embedding the chart inside a page that already carries its own ruled background.",
        "`horizontal` is off by default because `rowStripes` — on by default — already carries the same information (which row a bar belongs to) with far less ink; a rule under every single row, once the chart is more than a screenful tall, starts reading as a mesh rather than as structure. Reach for it on a dense, short-row chart closer to a spreadsheet than a timeline. `rowStripes` parity is the row's own logical index, not a count of what happens to be visible, which matters because rows are virtualized — deriving parity from the visible pass instead would flip the whole pattern as you scrolled.",
        "`nonWorkingDays` is on by default, shading weekends against the built-in Saturday/Sunday UTC pattern. Its object form has two independent knobs and they do not combine the way the names suggest: `weekend` only ever affects that built-in fallback path, while `calendar` names a `CalendarDef` id to read from the loaded dataset (`query().calendars`) and evaluate through the shared working-time engine instead — an id the store does not have degrades silently back to the weekend fallback, and once a named calendar resolves, `weekend` has no effect on it at all. There is no \"registry default\" auto-detection: with `calendar` unset the pass always uses the fallback, never an implicit best-guess calendar.",
        "`nonWorkingHours` hatches the off-hours of an otherwise-working day on top of the tint `nonWorkingDays` already paints, and only ever marks gaps inside a single UTC day — a band running from Friday evening across the weekend is non-working time, not off-hours, and gets the tint alone. It needs a named `nonWorkingDays.calendar` whose `CalendarDef` actually defines `workingHours`; without one it draws nothing, a deliberate silent no-op rather than a guess.",
        "`zones` and `rowHover` are the two options with nothing to do with calendars at all. A zone is a plain `[start, end)` millisecond range with an optional color, for a span the calendar has no opinion about — a sprint window, a release freeze; a color string starting with `--` resolves as a theme token and follows light/dark theming (and is deliberately left unpainted under forced-colors, so an arbitrary author color never overrides a system high-contrast palette), while anything else is a literal canvas color. `rowHover` fills the row under the pointer with the same token the grid pane's own CSS hover rule uses, so both panes highlight identically; it carries no selection state and fires no event, and it costs one paint-time lookup per pointer move at most.",
      ],
      demo: {
        kind: "values",
        values: [
          { label: "default (major lines, stripes on, weekends shaded)", demo: {} },
          { label: '{ vertical: "both" }', demo: { preset: { view: { gridLines: { vertical: "both" } } } } },
          {
            label: "{ horizontal: true, rowStripes: false }",
            demo: { preset: { view: { gridLines: { horizontal: true, rowStripes: false } } } },
          },
          {
            label: "{ nonWorkingDays: false }",
            demo: { preset: { view: { gridLines: { nonWorkingDays: false } } } },
          },
          {
            label: "one zone, token color",
            demo: {
              preset: {
                view: { gridLines: { zones: [{ start: ZONE_START, end: ZONE_END, color: "--sg-grid-zone" }] } },
              },
            },
          },
        ],
      },
    },
    {
      name: "todayLine",
      prose: [
        "A gantt chart's bars encode two kinds of time — when work is planned, when it actually happened — and neither tells you where \"now\" sits without something drawn on top of them. This plugin's internal today-line module is that something: one solid vertical line at the start of the current UTC day, repainted on every scroll and zoom and re-armed by its own timer so it walks forward at midnight without anyone reloading the page. It draws by default and needs no configuration; `false` is the explicit way to switch the whole pass off.",
        "`statusDate` adds a second, dashed line — a different kind of \"now\": the instant your progress figures (percent complete, a portfolio's SPI/CPI, conditional-format's RAG status) are measured as of, which very often is not today. A status report locked on Friday afternoon and reopened on Monday still means Friday's numbers, and without this the chart has no way to say so past a caption. The two lines coexist on purpose — when they land on the same date, the solid line paints last and wins, which loses nothing since the dates agree anyway.",
        "The value is read once, at setup, and never again: a dashboard letting a reader pick a different status date has to rebuild the plugin (or the whole chart) with the new value. Anything `Date.parse` cannot make sense of, a non-finite number, or an invalid `Date` is silently dropped rather than thrown, so a typo in a hand-written date string simply produces no line, with nothing in the console to say why.",
      ],
      demo: {
        kind: "values",
        values: [
          { label: "default (today line on, no status date)", demo: {} },
          {
            label: "statusDate 3 days out",
            demo: { preset: { view: { todayLine: { statusDate: T0 + 3 * DAY } } } },
          },
          { label: "false (today line off)", demo: { preset: { view: { todayLine: false } } } },
        ],
      },
    },
    {
      name: "progressive",
      prose: [
        "Marks every frame painted while the chart is actively scrolling with `Viewport.detail === \"coarse\"`, so a layer contribution that does expensive per-frame work — text shaping, gradients, anything proportional to the visible row count — can skip it while the view is moving and repaint at full fidelity once scrolling settles (a short quiet period triggers exactly one full \"fine\" repaint).",
        "Writing a contribution that takes advantage of it means branching its draw on `viewport.detail`: on \"coarse\" it should still paint every visible item's position and size correctly, but skip the parts that cost more than a flat fill. Getting this wrong in the cheap direction (skipping geometry, not decoration) makes bars appear to jump during a scroll; getting it wrong in the expensive direction is merely a missed optimization.",
        "Reach for this on datasets large enough that per-frame paint cost is the bottleneck during a scroll fling — at small row counts a full-detail repaint every frame is already cheap enough that the coarse/fine split adds a state machine for no payoff.",
      ],
      demo: {
        kind: "none",
        reason:
          "No official layer contribution currently reads Viewport.detail, so with only presetStandard() plugins enabling this option repaints byte-identically to leaving it off — there is nothing on the shared sample chart for a reader to see change.",
      },
    },
    {
      name: "dirtyRegions",
      prose: [
        "Lets a layer's `invalidate()` calls carry a rectangle and have the repaint clipped to the union of those rectangles instead of the whole viewport — the difference between repainting one bar's few thousand square pixels and repainting the whole canvas because that one bar moved.",
        "Computing a correct rect means bounding the union of everywhere a draw actually changed pixels — not the item's bounds before the move, not just its bounds after, but both, or the old position's paint is left on screen as a smear. Any `invalidate()` call that omits the rect (scroll, resize, a DPR change, a contribution not yet taught to compute one) forces a full repaint of that layer for that one pass only, so one careless rect-less call does not disable narrowing permanently.",
        "As with `progressive`, none of the officially bundled contributions currently pass rectangles to `invalidate`, so enabling this against the default preset changes no pixel a reader can compare — the payoff belongs to a contribution written to take advantage of it.",
      ],
      demo: {
        kind: "none",
        reason:
          "No official contribution invalidates with a rectangle, so with only presetStandard() plugins this option changes no repaint a reader could see against the shared sample — every invalidation already targets the whole layer either way.",
      },
    },
    {
      name: "prefetch",
      prose: [
        "Extrapolates recent scroll velocity into an off-screen viewport a short distance ahead (`ViewService.predictedViewport()`) and, after each painted scroll frame, runs a warm off-screen composite over that predicted region so contribution-side caches — measured text widths, resolved theme tokens, built paths — are already hot by the time the real scroll reaches it.",
        "The warm pass touches no on-screen canvas and emits nothing observable; it exists purely to move cache-population cost earlier, off the frame where a reader would otherwise notice a stutter on first paint of freshly-scrolled-in content. Its value scales with how much per-item work a contribution's draw does and how large the dataset is.",
        "It is not free: every scroll frame does the extra work of an off-screen composite pass, competing for the same frame budget as the on-screen one. Pair it with `progressive` on very large datasets rather than turning it on in isolation on a small chart, where the extra composite is pure cost with nothing to prefetch into.",
      ],
      demo: {
        kind: "none",
        reason:
          "predictedViewport() and the warm pass touch no on-screen canvas and emit no event, so there is no pixel or DOM difference a chart demo could show — its effect is a cache-population timing change, not a visual one.",
      },
    },
  ],

  notes: {
    services: {
      "stargantt.view":
        "The service every other plugin reaches for to invalidate a layer, read the live viewport, get the chart pane element, or scroll programmatically — plus the `viewport` and `viewMode` stores a subscriber watches instead of listening for a mode-change event. The pane element it hands back carries the resolved safe area as four inline custom properties — `--sg-safe-top`, `--sg-safe-right`, `--sg-safe-bottom`, `--sg-safe-left` — so a plugin placing a floating panel writes `calc(var(--sg-safe-top, 0px) + 8px)` and lands clear of the header and scrollbar strips without measuring anything itself.",
      "stargantt.timeline":
        "The service that turns a date into an x position and back — `tToX` / `xToT` — plus the runtime zoom and origin movers, `levelMetrics()` for reading the ladder's densities without activating a level, `unitBoundaries` for the exact calendar boundaries a consumer needs to agree with the header on, `gridCellAt` for the one-cell span an insert gesture should use, and the `zoomLevel` store a subscriber watches instead of listening for a zoom-change event. Ask here before any plugin computes a screen position from a date itself; disagreeing with this service is disagreeing with what the reader sees.",
      "stargantt.theme":
        "The read path every other official plugin uses for colour: `theme.get(token) || FALLBACK`, plus the `tokens` store a subscriber watches instead of listening for a theme-change event. Reach for it yourself the moment a plugin you write paints anything — a custom overlay, a `renderBar` decoration — so it inherits presets, forced-colors and the scheme pin for free instead of hardcoding a colour that ignores all three.",
    },
    events: {
      "view/scrolled":
        "This plugin is the sole emitter — every scroll mutation, including one requested through `ViewService.scrollTo` by another plugin (tree-grid's own wheel path, routed through the shared viewport rather than moving its pane directly), is announced from here and nowhere else. The `viewport` store is set in the same pass, so a subscriber that only needs the current value can read the store instead of tracking this event.",
      "pointer/barDown":
        "The raw pointer event, captured and re-emitted annotated with the hit-test result and viewport-local coordinates. A press here also starts a gesture, whose movement and release arrive as `pointer/barMove` and `pointer/barUp` — this is the event task-bars' drag handles and dependency-line anchors are built on.",
      "pointer/barHover":
        "Resolved at most once per animation frame, on the latest recorded pointer position — never during an active gesture — so it trails the pointer by up to one frame and carries no raw event. Cheaper to subscribe to than polling `renderer/hitTest` yourself on every pointer move.",
      "pointer/background":
        "A press that hit nothing — no `HitResult` — which also starts a gesture whose subsequent `pointer/barMove`/`pointer/barUp` carry no `hit`. This is what a rubber-band selection or a background context menu is built from.",
      "view/bottomPaneResized":
        "The event twin of a bottom pane's own `onResize` callback — same information, but reachable by anything subscribing rather than only the contribution that owns the pane. Useful for a host that wants to persist a strip's height without being the plugin that mounted it.",
    },
    commands: {
      "timeline/zoomIn":
        "One density step finer, on the same ladder the Ctrl+wheel gesture climbs — the two inputs can never disagree about which direction is \"in\" because both read the same list ordered by density rather than by contribution order.",
      "timeline/zoomOut":
        "One density step coarser. Both zoom commands are silent no-ops at either end of the ladder — no error, no event — so a toolbar button wired to them needs no manual bounds checking.",
      "view/paneToggle":
        "Only affects a pane whose contribution opted into `collapsible: true`; targeting any other pane, or an unknown id, is a silent no-op rather than an error, so a toolbar button wired to this command never needs to check first whether the target supports it.",
      "view/setViewMode":
        "The live counterpart of `panes.initialViewMode` — dispatch this any time after mount to change modes, including before `lifecycle/ready`, where it is queued and applied once panes exist. Not undoable: this is view state, not a change to the schedule, so it never enters the undo stack drag-edit and the data store share.",
      "view/setBottomPaneHeight":
        "Height changes here route through the same clamp a pointer drag would hit, so a contributor cannot use this command to push a strip past its own effective range. Setting exactly 0 is the one value that releases a strip entirely rather than clamping up to a floor.",
    },
    extensionPoints: {
      "renderer/layers":
        "The point every visible pixel goes through. A contribution is a plain `{ id, zIndex, draw }` object, and `zIndex` does double duty: its band picks which of the three canvases (background/main/overlay) the contribution paints into, and within that canvas it also orders the draw against the canvas's other contributions. This plugin's own grid-lines (order 10) and today-line (order 55) modules are ordinary contributors here, arbitrated through `claimOrder` on equal terms with anyone else's.",
      "renderer/hitTest":
        "First strategy: the first tester to return a hit wins and later ones are never asked. Order contributions from most specific target (a resize handle) to least (a bar body) if you add your own, the way task-bars already does.",
      "renderer/insets":
        "Reserves chart-body edge space for chrome that must stay inside the scrollable pane, as opposed to chrome outside every pane, which is the `view/panes`/`view/bottomPanes` points' domain instead. Contributions stack outermost-first by order and the side reserves their sum; the internal timeline header contributes the top strip through this point.",
      "renderer/domOverlays":
        "The sanctioned way to place real HTML inside the chart body without owning a renderer yourself — a wrapper this plugin keeps pixel-aligned with the canvases as the chart scrolls, in the same frame the scroll itself repaints.",
      "renderer/contentExtent":
        "How this plugin learns how far there is to scroll. tree-grid contributes the vertical extent and task-bars the horizontal one; an axis nobody contributes to stays unbounded, which is what keeps the chart scrollable even in a minimal composition.",
      "renderer/rowGeometry":
        "Strict downward-only service consumption means this plugin cannot reach up to ask tree-grid for row geometry, so tree-grid instead contributes a `RowGeometryProvider` down into this point. First strategy — the first contributor wins — and with none at all, the row-dependent background passes (horizontal lines, row stripes, row hover) silently draw nothing while the vertical passes are unaffected. Repaint responsibility belongs to the contributor: whenever its geometry changes, it must call `ViewService.invalidate(\"background\")` itself.",
      "view/panes":
        "Collect strategy: every contribution becomes a side pane, sorted by side then order. This is how tree-grid's grid pane exists without this plugin knowing tree-grid exists, and it is open to third-party contributions on the same terms — mounted on `lifecycle/ready`.",
      "view/bottomPanes":
        "Collect strategy, stacked downward by ascending order — full-width strips below the pane row. A third party adding a filter bar or a summary strip underneath the chart contributes here.",
      "timeline/zoomLevels":
        "Where a level — built-in, configured through `timeline.zoomLevels`, or contributed by a third-party plugin — joins the ladder `setZoomLevel`, the zoom commands and the Ctrl+wheel gesture all read from. Collect strategy: everything contributed stacks, and this plugin's own `zoomLevels` option changes only what it itself contributes, never what others add.",
    },
  },

  recipes: [
    {
      title: "Build a right-to-left chart base",
      intent:
        "Set the chart's reading direction once, so every plugin that consults ViewService.direction() can mirror consistently — remembering that today, only this plugin's own scrollbars and safe area actually do.",
      code: `presetStandard({
  view: { direction: "rtl" },
})`,
    },
    {
      title: "Tune the performance tier for very large datasets",
      intent:
        "At ten-thousand-plus rows, moving per-frame cost off the scrolling frame and clipping repaints to what actually changed is the difference between a smooth fling and a visible stutter. Off by default because at ordinary row counts the extra bookkeeping is pure cost.",
      code: `presetStandard({
  view: {
    progressive: true,   // coarse detail while scrolling, one fine repaint at rest
    dirtyRegions: true,  // rect-scoped invalidate() calls repaint only their region
    prefetch: true,      // warm caches for the viewport scrolling is about to reach
  },
})`,
    },
    {
      title: "Start a chart already in table view",
      intent:
        "An embed whose first job is letting the reader scan and edit fields, not read a timeline — skip the chart entirely on first paint instead of asking the reader to switch to it.",
      code: `presetStandard({
  view: { panes: { initialViewMode: "grid" } },
})`,
    },
    {
      title: "Ship an in-app high-contrast toggle",
      intent:
        "Give users an accessibility switch that swaps the whole palette at runtime, rather than shipping two builds or asking them to change their OS settings.",
      code: `const gantt = create({ element: el, plugins: presetStandard() });

function setHighContrast(on: boolean) {
  gantt.service("stargantt.theme").setPreset(on ? "high-contrast" : null);
}`,
    },
    {
      title: "Show a fiscal calendar to a Tokyo-based team",
      intent:
        "Combines a fiscal year offset with wareki-era labels and a local display zone — three independently orthogonal timeline options that commonly travel together for this kind of audience.",
      code: `presetStandard({
  view: {
    timeline: {
      fiscalYearStartMonth: 4,     // April fiscal year
      calendar: "japanese",        // Reiwa-era year labels
      displayTimeZone: "Asia/Tokyo",
    },
  },
})`,
    },
    {
      title: "Show a status date alongside today, for a locked weekly report",
      intent:
        "The chart may be opened any day, but the progress figures on it are only ever correct as of the last status date. Drawing both lines keeps that distinction visible instead of relying on a caption.",
      code: `const statusDate = new Date("2026-08-14T00:00:00Z").getTime(); // last Friday close

presetStandard({
  view: { todayLine: { statusDate } },
})`,
    },
    {
      title: "Highlight a release freeze without touching the calendar",
      intent:
        "A zone is the right tool when the span is a project fact, not a working-day fact — it needs no calendar data and no per-task field.",
      code: `presetStandard({
  view: {
    gridLines: {
      zones: [{ start: freezeStart, end: freezeEnd, color: "--sg-grid-zone" }],
    },
  },
})`,
    },
  ],
};

export default doc;
