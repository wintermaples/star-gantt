import type { GuideDoc } from "../types";

/**
 * The zero-to-chart guide, and the first page most readers land on. It stays at the level of "what
 * do I type" — what a plugin *is* belongs to the core chapters, and what each one does belongs to
 * its reference page. Both are one click away from the end of this guide.
 *
 * The listing is the whole page rather than a fragment, and it is `examples/hello.html` with the
 * example-site chrome removed: a reader has to be able to paste something that runs, and a snippet
 * that assumes an element, a script tag and a stylesheet it never shows is not that.
 */
const doc: GuideDoc = {
  slug: "your-first-chart",
  title: "Your first chart",
  lede: "One HTML file, one script tag, one call to `create()`. Here is the whole thing, and what each line of it is for.",
  cells: [
    {
      kind: "prose",
      paragraphs: [
        "StarGantt ships as one file: the library, every official plugin, and the CSS. There is no build step and nothing is fetched at runtime.",
        "A working page needs three things — an element to draw into, a call to `create()`, and your tasks. Here is all of it.",
      ],
    },
    {
      kind: "code",
      source: `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <title>My schedule</title>
    <style>
      #chart { height: 420px; }
    </style>
  </head>
  <body>
    <div id="chart"></div>

    <script src="stargantt.iife.js"></script>
    <script>
      const gantt = StarGantt.create({
        element: document.getElementById("chart"),
        plugins: StarGantt.presetStandard(),
      });

      const day = 86400000;
      const t0 = Math.floor(Date.now() / day) * day;

      gantt.service("stargantt.data").load([
        { id: "root", parentId: null, name: "Release prep", start: t0, end: t0 + 20 * day },
        { id: "spec", parentId: "root", name: "Design", start: t0, end: t0 + 5 * day, progress: 1 },
        { id: "impl", parentId: "root", name: "Implementation", start: t0 + 5 * day, end: t0 + 15 * day, progress: 0.4 },
        { id: "qa", parentId: "root", name: "Verification", start: t0 + 15 * day, end: t0 + 20 * day },
        { id: "ship", parentId: "root", name: "Release", type: "milestone", start: t0 + 20 * day, end: t0 + 20 * day },

        { sourceId: "spec", targetId: "impl", type: "FS" },
        { sourceId: "impl", targetId: "qa", type: "FS" },
        { sourceId: "qa", targetId: "ship", type: "FS" },
      ]);
    </script>
  </body>
</html>`,
      label: "html",
      caption: "the complete page — this is `examples/hello.html`",
    },
    {
      kind: "prose",
      paragraphs: [
        "Three things in there are worth pointing at.",
        "`#chart` has a height. Without one the element collapses and the chart has nowhere to draw — this is the most common reason a first attempt shows nothing at all.",
        "`load()` takes one array holding both tasks and the links between them. `t0` rounds the current time down to a whole day, so the tasks line up with the day columns instead of starting halfway through one.",
        "If you use npm rather than a script tag, the calls are identical — `import { create, presetStandard } from \"stargantt\"` and carry on from there.",
      ],
    },
    {
      kind: "prose",
      paragraphs: [
        "`presetStandard()` is a normal function returning a list of plugins, already in a working order. It takes one object, and each key in it configures one plugin.",
        "The cells on this site are editable, and each one holds a single object: `preset` is what goes to `presetStandard()`, and `plugins` adds anything outside the preset. The page writes the `create()` call around it. Edit the cell and press Run — and open `the call this makes` under it to see the whole call it stands for.",
      ],
    },
    {
      kind: "runnable",
      source: `{
  preset: {
    treeGrid: { rowHeight: 36 },
  },
}`,
      caption: "`presetStandard()`, with the row height nudged up from its 28px default",
    },
    {
      kind: "prose",
      paragraphs: [
        "The preset is a list, so you can add to it. Anything not in the preset is added the same way — append it and it works on the same footing as everything else.",
      ],
    },
    {
      kind: "code",
      source: `const gantt = StarGantt.create({
  element: document.getElementById("chart"),
  plugins: [
    ...StarGantt.presetStandard(),
    StarGantt.perfTools(),
  ],
});`,
      caption: "an opt-in plugin, appended to the preset",
    },
    {
      kind: "runnable",
      source: `{
  plugins: (sg) => [sg.perfTools()],
}`,
      caption: "the same thing, live — a frame-time overlay in the corner of the chart",
    },
    {
      kind: "callout",
      tone: "warn",
      body: "You can drop plugins from the preset too, but some depend on others. Remove one that others need and `create()` throws right away, with the missing name in the message — you will not be left hunting a blank area of the chart.",
    },
    {
      kind: "prose",
      paragraphs: [
        "That is the whole setup. From here, the next guide covers what your task data has to look like, and the reference pages cover each plugin one at a time.",
      ],
    },
  ],
  next: ["/guides/loading-your-data", "/guides/sizing-task-bars", "/reference/tree-grid"],
};

export default doc;
