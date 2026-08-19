import type { GuideDoc } from "../types";

/**
 * The pointer gestures, in the order a reader meets them: move/resize/progress, then reorder, then
 * link creation, then turning the lot off. The plugin-boundary story (who computes, who rounds, who
 * records) belongs to the reference pages and is only alluded to here.
 */
const doc: GuideDoc = {
  slug: "editing-by-drag",
  title: "Editing by drag",
  lede: "Move a bar, resize it, set its progress, reorder rows, draw a dependency. All of it works out of the box — try the charts on this page.",
  cells: [
    {
      kind: "prose",
      paragraphs: [
        "Dragging works as soon as you call `presetStandard()`. Drag a bar's body to move it, an edge to resize it, and the progress fill to set completion.",
        "Turn on `dragTooltip` to show the dates the drag will commit while you are still holding the pointer.",
      ],
    },
    {
      kind: "runnable",
      source: `{
  preset: {
    treeGrid: { paneWidth: 360 },
    interaction: { dragEdit: { dragTooltip: true } },
  },
  height: 380,
}`,
      height: 380,
      caption: "drag the body to move, an edge to resize, the progress fill to set completion",
    },
    {
      kind: "prose",
      paragraphs: [
        "Press Escape mid-drag and nothing is committed — the bar goes back where it was. Releasing without having moved anything commits nothing either, so tapping a bar never fills your undo history with nothing.",
        "Dates round to whatever the timeline header is showing: days at day zoom, weeks at week zoom. Set `interaction.snap.unit` to fix the rounding regardless of zoom, and hold Alt while dragging to skip it for one gesture.",
      ],
    },
    {
      kind: "runnable",
      source: `{
  preset: {
    treeGrid: { paneWidth: 360 },
    interaction: {
      dragEdit: { dragTooltip: true },
      snap: { unit: "week" },
    },
  },
  height: 380,
}`,
      height: 380,
      caption: '`snap.unit: "week"` rounds to Monday boundaries at any zoom — hold Alt to commit the exact date instead',
    },
    {
      kind: "prose",
      paragraphs: [
        "Turn on `rowDrag` and dragging a row — by its bar in the chart, or by the row itself in the grid pane — reorders it, or files it under a different summary. A line shows the gap it will land in, indented to the outline level the drop would use.",
        "How deep the drop lands follows the pointer sideways: one outline level per 16px of horizontal travel. Drag left to lift a task out of its branch, all the way back to the root; drag right to file it under the row above.",
        "It is off by default, because up-and-down wobble during an ordinary date drag should not move a task to another parent.",
      ],
    },
    {
      kind: "runnable",
      source: `{
  preset: {
    treeGrid: { paneWidth: 360 },
    interaction: { dragEdit: { rowDrag: true } },
  },
  height: 380,
}`,
      height: 380,
      caption: "drag a bar up or down to reorder or re-parent it",
    },
    {
      kind: "prose",
      paragraphs: [
        "Every bar has a small port at each end. Drag from one to another to create a dependency; which ends you used decides the type, so end-to-start gives you FS and start-to-start gives you SS.",
        "Without a mouse: `Alt+L` on one task, then `Alt+L` on the next.",
      ],
    },
    {
      kind: "runnable",
      source: `{
  preset: {
    treeGrid: { paneWidth: 360 },
    scheduling: { dependencies: { highlightDropTargets: true } },
  },
  height: 380,
}`,
      height: 380,
      caption: "drag port to port to link two tasks — `highlightDropTargets` rings the one you are over",
    },
    {
      kind: "prose",
      paragraphs: [
        "One drag is one undo step, whatever it moved. Ctrl+Z and Ctrl+Shift+Z work without any setup.",
        "Turn on `liveUpdate` if you want dependent tasks to reschedule while you drag rather than on release. It costs you Escape: once an edit has been committed, Escape stops the drag but does not take it back — Ctrl+Z does.",
      ],
    },
    {
      kind: "prose",
      paragraphs: [
        "To make a chart read-only, switch the gestures off rather than removing plugins.",
        "Note what this looks like: with editing disabled the chart is pixel-identical until you try to drag something. Only the connector ports actually disappear.",
      ],
    },
    {
      kind: "runnable",
      source: `{
  preset: {
    treeGrid: { paneWidth: 360 },
    interaction: { dragEdit: { enabled: false } },
    scheduling: { dependencies: { allowLinkCreate: false } },
  },
  height: 380,
}`,
      height: 380,
      caption: "the bars look untouched, but nothing here responds to a drag",
    },
    {
      kind: "callout",
      tone: "warn",
      body: "Undo covers every edit, not just drags — grid edits, links and resource changes are all in the same history. Ctrl+Z always takes back the last thing that happened, whichever part of the chart it happened in.",
    },
  ],
  next: ["/reference/interaction", "/reference/interaction/config", "/reference/scheduling", "/reference/undo-redo"],
};

export default doc;
