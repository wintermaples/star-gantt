import { T0 } from "../../../lib/data";
import type { PluginDoc, StarGanttApi } from "../../types";

const DAY = 86_400_000;
const d = (n: number): number => T0 + n * DAY;

/**
 * A small dataset for the milestoneShape demo: one task, one milestone six days out. The shared
 * sample dataset's own milestone sits at day 24, which is well past the right edge of the default
 * ~week-wide viewport — every shape option would paint nothing at all, so no two values could ever
 * be told apart. This dataset exists solely to put a milestone on screen.
 */
const MILESTONE_DEMO_DATA = [
  { id: "design", parentId: null, name: "Design", type: "summary" as const, start: d(0), end: d(6) },
  { id: "wire", parentId: "design", name: "Wireframes", start: d(0), end: d(4), progress: 1 },
  { id: "ship", parentId: null, name: "Ship", type: "milestone" as const, start: d(6), end: d(6) },
];

/**
 * A dataset for the labelBackdrop demo: two tasks with a gap between them and one FS link, so a
 * dependency line is routed straight through where the first task's label is drawn. The shared
 * sample's bars sit too close together for the collision the option exists to fix.
 */
const BACKDROP_DEMO_DATA = [
  { id: "design", parentId: null, name: "Design phase", start: d(0), end: d(4) },
  { id: "build", parentId: null, name: "Build phase", start: d(9), end: d(14) },
  { id: "l1", sourceId: "design", targetId: "build", type: "FS" as const },
];

/**
 * Collapses the "Build" summary row once the demo's data has loaded, so the collapsedSummary
 * option has a folded row to act on. The shared sample opens with every row expanded, and
 * collapsedSummary paints nothing for an expanded summary — without this, "split" and "hidden"
 * would both be demonstrating the same expanded chart the default already shows.
 */
function collapseBuildRow(sg: StarGanttApi) {
  return [
    sg.definePlugin({
      meta: { id: "docs.task-bars-collapse-build", dependsOn: ["stargantt.tree-grid", "stargantt.data-store"] },
      setup(ctx) {
        // There is no `data/tasksChanged` event — subscribe to the `tasks` store on
        // `stargantt.data` instead, which is set (among other times) once per `load()`.
        const data = ctx.use("stargantt.data");
        const off = data.tasks.subscribe(() => {
          off.dispose();
          ctx.dispatch("view/rowToggle", { id: "build", expanded: false });
        });
        ctx.own(off);
      },
    }),
  ];
}

/**
 * Reference implementation of a plugin page. Every other plugin module follows this shape:
 * a summary line, an overview that says what the plugin owns, one entry per option in `api.json`,
 * and recipes for the two or three things people ask for first.
 */
const doc: PluginDoc = {
  id: "stargantt.task-bars",
  summary: "Draws the bars themselves, and owns the bar geometry every other plugin measures against.",
  overview: [
    "Draws one bar per visible task. It contributes two canvas layers to the renderer — the bar bodies, and the adornments that sit on a bar's ends — and it answers the hit test for bars, their resize handles, and the narrow strip around each bar's progress boundary.",
    "It also publishes the resulting bar geometry as a service, which matters more than it sounds. Drag-edit, dependencies and baselines all ask this plugin where a bar is rather than recomputing it from dates and zoom, so they cannot disagree with what you can see. If you write a plugin that needs to point at a bar, ask here too.",
    "Bar colours are theme tokens read through the view plugin's `stargantt.theme` service (its own cached `getComputedStyle`), so a stylesheet can restyle every bar without this plugin knowing anything about it.",
  ],
  whenYouNeedIt:
    "always. Remove task-bars and the timeline still scrolls, still has a header and still has rows — with nothing drawn on it.",
  demo: { preset: { treeGrid: { rowHeight: 30, paneWidth: 200 } } },
  overviewDemo: {
    kind: "configured",
    // One option, plus the same grid tweaks `demo` uses to keep the chart pane wide enough to read.
    // A label provider is the smallest thing that puts something on the canvas the default bar does
    // not already draw, and it needs no prerequisite of its own.
    spec: {
      preset: {
        taskBars: { label: (task: { name: string }) => task.name },
        treeGrid: { rowHeight: 30, paneWidth: 200 },
      },
    },
    caption:
      "Each bar now carries its task's name past its right end — text this plugin paints onto the canvas, not the grid pane's Name column.",
  },

  properties: [
    {
      name: "barRadius",
      prose: [
        "Rounds the corners of ordinary task bars. Milestones are a shape of their own and ignore it; summary glyphs keep their bracket profile.",
        "Leave it out and the `--sg-bar-radius` theme token decides instead, which is the better default for an application: one stylesheet then sets the house style for every chart on the page. Set it here only when a single chart needs to differ from its neighbours. `0` is itself a value and wins over the token — square corners on a chart whose theme asks for something rounder — which is the one case worth calling out: only a negative or non-finite number is treated as leaving the option unset and falls back to the token. The shipped theme's token is 4px, which is why the default chart on this page is already gently rounded.",
        "Large values read as pills and cost horizontal precision — a rounded end no longer marks the exact date the bar ends, which starts to matter at day zoom.",
      ],
      demo: {
        kind: "values",
        values: [
          { label: "default (theme token, 4px)", demo: {} },
          { label: "0", demo: { preset: { taskBars: { barRadius: 0 } } } },
          { label: "10", demo: { preset: { taskBars: { barRadius: 10 } } } },
          { label: "20", demo: { preset: { taskBars: { barRadius: 20 } } } },
        ],
      },
    },
    {
      name: "progressLabel",
      prose: [
        "Completion is normally shown as a lighter fill inside the bar — a length, which the eye compares well but reads imprecisely. This adds the number.",
        "It is also the accessible fallback. Progress carried only by fill length is progress carried by a visual property alone; with the label on, the same fact survives greyscale, low vision and a printed page.",
        "Milestones and summaries get none — neither has a completion of its own to state.",
      ],
      demo: {
        kind: "values",
        values: [
          { label: "default (off)", demo: {} },
          { label: "true", demo: { preset: { taskBars: { progressLabel: true } } } },
          {
            label: '{ placement: "right" }',
            demo: { preset: { taskBars: { progressLabel: { placement: "right" } } } },
          },
        ],
      },
    },
    {
      name: "durationLabel",
      prose: [
        "Bar length encodes duration, but only against the timeline header — at month zoom a reader cannot tell four days from six without counting gridlines. The label removes the counting.",
        "Rounded to whole days, minimum one, so a sub-day task never reads as \"0d\". Milestones carry no duration and get no label.",
        "It costs horizontal room: with the label past the bar's right edge, a dense chart can end up with labels running into the next bar. Prefer \"inside\" when bars are long and \"right\" when they are short.",
      ],
      demo: {
        kind: "values",
        values: [
          { label: "default (off)", demo: {} },
          { label: "true", demo: { preset: { taskBars: { durationLabel: true } } } },
          {
            label: '{ placement: "inside" }',
            demo: { preset: { taskBars: { durationLabel: { placement: "inside" } } } },
          },
        ],
      },
    },
    {
      name: "label",
      prose: [
        "The task names in the grid are not on the chart. This puts them there — useful when the chart is exported on its own, or when the grid pane is narrow enough that names are truncated.",
        "The function runs once per visible bar on every paint, so it must be cheap: read a field, format a string, return. Anything that allocates or does work proportional to the dataset belongs in a memo outside the provider.",
        "Returning undefined or an empty string leaves that bar unlabelled, which is how you label only the rows that matter rather than all of them.",
      ],
      demo: {
        kind: "values",
        values: [
          { label: "default (no labels)", demo: {} },
          {
            label: "(task) => task.name",
            demo: { preset: { taskBars: { label: (task: { name: string }) => task.name } } },
          },
        ],
      },
    },
    {
      name: "labelBackdrop",
      prose: [
        "A halo painted behind every label that sits outside its bar, so the label stays readable where a dependency line crosses it. Labels live in the gap between two bars and so do the lines, which is the whole collision: the chart draws the labels above the lines, and this covers the few pixels of line directly behind each word.",
        "It is on by default and costs nothing until you configure a label, because with no label source there is nothing to put a halo behind. The fill comes from the `--sg-bar-label-backdrop` token, which is the chart background at most of its alpha rather than a colour of its own — the point is to make the text read, not to blank the gap, so the line stays visible either side of every label.",
        'Labels placed "inside" never get one. They sit on the bar\'s own fill, not on the chart background, and the plugin already measures their contrast against that fill.',
      ],
      demo: {
        kind: "values",
        // Nothing to sit behind without a label, and no line to hide without a dependency, so the
        // prerequisite supplies both.
        prerequisite: {
          preset: { taskBars: { label: (task: { name: string }) => task.name } },
          data: BACKDROP_DEMO_DATA,
        },
        values: [
          { label: "default (on)", demo: {} },
          { label: "false", demo: { preset: { taskBars: { labelBackdrop: false } } } },
          {
            label: "{ color, padding, radius }",
            demo: {
              preset: {
                taskBars: {
                  labelBackdrop: { color: "rgba(255, 235, 59, 0.75)", padding: 5, radius: 8 },
                },
              },
            },
          },
        ],
      },
    },
    {
      name: "milestoneShape",
      prose: [
        "Milestones have zero length, so they cannot be a bar; they are a marker at a date. The diamond is the convention every project tool shares, and changing it costs recognition — do it when a second class of milestone needs to be told apart, not for style.",
        "The function form is what makes that possible: return a different shape for an external deadline than for an internal gate and the difference survives greyscale, which a colour change would not.",
        "Every shape fills the same square box, so hit-testing and label anchors do not move when you change it.",
      ],
      demo: {
        kind: "values",
        // The shared sample's milestone sits at day 24, off the right edge of the default
        // viewport — no shape would ever paint there. This dataset's milestone is six days out
        // instead, so it is on screen for every value, including the default.
        values: [
          { label: 'default ("diamond")', demo: { data: MILESTONE_DEMO_DATA } },
          {
            label: '"triangle"',
            demo: { data: MILESTONE_DEMO_DATA, preset: { taskBars: { milestoneShape: "triangle" } } },
          },
          {
            label: '"star"',
            demo: { data: MILESTONE_DEMO_DATA, preset: { taskBars: { milestoneShape: "star" } } },
          },
          {
            label: '"square"',
            demo: { data: MILESTONE_DEMO_DATA, preset: { taskBars: { milestoneShape: "square" } } },
          },
        ],
      },
    },
    {
      name: "patternFill",
      prose: [
        "true hatches ordinary bars diagonally and cross-hatches summary bodies. Milestones already differ by shape and are left alone.",
        "This is the direct answer to \"meaning must never be carried by colour alone\". If your chart uses fill colour to mean something — a status, an owner, a scenario — texture is the second channel that keeps it readable for a colour-blind reader and in a black-and-white export.",
        "The function form chooses per task and falls back to the built-in mapping when it returns undefined, so you can texture only the rows that need it.",
      ],
      demo: {
        kind: "values",
        values: [
          { label: "default (off)", demo: {} },
          { label: "true", demo: { preset: { taskBars: { patternFill: true } } } },
        ],
      },
    },
    {
      name: "expandedHitArea",
      prose: [
        "Nothing painted changes — this option is invisible until you try to click something small. A one-day task at month zoom is a two-pixel sliver: perfectly legible, and effectively unclickable.",
        "24 × 24 CSS px is the accessible minimum for a pointer target, and it is what this guarantees around each bar's centre. Resize handles and the progress strip keep their exact zones, so precision editing is not traded away for reach.",
        "Turn it on for charts used on a tablet or at wide zoom levels. The cost is that two bars closer together than 24px start competing for the same clicks.",
      ],
      demo: {
        kind: "none",
        reason:
          "Nothing painted changes — the option widens the pointer target and leaves every pixel where it was. A value picker here would offer a reader a choice between two identical charts, which is worse than saying plainly that the difference is in what you can hit, not in what you can see.",
      },
    },
    {
      name: "collapsedSummary",
      prose: [
        'What a summary row shows while it is folded. "range" paints the summary\'s own span, which is the honest default: one row, one bar, one span.',
        '"split" paints the direct children inside the parent\'s row instead, so a folded project still shows what it contains and when. Those in-row bars are real editing surfaces — draggable, resizable — and they carry the same conditional-format colors and bar labels a row-owning bar would, so a reader can tell them apart without hovering; what they do not get is bar icons, avatars or `taskbars/overlays`, since those are per-row-owning-bar and a split row owns none. A child whose own row is filtered or collapsed out to height 0 is left out entirely — not painted, not hit-testable — so a split row never shows a task the grid itself is hiding.',
        '"hidden" paints and hit-tests nothing for a folded summary, which is what you want when the summary row exists purely as a grouping device and its span means nothing.',
      ],
      demo: {
        kind: "values",
        // The shared sample opens fully expanded, and this option paints nothing for an expanded
        // summary — the "Build" row has to actually be folded before "split" and "hidden" have
        // anything to differ over, including from the default's untouched, expanded chart.
        prerequisite: { plugins: collapseBuildRow },
        values: [
          { label: 'default ("range")', demo: {} },
          { label: '"split"', demo: { preset: { taskBars: { collapsedSummary: "split" } } } },
          { label: '"hidden"', demo: { preset: { taskBars: { collapsedSummary: "hidden" } } } },
        ],
      },
    },
    {
      name: "barIcons",
      prose: [
        "Draws a glyph inside each end of a bar — a lock on a constrained start, a flag on a committed finish, a warning on an end that has moved.",
        "Bars too narrow to fit a glyph per end draw none, and milestones never do. That is a silent fallback by design: an icon that does not fit is better dropped than drawn over the bar it belongs to.",
        "Like every provider that runs in the paint loop, the first throw is reported once through the plugin-error event and the provider then declines for good, so a bad icon function degrades the chart rather than stopping it.",
      ],
      demo: {
        kind: "values",
        values: [
          { label: "default (none)", demo: {} },
          {
            label: "lock on started tasks",
            demo: {
              preset: {
                taskBars: {
                  barIcons: (task: { progress?: number }) =>
                    (task.progress ?? 0) > 0 ? { left: "🔒" } : undefined,
                },
              },
            },
          },
        ],
      },
    },
    {
      name: "avatar",
      prose: [
        "A filled circle with initials on a bar's right end — who owns this task, answerable without opening anything.",
        "Initials rather than a picture is a deliberate limit: the chart paints to canvas, and a remote image would make painting asynchronous and the frame budget unpredictable. Two characters is what reliably fits.",
        "Return undefined for tasks with no owner rather than an empty badge; an empty circle reads as \"unassigned and we are sure\", which is rarely what the data means.",
      ],
      demo: {
        kind: "values",
        values: [
          { label: "default (none)", demo: {} },
          {
            label: "initials from the task name",
            demo: {
              preset: {
                taskBars: {
                  avatar: (task: { name: string }) => ({ initials: task.name.slice(0, 2).toUpperCase() }),
                },
              },
            },
          },
        ],
      },
    },
    {
      name: "renderBar",
      prose: [
        "Replaces the painting of every bar body. The callback is handed the canvas context, the bar's box, the task, and a defaultPaint function that draws the built-in look — so the usual use is to call defaultPaint and then decorate, not to redraw from nothing.",
        "Labels, icons, avatars and overlay contributions still draw on top afterwards, so a custom body does not silently remove them.",
        "This runs once per visible bar per frame. At ten thousand rows that is the hottest path in the library: no allocation, no getComputedStyle, no measureText per call.",
      ],
      demo: {
        kind: "none",
        reason:
          "A renderer's effect depends entirely on the function supplied, so a value picker would be documenting an example rather than the option. The Recipes tab carries a worked one.",
      },
    },
    {
      name: "messages",
      prose: [
        "Replacement wording for this plugin's built-in empty state. Keys left out keep their English defaults.",
        "Resolved once, at setup, and not re-read afterwards — changing the object later has no effect. Charts that switch language at runtime rebuild instead.",
      ],
      demo: {
        kind: "none",
        reason:
          "The strings only appear when the chart has no tasks at all, which the shared sample dataset is the opposite of. The i18n plugin's page covers the language story end to end.",
      },
    },
  ],

  notes: {
    services: {
      "stargantt.task-bars":
        "Ask this before computing a bar's position yourself. It is the same geometry the hit test and every official overlay uses, so an answer from here cannot disagree with what is on screen.",
    },
    events: {
      __empty:
        "Bars are drawn state, not a source of intent. The gestures that change a bar belong to drag-edit, and the transactions they produce belong to data-store — subscribe there.",
    },
    commands: {
      __empty:
        "Nothing here is imperative. To change what a bar shows, change the data or the config; to change how it is painted, contribute to taskbars/style.",
    },
    extensionPoints: {
      "taskbars/overlays":
        "The point almost every official decoration uses: baselines' slip triangle, critical-path's warning glyph, progress-tracking's RAG badge. Collect strategy, so contributions stack rather than compete.",
      "taskbars/style":
        "First strategy — the first provider that answers wins, and a contribution cannot be withdrawn later. That is why conditional-format always contributes and decides inside its provider instead.",
      "taskbars/endGutter":
        "Reserve clearance outside a bar's start or end edge instead of shrinking the bar itself — a dependency-line connector port and this plugin's own label offset both read the resolved value from `BarBox.gutterStart`/`gutterEnd` rather than guessing at each other's territory. Reduce strategy: the largest active reservation per end wins, so two contributions asking for room never fight over it.",
    },
  },

  recipes: [
    {
      title: "Distinguish task types without relying on colour",
      intent:
        "Required whenever fill colour carries meaning: a colour-blind reader, a greyscale print and a projector all lose hue before they lose texture or shape.",
      code: `presetStandard({
  taskBars: {
    patternFill: true,           // hatched bars, cross-hatched summaries
    milestoneShape: "triangle",  // milestones already differ by shape
    progressLabel: true,         // completion as a number, not only a fill
  },
})`,
    },
    {
      title: "Make short bars grabbable on a tablet",
      intent:
        "A one-day task at month zoom is a two-pixel target. This widens the pointer area to the accessible minimum without changing a single painted pixel.",
      code: `presetStandard({
  taskBars: { expandedHitArea: true },
})`,
    },
    {
      title: "Decorate the default bar instead of replacing it",
      intent:
        "The usual mistake with renderBar is redrawing everything. Call defaultPaint first, then add — you keep theming, progress fill and selection for free.",
      code: `presetStandard({
  taskBars: {
    renderBar: (ctx, box, task, defaultPaint) => {
      defaultPaint();
      if (task.progress === 1) return;
      ctx.strokeStyle = "#c0392b";
      ctx.strokeRect(box.x + 0.5, box.y + 0.5, box.width - 1, box.height - 1);
    },
  },
})`,
    },
  ],
};

export default doc;
