import { T0 } from "../../../lib/data";
import type { AnyPlugin, PluginDoc, StarGanttApi } from "../../types";

const DAY = 86_400_000;
const d = (n: number): number => T0 + n * DAY;

/**
 * `stargantt.resource` covers the resource pool, assignment, resourcing view, utilization and
 * load-chart surfaces in one opt-in plugin with six config nests. Because every nest is a field
 * of the SAME factory call, a property's demo below never has to compose a second plugin instance
 * — one `sg.resource({...})` call per non-default value is enough, and there is nothing here for
 * two values to collide over the way `mergeSpecs`-concatenated `plugins` builders can collide on
 * separate per-feature plugin ids. The page-level `demo` still stays `{}` (the plugin not composed
 * at all): it is opt-in, so an untouched config page should show the same plain chart every other
 * opt-in plugin's config page starts from, not a resourcing feature nobody asked to see yet.
 */

/** A narrow one-column grid track, so the Resources / Overallocation column this plugin
 *  contributes lands inside the ~280-300px the config page's split layout actually gives the grid
 *  pane, instead of starting past the built-in Name/Start/End/Progress track's 530px right edge. */
const NAME_ONLY_COLUMN = {
  id: "name",
  header: "Name",
  width: 100,
  render: (el: HTMLElement, task: { name: string }) => {
    el.textContent = task.name;
  },
  getValue: (task: { name: string }) => task.name,
};
const NARROW_PANE = { treeGrid: { paneWidth: 300, columns: [NAME_ONLY_COLUMN] } };

/**
 * Assigns a resource id the store has never heard of, straight into `data.assignments`, once the
 * shared sample dataset has loaded. No `resource/add` precedes it — this is the case where the pool
 * is the only place a friendly name for that id exists at all, which is exactly what the `pool`
 * property below needs to show.
 */
function assignUnknownResource(sg: StarGanttApi, taskId: string, resourceId: string, units = 1): AnyPlugin {
  return sg.definePlugin({
    meta: { id: "docs.resource-pool-only-assign", dependsOn: ["stargantt.data-store"] },
    setup(ctx) {
      const data = ctx.use("stargantt.data");
      const off = data.tasks.subscribe(() => {
        off.dispose();
        ctx.dispatch("assignment/set", { taskId, resourceId, units });
      });
      ctx.own(off);
    },
  });
}

/** Mirrors one named resource straight into the store, then assigns it — the ordinary path when a
 *  resource's name comes from the data store rather than from a pool entry the `pool` nest seeded. */
function seedNamedAssignment(
  sg: StarGanttApi,
  taskId: string,
  resourceId: string,
  name: string,
  units = 1,
): AnyPlugin {
  return sg.definePlugin({
    meta: { id: "docs.resource-assign-seed", dependsOn: ["stargantt.data-store"] },
    setup(ctx) {
      const data = ctx.use("stargantt.data");
      const off = data.tasks.subscribe(() => {
        off.dispose();
        ctx.dispatch("resource/add", { resource: { id: resourceId, name } });
        ctx.dispatch("assignment/set", { taskId, resourceId, units });
      });
      ctx.own(off);
    },
  });
}

/** Two overlapping tasks on two different projects, used by the `view` property's demo. */
const VIEW_TASKS = [
  { id: "atlas", parentId: null, name: "Atlas launch", start: d(0), end: d(4), meta: { project: "Atlas" } },
  { id: "borealis", parentId: null, name: "Borealis build", start: d(2), end: d(6), meta: { project: "Borealis" } },
] as const;

/** Priya is double-booked where the two tasks above overlap (1 + 0.75 units against a capacity of
 *  1), and Sam is single-booked on Borealis — enough for the panel's overallocation marking and its
 *  project attribution to both have something real to show. */
function seedViewResourcing(sg: StarGanttApi): AnyPlugin {
  return sg.definePlugin({
    meta: { id: "docs.resource-view-seed", dependsOn: ["stargantt.data-store"] },
    setup(ctx) {
      const data = ctx.use("stargantt.data");
      const off = data.tasks.subscribe(() => {
        off.dispose();
        ctx.dispatch("resource/add", { resource: { id: "priya", name: "Priya Shah", capacity: 1 } });
        ctx.dispatch("resource/add", { resource: { id: "sam", name: "Sam Okafor", capacity: 1 } });
        ctx.dispatch("assignment/set", { taskId: "atlas", resourceId: "priya", units: 1 });
        ctx.dispatch("assignment/set", { taskId: "borealis", resourceId: "priya", units: 0.75 });
        ctx.dispatch("assignment/set", { taskId: "borealis", resourceId: "sam", units: 1 });
      });
      ctx.own(off);
    },
  });
}

/** Three tasks under one summary, used by the `utilization` property's demo. */
const UTIL_TASKS = [
  { id: "platform", parentId: null, name: "Platform", type: "summary" as const, start: d(0), end: d(6) },
  { id: "api", parentId: "platform", name: "API service", start: d(0), end: d(4) },
  { id: "auth", parentId: "platform", name: "Auth hardening", start: d(1), end: d(5) },
] as const;

/** Alex is booked at 1.0 units on "API service" and 0.9 on the overlapping "Auth hardening" — 1.9
 *  units against a capacity rate of 1.0 over the three-day overlap, over the plugin's own default
 *  threshold (1). */
function seedUtilResourcing(sg: StarGanttApi): AnyPlugin {
  return sg.definePlugin({
    meta: { id: "docs.resource-util-seed", dependsOn: ["stargantt.data-store"] },
    setup(ctx) {
      const data = ctx.use("stargantt.data");
      const off = data.tasks.subscribe(() => {
        off.dispose();
        ctx.dispatch("resource/add", { resource: { id: "alex", name: "Alex Ruiz", capacity: 1 } });
        ctx.dispatch("assignment/set", { taskId: "api", resourceId: "alex", units: 1 });
        ctx.dispatch("assignment/set", { taskId: "auth", resourceId: "alex", units: 0.9 });
      });
      ctx.own(off);
    },
  });
}

/** Two overlapping tasks, for the `loadChart` property's demo. */
const LOAD_TASKS = [
  { id: "design", parentId: null, name: "Design", type: "summary" as const, start: d(0), end: d(5) },
  { id: "wireLC", parentId: "design", name: "Wireframes", start: d(0), end: d(3) },
  { id: "specLC", parentId: "design", name: "Visual spec", start: d(2), end: d(5) },
] as const;

/** Alice carries both tasks; Bob joins on "Visual spec" — days 2-3 stack Alice (1.0) and Bob (1.0)
 *  against a combined capacity of 2.0, drawing a visible step in the aggregate band. */
function seedLoadChartResourcing(sg: StarGanttApi): AnyPlugin {
  return sg.definePlugin({
    meta: { id: "docs.resource-loadchart-seed", dependsOn: ["stargantt.data-store"] },
    setup(ctx) {
      const data = ctx.use("stargantt.data");
      const off = data.tasks.subscribe(() => {
        off.dispose();
        ctx.dispatch("resource/add", { resource: { id: "alice", name: "Alice", capacity: 1 } });
        ctx.dispatch("resource/add", { resource: { id: "bob", name: "Bob", capacity: 1 } });
        ctx.dispatch("assignment/set", { taskId: "wireLC", resourceId: "alice", units: 1 });
        ctx.dispatch("assignment/set", { taskId: "specLC", resourceId: "alice", units: 1 });
        ctx.dispatch("assignment/set", { taskId: "specLC", resourceId: "bob", units: 1 });
      });
      ctx.own(off);
    },
  });
}

const doc: PluginDoc = {
  id: "stargantt.resource",
  summary:
    "The whole resourcing stack in one opt-in plugin: a resource ledger, an assignment column and editor, a resource-axis panel, over-allocation analysis, and a load chart with a heatmap and CSV/PDF reports.",
  overview: [
    "The whole resourcing stack lives in six config nests, and they share a great deal more than a factory call: `utilization` and `loadChart` both read one internal aggregation engine over the same buckets, so a resource's utilization ratio at day grain and the same resource's lane in the load chart at day grain are two views of one computation, not two engines that can quietly disagree. `pool` is the ledger everything else draws from — people, equipment and material entries with skills, a working calendar, time off and a cost rate — and it is the one nest with no rendering surface of its own; every other nest either reads it (falling back to a default Monday-Friday calendar and the raw store `Resource` for anything the pool does not know) or writes through the data store's own commands, so undo/redo, `tasks`/`assignments` store subscribers and every other plugin see a resourcing edit as an ordinary edit.",
    "Every nest is DORMANT until you pass it, even as an empty object: omit `utilization` entirely and there is no warning glyph, no column, no panel, and the `stargantt.utilization` service still answers every query — over whatever pool and assignment data already exists — it just never paints. That presence rule is the whole story of composing this plugin gradually: start with `assign` alone for a chart that only needs to show who is on what, add `utilization` once over-allocation reporting matters, add `loadChart` once someone needs the aggregate view, and nothing you added earlier has to change shape to make room for the next nest.",
    "Two services carry the entire read surface: `stargantt.resource-pool` is the ledger (entries, skills, calendars, time off, bookings), and `stargantt.utilization` is everything the aggregation engine produces, which includes the load chart's own report exports, its heatmap toggle and all eight of its strip visibility/height members — there is no service named after the strip, and a host reaching for `bandVisible()` or `utilizationReportCSV()` calls `gantt.service(\"stargantt.utilization\")` instead. There is no service named `stargantt.resource-assign` either: assigning, unassigning and moving an assignment are the data store's own `assignment/set` / `assignment/remove` commands (a pool-only resource mirrored in with `resource/add` first), dispatched by the editor internally or by a host directly — there is no dedicated `assign()`/`unassign()` method to call instead.",
  ],
  whenYouNeedIt:
    "a chart needs to answer \"who\", not just \"when\" — assigning people or equipment to tasks, seeing who is over-committed, or aggregating demand against capacity across a team. Without it, the data store's own resource list stays a flat id/name/capacity record with nothing pointing from a task back to a person's calendar, time off or cost rate, and no view ever flips the axis to show one resource's whole week.",
  demo: {},
  // The `utilization` nest alone: no pool, no assign column, no strips — just the warning glyph and
  // the read-only column, which need nothing more than an assignment the store already knows about.
  // That is the smallest configuration this merged plugin has that a reader can actually see.
  overviewDemo: {
    kind: "configured",
    spec: {
      data: UTIL_TASKS,
      preset: NARROW_PANE,
      plugins: (sg) => [sg.resource({ utilization: {} }), seedUtilResourcing(sg)],
    },
    caption:
      "Alex is booked on two overlapping tasks: a warning triangle sits beside both bars, and the read-only `Overallocation` column carries the same finding as text on each row.",
  },

  properties: [
    {
      name: "pool",
      prose: [
        "This is the one nest with nothing to paint on its own — a pool entry is a name, a kind, a capacity rate, skills, a working calendar, time off and a cost rate, none of which the chart renders directly. What makes it visible is every other nest's fallback rule: `assign`'s chips, `view`'s rows and `utilization`'s rollups all resolve a resource's display name and working time from the store first, then from a pool entry, so an id that only the pool knows about still reads as a real name everywhere else in the plugin, not as a raw id string with no explanation.",
        "`syncToStore` is the field most compositions eventually reach for, because it is the only bridge from the pool back into the plain data store's own resource list — the `loadChart` strips, for instance, roster themselves from that list, not from the pool, so a pool entry that is never mirrored in never gets a lane no matter how many tasks it is assigned to. The mirror is one-way and cascades on entry mutation (`resource/add` / `update` / `remove`, stamped `origin: \"stargantt.resource/pool-sync\"`), which is worth knowing before pairing it with undo-redo: undoing a mirrored transaction reverts only the store's copy until the next pool edit reconciles the two again.",
        "`bookings` is the ledger's other half — dated holds on a resource, tentative or confirmed, independent of any task assignment — and it has no shipped visual consumer at all in this plugin: no strip, no panel, no glyph reads a booking. Everything about a booking is reached through `stargantt.resource-pool`'s own members (`bookings`, `book`, `cancelBooking`, `setBookingState`), which is the service surface a host builds a conflict calendar or a resourcing request flow on top of.",
      ],
      demo: {
        kind: "values",
        values: [
          { label: "default (plugin not added)", demo: {} },
          {
            label: 'pool: { resources: [{ id: "priya", name: "Priya Shah" }] }, assign: {} — the chip resolves a pool-only name',
            demo: {
              data: [
                { id: "wire", parentId: null, name: "Wireframes", start: d(0), end: d(4) },
              ],
              preset: NARROW_PANE,
              plugins: (sg) => [
                sg.resource({
                  pool: { resources: [{ id: "priya", name: "Priya Shah", kind: "person" }] },
                  assign: {},
                }),
                assignUnknownResource(sg, "wire", "priya"),
              ],
            },
          },
        ],
      },
    },
    {
      name: "assign",
      prose: [
        "The one nest that writes anything: a `grid/columns` contribution showing one chip per assignment, and a per-task dialog opened from that column's cells where a reader ticks resources on and sets an allocation percentage per pick. Every write it makes — the dialog's Apply, a chip drag between tasks — lands as the data store's own `assignment/set` / `assignment/remove` commands, batched into one transaction per Apply or per drag, so undo/redo sees it exactly like a hand-made edit and nothing plugin-specific has to know an assignment editor exists.",
        "`columnWidth` is a hard budget, not a proportion: the tree grid does not reflow its neighbours or grow the pane to fit, so pushing this past the room a composition has left simply pushes the column (and anything contributed after it) past the pane's right edge, reachable only by scrolling the grid body sideways. Plan the pane width first if several plugins are contributing columns at once.",
        "`dragReassign` only removes the shortcut, never the capability — with it off, moving an assignment from one task to another still works through the editor (unassign in one, assign in the other), it just costs two dialog visits instead of one drag. Since HTML5 drag-and-drop has no keyboard equivalent, a chart built for keyboard-first or screen-reader use gets no benefit from leaving this on regardless of how it is set.",
      ],
      demo: {
        kind: "values",
        values: [
          { label: "default (plugin not added)", demo: {} },
          {
            label: 'assign: {} — a "Resources" chip on the Wireframes row',
            demo: {
              data: [
                { id: "wire", parentId: null, name: "Wireframes", start: d(0), end: d(4) },
                { id: "visual", parentId: null, name: "Visual spec", start: d(4), end: d(8) },
              ],
              preset: NARROW_PANE,
              plugins: (sg) => [sg.resource({ assign: {} }), seedNamedAssignment(sg, "wire", "alex", "Alex Ruiz")],
            },
          },
          {
            label: "columnWidth: 90 — one chip's worth, before the pane's own cap even applies",
            demo: {
              data: [
                { id: "wire", parentId: null, name: "Wireframes", start: d(0), end: d(4) },
                { id: "visual", parentId: null, name: "Visual spec", start: d(4), end: d(8) },
              ],
              preset: NARROW_PANE,
              plugins: (sg) => [
                sg.resource({ assign: { columnWidth: 90 } }),
                seedNamedAssignment(sg, "wire", "alex", "Alex Ruiz"),
              ],
            },
          },
        ],
      },
    },
    {
      name: "view",
      prose: [
        "This flips the chart's own axis: instead of one row per task, one row per resource, each carrying that resource's assigned task segments laid side by side on the shared timeline, with an overbooked window marked by a modifier class and label text rather than colour alone. It is the surface for \"what does this person's whole week look like\", which no task-axis view — including `assign`'s own column — can answer without a reader mentally re-sorting every row by assignee.",
        "It boots hidden: contributed at height zero unless `startOpen: true`, so adding this nest to a running composition changes nothing on screen until something opens it, the same non-destructive default `loadChart`'s two strips take. `teams` groups the rows under named headers with roll-up totals — member count, capacity, peak load, free capacity — which is the number a staffing conversation actually wants; a resource claimed by two teams belongs to whichever is listed first, and anyone unclaimed falls into a trailing group.",
        "`projectOf` decides the `[Project]` tag appended to a segment's label, defaulting to `task.meta.project` when it is a non-empty string — a convention, not a schema requirement, so a host whose project attribution lives elsewhere supplies its own accessor rather than reshaping tasks to fit the default. The panel is read-only on its own; its one write path, a lane-aware drag reassigning a segment, arrives through the `drag/lanes` contribution `interaction`'s drag-edit consumes, not through a gesture this nest owns directly.",
      ],
      demo: {
        kind: "values",
        values: [
          { label: "default (plugin not added)", demo: {} },
          {
            label: "startOpen: true — one row per resource instead of one per task",
            demo: {
              data: VIEW_TASKS,
              height: 340,
              plugins: (sg) => [sg.resource({ view: { startOpen: true } }), seedViewResourcing(sg)],
            },
          },
          {
            label: 'teams: [{ name: "Design", members: ["priya"] }, { name: "Delivery", members: ["sam"] }]',
            demo: {
              data: VIEW_TASKS,
              height: 340,
              plugins: (sg) => [
                sg.resource({
                  view: {
                    startOpen: true,
                    teams: [
                      { name: "Design", members: ["priya"] },
                      { name: "Delivery", members: ["sam"] },
                    ],
                  },
                }),
                seedViewResourcing(sg),
              ],
            },
          },
        ],
      },
    },
    {
      name: "utilization",
      prose: [
        "This is the analysis half of resourcing, and it computes, never edits: bucketed utilization per resource, an over-allocation verdict against a configurable threshold, role and team rollups, and a demand-vs-supply trend, all published on `stargantt.utilization` regardless of which display switches below are on — a CI check that fails a build on over-allocation, or an export footnote, can read the same numbers the built-in warning triangle and grid column use without ever touching a canvas.",
        "`warnings` and `column` are two independent ways to see the identical finding — a filled triangle beside a bar whose assignee has an over-allocated bucket overlapping that task, and a read-only `Overallocation` column carrying the same names as text — and either can be switched off while the other keeps working, because both read one cached warned-task set rather than deriving it twice. `threshold` moves every surface together: there is no separate knob per glyph, column or panel.",
        "`summaryPanel` and `trendPanel` are on-demand cards rather than always-on strips — a team capacity summary with a per-role breakdown, and a canvas graph of demand against supply over time — both live, re-rendering on the same data and pool notifications that invalidate the cached buckets. `range` is the field to reach for when a report needs to mean the same fixed window every time it runs (\"Q3 utilization\"), rather than the derived task-extent default, which silently redraws its own boundaries every time a task is added or moved.",
      ],
      demo: {
        kind: "values",
        values: [
          { label: "default (plugin not added)", demo: {} },
          {
            label: "utilization: {} — a warning triangle and an Overallocation cell on both overlapping rows",
            demo: {
              data: UTIL_TASKS,
              preset: NARROW_PANE,
              plugins: (sg) => [sg.resource({ utilization: {} }), seedUtilResourcing(sg)],
            },
          },
          {
            label: "threshold: 2.2 — Alex's 1.9-unit overlap now reads as fine",
            demo: {
              data: UTIL_TASKS,
              preset: NARROW_PANE,
              plugins: (sg) => [sg.resource({ utilization: { threshold: 2.2 } }), seedUtilResourcing(sg)],
            },
          },
        ],
      },
    },
    {
      name: "loadChart",
      prose: [
        "Two strips below the chart — an aggregate demand band with a capacity line, and one histogram lane per resource — plus an on-demand heatmap card and CSV/PDF utilization reports, all reading the same internal aggregation engine `utilization` does. Both strips default off (`total`/`lanes: false`), so composing this nest alone with no options claims no height and changes nothing on screen; a chart built only for its export button pays nothing until the button is actually clicked.",
        "`load` and `capacity` reshape the band only — a raw per-bucket function with no calendar awareness, kept aligned with the timeline header even at week or month width — while `resourceLoad` and `resourceCapacity` adjust the shared working-time matrix behind the lanes, the heatmap and the reports, and the moment either of those is configured the band switches to summing that same matrix and stops calling `load` / `capacity` at all. This is worth internalizing before composing a custom `load` expecting it to also fix a discrepancy in the heatmap: it never reaches the heatmap, because the heatmap does not read `load`.",
        "Rendering is canvas-based, so the live strips and an `export/auxiliarySurfaces` contribution share one paint routine — restyling the bars and lines is token-only (`--sg-load-*`) rather than through per-element classes. Every read and toggle this nest exposes — `bandVisible`, `setLanesHeight`, `utilizationReportCSV`, `openHeatmap`, all eight strip members — lives on `gantt.service(\"stargantt.utilization\")`; there is no separate load-chart service.",
      ],
      demo: {
        kind: "values",
        values: [
          { label: "default (plugin not added)", demo: {} },
          {
            label: "loadChart: { total: true } — the aggregate band, with a visible step where Alice and Bob overlap",
            demo: {
              data: LOAD_TASKS,
              height: 340,
              plugins: (sg) => [sg.resource({ loadChart: { total: true } }), seedLoadChartResourcing(sg)],
            },
          },
          {
            label: "loadChart: { total: true, lanes: true } — the per-resource lanes underneath it",
            demo: {
              data: LOAD_TASKS,
              height: 380,
              plugins: (sg) => [
                sg.resource({ loadChart: { total: true, lanes: true } }),
                seedLoadChartResourcing(sg),
              ],
            },
          },
        ],
      },
    },
    {
      name: "messages",
      prose: [
        "One merged 37-key catalog covering every English string across all five feature areas — the assignment editor's dialog and chip labels, the resource-view panel and its team/segment builders, the utilization column and both panels, and the load chart's axis, lane and heatmap text — resolved once at setup, so a chart that switches language at runtime remounts with a fresh catalog rather than mutating this object in place.",
        "The two column headers are `assignColumnHeader` and `utilizationColumnHeader` rather than a shared plain `columnHeader`, since one plugin owns both columns and a shared name would collide; `closeLabel` and the `duration` formatter are shared verbatim across the utilization and load-chart surfaces rather than each carrying its own copy, so overriding either once re-skins every panel and strip that uses it.",
        "The two strip divider labels (`resizeLabel`, `bandResizeLabel`, `lanesResizeLabel`) are the one place the usual \"empty string suppresses the text\" convention does not apply: a focusable divider must always have an accessible name, so an empty or blank override falls back to the built-in English text instead of leaving it unnamed. Every other string key accepts `\"\"` as a genuine suppression.",
      ],
      demo: {
        kind: "values",
        values: [
          { label: "default (plugin not added)", demo: {} },
          {
            label: "default (English) — assign: {} with the built-in \"Resources\" header",
            demo: {
              data: [
                { id: "wire", parentId: null, name: "Wireframes", start: d(0), end: d(4) },
              ],
              preset: NARROW_PANE,
              plugins: (sg) => [sg.resource({ assign: {} }), seedNamedAssignment(sg, "wire", "alex", "Alex Ruiz")],
            },
          },
          {
            label: 'messages: { assignColumnHeader: "Team" }',
            demo: {
              data: [
                { id: "wire", parentId: null, name: "Wireframes", start: d(0), end: d(4) },
              ],
              preset: NARROW_PANE,
              plugins: (sg) => [
                sg.resource({ assign: {}, messages: { assignColumnHeader: "Team" } }),
                seedNamedAssignment(sg, "wire", "alex", "Alex Ruiz"),
              ],
            },
          },
        ],
      },
    },
  ],

  notes: {
    services: {
      "stargantt.resource-pool":
        "The entry and booking ledger: CRUD over pool entries and their skills, calendar and time off, plus the booking lifecycle. Nothing here goes through the data store's undo stack — a pool edit is not undoable by a composed undo-redo plugin unless you build that yourself on top of the `resources` / `bookings` stores.",
      "stargantt.utilization":
        "Everything the shared aggregation engine produces: bucketed queries, over-allocation checks, role/team rollups, the trend, the heatmap toggle, the report exports, and all eight strip visibility/height members for the two load-chart strips. A host reaching for `bandVisible()` or `utilizationReportCSV()` calls this service, not one named after the strip.",
    },
    events: {
      "resourceView/toggled":
        "Fires only from a reader- or host-driven visibility change to the resource-view strip, never from the boot state — `view.startOpen: true` raises nothing, so a listener only interested in an actual toggle does not have to filter the initial mount.",
    },
    commands: {
      __empty:
        "This plugin owns no commands of its own. Assignment and pool-mirror writes are the data store's own `assignment/set`, `assignment/remove` and `resource/add`; strip heights ride the view plugin's `view/setBottomPaneHeight`, dispatched internally by the utilization service's strip members or directly by a host.",
    },
    extensionPoints: {
      __empty:
        "This plugin defines none of its own. It contributes into several others' points instead — three `view/bottomPanes` strips, a `taskbars/overlays` warning glyph, two `grid/columns` entries, an `export/auxiliarySurfaces` surface for the load band, and a `drag/lanes` provider for lane-aware reassignment — each documented in the property above that turns it on.",
    },
  },

  recipes: [
    {
      title: "A staffing dashboard: pool, assignments and over-allocation together",
      intent:
        "The everyday combination: a named roster, the column and editor to assign it, and both read-only over-allocation surfaces on by their own defaults.",
      code: `const gantt = create({
  element: el,
  plugins: [
    ...presetStandard(),
    resource({
      pool: {
        resources: [
          { id: "alex", name: "Alex Ruiz", kind: "person", skills: ["Backend"], costRate: 95 },
          { id: "priya", name: "Priya Shah", kind: "person", skills: ["Design"], costRate: 88 },
        ],
        syncToStore: true, // so load-chart's roster (below) can see them too
      },
      assign: {},
      utilization: {}, // warnings: true, column: true by default
    }),
  ],
});`,
    },
    {
      title: "A resource-load band with a policy capacity line",
      intent:
        "Show total demand against a fixed capacity ceiling rather than the built-in per-resource sum — useful when headcount for a phase has not been decided yet, or a known blackout period has no meaningful capacity at all.",
      code: `resource({
  loadChart: {
    total: true,
    axisLabels: true,
    valueLabels: true,
    capacity: (input) => (input.bucketStart < PHASE_TWO_START ? 1.5 : null), // no line yet in phase two
  },
})`,
    },
    {
      title: "A read-only resource-axis view for a capacity review meeting",
      intent:
        "The resource view alone, grouped by team, with no assignment editor composed — a viewing surface a lead can scan without also being able to edit it.",
      code: `resource({
  view: {
    startOpen: true,
    teams: [
      { name: "Platform", members: ["alex"] },
      { name: "Experience", members: ["priya"] },
    ],
  },
  utilization: { summaryPanel: true },
})`,
    },
  ],
};

export default doc;
