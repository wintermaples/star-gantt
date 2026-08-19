import type { GuideDoc } from "../types";

/**
 * Large charts: what is already handled, the three settings that help when it is not, and how to
 * measure rather than guess. The layer/zIndex table and the dirty-region rules stay on the view
 * plugin's reference page; this guide keeps to what a host decides.
 */
const doc: GuideDoc = {
  slug: "ten-thousand-tasks",
  title: "Ten thousand tasks",
  lede: "Nothing about the API changes as a plan gets big. Here is what already handles it for you, and the few things that can undo that.",
  cells: [
    {
      kind: "prose",
      paragraphs: [
        "The chart below loads ten thousand tasks with the same `load()` call as everything else on this site. There is no large-data mode to switch on.",
        "Only the rows you can see are built. Scroll and a different handful is built; the number never grows with your data.",
      ],
    },
    {
      kind: "runnable",
      source: `{
  data: (() => {
    const DAY = 86400000;
    const base = Math.floor(Date.now() / DAY) * DAY;
    const projects = 200;
    const perProject = 50; // 200 * 50 = 10,000 leaf tasks, plus 200 summary rows
    const tasks = [];
    for (let p = 0; p < projects; p++) {
      const projectId = "proj-" + p;
      const projectStart = base + p * 20 * DAY;
      tasks.push({
        id: projectId,
        parentId: null,
        name: "Project " + (p + 1),
        type: "summary",
        start: projectStart,
        end: projectStart + perProject * DAY,
      });
      for (let t = 0; t < perProject; t++) {
        const start = projectStart + t * DAY;
        tasks.push({
          id: projectId + "-t" + t,
          parentId: projectId,
          name: "Task " + (t + 1),
          start,
          end: start + 2 * DAY,
          progress: (t % 5) / 5,
        });
      }
    }
    return tasks;
  })(),
  preset: {
    treeGrid: { paneWidth: 220 },
    view: { timeline: { initialZoom: "month" } },
  },
  height: 360,
}`,
      height: 360,
      caption: "10,200 tasks in one `load()` call — scroll it",
    },
    {
      kind: "prose",
      paragraphs: [
        "Working out which rows are on screen is fast because every row is the same height — the position of row 6,000 is a multiplication.",
        "Make one row a different height and that shortcut is gone for the whole chart. It is still fast, just not free, and one odd row costs the same as a thousand.",
        "If the taller row is only there for looks, use padding inside the cell instead and keep the shortcut.",
      ],
    },
    {
      kind: "runnable",
      source: `{
  preset: {
    treeGrid: { paneWidth: 260 },
  },
  plugins: (sg) => [
    sg.definePlugin({
      meta: { id: "acme.tall-row", dependsOn: ["stargantt.tree-grid"] },
      setup(ctx) {
        // One row, three times its neighbours' height.
        ctx.contribute("rows/height", (task, defaultHeight) =>
          task.id === "wire" ? defaultHeight * 3 : undefined,
        );
      },
    }),
  ],
}`,
      caption: "one taller row — and every row lookup in the chart takes the slower path",
    },
    {
      kind: "prose",
      paragraphs: [
        "Three view-plugin settings help a chart that is both large and constantly moving. All three are off by default, because they cost something on a chart that just sits there.",
        "`dirtyRegions` repaints only the part that changed. `progressive` draws a simpler frame while you are scrolling and a full one once you stop. `prefetch` prepares the area you are scrolling towards.",
        "Turn them on for ten thousand rows that get dragged around all day. Leave them off for a status report that renders once.",
      ],
    },
    {
      kind: "runnable",
      source: `{
  preset: {
    treeGrid: { paneWidth: 220 },
    view: { dirtyRegions: true, progressive: true, prefetch: true },
  },
  height: 300,
}`,
      height: 300,
      caption: "identical pixels — these change what a repaint costs, not what it draws",
    },
    {
      kind: "prose",
      paragraphs: [
        "Do not guess at any of this. `perf-tools` is an opt-in plugin that puts a frame-rate readout and a sparkline in the corner, and records a trace you can export.",
        "It cannot be clicked and is hidden from screen readers, so leaving it in costs nothing but the corner of the screen.",
      ],
    },
    {
      kind: "runnable",
      source: `{
  data: (() => {
    const DAY = 86400000;
    const base = Math.floor(Date.now() / DAY) * DAY;
    const projects = 80;
    const perProject = 40; // 3,200 leaf tasks — enough to make the readout move
    const tasks = [];
    for (let p = 0; p < projects; p++) {
      const projectId = "proj-" + p;
      const projectStart = base + p * 20 * DAY;
      tasks.push({
        id: projectId,
        parentId: null,
        name: "Project " + (p + 1),
        type: "summary",
        start: projectStart,
        end: projectStart + perProject * DAY,
      });
      for (let t = 0; t < perProject; t++) {
        const start = projectStart + t * DAY;
        tasks.push({
          id: projectId + "-t" + t,
          parentId: projectId,
          name: "Task " + (t + 1),
          start,
          end: start + 2 * DAY,
          progress: (t % 5) / 5,
        });
      }
    }
    return tasks;
  })(),
  preset: { treeGrid: { paneWidth: 220 } },
  plugins: (sg) => [sg.perfTools({ budgetMs: 8 })],
  height: 320,
}`,
      height: 320,
      caption: "the readout in the corner is `perf-tools` — scroll to see the sparkline move",
    },
    {
      kind: "callout",
      tone: "warn",
      body: "When a big chart feels slow it is usually one of three things you added: a row with its own height, something that repaints the whole chart on every pointer move, or drawing code that allocates on every frame. None of them is an error, and all three are invisible until the plan gets big. Measure with `perf-tools` before changing anything.",
    },
  ],
  next: ["/reference/view", "/reference/view/config", "/reference/tree-grid", "/reference/perf-tools"],
};

export default doc;
