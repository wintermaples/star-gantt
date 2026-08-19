import type { GuideDoc } from "../types";
import { T0 } from "../../lib/data";

const DAY = 86_400_000;
const d = (n: number): number => T0 + n * DAY;

/**
 * Baseline, actuals, RAG and the progress line, then a look at earned value — all four nested
 * inside the one opt-in `tracking` plugin (`baselines`, `progress`, `cost`, `evm`). This guide
 * covers `baselines` and `progress`; earned value gets its own guide. Every cell composes what
 * it needs by hand. The variance/report API surface stays on the reference pages.
 */
const doc: GuideDoc = {
  slug: "baselines-and-progress",
  title: "Baselines and tracking progress",
  lede: "The plan you agreed to, the plan you are working to now, and where the work actually is. Here is how to show all three.",
  cells: [
    {
      kind: "prose",
      paragraphs: [
        'A baseline is a frozen copy of the plan. Call `save("Kickoff plan")` and the chart remembers every task\'s dates as they are today.',
        "From then on it draws that copy in grey under the live bars, and marks the tasks that have moved away from it.",
        "The chart below saves a baseline, moves two tasks, and then compares against the saved copy. `baselines` is one nest of the opt-in `tracking` plugin.",
      ],
    },
    {
      kind: "runnable",
      source: `{
  preset: {
    view: { timeline: { initialZoom: "week" } },
    treeGrid: { paneWidth: 200 },
  },
  plugins: (sg) => [
    sg.tracking({ baselines: {} }),
    sg.definePlugin({
      meta: {
        id: "guide.capture-baseline",
        dependsOn: ["stargantt.tracking", "stargantt.data-store"],
      },
      setup(ctx) {
        const data = ctx.use("stargantt.data");
        const off = data.tasks.subscribe(() => {
          off.dispose();
          // A data-store subscriber may not dispatch synchronously — it would re-enter the
          // tasks store's own set(). One microtask is enough of a defer.
          queueMicrotask(() => {
            const baselines = ctx.use("stargantt.baselines");
            const kickoff = baselines.save("Kickoff plan");
            ctx.dispatch("task/move", { id: "kernel", start: ${d(9)}, end: ${d(15)} });
            ctx.dispatch("task/move", { id: "renderer", start: ${d(14)}, end: ${d(20)} });
            baselines.save("Revised plan");
            baselines.setActive(kickoff);
          });
        });
        ctx.own(off);
      },
    }),
  ],
  height: 340,
}`,
      height: 340,
      caption: "grey is the saved plan; kernel and renderer show +2d, and the tasks after them show +5d as the delay cascades",
    },
    {
      kind: "prose",
      paragraphs: [
        "Look at what the cascade did. Two tasks were moved by two days each, and everything downstream of them ended up five days late — including the Ship milestone, which nobody touched.",
        "That is what a baseline is for. The two days you dragged are rarely the whole story.",
        "Slip is shown as a triangle and a signed number, never as colour alone.",
      ],
    },
    {
      kind: "prose",
      paragraphs: [
        "Actual dates are a separate thing and need no baseline. Give a task `meta.actualStart` and `meta.actualEnd` and a dark stripe shows what really happened inside its bar.",
        "Work still in progress gets a stripe running up to the planned end, rather than stopping at nothing.",
      ],
    },
    {
      kind: "runnable",
      source: `{
  preset: {
    view: { timeline: { origin: ${d(-6)}, initialZoom: "week" } },
  },
  plugins: (sg) => [sg.tracking({ baselines: {} })],
  data: [
    { id: "spec", parentId: null, name: "Design review", start: ${d(-6)}, end: ${d(-2)}, progress: 1, meta: { actualStart: ${d(-5)}, actualEnd: ${d(-2)} } },
    { id: "impl", parentId: null, name: "Implementation", start: ${d(-4)}, end: ${d(6)}, progress: 0.5, meta: { actualStart: ${d(-4)} } },
    { id: "ship", parentId: null, name: "Ship", type: "milestone", start: ${d(13)}, end: ${d(13)}, meta: { actualStart: ${d(13)} } },
  ],
  height: 280,
}`,
      height: 280,
      caption: "the dark stripe is what really happened — no baseline needed",
    },
    {
      kind: "prose",
      paragraphs: [
        "`progress`, the other nest, adds health status. You set red, amber or green yourself — it is never guessed from the percentage, because 40% done can be fine or a disaster depending on the deadline.",
        "The badge shows the letter as well as the colour, so it survives being printed or screenshotted in greyscale.",
        "`progressLine` draws a zigzag through where each task should be by now. A bar to the left of the line is behind.",
      ],
    },
    {
      kind: "runnable",
      source: `{
  preset: {
    view: { timeline: { origin: ${d(-6)}, initialZoom: "week" } },
  },
  plugins: (sg) => [sg.tracking({ progress: { progressLine: true } })],
  data: [
    { id: "plan", parentId: null, name: "Planning", start: ${d(-6)}, end: ${d(-2)}, progress: 1 },
    { id: "design", parentId: null, name: "Design", start: ${d(-4)}, end: ${d(1)}, progress: 0.7, meta: { progressTracking: { rag: "green" } } },
    { id: "impl", parentId: null, name: "Implementation", start: ${d(-2)}, end: ${d(6)}, progress: 0.2, meta: { progressTracking: { rag: "amber" } } },
    { id: "test", parentId: null, name: "Test pass", start: ${d(2)}, end: ${d(8)}, meta: { progressTracking: { rag: "red" } } },
    { id: "release", parentId: null, name: "Release", start: ${d(9)}, end: ${d(10)} },
  ],
  height: 300,
}`,
      height: 300,
      caption: "R/A/G badges and the progress line together",
    },
    {
      kind: "prose",
      paragraphs: [
        "Earned value asks a third question: is the spending keeping pace with the calendar? It lives in the same plugin, under `evm`, and gets its own guide — the short version: give tasks a budget at `meta.evm.bac` and what they have cost so far at `meta.evm.actualCost`, and open the dashboard.",
        "You get SPI and CPI out of it — under 1 means behind schedule and over budget respectively. They move independently, so a project can be on time and over budget or the reverse.",
      ],
    },
    {
      kind: "runnable",
      source: `{
  preset: {
    view: { timeline: { origin: ${d(-5)}, initialZoom: "week" } },
    treeGrid: { paneWidth: 200 },
  },
  plugins: (sg) => [
    sg.tracking({ evm: {} }),
    sg.definePlugin({
      meta: { id: "guide.evm-open-dashboard", dependsOn: ["stargantt.tracking", "stargantt.data-store"] },
      setup(ctx) {
        const data = ctx.use("stargantt.data");
        const off = data.tasks.subscribe(() => {
          off.dispose();
          queueMicrotask(() => ctx.use("stargantt.evm").openDashboardPanel());
        });
        ctx.own(off);
      },
    }),
  ],
  data: [
    { id: "design", parentId: null, name: "Design", start: ${d(-5)}, end: ${d(5)}, progress: 0.3, meta: { evm: { bac: 8000, actualCost: 7000 } } },
    { id: "build", parentId: null, name: "Build", start: ${d(-2)}, end: ${d(18)}, progress: 0.05, meta: { evm: { bac: 12000, actualCost: 2000 } } },
  ],
  height: 400,
}`,
      height: 400,
      caption: 'the tiles say "behind schedule" and "over cost" in words, not just in colour',
    },
    {
      kind: "prose",
      paragraphs: [
        "One to be careful with. `slipThresholdMs` hides slip markers smaller than the duration you give it, in milliseconds — write it as arithmetic, like `3 * 86_400_000` for three days, so the unit stays visible.",
        "Set it above the slip in your data and every marker disappears while the grey baseline bars stay put. Nothing warns you — the numbers are still there in the reports, just not on screen. The comparison is exact, not rounded to whole days, so a slip of 2.5 days is hidden by a three-day threshold.",
      ],
    },
    {
      kind: "runnable",
      source: `{
  preset: {
    view: { timeline: { initialZoom: "week" } },
  },
  plugins: (sg) => [
    sg.tracking({
      baselines: {
        baselines: [
          {
            id: "b1",
            tasks: [
              { id: "kernel", start: ${d(7)}, end: ${d(11)} },
              { id: "renderer", start: ${d(11)}, end: ${d(16)} },
            ],
          },
        ],
        active: "b1",
        slipThresholdMs: 3 * 86_400_000, // three days
      },
    }),
  ],
  height: 280,
}`,
      height: 280,
      caption: "both tasks are still two days late — a three-day threshold just stops saying so",
    },
    {
      kind: "callout",
      tone: "warn",
      body: "`baselines`, `progress`, `cost` and `evm` read each other's data but never change it — they are nests of one plugin, not separate ones, so there is no compose order to get wrong. If a number looks stale, check which nest owns it: variance belongs to `baselines`, RAG and remaining work are plain fields `progress` reads, and the earned-value figures are recomputed every time you ask for them.",
    },
  ],
  next: ["/reference/tracking", "/reference/tracking/config", "/guides/earned-value-management"],
};

export default doc;
