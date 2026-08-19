import type { AnyPlugin, PluginDoc, StarGanttApi } from "../../types";
import { T0 } from "../../../lib/data";

const DAY = 86_400_000;
const bd = (n: number): number => T0 + n * DAY;

/**
 * `stargantt.tracking` is opt-in, and this one plugin carries baselines, progress-tracking,
 * cost-tracking and evm as four independent config nests. Every property below therefore mounts
 * its own, differently-configured `sg.tracking({...})` instance — the only way to show a
 * genuinely different `rates`, `active` baseline, or accrual `method`, since none of those are
 * runtime-settable from outside. `PluginConfigPage.mergeSpecs` concatenates every non-default
 * property's `plugins` builder into one `create()` call and dedupes same-id plugin instances by
 * keeping the last one — so selecting non-default values on two properties from different nests
 * at once shows only the later one's configuration, silently, rather than throwing. Documented
 * here once rather than on every property below (an accepted gap for a plugin whose config nests
 * each carry independently substantial demos).
 */

// Plan of record: an earlier, tighter schedule than the shared sample dataset currently shows.
// Every leaf task in the sample has since slipped 1-4 days late against this snapshot, which is
// what makes the slip-indicator and baseline-bar demos below tell a real story.
const BASELINE_TASKS = [
  { id: "wire", start: bd(0), end: bd(3) },
  { id: "visual", start: bd(3), end: bd(6) },
  { id: "kernel", start: bd(6), end: bd(11) },
  { id: "renderer", start: bd(10), end: bd(15) },
  { id: "plugins", start: bd(13), end: bd(16) },
  { id: "qa", start: bd(16), end: bd(20) },
  { id: "ship", type: "milestone" as const, start: bd(20), end: bd(20) },
];

// Three tasks, each carrying a distinct RAG classification and a distinct progress fraction, all
// inside the default day-zoom viewport. The shared sample carries no meta.progressTracking at all,
// so every RAG-dependent value would paint identically without a dedicated dataset.
const RAG_DEMO_DATA = [
  { id: "design", parentId: null, name: "Design spec", start: bd(0), end: bd(3), progress: 1, meta: { progressTracking: { rag: "green" } } },
  { id: "api", parentId: null, name: "API contract", start: bd(1), end: bd(5), progress: 0.5, meta: { progressTracking: { rag: "amber" } } },
  { id: "infra", parentId: null, name: "Infra migration", start: bd(2), end: bd(7), progress: 0.1, meta: { progressTracking: { rag: "red" } } },
] as const;

// Two tasks with a fractional (never 0 or 1) progress each, so the accrual method actually changes
// the earned figure instead of every method collapsing to the same number.
const EVM_DEMO_DATA = [
  { id: "design", parentId: null, name: "Design", start: bd(-5), end: bd(5), progress: 0.7 },
  { id: "build", parentId: null, name: "Build", start: bd(-2), end: bd(18), progress: 0.15 },
] as const;

/** Seeds a resource and an overtime-tinged assignment, then opens the cost table panel — the
 *  shared sample carries no resources or assignments at all, so without this every `rates` value
 *  would compute the same zero labor cost. */
function seedAssignmentAndOpenCostPanel(sg: StarGanttApi): AnyPlugin {
  return sg.definePlugin({
    meta: { id: "docs.tracking-cost-seed", dependsOn: ["stargantt.tracking", "stargantt.data-store"] },
    setup(ctx) {
      const data = ctx.use("stargantt.data");
      // `data/didApplyTransaction` never fires for a bulk `load()` — only for command-driven
      // transactions — so waiting on it here would wait forever for the demo's initial data,
      // which GanttPreview only ever populates through `load()`.
      const off = data.tasks.subscribe(() => {
        off.dispose();
        ctx.dispatch("resource/add", { resource: { id: "eng", name: "Engineer" } });
        ctx.dispatch("assignment/set", { taskId: "wire", resourceId: "eng", units: 1.5 });
        ctx.use("stargantt.cost").openCostTablePanel();
      });
      ctx.own(off);
    },
  });
}

/** Seeds BAC/actual-cost on the two EVM demo tasks and opens the requested panel once the data has
 *  loaded — the same sequence a host's own "Open dashboard" button would run. */
function seedEvmAndOpen(panel: "dashboard" | "curve") {
  return (sg: StarGanttApi) => [
    sg.definePlugin({
      meta: { id: `docs.tracking-evm-seed-${panel}`, dependsOn: ["stargantt.tracking", "stargantt.data-store"] },
      setup(ctx) {
        const data = ctx.use("stargantt.data");
        // `data/didApplyTransaction` never fires for a bulk `load()` (data-store.md: "never for a
        // cancelled transaction, a failed apply, or the bulk paths"), only for command-driven
        // transactions — so waiting on it here would wait forever, since GanttPreview's own
        // `data.load(...)` is the only thing that populates this demo's data. The `tasks` store's
        // own first notification is what actually signals "the
        // demo's starting data has landed", for a bulk load exactly as for a command.
        const off = data.tasks.subscribe(() => {
          off.dispose();
          const evm = ctx.use("stargantt.evm");
          evm.setFields("design", { bac: 8000, actualCost: 6000 });
          evm.setFields("build", { bac: 12000, actualCost: 1000 });
          if (panel === "dashboard") evm.openDashboardPanel();
          else evm.openCurvePanel();
        });
        ctx.own(off);
      },
    }),
  ];
}

const doc: PluginDoc = {
  id: "stargantt.tracking",
  summary:
    "The status-reporting layer over the schedule: baselines and slip, RAG progress tracking, resource-rate cost accounting, and earned-value management — four independent config nests under one opt-in factory.",
  overview: [
    "This plugin answers \"how are we doing\", not \"what is scheduled\". `baselines` snapshots the plan so the live schedule can be compared against it later — planned bars, slip indicators, a variance report, a critical-path delta. `progress` adds the vocabulary a status meeting actually uses on top of the store's bare 0-1 progress fraction: a red/amber/green health call, remaining-work and physical-percent as alternate ways to state progress, a status date the whole set is evaluated against, and a bulk-update panel. `cost` turns resource assignments and a per-resource rate master into labor cost automatically, adds manual fixed/material/actual fields and budgets with threshold alerts. `evm` derives PV/EV/AC, SPI/CPI and an EAC/ETC forecast from budgets and progress that already exist elsewhere in the composition — its own fields, or `cost`'s and `progress`'s, whichever resolve.",
    "The four nests stay functionally independent despite living in one plugin: compose `tracking({ progress: {...} })` alone and get RAG badges with no baseline, no cost model and no EVM math running underneath. Internally the plugin calls between its own modules directly — a task's BAC falls through to `cost`'s estimated cost, its planned dates fall through to an active baseline, all without a service lookup that could come back absent. Compose only the nests you need; the other three's services still exist, they simply have nothing recorded.",
    "Every task-level write — a baseline's `setActual`, a RAG call, a manual cost field, an EVM BAC override — goes through the ordinary `task/update` command, so undo/redo and persistence apply exactly as they do to a drag-resize. What does not undo, and does not appear in `toJSON()`, is the session-local state each nest keeps for itself: the baseline set and which one is active, the rate master and budgets, the project-BAC override, the recorded snapshot histories. A host that needs any of that to survive a reload reads it back through the corresponding service and re-supplies it through config next time.",
  ],
  whenYouNeedIt:
    "a reader needs to know how a project is trending, not just what it currently looks like — a status meeting, a stakeholder deck, a budget review, a retrospective on why a date slipped. Skip it for a chart that only ever shows the live plan; every service here still answers, but with nothing recorded the figures are honestly all zero.",
  // Deliberately not `{ plugins: (sg) => [sg.tracking()] }`: every property below already mounts
  // its own differently-configured instance (see the file-top note), and composing a second,
  // unconfigured one here would collide with those the moment any property picks a non-default
  // value — a trap this page's config demos take care to avoid.
  demo: {},
  overviewDemo: {
    kind: "configured",
    spec: {
      plugins: (sg) => [
        sg.tracking({
          baselines: {
            baselines: [{ id: "plan", name: "Plan of record", tasks: BASELINE_TASKS }],
            active: "plan",
          },
        }),
      ],
      // Every leaf task has slipped against this snapshot, but only Wireframes' slip is inside the
      // default day-zoom viewport. The week zoom puts the whole project, and every slip mark, in
      // frame.
      preset: { view: { timeline: { initialZoom: "week" } } },
    },
    caption:
      "Under each bar is the thin span the plan of record captured for it, and beside the bar the signed number of days its finish has moved since — loaded here through this plugin's own plugins call, since tracking is opt-in and off by default.",
  },

  properties: [
    {
      name: "baselines",
      prose: [
        "Snapshots the schedule as a named, immutable baseline — call `save()`, or seed one at setup the way this option does — and compares the live plan against whichever one is active: a thin planned-bar underlay, a per-task slip triangle once the finish has moved by at least `slipThresholdMs`, and, with `criticalPath: true`, solid/dashed rings marking which tasks joined or left the critical chain since capture. With no baseline active nothing paints; there is no default schedule to compare against, so there is nothing honest to draw.",
        "Recorded actuals (`actualBars`, via the service's `setActual`) are the one piece of this nest's state that genuinely is transactional — it writes `meta.actualStart` / `meta.actualEnd` through an ordinary `task/update` — and the one visual that needs no active baseline at all, since an actual date is a fact about the task, not a comparison against a snapshot. Everything else here — the baseline set, which one is active — is session-local and outside undo; only `setActual` shows up in Ctrl+Z.",
        "`barStyle: \"overlay\"` reads faster than the default `\"under\"` when planned and current spans sit close together, but starts competing visually with the live bar once they diverge by more than a few pixels — prefer `\"under\"` once a schedule is dense enough that two overlapping translucent rects would just add noise.",
      ],
      demo: {
        kind: "values",
        values: [
          { label: "default (no baseline registered)", demo: {} },
          {
            label: "one active baseline — planned bars + slip triangles",
            demo: {
              plugins: (sg) => [
                sg.tracking({
                  baselines: {
                    baselines: [{ id: "plan", name: "Plan of record", tasks: BASELINE_TASKS }],
                    active: "plan",
                  },
                }),
              ],
              preset: { view: { timeline: { initialZoom: "week" } } },
            },
          },
          {
            label: '{ barStyle: "overlay", slipIndicators: false }',
            demo: {
              plugins: (sg) => [
                sg.tracking({
                  baselines: {
                    baselines: [{ id: "plan", tasks: BASELINE_TASKS }],
                    active: "plan",
                    barStyle: "overlay",
                    slipIndicators: false,
                  },
                }),
              ],
              preset: { view: { timeline: { initialZoom: "week" } } },
            },
          },
        ],
      },
    },
    {
      name: "progress",
      prose: [
        "Adds the vocabulary a status meeting reports with on top of the store's bare `progress` fraction: a RAG health call independent of the raw percentage, remaining-work and remaining-duration as alternate ways to state progress that recompute the underlying fraction for you, a status date the whole set is read against, and a bulk-update dialog for editing several tasks at once as one undo step. None of it changes scheduling or dependencies — only how progress is recorded and reported.",
        "The badge (`showRagOnBars`) is the fast path: a filled, lettered circle at a classified bar's edge that reads without hovering. `colorBars` is the louder alternative — it recolors the whole bar and competes with any other bar-coloring scheme already in play, which is exactly why it is off by default while the badge stays on. Both are additive to a classified subset only: an unclassified task looks exactly as it would without this nest composed.",
        "`progressWeighting` only changes `statusReport()`'s single `percentComplete` figure — `\"count\"` (the default) treats every leaf task equally, `\"duration\"` weights by span so long tasks dominate the number the way they dominate the schedule. The status-date zigzag line (`progressLine`) reads bar geometry from task-bars' own geometry service rather than recomputing it, so it can never disagree with where a bar visibly sits, including mid-drag.",
      ],
      demo: {
        kind: "values",
        prerequisite: { data: RAG_DEMO_DATA },
        values: [
          { label: "default (unclassified data)", demo: {} },
          {
            label: "default nest, classified data — RAG badges",
            demo: { plugins: (sg) => [sg.tracking({ progress: {} })] },
          },
          {
            label: "{ colorBars: true }",
            demo: { plugins: (sg) => [sg.tracking({ progress: { colorBars: true } })] },
          },
        ],
      },
    },
    {
      name: "cost",
      prose: [
        "Adds nothing to the canvas on its own — every visual surface (the budget-vs-actual table, the cumulative cost curve with its S-curve forecast, the breakdown chart) is a DOM dialog that opens only when `openCostTablePanel()`, `openCostCurvePanel()` or `openBreakdownPanel()` is called. Underneath, labor cost derives automatically from a task's assignments and a per-resource rate master — `rates` seeds it, `setRate` adjusts it at runtime — while fixed, material and actual costs are entered by hand at `task.meta.costTracking` through the ordinary `task/update` pipeline.",
        "Without a resolvable rate (no seed, and no matching `costRate` on a composed `stargantt.resource` pool entry) every assignment contributes exactly 0 labor, silently — `costOf` still returns a full breakdown, just all zeros. That is the trap this nest exists to avoid: a chart can look fully wired, panels opening and totals rendering, while quietly reporting a project that costs nothing because nobody said what an hour is worth. Allocation above 1.0 units costs the overtime rate, which falls back to the standard rate when omitted.",
        "Budgets, alerts and cost baselines are session-local plugin state, not store data — they reset when the plugin is disposed unless a host reads them back (`rateOf`, the `state` store's `budget`) and re-seeds them through `rates` / `budget` / `budgets` on the next `tracking(...)` call. `formulas` and `renderPanel` extend the table panel and replace a panel's body respectively, both host-supplied and both contained the same way: a throw is reported once and, for `renderPanel`, latches the built-in rendering back on for the rest of the instance's life.",
      ],
      demo: {
        kind: "values",
        values: [
          { label: "default (no rate master)", demo: {} },
          {
            label: 'rates: [{ resourceId: "eng", standard: 80 }]',
            demo: {
              plugins: (sg) => [
                sg.tracking({ cost: { rates: [{ resourceId: "eng", standard: 80 }] } }),
                seedAssignmentAndOpenCostPanel(sg),
              ],
            },
          },
          {
            label: 'rates: [{ resourceId: "eng", standard: 80, overtime: 160 }]',
            demo: {
              plugins: (sg) => [
                sg.tracking({ cost: { rates: [{ resourceId: "eng", standard: 80, overtime: 160 }] } }),
                seedAssignmentAndOpenCostPanel(sg),
              ],
            },
          },
        ],
      },
    },
    {
      name: "evm",
      prose: [
        "Derives Planned Value, Earned Value and Actual Cost per task from three things this plugin already has elsewhere: a budget (its own `meta.evm.bac`, or `cost`'s estimated cost), a progress fraction (`progress`'s physical percent, or the task's plain `progress`), and, when a baseline is active, the plan's dates instead of the live ones. Nothing it computes writes back onto the schedule — ask the service, or open one of its two panels, and the numbers are current as of whichever status date is in effect.",
        "`method` is the single biggest lever on every number the dashboard shows, because SPI, CPI, SV, CV and both forecasts are all downstream of EV. `\"percentComplete\"` (the default) trusts the reported percentage directly; `\"zeroHundred\"` and `\"fiftyFifty\"` are the disciplined alternative auditors reach for, where nothing (or half) is earned until work is verifiably finished. `eacMethod` picks which of three textbook forecast formulas — `\"cpi\"`, `\"remaining\"`, `\"cpiSpi\"` — turns current performance into a completion estimate; they diverge hardest exactly when a project is troubled, which is when the choice matters most.",
        "Like `cost`, this nest adds nothing to the canvas until a panel opens — there is no ambient dashboard badge that ships with it, so a reader needs earned value visible without host code is a button you build yourself, wired to `openDashboardPanel()` / `openCurvePanel()`. Per-task attributes (BAC, actual cost, a method override, weighted milestones) live at `task.meta.evm` and write through `setFields()`, undoable like any other field; the project-BAC override and the snapshot history are session-local plugin state instead.",
      ],
      demo: {
        kind: "values",
        values: [
          { label: 'default ("percentComplete", no panel open)', demo: {} },
          {
            label: 'default ("percentComplete") — dashboard open',
            demo: { data: EVM_DEMO_DATA, plugins: (sg) => [sg.tracking({ evm: {} }), ...seedEvmAndOpen("dashboard")(sg)] },
          },
          {
            label: '{ method: "zeroHundred" } — dashboard open',
            demo: {
              data: EVM_DEMO_DATA,
              plugins: (sg) => [sg.tracking({ evm: { method: "zeroHundred" } }), ...seedEvmAndOpen("dashboard")(sg)],
            },
          },
        ],
      },
    },
    {
      name: "messages",
      prose: [
        "One merged catalog covering all four nests — 73 keys spanning baselines, progress-tracking, cost-tracking and evm, with six collisions resolved: `duration` and `panelClose` merged into one shared key each (identical role, identical default across the areas that used them), and four others (`baselineName`, `curveTitle`, `curveEmpty`, `curvePoint`) prefixed per area since `cost` and `evm` each need their own. Resolved once at setup by per-key shallow override, same as every other catalog in this library.",
        "Most of it stays unread until a panel actually opens — the cost and EVM catalogs are almost entirely panel-facing — but `slipLabel` is a visible exception: it is called once per slipping bar, on every paint, to produce the text beside a baseline's slip triangle, so a replacement shows up on the chart itself with no panel involved. It is latched: a throw is reported once and the built-in default answers every later call for the rest of the instance's life, the same as the paired `duration` formatter it composes.",
        "Amounts in the cost and EVM builders render through `Intl.NumberFormat(\"en-US\")` with no currency symbol on purpose — the plugin never assumes a currency. A host billing in a different unit replaces `costCurvePoint` / `evmCurvePoint` / `breakdownEntry` wholesale rather than fighting a symbol the defaults never had.",
      ],
      demo: {
        kind: "values",
        values: [
          { label: "default (English)", demo: {} },
          {
            label: 'slipLabel: (ms) => `${Math.round(Math.abs(ms) / DAY)}d late/early`',
            demo: {
              plugins: (sg) => [
                sg.tracking({
                  baselines: { baselines: [{ id: "plan", tasks: BASELINE_TASKS }], active: "plan", bars: false },
                  messages: {
                    slipLabel: (ms: number) => `${Math.round(Math.abs(ms) / DAY)}d ${ms > 0 ? "late" : "early"}`,
                  },
                }),
              ],
              preset: { view: { timeline: { initialZoom: "week" } } },
            },
          },
        ],
      },
    },
  ],

  notes: {
    services: {
      "stargantt.baselines":
        "save/remove/setActive to manage the baseline set — the set itself is store-shaped, not a method: read it off `state.get().baselines` (registration order) and the active id off `state.get().activeId`, rather than a `list()` call. variance/milestoneVariance/summary/reportCSV compare against one, setActual/actualOf hold recorded dates, and criticalPath/criticalPathDelta back the same comparison the baselines property's criticalPath field visualizes.",
      "stargantt.progress":
        "Every input method (setRag, setProgressFields, setRemainingWork, setPhysicalPercent, setRemainingDuration) and every read (progressOf, ragOf, statusReport), plus the two on-demand panels and the runtime progress-line toggle. Reach for setProgressFieldsBatch rather than a loop of setProgressFields calls when seeding several tasks at once — a loop leaves one undo entry per task.",
      "stargantt.cost":
        "The only way in or out of this nest's state — every rate, manual cost field, budget and baseline is read and written here, never through a command. Ask costOf / comparison / alerts before building your own aggregation; they already apply the same rules the panels render.",
      "stargantt.evm":
        "setFields/valuesOf for per-task attributes, bacOf/projectBac/setProjectBac for budgets, metricsOf/metrics/projectMetrics for the computed indices, scurve for the raw S-curve points, and recordSnapshot to add to the history — the history itself is store-shaped, not a method: read it off `state.get().snapshots` (oldest first), rather than a `snapshots()` call. Read metricsOf(id) rather than recomputing EV by hand — it already resolves the cost/baselines/progress fallbacks the panels use.",
    },
    events: {
      __empty:
        "This plugin emits none of its own — session-state changes (a new baseline, a RAG call, a cost edit, a recorded EVM snapshot) fold into the four services' state stores instead. Subscribe to each service's state store for its own session-state changes, and to data/didApplyTransaction for anything that lives on a task.",
    },
    commands: {
      __empty:
        "Every mutation this plugin exposes goes through a service method directly, never a dispatched command. Per-task writes (setActual, setRag, setCostFields, evm's setFields) each dispatch an ordinary task/update underneath, so they are undoable through the standard undo-redo plugin without this plugin needing a command surface of its own.",
    },
    extensionPoints: {
      __empty:
        "This plugin defines no extension point of its own. It contributes to three points lower-layer plugins define — renderer/layers (baseline bars, actual bars, the progress line), taskbars/style (RAG recoloring) and taskbars/overlays (slip indicators, RAG badges) — which is why the renderer and task-bars are optional dependencies rather than hard ones.",
    },
  },

  recipes: [
    {
      title: "Compare the live schedule against the plan of record",
      intent:
        "The everyday baselines shape: capture the plan once, then let the underlay and slip triangles do the rest of the talking.",
      code: `const gantt = create({ element, plugins: [...presetStandard(), tracking()] });
gantt.service("stargantt.data").load(dataset);

const planId = gantt.service("stargantt.baselines").save("Plan of record");`,
    },
    {
      title: "Classify tasks and show it without relying on color alone",
      intent:
        "The badge's letter keeps RAG status readable in greyscale; the optional recolor is the fast, at-a-glance version for a status-focused view.",
      code: `const gantt = create({ element, plugins: [...presetStandard(), tracking({ progress: { colorBars: true } })] });
gantt.service("stargantt.data").load(dataset);

const progress = gantt.service("stargantt.progress");
progress.setRag("design", "green");
progress.setRag("api", "amber");
progress.setRag("infra", "red");`,
    },
    {
      title: "Cost a project from assignments alone",
      intent:
        "The minimum viable setup: seed rates for the resources already assigned in the data, and every task's labor cost computes itself.",
      code: `tracking({
  cost: {
    rates: [
      { resourceId: "r-eng", standard: 110, overtime: 165 },
      { resourceId: "r-des", standard: 90 },
    ],
    hoursPerDay: 8,
  },
})`,
    },
    {
      title: "Read EVM budgets from cost instead of duplicating them",
      intent:
        "Skip meta.evm.bac entirely and let evm fall back to cost's estimated cost per task, so a budget is entered once.",
      code: `const gantt = create({
  element,
  plugins: [...presetStandard(), tracking({ cost: {}, evm: {} })],
});
gantt.service("stargantt.data").load(dataset);

const cost = gantt.service("stargantt.cost");
cost.setCostFields("design", { fixedCost: 8000, actualCost: 6000 });

// Visible through the EVM service without any evm-specific write:
gantt.service("stargantt.evm").bacOf("design"); // 8000`,
    },
  ],
};

export default doc;
