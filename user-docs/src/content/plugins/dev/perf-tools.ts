import type { PluginDoc } from "../../types";

/**
 * `stargantt.perf-tools` is opt-in (it is not part of `presetStandard()`), so — exactly like every
 * other opt-in plugin on this site whose properties need their own live instance — the page-level
 * `demo` mounts nothing. `PluginConfigPage.tsx`'s `mergeSpecs` always starts from `doc.demo` and
 * then concatenates the `plugins` builder of whichever value is currently chosen for every
 * "values" property on the page. If `doc.demo` here already called `sg.perfTools()`, choosing any
 * non-default value of `overlay`, `position`, `sparkline`, `budgetMs`, `windowSize` or `messages`
 * would concatenate a second `perfTools(...)` instance on top of it and PluginHost would throw
 * `duplicate plugin id "stargantt.perf-tools"`. So `values[0]` on every property below reads "not
 * composed" rather than the plugin's true default (`overlay: true` etc.); the true default is one
 * click away as the second value, which mounts a bare `sg.perfTools()`.
 *
 * This does NOT make the page safe against two properties being at a non-default value at once —
 * `mergeSpecs` concatenates the `plugins` builder of every property currently off its default, so
 * picking non-default values on two pickers at the same time would mount `perfTools(...)` twice
 * and PluginHost throws duplicate plugin id. That gap is in the shared page harness (`mergeSpecs`
 * has no per-plugin-id de-duplication), not something this module can route around; the same
 * trade-off every other opt-in-plugin page on this site accepts.
 */
const doc: PluginDoc = {
  id: "stargantt.perf-tools",
  summary:
    "A floating frame-time overlay and a start/stop trace recorder for diagnosing paint performance — opt-in, invisible to end users, and inert unless something is asking it to measure.",
  overview: [
    "This plugin draws nothing into the chart and changes no other plugin's behaviour. It appends one small, `pointer-events: none`, `aria-hidden` box to the chart pane — an FPS readout and, by default, a sparkline of recent frame durations against a budget line — and it owns a start/stop recorder that captures per-frame durations, named instant marks and named counters into a JSON-serializable trace. Because the view plugin publishes no per-frame event on the public surface, and a dev tool also needs to see frames in which nothing painted, the plugin measures its own `requestAnimationFrame` loop rather than listening to anyone else's paint calls.",
    "That loop is not free-running: it exists only while something is consuming it — the overlay visible, or a recording in progress — and is cancelled the moment neither is true. A chart shipped with `overlay: false` and no recorder ever started performs zero per-frame work from this plugin; a chart with the default overlay on pays one rAF callback and a throttled 250ms text update for the life of the instance. That is also why it is a category of its own (`dev`) alongside `i18n` rather than folded into an existing category: it is developer tooling that happens to be an ordinary plugin, not a feature an end user's chart is expected to ship with turned on.",
    "The service (`stargantt.perf-tools`) is the part meant to outlive the demo you are looking at on this page: `mark()` and `count()` let your own code — a data-load path, a materialize step, a custom render hook — drop instants and counters into whatever recording is running, and `exportJson()` hands you the whole thing as a string a host page can download or POST to a collector.",
  ],
  whenYouNeedIt:
    "while you are chasing a specific perceived-slowness report, tuning a large dataset's zoom or scroll path, or want a trace to attach to a bug report — not for production. Every reader-facing chart should ship with this plugin absent or fully quiet.",
  demo: {},
  // The whole plugin is visible from a bare `perfTools()` — `overlay` defaults to true — so the
  // smallest configuration that shows it doing something is simply composing it, which the
  // page-level `demo` deliberately cannot do (see the module comment above). None of this page's
  // other charts claim an `overlay-corner` slot at their defaults — presetStandard()'s interaction
  // plugin only claims one when its filter toolbar or zoom toolbar is turned on, and scheduling
  // only claims one when its diagnostics panel is — so the plugin's own default "top-right" request
  // is the first and only claimant here and is granted outright.
  overviewDemo: {
    kind: "configured",
    spec: { plugins: (sg) => [sg.perfTools()] },
    caption:
      "The floating box in the chart pane's top-right corner, sitting just below the timeline header rather than over it, is the whole plugin: current frames per second, average frame time, and one sparkline bar per recent frame measured against the budget guide line.",
  },

  properties: [
    {
      name: "overlay",
      prose: [
        'Whether the floating readout exists at all, and whether it starts visible. Defaults to `true`, so simply mounting `perfTools()` with no config puts a small "N fps · N.N ms" box in the corner of the chart pane immediately — nothing else needs to be configured for the plugin to be doing something you can see.',
        "`overlay: false` is not merely \"start hidden\" — it means no DOM is created at all, and no `overlay-corner` slot is claimed, until something asks for it. `setOverlayVisible(true)` on the service creates the element lazily on that first call, which is the intended pattern for a host that wants the overlay reachable from a debug menu or a keyboard shortcut without paying for it (or squatting a corner) on every chart that composes this plugin. Because `overlay: false` produces literally nothing in the chart pane, it renders identically to not composing the plugin at all — which is why this option's demo below only shows two states rather than three: there is no honest third picture to show for \"off\".",
      ],
      demo: {
        kind: "values",
        values: [
          { label: "not composed (no overlay)", demo: {} },
          { label: "true (default, overlay shown)", demo: { plugins: (sg) => [sg.perfTools()] } },
        ],
      },
    },
    {
      name: "position",
      prose: [
        'Which corner the overlay floats in, 12px in. The corners are corners of the chart pane\'s *safe area* rather than of the pane box — the timeline header band is excluded from the top, and the floating scrollbars\' strips from the right and bottom edges — so no value here can park the readout over the date labels or on top of a scrollbar. `"top-right"` on this page\'s charts therefore lands 12px below a 44px header, not 12px from the pane\'s own top.',
        'The corner is not read off a fixed table: it is acquired at setup through the shared `overlay-corner` slot registry (`ctx.claimSlot`). The first plugin to claim a given corner in registration order gets it; a later claimant to the same corner gets the lexicographically smallest corner still free instead, or — if none is free — keeps its own requested corner and visually overlaps the occupant, which is harmless by construction (the overlay is `pointer-events: none` and `aria-hidden`). Nothing else in `presetStandard()` claims a corner unless you turn it on: interaction\'s filter toolbar and zoom toolbar, and scheduling\'s diagnostics panel, are all opt-in sub-features that claim `top-right`, `bottom-right` and `top-left` respectively only when enabled. So on this page\'s demos — and on most real charts — perf-tools\' `position` request is the only claim in flight and always lands exactly where you asked.',
        "Compose enough of those other features together, though, and corners fill up: with a filter toolbar, a zoom toolbar and a diagnostics panel all turned on, three of the four corners are taken before perf-tools ever asks, and its `\"top-right\"` default would be redirected to whatever corner is left — `\"bottom-left\"` in that exact combination, since it is the only one none of the three claims. This only decides where the box sits; it does not resize the chart pane or reserve space, so the overlay always floats above whatever the view plugin paints underneath it. In a composition with no view plugin at all there is no chart pane and no safe area to read; the overlay falls back to the corresponding corner of the chart root, which is the right answer there because a view-less chart has neither a header band nor scrollbars to avoid.",
      ],
      demo: {
        kind: "values",
        values: [
          { label: "not composed (no overlay)", demo: {} },
          {
            label: 'default ("top-right")',
            demo: { plugins: (sg) => [sg.perfTools({ sparkline: false })] },
          },
          {
            label: '"top-left"',
            demo: { plugins: (sg) => [sg.perfTools({ position: "top-left", sparkline: false })] },
          },
          {
            label: '"bottom-left"',
            demo: { plugins: (sg) => [sg.perfTools({ position: "bottom-left", sparkline: false })] },
          },
          {
            label: '"bottom-right"',
            demo: { plugins: (sg) => [sg.perfTools({ position: "bottom-right", sparkline: false })] },
          },
        ],
      },
    },
    {
      name: "sparkline",
      prose: [
        "A canvas strip under the text readout: one bar per recorded frame, newest at the right edge, scaled so the configured frame budget sits at a fixed guide-line height. A bar that exceeds the budget both crosses that line and switches colour — over-budget is never carried by colour alone, which matters because the canvas paints fixed literal colours rather than theme tokens (a canvas fill cannot resolve `var()`, so this one corner of the chart deliberately does not participate in theming).",
        "The text readout alone answers \"how fast is it right now\"; the sparkline answers \"how fast has it been\" — a single number cannot show you the stutter three seconds ago that a reader just complained about, but a strip of recent bars can. Turning it off saves a small canvas element and its per-tick redraw, which is not a meaningful cost at any realistic frame rate, so there is little reason to disable it beyond wanting the smallest possible overlay footprint.",
      ],
      demo: {
        kind: "values",
        values: [
          { label: "not composed (no overlay)", demo: {} },
          { label: "true (default, sparkline shown)", demo: { plugins: (sg) => [sg.perfTools()] } },
          { label: "false", demo: { plugins: (sg) => [sg.perfTools({ sparkline: false })] } },
        ],
      },
    },
    {
      name: "budgetMs",
      prose: [
        'The frame budget in milliseconds, defaulting to `16.7` — the classic 60fps target. Every recorded frame longer than this counts toward `stats().overBudget`, and it sets the scale the sparkline draws against: a frame exactly at budget draws a bar that just touches the guide line, so the guide line always represents "budget" even though its own pixel position never moves. Set this lower to make a tighter target visible at a glance (a chart you are holding to 120fps, say), or higher while profiling on hardware you already know is slow and do not want every frame flagged red.',
        "This is purely a display and counting threshold — it does not throttle anything, skip frames, or change what the view plugin does. A budget of `1` will paint almost every real frame as over-budget and clipped to the top of the sparkline; a budget of `1000` will paint almost every frame as a sliver near the bottom. Neither changes the chart's actual performance, only how alarming the overlay looks while you watch it, which is exactly the point of a configurable budget: the same trace can look calm or urgent depending on what you are holding it to.",
      ],
      demo: {
        kind: "values",
        values: [
          { label: "not composed (no overlay)", demo: {} },
          {
            label: "4 (nearly every frame reads over-budget)",
            demo: { plugins: (sg) => [sg.perfTools({ budgetMs: 4 })] },
          },
          {
            label: "1000 (nearly every frame reads far under budget)",
            demo: { plugins: (sg) => [sg.perfTools({ budgetMs: 1000 })] },
          },
        ],
      },
    },
    {
      name: "windowSize",
      prose: [
        "How many recent frame durations the rolling window — and therefore the sparkline — holds, backed by a preallocated ring buffer so recording a frame never allocates. The default, `120`, holds about two seconds of frames at 60fps, which is the horizon `stats()` and the overlay's readout summarize: `avgMs`, `maxMs` and `overBudget` are all averages or counts over whatever is currently in the window, not over the chart's whole lifetime.",
        "The sparkline draws one bar per sample currently held, sized to fill its fixed 120px width — so a small window fills up fast and produces a handful of wide, chunky bars, while the default window takes longer to fill and produces many thin ones. A very small window (the minimum usable value is `2`) makes the overlay reflect only the last instant, which is closer to \"is it stuttering right now\" than \"how has it been trending\"; a very large one (up to `10000`) smooths past a single bad frame, which can hide exactly the stutter you are trying to catch. There is no scrollback beyond the window — once a sample falls out, `stats()` and the sparkline can no longer see it, so a trace recording (which has no such cap on frames, short of the 100,000-frame safety limit) is the tool for anything you need to look back on.",
      ],
      demo: {
        kind: "values",
        values: [
          { label: "not composed (no overlay)", demo: {} },
          {
            label: "2 (minimum, two wide bars)",
            demo: { plugins: (sg) => [sg.perfTools({ windowSize: 2 })] },
          },
        ],
      },
    },
    {
      name: "performanceMarks",
      prose: [
        "Whether `mark()` calls and the start/stop of a recording are mirrored to the browser's own Performance API (`performance.mark` / `performance.measure`), under a `stargantt:` prefix so they never collide with a host page's own marks. This is the option that makes a StarGantt trace show up in the DevTools Performance panel or any tracing importer that reads Performance API entries, alongside whatever the rest of the page is doing at the same moment.",
        "Turning it off does not disable recording, `mark()` or `count()` — a trace is still captured and still exportable as JSON either way. All it removes is the second, parallel copy of the same instants going to a browser API this plugin never reads back from itself. Every call into that API is individually wrapped, so an environment without `performance.mark` (or one where it throws) is silently inert regardless of this setting — there is nothing to turn off in that environment because there was nothing happening.",
      ],
      demo: {
        kind: "none",
        reason:
          "This mirrors instants to the browser's Performance API, which paints nothing in the chart pane and has no readable effect on the overlay or the exported trace JSON — the only way to observe it is to open DevTools' own Performance panel, which a chart screenshot cannot show either state of.",
      },
    },
    {
      name: "messages",
      prose: [
        'Replaces the `readout` message: the function that turns the current `FrameStats` into the one line of text the overlay prints. The built-in default is `` `${Math.round(stats.fps)} fps · ${stats.avgMs.toFixed(1)} ms` `` — override it to report a different unit (frame budget headroom as a percentage, say), add a project-specific prefix, or fold in `stats.overBudget` for a running tally the built-in string does not show.',
        "The builder runs synchronously inside the render loop, throttled to once every 250ms, and is wrapped in a barrier that latches: the first time it throws, the failure is reported once through `core/pluginError` (with `pluginId: \"stargantt.perf-tools\"`) and the built-in default readout is used for the rest of the instance's life — the builder is not retried. That makes a bad `messages.readout` a one-time event you can catch in a `core/pluginError` listener, not a repeating error flood.",
      ],
      demo: {
        kind: "values",
        values: [
          { label: "not composed (no overlay)", demo: {} },
          {
            label: "default (English)",
            demo: { plugins: (sg) => [sg.perfTools({ sparkline: false })] },
          },
          {
            label: 'messages: { readout: (s) => `frame ${s.avgMs.toFixed(1)}ms` }',
            demo: {
              plugins: (sg) => [
                sg.perfTools({
                  sparkline: false,
                  messages: { readout: (s: { avgMs: number }) => `frame ${s.avgMs.toFixed(1)}ms` },
                }),
              ],
            },
          },
        ],
      },
    },
  ],

  notes: {
    services: {
      "stargantt.perf-tools":
        "The whole plugin is reachable through this even with the overlay off: `stats()` for the live rolling window, `startRecording`/`stopRecording`/`lastTrace`/`exportJson` for the trace lifecycle, `mark`/`count` for your own code to annotate a running recording, and `setOverlayVisible` to show or hide the overlay at runtime regardless of the `overlay` config flag it started with.",
    },
    events: {
      __empty:
        "This plugin narrates nothing of its own — it has no store-shaped state and is a passive observer, not a source of chart events. The one exception is indirect: a throwing `messages.readout` builder is reported once, latched, through the framework's own `core/pluginError` (with this plugin's id attached), not through an event this plugin defines.",
    },
    commands: {
      __empty:
        "Nothing here is document state. Starting or stopping a recording, or marking an instant, changes what the plugin has observed, not what the chart contains — none of it belongs on the undo/redo stack, so there is no command surface to define.",
    },
    extensionPoints: {
      __empty:
        "The plugin owns no canvas layer and no slot another plugin's contribution could land in — its entire visible surface is one self-contained overlay element it creates and removes itself, with nothing to extend. It competes for a corner through the shared `overlay-corner` slot registry the same way every other corner-claiming plugin does, which is arbitration, not an extension point of its own.",
    },
  },

  recipes: [
    {
      title: "Wire the overlay into a debug toggle instead of always showing it",
      intent:
        "Ship the plugin (and its service) in every build, but keep the visible box off unless a developer explicitly asks for it — the loop performs no per-frame work while both the overlay is hidden and no recording is running.",
      code: `const gantt = create({
  element,
  plugins: [
    ...presetStandard(),
    perfTools({ overlay: false }),
  ],
});

// later, from a debug menu or a keyboard shortcut:
const perf = gantt.service("stargantt.perf-tools");
perf.setOverlayVisible(true);`,
    },
    {
      title: "Record a trace around a specific operation and download it",
      intent:
        "Capture exactly the frames and instants around one suspect operation — a bulk load, a big scroll — rather than eyeballing the live overlay, then hand the JSON to a colleague or a bug report.",
      code: `const perf = gantt.service("stargantt.perf-tools");
const dataStore = gantt.service("stargantt.data");
perf.startRecording();
perf.mark("load:start");
dataStore.load(hugeTaskArray);
perf.mark("load:end");
perf.count("tasksLoaded", hugeTaskArray.length);

const trace = perf.stopRecording();
const json = perf.exportJson(); // same as JSON.stringify(trace)
const url = URL.createObjectURL(new Blob([json], { type: "application/json" }));
const a = Object.assign(document.createElement("a"), { href: url, download: "trace.json" });
a.click();`,
    },
    {
      title: "A tighter budget for a chart you are holding to a higher frame rate",
      intent:
        'Default `budgetMs` assumes 60fps. Profiling against a stricter target (a kiosk display locked to 120fps, say) means lowering it so "over budget" actually means something for that target.',
      code: `perfTools({
  budgetMs: 8.3,   // ~120fps
  windowSize: 240, // ~2s of history at 120fps, same horizon as the 60fps default
})`,
    },
  ],
};

export default doc;
