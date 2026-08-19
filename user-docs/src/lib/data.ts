// One dataset shared by every embedded chart in the docs. Keeping it identical everywhere means a
// reader comparing two config values is only ever seeing the config change, never the data.

const DAY = 86_400_000;

/** Start of the current UTC day — the time-axis origin `create()` defaults to. */
export const T0 = Math.floor(Date.now() / DAY) * DAY;

const d = (n: number): number => T0 + n * DAY;

export const SAMPLE_TASKS = [
  { id: "rel", parentId: null, name: "Release 1.4", type: "summary", start: d(0), end: d(24) },
  { id: "design", parentId: "rel", name: "Design", type: "summary", start: d(0), end: d(8) },
  { id: "wire", parentId: "design", name: "Wireframes", start: d(0), end: d(4), progress: 1 },
  { id: "visual", parentId: "design", name: "Visual spec", start: d(4), end: d(8), progress: 0.6 },
  { id: "build", parentId: "rel", name: "Build", type: "summary", start: d(7), end: d(20) },
  { id: "kernel", parentId: "build", name: "Core kernel", start: d(7), end: d(13), progress: 0.8 },
  { id: "renderer", parentId: "build", name: "Renderer", start: d(12), end: d(18), progress: 0.25 },
  { id: "plugins", parentId: "build", name: "Plugins", start: d(15), end: d(20), progress: 0 },
  { id: "qa", parentId: "rel", name: "Verification", start: d(20), end: d(24), progress: 0 },
  { id: "ship", parentId: "rel", name: "Ship", type: "milestone", start: d(24), end: d(24) },

  { id: "l1", sourceId: "wire", targetId: "visual", type: "FS" },
  { id: "l2", sourceId: "kernel", targetId: "renderer", type: "FS" },
  { id: "l3", sourceId: "renderer", targetId: "plugins", type: "FS" },
  { id: "l4", sourceId: "plugins", targetId: "qa", type: "FS" },
  { id: "l5", sourceId: "qa", targetId: "ship", type: "FS" },
] as const;
