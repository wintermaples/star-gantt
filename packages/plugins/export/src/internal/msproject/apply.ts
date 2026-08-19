// docs/specs/plugins/export.md §1.7 (Apply) — classifies a parsed MS Project document against the
// current store into the command payloads `applyMsProjectXml` will dispatch. Hostless and pure —
// computes, never dispatches.
import type { Assignment, Link, ReadonlyDataView, Resource, Task, TaskId } from "@stargantt/plugin-data-store";
import type { MsProjectDocument } from "../../types";

export interface ApplyPlan {
  taskAdds: Task[];
  taskUpdates: { id: TaskId; after: Partial<Task> }[];
  resourceAdds: Resource[];
  linkAdds: Link[];
  assignmentSets: Assignment[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object";
}

/** A document field as an array — untrusted input may omit it or hold a non-array. */
function listOf<T>(value: readonly T[] | undefined): readonly T[] {
  return Array.isArray(value) ? value : [];
}

/** The minimal update for a known task: stated fields only, changed ones only. */
function taskDelta(existing: Readonly<Task>, task: Readonly<Task>): Partial<Task> {
  const after: Partial<Task> = {};
  if (existing.parentId !== task.parentId) after.parentId = task.parentId;
  if (existing.name !== task.name) after.name = task.name;
  if (existing.start !== task.start) after.start = task.start;
  if (existing.end !== task.end) after.end = task.end;
  // Absent optional fields mean "not stated", never "clear it" (§1.7's "progress/type only when
  // the document states them" rule).
  if (task.progress !== undefined && existing.progress !== task.progress) after.progress = task.progress;
  if (task.type !== undefined && existing.type !== task.type) after.type = task.type;
  return after;
}

/**
 * Reorders new tasks parent-first: a hand-authored document may list a child before its parent,
 * but `task/add` requires the parent to already exist (in the store or earlier in this batch).
 * Tasks whose parent is unknown (outside this batch) keep their relative document order at the
 * end, same as a topological sort's leftover pass. A task caught in a parent/child cycle is
 * placed as soon as the cycle is detected (breaking the cycle at that point), so cycle members
 * are interleaved with acyclic tasks in document order rather than deferred as a block.
 */
function parentFirst(tasks: readonly Task[]): Task[] {
  const byId = new Map(tasks.map((t) => [t.id, t]));
  const out: Task[] = [];
  const placed = new Set<TaskId>();

  const place = (task: Task, guard: Set<TaskId>): void => {
    if (placed.has(task.id) || guard.has(task.id)) return; // already placed, or a cycle
    guard.add(task.id);
    const parent = task.parentId === null ? undefined : byId.get(task.parentId);
    if (parent !== undefined) place(parent, guard);
    if (!placed.has(task.id)) {
      placed.add(task.id);
      out.push(task);
    }
  };

  for (const task of tasks) place(task, new Set());
  return out;
}

/** Plans task adds/updates in document order; returns the ids the document declares. */
function planTasks(doc: MsProjectDocument, view: ReadonlyDataView, plan: ApplyPlan): Set<TaskId> {
  const docTaskIds = new Set<TaskId>();
  const tasks = listOf(doc.tasks).filter((task): task is Task => isRecord(task) && task.id !== undefined);
  for (const task of tasks) docTaskIds.add(task.id);
  for (const task of parentFirst(tasks)) {
    const existing = view.byId.get(task.id);
    if (existing === undefined) {
      plan.taskAdds.push({ ...task });
      continue;
    }
    const after = taskDelta(existing, task);
    if (Object.keys(after).length > 0) plan.taskUpdates.push({ id: task.id, after });
  }
  return docTaskIds;
}

function planResources(doc: MsProjectDocument, view: ReadonlyDataView, plan: ApplyPlan): void {
  for (const resource of listOf(doc.resources)) {
    if (!isRecord(resource) || resource.id === undefined) continue;
    if (view.resources.has(resource.id)) continue;
    plan.resourceAdds.push({ ...resource });
  }
}

/** Plans link adds: unknown link ids only, and only when both ends will exist after the apply. */
function planLinks(
  doc: MsProjectDocument,
  view: ReadonlyDataView,
  docTaskIds: ReadonlySet<TaskId>,
  plan: ApplyPlan,
): void {
  const taskKnown = (id: TaskId): boolean => docTaskIds.has(id) || view.byId.has(id);
  const existingLinkIds = new Set<Link["id"]>();
  for (const perTask of view.linksByTask.values()) {
    for (const link of perTask.out) existingLinkIds.add(link.id);
  }
  for (const link of listOf(doc.links)) {
    if (!isRecord(link)) continue;
    if (existingLinkIds.has(link.id)) continue;
    if (!taskKnown(link.sourceId) || !taskKnown(link.targetId)) continue;
    plan.linkAdds.push({ ...link });
  }
}

/** A missing or unparsable `units` defaults to `1` rather than silently dropping the assignment. */
function unitsOrDefault(value: unknown): number {
  const n = typeof value === "number" ? value : Number(value);
  return Number.isFinite(n) && n > 0 ? n : 1;
}

function planAssignments(doc: MsProjectDocument, plan: ApplyPlan): void {
  for (const assignment of listOf(doc.assignments)) {
    if (!isRecord(assignment)) continue;
    if (assignment.taskId === undefined || assignment.resourceId === undefined) continue;
    plan.assignmentSets.push({ ...assignment, units: unitsOrDefault(assignment.units) } as Assignment);
  }
}

/**
 * Plans the §1.7 apply: tasks parents-first (adds for unknown ids, minimal updates for known
 * ones — `progress`/`type` only when the document states them), then new resources, new links
 * whose ends exist, and every assignment. Nothing is ever removed.
 */
export function planApply(doc: MsProjectDocument, view: ReadonlyDataView): ApplyPlan {
  const plan: ApplyPlan = { taskAdds: [], taskUpdates: [], resourceAdds: [], linkAdds: [], assignmentSets: [] };
  if (!isRecord(doc)) return plan;
  const docTaskIds = planTasks(doc, view, plan);
  planResources(doc, view, plan);
  planLinks(doc, view, docTaskIds, plan);
  planAssignments(doc, plan);
  return plan;
}
