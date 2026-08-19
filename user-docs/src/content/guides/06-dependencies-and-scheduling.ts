import type { GuideDoc } from "../types";
import { T0 } from "../../lib/data";

const DAY = 86_400_000;
const d = (n: number): number => T0 + n * DAY;

/**
 * Links, then the plugin that enforces them, then critical path. The engine's internals (back-clamp
 * versus backward pass, transaction origins, float classes) stay on the auto-schedule and
 * critical-path reference pages; this guide only says what a reader has to do and what they will see.
 */
const doc: GuideDoc = {
  slug: "dependencies-and-scheduling",
  title: "Dependencies and automatic scheduling",
  lede: "The four kinds of link, what happens when one is broken, and how to make tasks move themselves when the task before them slips.",
  cells: [
    {
      kind: "prose",
      paragraphs: [
        "A link says which end of one task is pinned to which end of another. FS (finish-to-start) is the usual one: the second task cannot start until the first has finished.",
        "The other three cover the rest: SS starts them together, FF finishes them together, and SF is the rare case where one cannot finish until the other starts.",
        "`lag` shifts the link by a fixed amount of time. A negative lag pulls the second task earlier instead.",
      ],
    },
    {
      kind: "runnable",
      source: `{
  preset: {
    treeGrid: { paneWidth: 220 },
    view: { timeline: { initialZoom: "week" } },
  },
  data: [
    { id: "a", parentId: null, name: "A (predecessor)", start: ${d(4)}, end: ${d(8)} },
    { id: "b", parentId: null, name: "B — FS from A", start: ${d(8)}, end: ${d(12)} },
    { id: "c", parentId: null, name: "C — SS from A", start: ${d(4)}, end: ${d(9)} },
    { id: "d", parentId: null, name: "D — FF from A", start: ${d(3)}, end: ${d(8)} },
    { id: "e", parentId: null, name: "E — SF from A", start: ${d(0)}, end: ${d(4)} },
    { id: "f", parentId: null, name: "F — FS from A, lag 2d", start: ${d(10)}, end: ${d(14)} },
    { id: "l1", sourceId: "a", targetId: "b", type: "FS" },
    { id: "l2", sourceId: "a", targetId: "c", type: "SS" },
    { id: "l3", sourceId: "a", targetId: "d", type: "FF" },
    { id: "l4", sourceId: "a", targetId: "e", type: "SF" },
    { id: "l5", sourceId: "a", targetId: "f", type: "FS", lag: 2 * 86400000 },
  ],
  height: 320,
}`,
      height: 320,
      caption: "one predecessor, five different links",
    },
    {
      kind: "prose",
      paragraphs: [
        "Nothing stops you dragging a task in front of the one it depends on. Turn on `highlightConflicts` and any link whose promise is broken goes red and dashed.",
        "`highlightDriving` does the opposite: it thickens the links that are actually holding a task where it is.",
      ],
    },
    {
      kind: "runnable",
      source: `{
  preset: {
    treeGrid: { paneWidth: 220 },
    view: { timeline: { initialZoom: "week" } },
    scheduling: { dependencies: { highlightConflicts: true, highlightDriving: true } },
  },
  data: [
    { id: "a", parentId: null, name: "A", start: ${d(0)}, end: ${d(8)} },
    { id: "b", parentId: null, name: "B — on time (driving)", start: ${d(8)}, end: ${d(14)} },
    { id: "c", parentId: null, name: "C — starts before A finishes", start: ${d(5)}, end: ${d(10)} },
    { id: "l1", sourceId: "a", targetId: "b", type: "FS" },
    { id: "l2", sourceId: "a", targetId: "c", type: "FS" },
  ],
  height: 260,
}`,
      height: 260,
      caption: "B's link is thick and honoured; C's is dashed red",
    },
    {
      kind: "callout",
      tone: "warn",
      body: "A link that would create a loop is refused — the chart simply does not draw it. That guard covers links a person adds; it does not clean up a dataset you hand to `load()`, so build your own data without loops.",
    },
    {
      kind: "prose",
      paragraphs: [
        "Broken links stay broken until something fixes them, and that something is the auto-schedule engine — `scheduling.autoSchedule`. It is in the standard preset already, but it does not move anything until you ask it to.",
        "Pass `scheduling: { autoSchedule: { enabled: true } }` and the chart starts keeping itself consistent: drag one bar and everything downstream moves with it, in a single undo step. Leave it off and a drag moves only the bar you dragged — the links are still drawn, and a link that would make a loop is still refused either way.",
        "It is off by default because a chart that rearranges tasks you did not touch is alarming the first time you see it. Turn it on when your users expect a schedule that maintains itself.",
        'A task can opt out even then: give it `meta.scheduleMode: "manual"` and its dates are never moved for it again. Turn on `modeColumn` to show which tasks those are.',
      ],
    },
    {
      kind: "runnable",
      source: `{
  preset: {
    treeGrid: {
      paneWidth: 320,
      columns: [
        {
          id: "name",
          header: "Name",
          width: 220,
          getValue: (t) => t.name,
          render: (el, t) => { el.textContent = t.name; },
        },
      ],
    },
    view: { timeline: { initialZoom: "week" } },
    scheduling: { autoSchedule: { enabled: true, modeColumn: true } },
  },
  data: [
    { id: "design", parentId: null, name: "Design", start: ${d(0)}, end: ${d(4)} },
    { id: "build", parentId: null, name: "Build (auto)", start: ${d(4)}, end: ${d(10)} },
    { id: "launch", parentId: null, name: "Launch (manual)", start: ${d(10)}, end: ${d(12)}, meta: { scheduleMode: "manual" } },
    { id: "l1", sourceId: "design", targetId: "build", type: "FS" },
    { id: "l2", sourceId: "build", targetId: "launch", type: "FS" },
  ],
  height: 260,
}`,
      height: 260,
      caption: '`modeColumn: true` — Launch reads "Manual", the other two read "Auto"',
    },
    {
      kind: "prose",
      paragraphs: [
        "Critical path shows which tasks the finish date actually depends on. It is dormant until you name the nest, so you turn it on yourself.",
        "It only reads — it never moves anything. Tasks with no slack are marked critical, tasks that are already late are marked negative float, and everything else is left alone.",
        "Summary rows are not classified at all, so an unmarked summary means \"not analysed\", not \"has slack\".",
      ],
    },
    {
      kind: "runnable",
      source: `{
  preset: {
    treeGrid: { paneWidth: 220 },
    view: { timeline: { initialZoom: "week" } },
    scheduling: { criticalPath: { nearCriticalDays: 2 } },
  },
  height: 320,
}`,
      height: 320,
      caption: "the sample plan under `critical-path` — plugins, verification and ship are critical",
    },
    {
      kind: "prose",
      paragraphs: [
        "One combination worth seeing: a manual task with dates that already break the link into it.",
        "Manual means never moved, so this one never repairs itself. The red link is the only sign, which is a good reason to leave `highlightConflicts` on.",
      ],
    },
    {
      kind: "runnable",
      source: `{
  preset: {
    treeGrid: {
      paneWidth: 320,
      columns: [
        {
          id: "name",
          header: "Name",
          width: 220,
          getValue: (t) => t.name,
          render: (el, t) => { el.textContent = t.name; },
        },
      ],
    },
    view: { timeline: { initialZoom: "week" } },
    scheduling: {
      dependencies: { highlightConflicts: true },
      autoSchedule: { enabled: true, modeColumn: true },
    },
  },
  data: [
    { id: "design", parentId: null, name: "Design", start: ${d(0)}, end: ${d(6)} },
    { id: "build", parentId: null, name: "Build — manual, typed too early", start: ${d(2)}, end: ${d(8)}, meta: { scheduleMode: "manual" } },
    { id: "l1", sourceId: "design", targetId: "build", type: "FS" },
  ],
  height: 220,
}`,
      height: 220,
      caption: "Build is manual: this link will not repair itself, whatever else changes",
    },
    {
      kind: "callout",
      tone: "warn",
      body: "In short: links describe the order, `auto-schedule` enforces it, manual tasks are exempt from it, and critical path only reports on it.",
    },
  ],
  next: ["/reference/scheduling", "/reference/scheduling/config"],
};

export default doc;
