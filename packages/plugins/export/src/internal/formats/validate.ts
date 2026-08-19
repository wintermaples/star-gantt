// docs/specs/plugins/export.md §1.5 — cross-record validation of an import document against
// itself and the current store. Hostless.
import type { ReadonlyDataView, TaskId } from "@stargantt/plugin-data-store";
import type { ImportDocument, ImportIssue } from "../../types";

/** Whether a task id resolves — either the document declares it or the store already has it. */
type Knows = (id: TaskId) => boolean;

/** Tasks whose stated parent no task in the document or the store answers to. */
function checkUnknownParents(doc: ImportDocument, knows: Knows, issues: ImportIssue[]): void {
  for (const task of doc.tasks) {
    if (task.parentId !== null && !knows(task.parentId)) {
      issues.push({ code: "unknown-parent", taskId: task.id, parentId: task.parentId });
    }
  }
}

/**
 * Parent cycles among the document's tasks (store tasks cannot join a cycle through them unless
 * the import rewires them, which a task-only import cannot).
 */
function checkParentCycles(doc: ImportDocument, issues: ImportIssue[]): void {
  const parentOf = new Map<TaskId, TaskId | null>();
  for (const task of doc.tasks) parentOf.set(task.id, task.parentId);
  const state = new Map<TaskId, "visiting" | "done">();
  for (const task of doc.tasks) {
    const chain: TaskId[] = [];
    let current: TaskId | null = task.id;
    while (current !== null && parentOf.has(current) && state.get(current) === undefined) {
      state.set(current, "visiting");
      chain.push(current);
      current = parentOf.get(current) ?? null;
    }
    if (current !== null && state.get(current) === "visiting") {
      issues.push({ code: "parent-cycle", taskId: current });
    }
    for (const id of chain) state.set(id, "done");
  }
}

function checkUnknownLinkEnds(doc: ImportDocument, knows: Knows, issues: ImportIssue[]): void {
  for (const link of doc.links) {
    if (!knows(link.sourceId)) issues.push({ code: "unknown-link-end", linkId: link.id, taskId: link.sourceId });
    if (!knows(link.targetId)) issues.push({ code: "unknown-link-end", linkId: link.id, taskId: link.targetId });
  }
}

/** The dependency graph the cycle check walks: document links plus the store's existing links. */
function buildLinkGraph(doc: ImportDocument, view: ReadonlyDataView, knows: Knows): Map<TaskId, TaskId[]> {
  const edges = new Map<TaskId, TaskId[]>();
  const addEdge = (from: TaskId, to: TaskId): void => {
    const list = edges.get(from);
    if (list === undefined) edges.set(from, [to]);
    else list.push(to);
  };
  for (const link of doc.links) {
    if (knows(link.sourceId) && knows(link.targetId)) addEdge(link.sourceId, link.targetId);
  }
  for (const [taskId, byDir] of view.linksByTask) {
    for (const link of byDir.out) addEdge(taskId, link.targetId);
  }
  return edges;
}

const NO_EDGES: readonly TaskId[] = [];

/**
 * Iterative DFS with an explicit work list (node + child cursor): recursive depth would equal the
 * longest link chain, which overflows the call stack well inside a realistic task-count target.
 * Each distinct cycle is reported once.
 */
function checkDependencyCycles(edges: ReadonlyMap<TaskId, TaskId[]>, issues: ImportIssue[]): void {
  const color = new Map<TaskId, "gray" | "black">();
  const reported = new Set<string>();
  const stack: TaskId[] = [];
  const reportCycle = (next: TaskId): void => {
    const cycle = stack.slice(stack.indexOf(next));
    const key = [...cycle].map(String).sort().join("|");
    if (reported.has(key)) return;
    reported.add(key);
    issues.push({ code: "dependency-cycle", taskIds: [...cycle, next] });
  };
  const visit = (root: TaskId): void => {
    const work: { node: TaskId; children: readonly TaskId[]; cursor: number }[] = [
      { node: root, children: edges.get(root) ?? NO_EDGES, cursor: 0 },
    ];
    color.set(root, "gray");
    stack.push(root);
    while (work.length > 0) {
      const frame = work[work.length - 1] as (typeof work)[number];
      if (frame.cursor >= frame.children.length) {
        work.pop();
        stack.pop();
        color.set(frame.node, "black");
        continue;
      }
      const next = frame.children[frame.cursor] as TaskId;
      frame.cursor += 1;
      const c = color.get(next);
      if (c === "black") continue;
      if (c === "gray") {
        reportCycle(next);
        continue;
      }
      color.set(next, "gray");
      stack.push(next);
      work.push({ node: next, children: edges.get(next) ?? NO_EDGES, cursor: 0 });
    }
  };
  for (const node of edges.keys()) {
    if (color.get(node) === undefined) visit(node);
  }
}

/**
 * Finds unknown parents, parent cycles, links naming unknown tasks, and dependency cycles over
 * the union of the document's links and the store's existing links (an import that closes a loop
 * with existing links is a cycle too). Parse-time issues are not repeated.
 */
export function validateDocument(doc: ImportDocument, view: ReadonlyDataView): ImportIssue[] {
  const issues: ImportIssue[] = [];
  const docIds = new Set(doc.tasks.map((t) => t.id));
  const knows: Knows = (id) => docIds.has(id) || view.byId.has(id);

  checkUnknownParents(doc, knows, issues);
  checkParentCycles(doc, issues);
  checkUnknownLinkEnds(doc, knows, issues);
  checkDependencyCycles(buildLinkGraph(doc, view, knows), issues);
  return issues;
}
