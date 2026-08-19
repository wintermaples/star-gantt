import type { GuideDoc } from "../types";

/**
 * Select, filter, sort, act. The display-state-versus-store distinction that used to open this
 * guide is real but is a reference-page concern; what a reader needs here is which tool reaches a
 * task and which one changes it.
 */
const doc: GuideDoc = {
  slug: "finding-tasks",
  title: "Finding tasks in a large plan",
  lede: "Scrolling works at a hundred rows. At ten thousand you need to select, search, sort — and then do something with what you found.",
  cells: [
    {
      kind: "prose",
      paragraphs: [
        '`interaction.selection.mode` decides what clicking a task does. The default, "single", replaces the selection each time.',
        'Switch it to "multi" and you can gather a set: Ctrl/Cmd-click to add one, Shift-click for a run of rows, or drag on empty chart space to lasso several at once.',
        "Ctrl/Cmd+A selects everything in the plan, including rows that are scrolled away or collapsed out of sight.",
      ],
    },
    {
      kind: "runnable",
      source: `{
  preset: {
    interaction: {
      selection: {
        mode: "multi",
        shortcuts: { selectAll: true, clearOnEscape: true, deleteSelected: true },
      },
    },
  },
}`,
      caption: "Ctrl/Cmd-click, Shift-click, or drag on empty space. Click a row first, then try Ctrl/Cmd+A.",
    },
    {
      kind: "prose",
      paragraphs: [
        "`interaction.filterSearch` is the feature built for large plans. It adds a search box and a panel of field checkboxes, both off until you turn them on.",
        "The chart below arrives with a query already set, so you can see the effect without typing. Two rows survive: Design, which matches, and its parent, kept so the match has context.",
        "A matching summary does not bring its children with it — each row has to match on its own.",
      ],
    },
    {
      kind: "runnable",
      source: `{
  preset: {
    treeGrid: { paneWidth: 460 },
    interaction: { filterSearch: { searchBox: true, filterPanel: true } },
  },
  plugins: (sg) => [
    sg.definePlugin({
      meta: { id: "docs.filter-on-load", dependsOn: ["stargantt.interaction"] },
      setup(ctx) {
        ctx.on("lifecycle/ready", () => {
          ctx.use("stargantt.filter").setQuery("Design");
        });
      },
    }),
  ],
  height: 340,
}`,
      height: 340,
      caption: 'Filtered to "Design" on load. To clear it, click into the search box and press Escape.',
    },
    {
      kind: "prose",
      paragraphs: [
        "Filtering only hides rows. Your data is untouched, nothing is deleted, and clearing the filter brings everything back exactly as it was.",
        "That also means a filter is not undoable and does not survive a reload. If you want a filter to come back, save it yourself — the plugin's named views remember a query and its criteria for you.",
      ],
    },
    {
      kind: "prose",
      paragraphs: [
        "Sorting belongs to the `tree-grid`. Click a column header to cycle ascending, descending, off. Children are sorted within their own parent, so the tree keeps its shape.",
        "Only columns that know how to compare their values can sort, and none of the four built-in columns does by default. Set `collation` to make Name sortable — that is the common case.",
      ],
    },
    {
      kind: "runnable",
      source: `{
  preset: {
    treeGrid: { collation: true },
  },
}`,
      caption: "Click the Name header to sort. Start, End and Progress do nothing — they have no comparison set up.",
    },
    {
      kind: "prose",
      paragraphs: [
        "Once you have found a task, the context menu is how you act on it. Right-click a bar, a row, or empty space for insert, duplicate, delete and link entries.",
        "Unlike the other three tools, this one really does change your data — every entry is a normal edit, and Ctrl+Z takes it back.",
      ],
    },
    {
      kind: "runnable",
      source: `{
  preset: {
    interaction: { contextMenu: { insertMode: "sibling" } },
  },
}`,
      caption: "Right-click a bar or a row. Right-click below the last row for a new top-level task.",
    },
    {
      kind: "callout",
      tone: "warn",
      body: "A filter criterion that cannot be used is ignored rather than reported. `setCriteria({ types: [] })` looks like \"tasks with no type\", but an empty list means nothing to filter on, so the chart carries on showing everything. When a criterion is more than a list of values, use `predicate: (task) => …` instead.",
    },
  ],
  next: ["/reference/interaction", "/reference/interaction/config", "/reference/tree-grid"],
};

export default doc;
