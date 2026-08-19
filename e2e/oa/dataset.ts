// e2e/oa/dataset.ts — the single dataset every OA run charts.
//
// The single dataset every run charts, anchored on FIXED_TIME (CLAUDE.md §1). The 15-plugin
// official surface is small enough that this dataset can stay intentionally small too: one
// summary, two leaf tasks, one dependency link, one resource, one assignment — enough to give
// every plugin's config factors something real to act on (a row to filter, a bar to paint, a
// link to route, a resource to assign) without inflating boot text or screenshot noise.
//
// Anchored on the same instant e2e/_fixtures.ts's FIXED_TIME uses, for continuity with the rest
// of the suite (not imported directly — this file is also read as plain source text by
// boot-code.ts's fixtures string, so the anchor is a literal, not an import).

export const OA_FIXED_TIME = new Date("2026-08-07T12:00:00Z");

const OA_NOW = OA_FIXED_TIME.getTime();
const OA_DAY = 86400000;

export interface OaTask {
  id: string;
  parentId: string | null;
  name: string;
  type?: "summary" | "milestone";
  start: number;
  end: number;
  progress?: number;
  meta?: Record<string, unknown>;
}

export const OA_TASKS: readonly OaTask[] = [
  { id: "oa-p", parentId: null, name: "OA Phase", type: "summary", start: OA_NOW, end: OA_NOW + 10 * OA_DAY },
  {
    id: "oa-a",
    parentId: "oa-p",
    name: "OA Task A",
    start: OA_NOW,
    end: OA_NOW + 4 * OA_DAY,
    progress: 0.5,
    meta: { costTracking: { fixedCost: 1000, actualCost: 600 }, evm: { bac: 1000, actualCost: 600 }, actualStart: OA_NOW },
  },
  {
    id: "oa-b",
    parentId: "oa-p",
    name: "OA Task B",
    start: OA_NOW + 4 * OA_DAY,
    end: OA_NOW + 10 * OA_DAY,
    progress: 0.2,
    meta: { costTracking: { fixedCost: 1500 }, evm: { bac: 1500 } },
  },
];

export const OA_LINKS = [{ id: "oa-l1", sourceId: "oa-a", targetId: "oa-b", type: "FS" }] as const;

export const OA_RESOURCES = [{ id: "oa-r1", name: "OA Resource", capacity: 1 }] as const;

export const OA_ASSIGNMENTS = [{ taskId: "oa-a", resourceId: "oa-r1", units: 1 }] as const;

/** The full dataset, as `gantt.service("stargantt.data").load()` expects it. */
export const OA_DATASET = {
  tasks: OA_TASKS,
  links: OA_LINKS,
  resources: OA_RESOURCES,
  assignments: OA_ASSIGNMENTS,
};

/** Task count, for the `aria-rowcount` sanity bound in `oa.spec.ts`'s probe. */
export const OA_TASK_COUNT = OA_TASKS.length;
