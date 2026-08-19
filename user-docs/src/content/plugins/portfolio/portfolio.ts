import type { PluginContext } from "stargantt";
import { T0 } from "../../../lib/data";
import type { PluginDoc, StarGanttApi } from "../../types";

const DAY = 86_400_000;
const d = (n: number): number => T0 + n * DAY;

/**
 * `stargantt.portfolio` provides BOTH the `stargantt.portfolio` and `stargantt.dashboard`
 * services from a single `portfolio(config)` call — there is no separate `dashboard()` factory.
 * The dashboard panel's own options (`open`, `widgets`, `formulas`, `groupOf`, `renderWidget`)
 * live under this plugin's own `dashboard` config field rather than a sibling plugin's top-level
 * config, so this page's `properties` array has one entry per top-level `PortfolioConfig` field —
 * `nodes`, `goals`, `views`, `dashboard`, `messages`.
 *
 * This page never builds one shared `sg.portfolio()` instance: `dashboard.widgets`, `.formulas`,
 * `.groupOf` and `.renderWidget` are all resolved once at setup with no service setter, the same
 * as `messages`, so showing two different values of any of those needs two differently-configured
 * `portfolio(...)` instances — which would collide with any shared base instance the moment a
 * reader picked a non-default value (PluginHost rejects two plugins sharing an id). So the
 * page-level `demo` here is deliberately empty, and every property whose demo needs a live chart
 * builds its own complete `sg.portfolio(...)` call. The one thing config alone cannot do —
 * collapsing a project, narrowing the chart, or applying a saved view — is a runtime service call
 * from a small companion plugin, run once the shared sample data has actually loaded.
 */

const BUILD_PROJECT_ID = "docs-build-project";
const SHIP_GOAL_ID = "docs-ship-goal";

/** Runs `fn` once, after the data-store's `tasks` store has published at least one snapshot. */
function afterTasksLoad(ctx: PluginContext, fn: () => void): void {
  const off = ctx.use("stargantt.data").tasks.subscribe(() => {
    off.dispose();
    fn();
  });
  ctx.own(off);
}

/** Binds the Build project, then collapses it — proof that a project node is an addressable
 *  handle on a task subtree, not just a label. */
function collapseBuildProject(sg: StarGanttApi) {
  return sg.definePlugin({
    meta: {
      id: "docs.portfolio-collapse",
      dependsOn: ["stargantt.portfolio", "stargantt.tree-grid", "stargantt.data-store"],
    },
    setup(ctx) {
      afterTasksLoad(ctx, () => {
        ctx.use("stargantt.portfolio").setProjectCollapsed(BUILD_PROJECT_ID, true);
      });
    },
  });
}

/** Binds the Build project, then narrows the chart to its own tasks — proof that a node id
 *  resolves to a task set the interaction plugin's filter service can be told to show
 *  exclusively. `stargantt.interaction` is always present (it is one of presetStandard()'s nine
 *  plugins), so no extra plugin needs composing for `applyPortfolioFilter` to have somewhere to
 *  write. */
function narrowToBuildProject(sg: StarGanttApi) {
  return sg.definePlugin({
    meta: {
      id: "docs.portfolio-narrow",
      dependsOn: ["stargantt.portfolio", "stargantt.interaction", "stargantt.data-store"],
    },
    setup(ctx) {
      afterTasksLoad(ctx, () => {
        ctx.use("stargantt.portfolio").applyPortfolioFilter([BUILD_PROJECT_ID]);
      });
    },
  });
}

/** Applies a saved view seeded through `views` config — proof that a view seeded before the
 *  chart's first paint is reachable by name without ever calling `savePortfolioView`. */
function applyBuildView(sg: StarGanttApi) {
  return sg.definePlugin({
    meta: {
      id: "docs.portfolio-apply-view",
      dependsOn: ["stargantt.portfolio", "stargantt.interaction", "stargantt.data-store"],
    },
    setup(ctx) {
      afterTasksLoad(ctx, () => {
        ctx.use("stargantt.portfolio").applyPortfolioView("Build only");
      });
    },
  });
}

/**
 * A dataset with something for every dashboard widget to show, which the shared sample dataset
 * cannot provide: every one of its tasks starts today or later, so `overdueTasks()` and the
 * overdue widget are permanently empty against it. Here, "Design" ended four days ago at 60% (the
 * overdue widget's subject), "Implementation" is mid-flight, "Review" has not started, and "Ship"
 * is a milestone still eight days out.
 */
const DASHBOARD_DATA = [
  { id: "plan", parentId: null, name: "Planning", start: d(-7), end: d(-4), progress: 1 },
  { id: "design", parentId: null, name: "Design", start: d(-5), end: d(-1), progress: 0.6 },
  { id: "impl", parentId: null, name: "Implementation", start: d(-2), end: d(6), progress: 0.2 },
  { id: "review", parentId: null, name: "Review", start: d(5), end: d(8) },
  { id: "ship", parentId: null, name: "Ship", type: "milestone" as const, start: d(8), end: d(8) },
];

/** The same tasks, tagged with a department in `meta` instead of an assignment — the fixture the
 *  `groupOf` demo's custom hook reads from. */
const DEPT_DATA = [
  { id: "plan", parentId: null, name: "Planning", start: d(-7), end: d(-4), progress: 1, meta: { dept: "Ops" } },
  { id: "design", parentId: null, name: "Design", start: d(-5), end: d(-1), progress: 0.6, meta: { dept: "Design" } },
  {
    id: "impl",
    parentId: null,
    name: "Implementation",
    start: d(-2),
    end: d(6),
    progress: 0.2,
    meta: { dept: "Engineering" },
  },
  { id: "review", parentId: null, name: "Review", start: d(5), end: d(8), meta: { dept: "Engineering" } },
];

/** Adds two resources and assigns each to one task, once the dataset has loaded — the workload
 *  and default-grouping widgets have nothing to aggregate without them, since `DASHBOARD_DATA`
 *  carries no resources or assignments of its own. */
function seedResourcesAndAssignments(sg: StarGanttApi) {
  return sg.definePlugin({
    meta: { id: "docs.portfolio-seed-resources", dependsOn: ["stargantt.portfolio", "stargantt.data-store"] },
    setup(ctx) {
      afterTasksLoad(ctx, () => {
        ctx.dispatch("resource/add", { resource: { id: "alice", name: "Alice" } });
        ctx.dispatch("resource/add", { resource: { id: "bob", name: "Bob" } });
        ctx.dispatch("assignment/set", { taskId: "design", resourceId: "alice", units: 1 });
        ctx.dispatch("assignment/set", { taskId: "impl", resourceId: "bob", units: 1 });
      });
    },
  });
}

const doc: PluginDoc = {
  id: "stargantt.portfolio",
  summary:
    "The multi-project surface: a ranked initiative-program-project hierarchy over the task store, plus a headless KPI dashboard with an opt-in panel — two services from one plugin, nothing painted until you act on either.",
  overview: [
    "This plugin covers two things in one: portfolio, a ranked grouping hierarchy — initiative above program above project — laid over whatever tasks are already in the store, with per-project collapse, traffic-light health, goal roll-up, template duplication, scoped filtering and cross-project task moves; and dashboard, a headless aggregation service (progress summary, overdue list, burndown, workload, status counts, milestones, goal and portfolio roll-ups, group comparison, user-defined formula metrics) with an opt-in panel that renders those aggregations as cards and can export the whole thing as a PNG or PDF report. Portfolio state is store-shaped: the `nodes` and `goals` stores on the `stargantt.portfolio` service carry every hierarchy and goal change; the dashboard's own events (`dashboard/opened`, `dashboard/closed`, `dashboard/refreshed`) cover its panel lifecycle separately.",
    "A project node is the one kind that means something to the rest of the plugin: it binds to a single task id, and that task's whole subtree becomes \"the project\" for every capability here — collapsing it, filtering to it, aggregating its health, rolling it into a goal, duplicating it as a template, or moving other tasks into it. Initiative and program nodes exist purely to group projects; the dashboard's goal and portfolio-status widgets read their numbers by walking down to the project descendants underneath.",
    "Both services draw nothing themselves. Every visible consequence goes through a surface some other plugin already renders: collapsing a project dispatches tree-grid's own `view/rowToggle`, narrowing the chart writes through the interaction plugin's filter criteria, and the dashboard panel is a `role=\"dialog\"` overlay hosted through the view plugin's chart pane. With no config, and even with nodes and goals defined but never acted on, the rendered chart is byte-identical to a chart without this plugin at all — which is why every demo on this page pairs a config value with the one runtime action, or the one `dashboard.open`, that actually makes its consequence visible.",
  ],
  whenYouNeedIt:
    "when one chart needs to represent several projects at once — grouped, collapsible, filterable, compared against goals, cloned as templates, or shuffled between each other — or when a reader needs the state of the whole project without leaving the chart for a separate reporting tool. A chart that only ever shows a single project's tasks, with no audience for a summary view, has no use for either half.",
  demo: {},
  overviewDemo: {
    kind: "configured",
    spec: {
      plugins: (sg) => [
        sg.portfolio({
          nodes: [{ id: BUILD_PROJECT_ID, kind: "project", name: "Build", taskId: "build" }],
        }),
        narrowToBuildProject(sg),
      ],
      // The Build subtree runs from day 7 to day 20; the default day zoom frames the first week,
      // so every bar the filter kept was off the right edge and the chart pane read as empty.
      preset: { view: { timeline: { initialZoom: "week" } } },
    },
    caption:
      "One project node bound to the Build task, and the chart narrowed to it: the rows left are the Build task and its three children, kept under `Release 1.4` as their ancestor, while the release's other branches are filtered out by node id rather than by text.",
  },

  properties: [
    {
      name: "nodes",
      prose: [
        "Defines the starting hierarchy in one pass at setup, equivalent to calling `defineNode` once per entry in array order — which is why a parent must appear before its child in the array to be honored at all: a `parentId` naming a node not yet defined at that point in the array is simply not found, and the child becomes a root instead of throwing. Ranks are fixed and cannot be reordered: initiative outranks program outranks project, and a `parentId` is only honored when it names an already-defined node strictly above the child in that ranking. Try to parent a program under a project and the parentId is silently dropped, not rejected — the node still gets defined, just as a root.",
        "The `taskId` field is what turns a project node from a label into something the rest of the plugin can act on: it is kept only on nodes of kind `\"project\"` (a `taskId` on an initiative or program is dropped) and it does not need to resolve to a real task at define time — an unbound or dangling project is valid, it just resolves to no tasks anywhere `tasksOf`, `health`, `setProjectCollapsed` or filtering reads it, which fails silently rather than throwing. Binding the wrong id, or a task that later gets deleted, produces a project that looks correctly defined in `nodes.get()` and does nothing everywhere else — worth checking first when a project's collapse toggle or filter entry appears to have no effect.",
        "An id collision replaces the existing node in place rather than erroring, which is convenient for a host that reloads its whole node list from persistence on every save instead of diffing it — but it also means a stray duplicate id in a large config array silently drops everything but the last entry with that id. Nothing here is undoable and none of it appears in `toJSON()`: this list is read once, into plugin-local memory, and every observable change afterwards (through the service) publishes a fresh snapshot on the `nodes` store — a host that wants the hierarchy back after a reload is responsible for persisting it and passing it in again.",
      ],
      demo: {
        kind: "values",
        values: [
          { label: "default (none)", demo: {} },
          {
            label: "one project bound to \"Build\", then collapsed",
            demo: {
              plugins: (sg) => [
                sg.portfolio({ nodes: [{ id: BUILD_PROJECT_ID, kind: "project", name: "Build", taskId: "build" }] }),
                collapseBuildProject(sg),
              ],
            },
          },
          {
            label: "the same project, chart narrowed to just it",
            demo: {
              plugins: (sg) => [
                sg.portfolio({ nodes: [{ id: BUILD_PROJECT_ID, kind: "project", name: "Build", taskId: "build" }] }),
                narrowToBuildProject(sg),
              ],
            },
          },
        ],
      },
    },
    {
      name: "goals",
      prose: [
        "Seeds the goal set the same way `nodes` seeds the hierarchy: one `defineGoal` call per entry, in array order, at setup. A goal is a link, not a snapshot — `nodeIds` and `taskIds` are resolved fresh from the store (and from the node registry) on every call to `goalProgress`, never cached from define time, so a goal defined here before any tasks exist will still report correctly once tasks are loaded, and one defined against a project whose subtree later grows will pick up the new tasks automatically with no re-definition needed.",
        "`target` is what turns a progress number into a pass/fail: it is clamped into 0..1 and defaults to 1, and `achieved` is true only once the resolved progress reaches it — but `achieved` also requires at least one task to have actually resolved. A goal linking a project that never got a `taskId`, or node ids that do not exist, resolves to zero tasks, reports progress 0, and is never achieved regardless of `target` — it fails the same way an unbound project node fails `tasksOf`, silently rather than with an error a host could catch.",
        "This plugin itself draws nothing — `goalProgress(id)` is a number, and computing it is as far as the `stargantt.portfolio` service's own responsibility goes. But that number does not stop at a getter nobody reads: the merged plugin's own dashboard `\"goals\"` widget maps every goal to its `goalProgress` result and the goal's own name, and renders each one as a card in its panel, refreshed automatically whenever the `goals` (or `nodes`) store changes. That is a real, shipped, zero-code renderer for exactly this option — set `dashboard.widgets` to include `\"goals\"` and every goal seeded here shows up with no other configuration.",
      ],
      demo: {
        kind: "values",
        values: [
          { label: "default (none)", demo: {} },
          {
            label: 'a goal linked to the Build project, shown in the dashboard\'s goals card',
            demo: {
              plugins: (sg) => [
                sg.portfolio({
                  nodes: [{ id: BUILD_PROJECT_ID, kind: "project", name: "Build", taskId: "build" }],
                  goals: [{ id: SHIP_GOAL_ID, name: "Ship Build", nodeIds: [BUILD_PROJECT_ID], target: 1 }],
                  dashboard: { open: true, widgets: ["goals"] },
                }),
              ],
            },
          },
        ],
      },
    },
    {
      name: "views",
      prose: [
        "Pre-populates the saved-view map before the chart's first paint, so a host that persisted named narrowings between sessions — \"My projects\", \"At risk this sprint\" — has them available to `applyPortfolioView` the moment the plugin starts, without ever calling `savePortfolioView` itself. This is a seed, not an action: defining a view here changes nothing about what the chart shows until something — a host's own \"apply\" click, or code running on `lifecycle/ready` — actually calls `applyPortfolioView` with its name.",
        "The scope is narrower than it might read at first: a `PortfolioView` here is only ever `{ nodeIds }`, the same node-id narrowing `applyPortfolioFilter` takes directly. It does not capture anything else about the chart's state — no zoom level, no scroll position, no other filter criteria that might be layered on top. `nodeIds: null` (or omitted) means \"no narrowing\", which is a legitimate, useful entry: an \"Everything\" view that clears whatever narrowing came before it, listed right alongside the scoped ones in the same picker.",
        "An entry with an empty-string key or a non-object value is dropped during setup rather than kept malformed; a `nodeIds` that is present but not an array is treated the same as `nodeIds: null` rather than rejecting the whole entry. Both are silent — nothing here throws or logs, so a typo'd key just never shows up in `portfolioViewNames()`.",
      ],
      demo: {
        kind: "values",
        values: [
          { label: "default (none)", demo: {} },
          {
            label: '"Build only" (seeded) applied',
            demo: {
              // The narrowing this view applies is carried out entirely by the interaction
              // plugin's filter service (portfolio.md: "narrows the visible rows... by writing a
              // single predicate criteria wholesale through the interaction plugin's
              // stargantt.filter service"), and that service is dormant — not even
              // registered — unless `filterSearch` is configured, even as `{}`. Without this, the
              // view still looks up as "applied" (applyPortfolioView returns true regardless), but
              // the filter service is absent so the narrowing is a silent no-op and the chart never
              // visibly changes.
              preset: { interaction: { filterSearch: {} } },
              plugins: (sg) => [
                sg.portfolio({
                  nodes: [{ id: BUILD_PROJECT_ID, kind: "project", name: "Build", taskId: "build" }],
                  views: { "Build only": { nodeIds: [BUILD_PROJECT_ID] } },
                }),
                applyBuildView(sg),
              ],
            },
          },
        ],
      },
    },
    {
      name: "dashboard",
      prose: [
        "The dashboard panel's own options, all resolved once at setup with no runtime setter — `open` decides whether a `role=\"dialog\"` overlay ever mounts over the chart pane, `widgets` decides which of the ten standard cards it shows and in what order (default: all ten, summary through formulas), `formulas` seeds project-specific metric cards the standard ten cannot name, `groupOf` repoints the group-comparison widget's bars at a label of your choosing instead of the default \"first assigned resource\" rule, and `renderWidget` replaces one existing widget's card body wholesale with host-drawn content. Left entirely absent, the plugin still provides the `stargantt.dashboard` service — every aggregation is one call away — it simply never invites a reader to look; `dashboard.open: true` is what actually puts something on screen.",
        "`widgets` is the one field worth trimming deliberately rather than leaving at its ten-wide default: `\"goals\"` and `\"portfolio\"` render empty cards on a composition with no `nodes`/`goals`, and the burndown widget's *actual* line is empty without the tracking plugin's recorded progress snapshots. A panel showing only what a given composition can actually answer reads as more finished than one padded out with cards that only ever say `No data`.",
        "`formulas` and `renderWidget` are the two escape hatches, and they solve different problems. `formulas` adds a *number* the standard widgets cannot name — story points remaining, tasks matching a project-specific tag — as one more card in the `\"formulas\"` widget slot; `evaluate` runs over the whole snapshot including summary rows unless `filter` narrows it first, which is worth matching against the summary widget's own task count if the two are meant to agree. `renderWidget` replaces a *layout* — the whole body of one existing card, chrome and title kept — with your own DOM, and is a latched seam: the first throw falls back to the built-in body for the rest of that panel's life, so a bug there degrades once rather than repeating.",
        "`groupOf` only affects the `\"groups\"` widget, and only for leaf tasks: a task whose label comes back empty, non-string, or from a hook that throws is left out of the comparison entirely rather than folded into an \"unlabeled\" bucket. Because none of these five fields has a service setter, a grouping scheme or widget set that needs to change at runtime (an engineer's view versus an executive's) means two differently configured `portfolio(...)` instances behind two toolbar buttons, not one panel that tries to be both.",
      ],
      demo: {
        kind: "values",
        values: [
          { label: "default (not composed here, so no panel)", demo: {} },
          {
            label: "{ open: true } — all ten widgets",
            demo: { data: DASHBOARD_DATA, height: 520, plugins: (sg) => [sg.portfolio({ dashboard: { open: true } })] },
          },
          {
            label: '{ open: true, widgets: ["summary", "overdue"] }',
            demo: {
              data: DASHBOARD_DATA,
              plugins: (sg) => [sg.portfolio({ dashboard: { open: true, widgets: ["summary", "overdue"] } })],
            },
          },
          {
            label: '{ open: true, widgets: ["workload", "groups"] } — default grouping',
            demo: {
              data: DASHBOARD_DATA,
              plugins: (sg) => [
                sg.portfolio({ dashboard: { open: true, widgets: ["workload", "groups"] } }),
                seedResourcesAndAssignments(sg),
              ],
            },
          },
          {
            label: 'groupOf: (task) => task.meta?.dept',
            demo: {
              data: DEPT_DATA,
              plugins: (sg) => [
                sg.portfolio({
                  dashboard: {
                    open: true,
                    widgets: ["groups"],
                    groupOf: (task: { meta?: Record<string, unknown> }) =>
                      typeof task.meta?.dept === "string" ? task.meta.dept : undefined,
                  },
                }),
              ],
            },
          },
        ],
      },
    },
    {
      name: "messages",
      prose: [
        "One merged catalog covering both areas: three portfolio builders — `nodeName` for an unnamed node (\"Initiative 1\", \"Program 1\", \"Project 1\"), `goalName` for an unnamed goal (\"Goal 1\"), `copyName` for `duplicateProject`'s default title — and twenty dashboard strings and builders, from the panel title and the close/mark-done labels through the status and milestone words to the report title and every widget's own line builder (`summaryText`, `overdueLine`, `burndownPlanned`, `portfolioRow`, and the rest). Every key resolves once, at setup, by per-key shallow override — supply one and the other twenty-two keep their built-in English text.",
        "It is also the translation surface for `exportReport`: every line of the PNG/PDF report is built through this same resolved catalog, so a message you replace here changes the report text exactly as much as it changes the panel — there is no second, separate string table for the export path to keep in sync.",
        "This plugin's own canvas never draws any of the three portfolio builders directly, but `goalName` has a real, shipped renderer downstream of it: the dashboard's `\"goals\"` widget shows each goal's `name` on its card, so an unnamed goal's default \"Goal 1\" — or an override's text — is exactly what a reader sees there, which is what the demo below shows. `nodeName` and `copyName` stay closer to the original claim: a node's name is a string a host's own sidebar renders, and `copyName` only matters for a `duplicateProject()` call with no explicit `name`, which this page's demos never make.",
      ],
      demo: {
        kind: "values",
        values: [
          { label: "default (English)", demo: {} },
          {
            label: 'goalName: (n) => `OKR ${n}` — an unnamed goal\'s card',
            demo: {
              plugins: (sg) => [
                sg.portfolio({
                  nodes: [{ id: BUILD_PROJECT_ID, kind: "project", name: "Build", taskId: "build" }],
                  goals: [{ nodeIds: [BUILD_PROJECT_ID], target: 1 }],
                  dashboard: { open: true, widgets: ["goals"] },
                  messages: { goalName: (n: number) => `OKR ${n}` },
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
      "stargantt.portfolio":
        "The whole hierarchy surface: defineNode/removeNode/node/tree manage it; projectOf and tasksOf resolve it against the live store; setProjectCollapsed/collapseAllProjects/expandAllProjects drive tree-grid's row toggles; health/healthSummary compute the traffic light; defineGoal/removeGoal/goalProgress do the same for OKRs; duplicateProject clones a subtree as one undo step; moveTaskToProject reparents one as another; applyPortfolioFilter/portfolioFilter/savePortfolioView/applyPortfolioView/deletePortfolioView/portfolioViewNames cover the scoped-filter and saved-view surface; and the `nodes`/`goals` stores carry every hierarchy and goal change — subscribe there instead of to an event, since this plugin emits none for these changes.",
      "stargantt.dashboard":
        "Every widget's aggregation, callable without the panel existing at all — summary(), overdueTasks(), workload(), groupComparison(), burndown(), goalRollups()/portfolioStatus() (reading the same `stargantt.portfolio` node/goal registry), defineFormula/removeFormula/formulaValues for the custom-metric cards, updateTaskStatus for the panel's own write path, and open/close/refresh/element for driving the panel itself. Ask here for a custom report layout, a toolbar badge, or anything else that needs \"what does the project look like right now\" as data rather than as a rendered card.",
    },
    events: {
      "dashboard/opened":
        "Fires from both the boot path (`dashboard.open: true`) and a service `open()` call, with no way to tell them apart from the event alone — check whether your own code called `open()` if you need to distinguish a chart that opened itself from one a reader opened.",
      "dashboard/closed":
        "A no-op `close()` (the panel already closed) does not fire this — only an actual close does, whether triggered by the close button, Escape, or the service call.",
      "dashboard/refreshed":
        "The one place to watch for \"the panel just repainted\" without polling the service — `cause: \"data\"` for the automatic post-change refresh (coalesced to at most one per animation frame even after a burst of edits) and `cause: \"api\"` for an explicit `refresh()` call.",
    },
    commands: {
      __empty:
        "This plugin registers no commands of its own. It dispatches other plugins' public commands to do its work — tree-grid's `view/rowToggle` from `setProjectCollapsed`, and data-store's `task/add`/`task/update` from `duplicateProject`, `moveTaskToProject` and the dashboard's `updateTaskStatus` — but nothing here is a command a host would call by name through the command bus.",
    },
    extensionPoints: {
      __empty:
        "The plugin paints nothing outside its own dashboard panel, so it defines no extension point for another plugin to contribute into, and it contributes into none of the rendering points itself. A portfolio sidebar, a health board, or a custom dashboard widget body is host UI built entirely on the two services above — `renderWidget` is a config seam on one widget, not a point third parties register against.",
    },
  },

  recipes: [
    {
      title: "Group tasks into projects and let a reader narrow to one",
      intent:
        "The everyday shape: bind existing task subtrees to project nodes at setup, then let a picker built on the interaction plugin's filter service call applyPortfolioFilter with whichever nodes are checked.",
      code: `const gantt = StarGantt.create({
  element,
  plugins: [
    ...StarGantt.presetStandard(), // interaction is one of the nine — its filter service is what applyPortfolioFilter writes through
    StarGantt.portfolio({
      nodes: [
        { id: "platform", kind: "program", name: "Platform" },
        { id: "atlas", kind: "project", name: "Atlas rebuild", parentId: "platform", taskId: "atlas" },
        { id: "borealis", kind: "project", name: "Borealis mobile", parentId: "platform", taskId: "borealis" },
      ],
    }),
  ],
});
gantt.service("stargantt.data").load(dataset);

const portfolio = gantt.service("stargantt.portfolio");
portfolio.applyPortfolioFilter(["atlas"]);   // narrow to Atlas rebuild's tasks
portfolio.applyPortfolioFilter(null);        // clear the narrowing`,
    },
    {
      title: "Build a traffic-light health board",
      intent:
        "healthSummary() is the whole aggregation step — a host just maps the result onto whatever chips or rows its sidebar uses, with the status text always shown alongside any color.",
      code: `const portfolio = gantt.service("stargantt.portfolio");

for (const row of portfolio.healthSummary()) {
  const node = portfolio.node(row.nodeId);
  // row.status is "on-track" | "at-risk" | "late" — a string, always rendered as text,
  // never carried by color alone.
  console.log(\`\${node?.name}: \${row.status} (\${row.lateCount} late, \${row.atRiskCount} at risk)\`);
}`,
    },
    {
      title: "Clone a project as a template for a new engagement",
      intent:
        "duplicateProject deep-copies a project's whole task subtree and its internal links as one undo step, optionally shifting every date to a new start.",
      code: `const portfolio = gantt.service("stargantt.portfolio");

const newRootId = portfolio.duplicateProject("atlas", {
  name: "Atlas rebuild — Q3 kickoff",
  startAt: Date.now(),   // every copied date shifts by the same offset
  keepProgress: false,   // the copy starts at 0% regardless of the source's progress
});
// A new project node bound to newRootId is defined automatically, since the source
// ("atlas") was itself a project node rather than a raw task id.

gantt.dispatch("history/undo", {}); // undoes the whole clone — root task, children and links — in one step`,
    },
    {
      title: "Add the dashboard with a toolbar button, not on load",
      intent:
        "The usual shape for a real application: the plugin is always composed (its services are cheap and headless), but the panel only appears when a reader asks for it.",
      code: `const gantt = StarGantt.create({
  element: document.getElementById("chart"),
  plugins: [...StarGantt.presetStandard(), StarGantt.portfolio()],
});
gantt.service("stargantt.data").load(tasks);

document.getElementById("reportBtn").addEventListener("click", () => {
  gantt.service("stargantt.dashboard").open();
});`,
    },
    {
      title: "Custom metrics and a custom widget body",
      intent:
        "formulas covers a project-specific number the standard nine widgets cannot name; renderWidget replaces one widget's card body wholesale — here, the overdue list becomes a one-line summary, while still using ctx.markDone for the same one-undo-step commit the built-in button uses.",
      code: `StarGantt.portfolio({
  dashboard: {
    open: true,
    widgets: ["formulas", "overdue"],
    formulas: [
      {
        label: "Story points remaining",
        filter: (t) => t.type !== "summary",
        evaluate: (tasks) =>
          tasks.reduce((sum, t) => sum + ((t.progress ?? 0) < 1 ? (t.meta?.points ?? 0) : 0), 0),
      },
    ],
    renderWidget: (host, ctx) => {
      if (ctx.widget !== "overdue") return;
      const { overdue } = ctx.model;
      const line = document.createElement("p");
      line.textContent = overdue.length === 0 ? "Nothing overdue." : \`\${overdue.length} task(s) overdue.\`;
      host.appendChild(line);
    },
  },
})`,
    },
  ],
};

export default doc;
