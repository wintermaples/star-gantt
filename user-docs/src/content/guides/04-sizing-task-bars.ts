import type { GuideDoc } from "../types";

/**
 * Row height, bar radius, hit area, labels. Short by design: every option here has a full page of
 * its own on the task-bars config reference, and this guide is only the tour.
 */
const doc: GuideDoc = {
  slug: "sizing-task-bars",
  title: "Sizing task bars",
  lede: "How tall a row is, how tall the bar inside it is, and the settings that make bars easier to hit and easier to read.",
  cells: [
    {
      kind: "prose",
      paragraphs: [
        "A bar never fills its row. The space left over is what keeps one bar from touching the next.",
        "Row height is set once, on the `tree-grid`, and both panes follow it. Change it below and watch the names and the bars stay lined up.",
      ],
    },
    {
      kind: "runnable",
      source: `{
  preset: {
    treeGrid: { rowHeight: 28 },
  },
}`,
      caption: "`rowHeight` drives both panes at once",
    },
    {
      kind: "prose",
      paragraphs: [
        "Bars have square corners by default. `taskBars.barRadius` rounds them, in pixels.",
        "In an application, prefer setting the `--sg-bar-radius` CSS variable instead — one stylesheet then covers every chart on the page.",
      ],
    },
    {
      kind: "runnable",
      source: `{
  preset: {
    treeGrid: { rowHeight: 32 },
    taskBars: { barRadius: 6 },
  },
}`,
      caption: "`barRadius: 6` on a 32px row",
    },
    {
      kind: "prose",
      paragraphs: [
        "A one-day task at month zoom is a two-pixel sliver — readable, but almost impossible to grab. `expandedHitArea` makes the target at least 24 × 24 px without changing what is drawn.",
        "`progressLabel` writes the percentage on the bar. Worth turning on: fill length alone is lost in greyscale, in low vision, and on paper.",
      ],
    },
    {
      kind: "runnable",
      source: `{
  preset: {
    treeGrid: { rowHeight: 32 },
    taskBars: {
      barRadius: 6,
      expandedHitArea: true,
      progressLabel: true,
      durationLabel: { placement: "right" },
    },
  },
  height: 340,
}`,
      height: 340,
      caption: "same painting, bigger targets, meaning that survives losing colour",
    },
    {
      kind: "prose",
      paragraphs: [
        "One worth breaking on purpose. Make rows small enough and the bars have nowhere to go — you get a stripe pattern.",
        "No error appears, because nothing is wrong. It is a legal setting that happens to be useless.",
      ],
    },
    {
      kind: "runnable",
      source: `{
  preset: {
    treeGrid: { rowHeight: 12 },
    taskBars: { barRadius: 6 },
  },
  height: 220,
}`,
      height: 220,
      caption: "legal, and unreadable",
    },
    {
      kind: "callout",
      tone: "warn",
      body: "Row height decides how many tasks fit on a screen, how big every target is, and how much text fits in a cell. Pick it once for your application rather than per chart.",
    },
  ],
  next: ["/reference/task-bars", "/reference/task-bars/config"],
};

export default doc;
