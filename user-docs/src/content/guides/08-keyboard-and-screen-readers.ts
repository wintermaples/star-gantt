import type { GuideDoc } from "../types";

/**
 * Using the chart without a pointer, and the one setting combination that quietly leaves a keyboard
 * user with no visible focus. How the parallel treegrid is built belongs to the a11y reference
 * page; this guide is about the keys and the settings.
 */
const doc: GuideDoc = {
  slug: "keyboard-and-screen-readers",
  title: "Keyboard and screen-reader access",
  lede: "The chart is drawn on a canvas, so it keeps a second, invisible copy for screen readers and keyboard focus. It is on by default — here is how to drive it.",
  cells: [
    {
      kind: "prose",
      paragraphs: [
        "A canvas has nothing inside it to Tab through, so the chart keeps a hidden copy of the rows on screen for the browser and screen readers to use.",
        "`Tab` moves into and out of the chart as a whole. It does not step through rows. Once the chart has the focus, the arrow keys move it from row to row, and `Tab` again leaves for the next control on the page.",
        "That is deliberate. A grid with a thousand rows must not put a thousand stops in the page's tab order, so the chart keeps exactly one — the row you were last on. Every page on this site carries a `Skip to the chart` link as its first focusable element, so one `Tab` from the top of the page reaches the chart instead of walking the whole sidebar.",
        "You do not have to switch any of this on. Give the chart a label so a screen reader can say which chart it is.",
      ],
    },
    {
      kind: "runnable",
      source: `{
  preset: {
    treeGrid: { paneWidth: 220 },
    a11y: { label: "Release 1.4 schedule" },
  },
  height: 320,
}`,
      height: 320,
      caption: "Click into the chart, then press Tab and use the arrow keys",
    },
    {
      kind: "prose",
      paragraphs: [
        "By default, arrowing onto a row also selects it — the same as clicking it.",
        "If something else on your page reacts to selection, that becomes one reaction per arrow press. Set `syncSelection: false` and arrowing only moves the focus.",
      ],
    },
    {
      kind: "runnable",
      source: `{
  preset: {
    treeGrid: { paneWidth: 220 },
    a11y: { syncSelection: false },
  },
  height: 320,
}`,
      height: 320,
      caption: "arrow through the rows — the selection no longer follows",
    },
    {
      kind: "prose",
      paragraphs: [
        "There is a catch. With the selection no longer following, the focus outline is the only thing showing a keyboard user where they are.",
        "That outline is one CSS variable, `--sg-focus-stroke`, and it is as easy to theme away as any other colour. The chart below does exactly that: focus really is moving and a screen reader announces every row, but nobody watching the screen can tell.",
      ],
    },
    {
      kind: "runnable",
      source: `{
  preset: {
    treeGrid: { paneWidth: 220 },
    a11y: { syncSelection: false },
    view: {
      theme: {
        presets: {
          "washed-out-focus": { tokens: { "--sg-focus-stroke": "#f3f4f6" } },
        },
        preset: "washed-out-focus",
      },
    },
  },
  height: 320,
}`,
      height: 320,
      caption: "legal, correct for a screen reader, and invisible to everyone else",
    },
    {
      kind: "callout",
      tone: "warn",
      body: "If you turn `syncSelection` off, check `--sg-focus-stroke` against your background at the same time. Either one alone is fine; together they leave a keyboard user with nothing to look at.",
    },
    {
      kind: "prose",
      paragraphs: [
        "Editing works from the keyboard too. Ctrl+Arrow moves the focused task, Ctrl+Shift+Arrow resizes its end, Ctrl+Alt+Arrow resizes its start, and Ctrl+Shift+Up/Down steps progress by ten points.",
        "Each one moves by the same amount a drag would round to. On a summary row they do nothing, because a summary's dates come from its children.",
      ],
    },
    {
      kind: "runnable",
      source: `{
  preset: {
    treeGrid: { paneWidth: 220 },
    view: { timeline: { initialZoom: "week" } },
  },
  height: 320,
}`,
      height: 320,
      caption: "Tab to a leaf row, then Ctrl+ArrowRight — the bar moves exactly as a drag would",
    },
    {
      kind: "prose",
      paragraphs: [
        "Three extras are worth turning on for screen-reader users. `describeDependencies` reads out what each task depends on, `shortcutHelp` binds ? to a list of every shortcut, and `summaryTable` binds Ctrl+Alt+S to a plain table of the whole plan.",
        "`zoomKeys` adds + and - for zooming, but those keys already expand and collapse rows, and zooming wins. Arrow keys still expand and collapse, so nothing is lost — just tell your users.",
      ],
    },
    {
      kind: "runnable",
      source: `{
  preset: {
    treeGrid: { paneWidth: 220 },
    a11y: {
      describeDependencies: true,
      shortcutHelp: true,
      summaryTable: true,
      zoomKeys: true,
    },
    interaction: { zoomControls: {} },
  },
  height: 320,
}`,
      height: 320,
      caption: "Tab in, then try ? for the shortcut list and Ctrl+Alt+S for the summary table",
    },
    {
      kind: "prose",
      paragraphs: [
        "One last thing, for pointers rather than keyboards. Zoomed out, a short task is a two-pixel sliver: readable, and impossible to click.",
        "`expandedHitArea` gives every bar a target at least 24 × 24 px without changing what is drawn.",
      ],
    },
    {
      kind: "runnable",
      source: `{
  preset: {
    treeGrid: { paneWidth: 220 },
    view: { timeline: { initialZoom: "month" } },
    taskBars: { expandedHitArea: true },
  },
  height: 320,
}`,
      height: 320,
      caption: "zoomed out until the shortest bars are slivers — still clickable",
    },
  ],
  next: ["/reference/a11y", "/reference/a11y/config", "/reference/interaction", "/guides/sizing-task-bars"],
};

export default doc;
