import type { GuideDoc } from "../types";
import { T0 } from "../../lib/data";

const DAY = 86_400_000;
const d = (n: number): number => T0 + n * DAY;

/**
 * Earned value from zero: the three base figures, the four derived ones, both panels, and — the
 * part a StarGantt reader actually gets stuck on — what has to be in the data before any of the
 * numbers mean anything. One worked three-task example runs through the whole page, so every
 * figure in the prose is a figure the reader can see on the open dashboard beside it.
 */

/** The worked example: three tasks, a status date pinned to day 0, and round numbers throughout. */
const EXAMPLE_DATA = `[
    { id: "design", parentId: null, name: "Design", start: ${d(-8)}, end: ${d(-2)}, progress: 1, meta: { evm: { bac: 4000, actualCost: 4500 } } },
    { id: "build", parentId: null, name: "Build", start: ${d(-4)}, end: ${d(4)}, progress: 0.25, meta: { evm: { bac: 8000, actualCost: 3000 } } },
    { id: "test", parentId: null, name: "Test", start: ${d(2)}, end: ${d(6)}, progress: 0, meta: { evm: { bac: 2000 } } },
  ]`;

/** The guide-side wiring that opens a panel once the data has loaded, as a host button would. */
const openPanel = (panel: "dashboard" | "curve"): string => `sg.definePlugin({
      meta: { id: "guide.evm-open-${panel}", dependsOn: ["stargantt.tracking", "stargantt.data-store", "stargantt.view"] },
      setup(ctx) {
        const data = ctx.use("stargantt.data");
        const off = data.tasks.subscribe(() => {
          off.dispose();
          ctx.use("stargantt.evm").open${panel === "dashboard" ? "Dashboard" : "Curve"}Panel();
        });
        ctx.own(off);
      },
    })`;

const doc: GuideDoc = {
  slug: "earned-value-management",
  title: "Earned value management",
  lede: "A chart shows whether the work is on time. A cost report shows whether the spending is within budget. Earned value is how you answer both at once, from three numbers per task.",
  cells: [
    {
      kind: "prose",
      paragraphs: [
        "A gantt chart already compares two things: the plan and the progress. That answers one question — is the work on time — and a spending report against a budget answers another. What neither can answer alone is the question that matters in a status meeting: was the money spent worth the work it bought?",
        "Suppose half the schedule has passed, 60% of the budget is spent, and 40% of the work is done. The schedule view says slightly behind. The cost report says money left over. Both sound survivable, and together they are alarming — you paid 60 to get 40. To see that, you need schedule and cost measured in the same unit, and earned value does it by pricing everything in money.",
        "That is why EVM tracks three curves rather than the usual two. Each one is a running total, in currency, as of a chosen status date.",
      ],
    },
    {
      kind: "prose",
      paragraphs: [
        "`PV` — Planned Value — is what the plan says should have been earned by now: each task's budget, released evenly across its planned dates. A task past its planned end contributes its whole budget; one halfway through contributes half; one not yet started contributes nothing.",
        "`EV` — Earned Value — is what has actually been earned: each task's budget multiplied by how done it is. A 25%-done task with an 8 000 budget has earned 2 000, regardless of what it cost or when the plan wanted it.",
        "`AC` — Actual Cost — is what has actually been spent. It is the only one of the three that is a real cash figure rather than a budget fraction.",
        "Here it is with real numbers. Three tasks, and a status date on day 0 — Design's window is entirely past, Build is exactly halfway through its planned dates, Test has not started.",
      ],
    },
    {
      kind: "code",
      source: `// Status date: day 0. Budgets: Design 4 000, Build 8 000, Test 2 000 — BAC 14 000.
//
//         planned window   PV                 done   EV      spent  AC
// Design  day -8 ... -2    4000 (all of it)   100%   4000    4500   4500
// Build   day -4 ... +4    4000 (half of 8k)   25%   2000    3000   3000
// Test    day +2 ... +6       0 (not started)   0%      0       0      0
//                          ----                       ----           ----
//                    PV =  8000            EV =       6000    AC =   7500`,
      label: "ts",
      caption: "PV comes from the calendar, EV from the progress, AC from the spend — three independent measurements of the same project",
    },
    {
      kind: "runnable",
      source: `{
  preset: {
    view: { timeline: { origin: ${d(-9)}, initialZoom: "week" } },
    treeGrid: { paneWidth: 180 },
  },
  plugins: (sg) => [
    sg.tracking({ evm: { statusDate: ${d(0)} } }),
    ${openPanel("dashboard")},
  ],
  data: ${EXAMPLE_DATA},
  height: 420,
}`,
      height: 420,
      caption: "the worked example, live — the PV, EV and AC tiles show 8 000, 6 000 and 7 500, exactly the sums above",
    },
    {
      kind: "prose",
      paragraphs: [
        "Everything else falls out of those three by subtraction and division. Two variances, in money: `SV` (schedule variance) is `EV − PV`, and `CV` (cost variance) is `EV − AC`. Below zero means behind schedule and over budget respectively.",
        "Two indices, as ratios: `SPI` is `EV / PV`, and `CPI` is `EV / AC`. Above 1 is good, below 1 is bad, and — because PV and AC are independent — they move independently. A project can be ahead of schedule and over budget, or the reverse.",
      ],
    },
    {
      kind: "code",
      source: `SV  = EV - PV = 6000 - 8000 = -2000   // 2 000 worth of planned work not yet earned
CV  = EV - AC = 6000 - 7500 = -1500   // the earned work cost 1 500 more than it was worth
SPI = EV / PV = 6000 / 8000 =  0.75   // earning value at 75% of the planned pace
CPI = EV / AC = 6000 / 7500 =  0.80   // each unit spent buys 0.80 of value

EAC = BAC / CPI = 14000 / 0.80 = 17500   // projected total cost if CPI holds
ETC = EAC - AC  = 17500 - 7500 = 10000   // projected cost of the remaining work`,
      label: "ts",
      caption: "the four derived figures, plus the two forecasts, from the worked example — every one appears on a tile in the chart above",
    },
    {
      kind: "prose",
      paragraphs: [
        "Now the KPI panel above should read easily. It is ten tiles: the total budget `BAC`, the three base figures `PV` / `EV` / `AC`, the four derived ones `SV` / `CV` / `SPI` / `CPI`, and the two forecasts `EAC` / `ETC`. Each tile carries a one-line plain-language gloss under its value, so the panel explains its own vocabulary.",
        'When a figure is unhealthy — a variance below zero, an index below 1 — the tile says so in words ("behind schedule", "over cost"), never in colour alone.',
        "The forecasts deserve one caution: `EAC` extrapolates. The default formula, `BAC / CPI`, assumes the cost efficiency so far continues to the end — hence 17 500 for a 14 000 budget at CPI 0.80. It is a trend projected forward, not a promise, and `eacMethod` on the reference page offers other assumptions.",
      ],
    },
    {
      kind: "prose",
      paragraphs: [
        "The second panel draws the same three figures as curves over time — the classic S-curve. PV rises along the whole plan, from first planned start to last planned end; EV and AC rise only as far as the status date, because past it nothing has been earned or spent yet.",
        "Read it by the gaps at the right-hand edge. The vertical gap between EV and PV is the schedule variance; between EV and AC, the cost variance. Where EV would meet PV horizontally is roughly how late you are in time rather than money.",
      ],
    },
    {
      kind: "runnable",
      source: `{
  preset: {
    view: { timeline: { origin: ${d(-9)}, initialZoom: "week" } },
    treeGrid: { paneWidth: 180 },
  },
  plugins: (sg) => [
    sg.tracking({ evm: { statusDate: ${d(0)} } }),
    ${openPanel("curve")},
  ],
  data: ${EXAMPLE_DATA},
  height: 420,
}`,
      height: 420,
      caption: "the S-curve panel: EV running below PV is the schedule problem, AC running above EV is the cost problem",
    },
    {
      kind: "prose",
      paragraphs: [
        "Before any of these numbers mean anything, three things have to be in the data — and this is where most first attempts stall.",
        "Budgets, per task. A task's Budget at Completion goes at `meta.evm.bac` (or comes from the `cost` nest's estimated cost, when you have set one — `evm`, `cost` and `progress` are three nests of the one `tracking` plugin, so this fallback is always live, not something a separate plugin has to be added for). Every figure on both panels is a multiple of a budget: no budgets means PV, EV, AC and everything derived from them are all zero.",
        "Progress. EV is budget times done-ness, read from the task's plain `progress` field (or the `progress` nest's physical percent, when that is set). Tasks with budgets but no progress recorded earn nothing, so the chart reports you as far behind schedule as it is possible to be.",
        "A status date. PV is \"planned by now\", so there has to be a now. Unset, it falls back to the `progress` nest's status date, else today — which moves every time the page is opened. Pin `statusDate` in the config, as the demos above do, for numbers that stay reproducible; actual costs at `meta.evm.actualCost` should be the spend as of that same date.",
      ],
    },
    {
      kind: "callout",
      tone: "warn",
      body: "An all-zero dashboard is almost never a bug — it is a chart with no budgets. The plugin computes on whatever is there and a sum of zeros is zero, so it draws its panel and reports 0 on every tile without complaint. Put a `bac` on at least the tasks that matter before reading anything else on this page back to a stakeholder.",
    },
    {
      kind: "runnable",
      source: `{
  preset: {
    view: { timeline: { origin: ${d(-9)}, initialZoom: "week" } },
    treeGrid: { paneWidth: 180 },
  },
  plugins: (sg) => [
    sg.tracking({ evm: { statusDate: ${d(0)} } }),
    ${openPanel("dashboard")},
  ],
  data: [
    { id: "design", parentId: null, name: "Design", start: ${d(-8)}, end: ${d(-2)}, progress: 1 },
    { id: "build", parentId: null, name: "Build", start: ${d(-4)}, end: ${d(4)}, progress: 0.25 },
    { id: "test", parentId: null, name: "Test", start: ${d(2)}, end: ${d(6)}, progress: 0 },
  ],
  height: 420,
}`,
      height: 420,
      caption: "the same schedule with the budgets removed — progress is still there, and every figure is zero anyway",
    },
  ],
  next: ["/reference/tracking", "/reference/tracking/config", "/guides/baselines-and-progress"],
};

export default doc;
