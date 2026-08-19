import type { PluginDoc } from "../../types";
import { SAMPLE_TASKS, T0 } from "../../../lib/data";

const DAY = 86_400_000;
const d = (n: number): number => T0 + n * DAY;

// The shared sample carries no `meta` at all, so a mode column over it reads "Auto" nine times and
// says nothing about what the mode is *for*. Pinning one task out of automatic scheduling gives the
// column both of its values, which is the whole distinction it exists to make visible.
const PINNED_SAMPLE = SAMPLE_TASKS.map((row) =>
  row.id === "kernel" ? { ...row, meta: { scheduleMode: "manual" } } : row,
);

// A calendar demo pinned to a Wednesday: the sample project is anchored on today, so a fixed day
// offset lands on a different weekday every time the page is opened, and a holiday that happens
// to land on a weekend is shaded by the weekend band it duplicates, painting nothing new.
const iso = (offsetDays: number): string => new Date(T0 + offsetDays * DAY).toISOString().slice(0, 10);
const wednesdayFrom = (offsetDays: number): number =>
  offsetDays + ((3 - new Date(T0 + offsetDays * DAY).getUTCDay() + 7) % 7);
const HOLIDAY_1 = wednesdayFrom(5);
const HOLIDAY_2 = HOLIDAY_1 + 7;

// The shared sample links every detail task, so it reports zero diagnostics issues at rest — the
// diagnostics panel demo needs a dataset built to trip both checks it runs: an orphan (no link
// either direction) and a lead (a link with negative lag).
const DIAGNOSTICS_DATA = [
  { id: "spec", parentId: null, name: "Requirements", start: d(0), end: d(3), progress: 1 },
  { id: "build", parentId: null, name: "Build", start: d(3), end: d(9), progress: 0.3 },
  { id: "test", parentId: null, name: "Test", start: d(7), end: d(13) },
  { id: "audit", parentId: null, name: "Compliance audit", start: d(10), end: d(14) },
  { id: "l-spec-build", sourceId: "spec", targetId: "build", type: "FS", lag: 0 },
  { id: "l-build-test", sourceId: "build", targetId: "test", type: "FS", lag: -2 * DAY },
];

const doc: PluginDoc = {
  id: "stargantt.scheduling",
  summary:
    "The scheduling layer: dependency links and creation, the headless auto-schedule engine, working calendars, critical-path analysis, and a structural diagnostics panel — five independent config nests under one factory.",
  overview: [
    "This is the plugin that turns a pile of dated bars into a schedule. Its `dependencies` nest draws and lets a reader create the FS/SS/FF/SF links between tasks; `autoSchedule` publishes the headless engine that reads those links and, once turned on, folds every downstream move into the same transaction as the edit that caused it; `calendars` is the shared registry of working time that both the shading and the engine itself can read; `criticalPath` derives float and paints the chain that actually holds up the finish date; and `diagnostics` runs a small DCMA-style structural audit — unlinked tasks, negative-lag leads — behind an opt-in panel. None of the five needs the others to function: a chart can draw links with no engine composed, or run the engine headless with no renderer at all.",
    "Presence works differently across the five nests, and it is worth knowing which rule applies to which one before reaching for `{}`. `dependencies` is on by default: omit it and you still get link lines, ports and pointer-driven creation at their defaults, because leaving it out is not the same as turning it off. `calendars`, `criticalPath` and `diagnostics` are opt-in: omit any of those three and its feature is completely dormant — no registry seed, no shading, no CP visuals, no panel — and passing even an empty object turns it on with its own defaults. `autoSchedule` needs no such gate; the engine service is always live, and its two fields (`enabled`, `modeColumn`) simply default to composed, propagation off.",
    "Nothing here is optional at the service level even when its visuals are dormant: `stargantt.scheduler`, `stargantt.calendars` and `stargantt.critical-path` are all provided unconditionally, so a headless composition — `dataStore()` plus this plugin, no renderer, no task-bars — can still call `schedule()`, resolve working time, or read float for every task in plain Node. The chart-facing pieces (shading, link lines, bar recoloring, the diagnostics panel) degrade silently without a renderer or task-bars composed; nothing throws for their absence.",
  ],
  whenYouNeedIt:
    "any chart whose tasks have a real order — one task's finish or start pinning another's — or whose calendar isn't a plain seven-day week. Without this plugin a dependency link in the store is inert data with nothing to draw it, nothing derives a downstream move from an edit, and there is no notion of a working day beyond what grid-lines' own weekend fallback assumes.",
  demo: { preset: { treeGrid: { rowHeight: 30, paneWidth: 200 } } },
  overviewDemo: {
    kind: "configured",
    spec: {
      preset: {
        scheduling: { dependencies: { highlightConflicts: true } },
        treeGrid: { rowHeight: 30, paneWidth: 200 },
        // Both conflicting links live in the Build phase, past day 7 and outside the default
        // day-zoom viewport.
        view: { timeline: { initialZoom: "week" } },
      },
    },
    caption:
      "Every arrow is a stored dependency link; the two dashed red ones are links whose tasks no longer sit in the order the link promises — a conflict this plugin only reports, never fixes on its own.",
  },

  properties: [
    {
      name: "dependencies",
      prose: [
        "Enabled with its own defaults the moment this plugin is composed — the one nest here that is not opt-in. On by default it draws every FS/SS/FF/SF link as a routed line, paints a connector port at each linkable bar end, and lets a reader drag a new link from port to port; the sixteen fields underneath tune how much further that goes, from the routing style (`elbow` versus `straight`) and per-type line colors, to richer behavior that stays off until asked for: click-to-select-and-delete a link (`linkEditing`), hover-and-selection path emphasis (`highlightPaths`), a side-panel dependency inspector (`inspector`), and three kinds of dashed-line annotation — conflicting, driving, and a drop-target ring during a drag.",
        "It is deliberately quiet about scheduling itself: whether a link's constraint is actually honored is something this nest can only report, as `highlightConflicts`' dashed red line, never enforce — moving a date to satisfy a link is `autoSchedule`'s job, and the two compose or work alone without either knowing about the other. `showLinks: false` is the fastest way to isolate whether a slowdown is the link layer or the bars: it stops drawing and hit-testing lines without touching the store, the port drag, or any `link/*` command, so a chart built this way still tracks and edits dependencies, it just stops painting them.",
        "Reach past the defaults for a dense schedule specifically: `cullLines` skips lines wholly outside the horizontal viewport, and `avoidBars` nudges elbow routes clear of intervening task bars at a bounded cost (at most three passes, and it degrades to the plain route rather than looping). Both cost real per-frame work, which is why they are off by default rather than being the routing this nest starts with.",
      ],
      demo: {
        kind: "values",
        values: [
          { label: "default (16 fields at their own defaults)", demo: {} },
          {
            label: "{ highlightConflicts: true }",
            demo: {
              preset: {
                scheduling: { dependencies: { highlightConflicts: true } },
                view: { timeline: { initialZoom: "week" } },
              },
            },
          },
          {
            label: "{ showLinks: false }",
            demo: { preset: { scheduling: { dependencies: { showLinks: false } } } },
          },
        ],
      },
    },
    {
      name: "autoSchedule",
      prose: [
        "Publishes `SchedulerService` unconditionally and decides whether it runs on its own. `enabled` starts `false`, so composing this plugin, even through the standard preset, gives you the engine, the cycle guard on `link/add`, and a chart that moves only the bar a reader actually dragged. Turn it on and every user edit's own transaction grows to include the downstream moves the engine derives from the links you have, one undo step for the whole cascade. Off, the engine is still fully callable — `schedule()`, `latestTimes()`, `detectCycle()`, `previewReschedule()` all work exactly the same — so a host that wants to drive propagation on its own cadence, batched or on a timer, still has the primitive.",
        "Cycle rejection is not gated by `enabled` at all: it is a will-phase hook on `link/add` that runs whether or not propagation is turned on, because a cycle is a data-validity problem, not a scheduling one. A link that would close a loop is refused and `schedule/cycleRejected` fires regardless of this field.",
        "`modeColumn` is the one visible, static difference this nest can show without an edit: it adds a narrow read-only column to the tree grid stating whether each task is on autopilot or pinned via `task.meta.scheduleMode`, which the bar itself gives no hint of. It costs 64px of the grid pane's width and only appears with tree-grid composed; without it the contribution is buffered and inert.",
      ],
      demo: {
        kind: "values",
        prerequisite: { data: PINNED_SAMPLE, preset: { treeGrid: { paneWidth: 644 } } },
        values: [
          { label: "default (propagation off, no mode column)", demo: {} },
          {
            label: "{ modeColumn: true }",
            demo: { preset: { scheduling: { autoSchedule: { modeColumn: true } } } },
          },
        ],
      },
    },
    {
      name: "calendars",
      prose: [
        "Dormant when omitted — this nest is opt-in, and passing even `{}` turns the registry on. Once a calendar is registered, three things follow: its non-working time can be shaded across the chart body (whole rest days, plus intra-day gaps when the calendar declares `workingHours`); its pattern can be reflected into `autoSchedule`'s propagation, through the `scheduling` field, so a dependency chain stops landing a successor on a holiday; and any task can be assigned to it transactionally through the service's `assignTask`. The registry itself sits outside the transaction/undo pipeline — only `assignTask` is undoable — the same standing the data store's own calendars have.",
        "`shadeCalendar` and the registry's `isDefault` entry answer two different questions that are easy to conflate: `isDefault` decides which calendar a task with no `calendarId` of its own resolves to, and, unless `shadeCalendar` overrides it, which calendar gets shaded. Set `shadeCalendar` explicitly once a chart carries more than one calendar and the shading should track a specific one rather than whichever the registry happens to default to.",
        "`editor: true` mounts a hidden exception-day panel that a host opens later through `openEditor()` — nothing about it is visible until that call happens, so it costs a mounted DOM node with no on-screen effect on its own. Reach for it when a project owner needs to manage holidays and working windows without a code change on every edit, rather than shipping a new calendar list every time the list changes.",
      ],
      demo: {
        kind: "values",
        values: [
          { label: "default (empty registry, dormant)", demo: {} },
          {
            label: "one calendar, weekend Sat/Sun, two holidays shaded",
            demo: {
              preset: {
                scheduling: {
                  calendars: {
                    calendars: [
                      {
                        id: "standard",
                        name: "Standard (Mon-Fri)",
                        isDefault: true,
                        workingDays: [1, 2, 3, 4, 5],
                        exceptions: [
                          { date: iso(HOLIDAY_1), working: false },
                          { date: iso(HOLIDAY_2), working: false },
                        ],
                      },
                    ],
                  },
                },
                view: { timeline: { initialZoom: "week" } },
              },
            },
          },
          {
            label: '{ shadeCalendar: "gulf" } — a second registry calendar shaded instead',
            demo: {
              preset: {
                scheduling: {
                  calendars: {
                    shadeCalendar: "gulf",
                    calendars: [
                      { id: "standard", name: "Standard (Mon-Fri)", isDefault: true, workingDays: [1, 2, 3, 4, 5] },
                      { id: "gulf", name: "Gulf week (Sun-Thu)", workingDays: [0, 1, 2, 3, 4] },
                    ],
                  },
                },
                view: { timeline: { initialZoom: "week" } },
              },
            },
          },
        ],
      },
    },
    {
      name: "criticalPath",
      prose: [
        "Dormant when omitted, this nest is opt-in like `calendars` and `diagnostics`; passing it — even `{}` — enables classification and every default visual at once: `enabled: true`, a zero-day `thresholdDays`, bar recoloring and outlines, and critical-link emphasis strokes, with only `showFloat` starting off. The analysis reads the store's current dates plus `autoSchedule`'s own backward pass (`latestTimes()`) to derive, per task, how far its finish could slip without moving the project finish (total float) or any successor (free float) — it never moves a task itself, only reports on the schedule as it stands.",
        "Every parallel critical path is detected, not just one: a project with two independent zero-float chains reports two entries in `paths()`, which matters because a tool that only ever shows \"the\" critical path is hiding half the risk on a schedule with more than one driving chain. `nearCriticalDays` adds a second band just past the critical cutoff, turning a pass/fail chart into an early-warning one for tasks a handful of days from joining the critical set.",
        "The four color fields (`criticalColor`, `nearCriticalColor`, `negativeFloatColor`, `floatColor`) each resolve a CSS custom property first and a literal fallback second, refreshed on every paint — leave them unset and a theme switch recolors the critical path with the rest of the chart for free. `highlightBars` and `highlightLinks` can be turned off independently to keep the recolor while dropping the link emphasis, or the reverse, for a chart that already owns its own bar-coloring scheme.",
      ],
      demo: {
        kind: "values",
        // The zero-float and negative-float chains this nest paints both sit past day 7, outside
        // the default day-zoom viewport.
        prerequisite: { preset: { view: { timeline: { initialZoom: "week" } } } },
        values: [
          { label: "default (plugin dormant)", demo: {} },
          {
            label: "{} — defaults on (recolored, outlined, links emphasized)",
            demo: { preset: { scheduling: { criticalPath: {} } } },
          },
          {
            label: "{ showFloat: true }",
            demo: { preset: { scheduling: { criticalPath: { showFloat: true } } } },
          },
        ],
      },
    },
    {
      name: "diagnostics",
      prose: [
        "A single field, `panel`, and it defaults to `false` on purpose: the DCMA-style structural audit this nest runs — unlinked tasks (orphans) and negative-lag links (leads) — is available through the `stargantt.scheduler`-adjacent detection machinery whether or not a reader ever sees a button for it, and a CI job computing a report to fail a build has no use for a panel nobody will click. Turning `panel: true` on costs one absolutely-positioned root in the top-left corner of the chart pane's safe area and a single outside-press listener, both `ctx.own()`-registered.",
        "The button's label carries the finding count as text, `messages.button(issueCount)`, deliberately never as a color alone — a red dot conveys nothing in greyscale or to a reader who cannot distinguish that hue. With zero issues the button still opens a panel, just one reading `messages.noIssues`, so a clean schedule is a stated fact rather than an absent control.",
        "Summary tasks are exempt from the orphan check — their dates are a rollup, not something a link would normally touch — but milestones are not: an unlinked milestone is reported like any other task, because a marker nothing points at is exactly the kind of dangling logic DCMA audits are built to catch. The panel needs a renderer to mount into; without one composed it stays silently inert and the underlying report is still readable through the service.",
      ],
      demo: {
        kind: "values",
        values: [
          { label: "default (off)", demo: {} },
          {
            label: "{ panel: true } (on a dataset with findings)",
            demo: { preset: { scheduling: { diagnostics: { panel: true } } }, data: DIAGNOSTICS_DATA },
          },
        ],
      },
    },
    {
      name: "messages",
      prose: [
        "One merged catalog for all five areas — 62 keys, resolved once at setup by per-key shallow override. Most of them only render inside surfaces that stay hidden until a reader opens them: the calendar editor's labels, the dependency inspector's fields, the diagnostics panel's headings. The mode column's three keys (`modeColumnHeader`, `modeAuto`, `modeManual`) are the exception worth knowing first, because they are the one part of this catalog visible on an otherwise-untouched chart the moment `autoSchedule.modeColumn` is on.",
        "Builders are guarded per call, not latched, with one exception: every string in this catalog is either a plain replacement or a pure function of already-known values (a lag in days, a task pair, an exception date), so a throwing override falls back to the built-in English text for that one call and tries again cleanly next time — there is no per-instance failure mode to design around here.",
        "This is a construction-time value like every other message catalog in the library: a chart that needs to switch language at runtime is rebuilt with a new `scheduling(...)` call rather than mutating this object in place. Keys left out keep their English default, so translating one area — say, just the mode column — costs exactly those three keys, not all sixty-two.",
      ],
      demo: {
        kind: "values",
        prerequisite: {
          data: PINNED_SAMPLE,
          preset: { treeGrid: { paneWidth: 644 }, scheduling: { autoSchedule: { modeColumn: true } } },
        },
        values: [
          { label: "default (English)", demo: {} },
          {
            label: '{ modeColumnHeader: "Schedule", modeAuto: "Automatic", modeManual: "Fixed" }',
            demo: {
              preset: {
                scheduling: {
                  messages: { modeColumnHeader: "Schedule", modeAuto: "Automatic", modeManual: "Fixed" },
                },
              },
            },
          },
        ],
      },
    },
  ],

  notes: {
    services: {
      "stargantt.scheduler":
        "The headless engine other plugins build on — critical-path calls latestTimes() for its backward pass, and this plugin's own schedule/reschedule command calls schedule() to plan its moves. Call schedule() or previewReschedule() yourself when you need to know where something would land without touching the store, and taskScheduleMode(id) / propagationEnabled() to read the two facts that decide whether a task moves at all.",
      "stargantt.calendars":
        "The registry's own entry point: reading and editing calendars, resolving a task's effective one, working-time queries a host script can use directly (greying out a holiday in a date picker), assigning a task, and opening or closing the editor panel. Registry edits are outside the undo pipeline — only assignTask is transactional.",
      "stargantt.critical-path":
        "The real payload beyond the built-in painting: analysis() (or the floatOf / criticalityOf / paths shorthands) for a status widget, an export annotation, or a custom grid column, all reading the same lazily recomputed result the paint path itself uses.",
    },
    events: {
      "schedule/cycleRejected":
        "Fires from the will-phase guard that stops link/add from closing a loop, independently of autoSchedule.enabled — a cycle is a data-validity problem, not a scheduling one. Subscribe here to tell a reader why their drag-drawn link vanished instead of leaving them to work it out from the missing line.",
    },
    commands: {
      "schedule/reschedule":
        "The status-date rollup: moves the incomplete work forward, one transaction, one undo step. Call previewReschedule() on the scheduler service first if you want to show the moves before committing to them.",
      "schedule/setTaskMode":
        "The only supported way to flip a task between automatic and manual scheduling — writing meta.scheduleMode by hand through task/update bypasses the ignore-invalid-input guards this command applies (unknown ids, unusable mode values, no-op switches).",
    },
    extensionPoints: {
      "schedule/constraintBounds":
        "Teaches the engine a constraint type outside its eight built-ins. Only consulted for those extra types; a contribution cannot override ASAP, SNET, MSO or any other built-in's bounds.",
      "schedule/propagationRule":
        "Replaces the built-in date derivation for whichever tasks a contribution claims, consulted for every task the engine schedules. Declining (returning undefined) scopes a contribution to just the tasks it cares about; a claimed task's dates still pass through the built-in constraint clamp afterward.",
    },
  },

  recipes: [
    {
      title: "Turn dependency links into a schedule that keeps itself consistent",
      intent:
        "Links alone are just lines. Turning propagation on makes editing one task move everything the links say follows it, in a single undo step.",
      code: `presetStandard({
  scheduling: {
    autoSchedule: { enabled: true },
  },
})`,
    },
    {
      title: "Shade a working calendar and stop scheduling into holidays",
      intent:
        "The everyday calendars shape: one company calendar, its holidays visible on the chart, and automatic scheduling that already routes around them.",
      code: `presetStandard({
  scheduling: {
    calendars: {
      calendars: [
        {
          id: "standard",
          name: "Standard (Mon-Fri)",
          isDefault: true,
          workingDays: [1, 2, 3, 4, 5],
          exceptions: [
            { date: "2026-12-25", working: false },
            { date: "2027-01-01", working: false },
          ],
        },
      ],
      // scheduling: true is the default — registry calendars already feed automatic scheduling.
    },
    autoSchedule: { enabled: true },
  },
})`,
    },
    {
      title: "Show reviewers the chain that actually drives the finish date",
      intent:
        "No config beyond turning the nest on: classification, outlines and link emphasis are all default-on the moment criticalPath is present.",
      code: `presetStandard({
  scheduling: { criticalPath: {} },
})`,
    },
    {
      title: "Run a CI-style structural check with no UI at all",
      intent:
        "The diagnostics service works headless — fail a build on unlinked tasks or negative-lag leads without ever mounting the panel.",
      code: `const gantt = create({ element, plugins: presetStandard() });
gantt.service("stargantt.data").load(dataset);

const scheduler = gantt.service("stargantt.scheduler");
// Cycle rejection and the engine are already live; a structural check on top typically walks
// stargantt.data's ReadonlyDataView directly for orphan/lead-style rules of your own.`,
    },
  ],
};

export default doc;
