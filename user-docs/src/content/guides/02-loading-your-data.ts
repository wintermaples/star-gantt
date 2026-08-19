import type { GuideDoc } from "../types";

/**
 * The shape of the array `load()` takes. Written at the level of "what do my rows have to look
 * like"; the store's exact tolerances for malformed input are on the data-store reference page.
 */
const doc: GuideDoc = {
  slug: "loading-your-data",
  title: "Loading your data",
  lede: "Tasks, summaries, milestones and dependencies all go in one array. Here is what each kind of row looks like.",
  cells: [
    {
      kind: "prose",
      paragraphs: [
        'Call `gantt.service("stargantt.data").load(rows)` with one array. It can hold two kinds of row.',
        "A task row has `id`, `name`, `start`, `end` and `parentId`. A link row has `sourceId` and `targetId` instead. The store tells them apart by their fields, so both kinds can sit in the same list in any order.",
        'You do not mark a row as a summary. Give a task children — rows naming it as `parentId` — and it becomes one. Milestones are the exception: set `type: "milestone"` yourself, because a zero-length task is still a task.',
      ],
    },
    {
      kind: "runnable",
      source: `{
  data: [
    // "launch" names no type — it becomes a summary because "spec" and "build" name it as parentId.
    { id: "launch", parentId: null, name: "Launch", start: Date.now(), end: Date.now() + 6 * 86_400_000 },
    { id: "spec", parentId: "launch", name: "Spec", start: Date.now(), end: Date.now() + 2 * 86_400_000, progress: 1 },
    { id: "build", parentId: "launch", name: "Build", start: Date.now() + 2 * 86_400_000, end: Date.now() + 5 * 86_400_000, progress: 0.4 },
    { id: "ship", parentId: "launch", name: "Ship", type: "milestone", start: Date.now() + 6 * 86_400_000, end: Date.now() + 6 * 86_400_000 },
    // No task fields at all — sourceId/targetId is what makes these links.
    { sourceId: "spec", targetId: "build", type: "FS" },
    { sourceId: "build", targetId: "ship", type: "FS" },
  ],
}`,
      caption: "one array: four tasks and two links",
    },
    {
      kind: "prose",
      paragraphs: [
        "`parentId` builds the tree. Rows appear in the order you wrote them, unless you give them an `orderKey`.",
        "`orderKey` is a string, sorted alphabetically. Use it when the order has to survive edits, or when your data does not arrive in display order.",
      ],
    },
    {
      kind: "runnable",
      source: `{
  data: [
    { id: "launch", parentId: null, name: "Launch", start: Date.now(), end: Date.now() + 6 * 86_400_000 },
    // "build" is written second but carries the earlier orderKey, so it is drawn first.
    { id: "spec", parentId: "launch", name: "Spec", start: Date.now(), end: Date.now() + 2 * 86_400_000, orderKey: "1" },
    { id: "build", parentId: "launch", name: "Build", start: Date.now() + 2 * 86_400_000, end: Date.now() + 5 * 86_400_000, orderKey: "0" },
  ],
}`,
      caption: "same array order, but `orderKey` puts Build above Spec",
    },
    {
      kind: "prose",
      paragraphs: [
        "`progress` is a ratio from 0 to 1, not a percentage. Anything outside that range is pulled back into it, so 42 becomes 1 rather than an error.",
        "Leaving `progress` out is not the same as setting it to `0`. Unset means nothing to show; `0` means not started.",
      ],
    },
    {
      kind: "runnable",
      source: `{
  data: [
    { id: "launch", parentId: null, name: "Launch", start: Date.now(), end: Date.now() + 6 * 86_400_000 },
    { id: "over", parentId: "launch", name: "Overreported", start: Date.now(), end: Date.now() + 3 * 86_400_000, progress: 1.4, orderKey: "0" },
    { id: "under", parentId: "launch", name: "Underreported", start: Date.now() + 3 * 86_400_000, end: Date.now() + 6 * 86_400_000, progress: -0.3, orderKey: "1" },
  ],
}`,
      caption: "1.4 and -0.3 in, a full bar and an empty one out",
    },
    {
      kind: "prose",
      paragraphs: [
        "`start` and `end` are epoch milliseconds. Build them with `Date.UTC(year, month, day)` rather than `new Date(year, month, day)` — the second one means a different instant depending on the reader's machine.",
        'To show those instants in a particular zone, set `presetStandard({ view: { timeline: { displayTimeZone: "Asia/Tokyo" } } })`. Your data is untouched; only the header and the day boundaries move.',
      ],
    },
    {
      kind: "callout",
      tone: "warn",
      body: "A link pointing at an id you never loaded is not an error, and not drawn either. If dependencies are missing from the chart but present in your data, a mistyped id is the first thing to check.",
    },
    {
      kind: "prose",
      paragraphs: [
        "Resources and assignments do not fit in the bare array. Pass the object form instead.",
      ],
    },
    {
      kind: "code",
      source: `gantt.service("stargantt.data").load({
  tasks: [
    { id: "build", parentId: null, name: "Build", start: t0, end: t0 + 5 * day },
  ],
  links: [
    { sourceId: "spec", targetId: "build", type: "FS" },
  ],
  resources: [
    { id: "alice", name: "Alice", capacity: 1 },
  ],
  assignments: [
    { taskId: "build", resourceId: "alice", units: 0.5 },
  ],
});`,
      caption: "`units: 0.5` is half a working day, not half the task",
    },
    {
      kind: "prose",
      paragraphs: [
        "The `resource` reference page shows that shape against a running chart.",
      ],
    },
  ],
  next: ["/reference/data-store", "/reference/data-store/config", "/reference/resource", "/reference/resource/config"],
};

export default doc;
