// docs/specs/plugins/export.md §1.5 — diffing an import document against the current store, and
// ordering the resulting changes. Hostless.
import type { ReadonlyDataView, Task, TaskId } from "@stargantt/plugin-data-store";
import type { ImportChange, ImportDocument, ImportOptions } from "../../types";

/** The fields an update compares. `progress`/`type` are compared only when the incoming task carries them. */
const ALWAYS: readonly ("parentId" | "name" | "start" | "end")[] = ["parentId", "name", "start", "end"];
/** As `ALWAYS`, for a document that never states parent linkage (see `statesParent`). */
const WITHOUT_PARENT: readonly ("name" | "start" | "end")[] = ["name", "start", "end"];

/**
 * Whether the document states parent linkage at all. A CSV parse normalizes every row to
 * `parentId: null`, so when its column mapping carries no `parentId` column that `null` means
 * "not stated" — exactly like an absent `progress`/`type` — and comparing it against the store
 * would propose re-parenting the whole hierarchy to the root. A JSON document (no `mapping`)
 * states hierarchy natively and always compares it.
 */
function statesParent(doc: ImportDocument): boolean {
  return doc.mapping === undefined || doc.mapping.includes("parentId");
}

function updateOf(
  existing: Readonly<Task>,
  incoming: Readonly<Task>,
  fields: readonly ("parentId" | "name" | "start" | "end")[],
): ImportChange | undefined {
  const before: Partial<Task> = {};
  const after: Partial<Task> = {};
  let changed = false;
  for (const field of fields) {
    if (existing[field] !== incoming[field]) {
      (before as Record<string, unknown>)[field] = existing[field];
      (after as Record<string, unknown>)[field] = incoming[field];
      changed = true;
    }
  }
  for (const field of ["progress", "type"] as const) {
    // An absent optional field in the import means "not stated", never "clear it".
    if (incoming[field] !== undefined && existing[field] !== incoming[field]) {
      (before as Record<string, unknown>)[field] = existing[field];
      (after as Record<string, unknown>)[field] = incoming[field];
      changed = true;
    }
  }
  return changed ? { kind: "update", id: incoming.id, before, after } : undefined;
}

/** Orders `add` changes parents-first so each `task/add` command finds its parent already present. */
export function orderAddsParentsFirst(
  adds: readonly Extract<ImportChange, { kind: "add" }>[],
): Extract<ImportChange, { kind: "add" }>[] {
  const byId = new Map<TaskId, Extract<ImportChange, { kind: "add" }>>(adds.map((a) => [a.task.id, a]));
  const out: Extract<ImportChange, { kind: "add" }>[] = [];
  const placed = new Set<TaskId>();
  const place = (add: Extract<ImportChange, { kind: "add" }>, trail: Set<TaskId>): void => {
    if (placed.has(add.task.id) || trail.has(add.task.id)) return;
    trail.add(add.task.id);
    const parent = add.task.parentId;
    if (parent !== null) {
      const parentAdd = byId.get(parent);
      if (parentAdd !== undefined) place(parentAdd, trail);
    }
    placed.add(add.task.id);
    out.push(add);
  };
  for (const add of adds) place(add, new Set());
  return out;
}

/**
 * Computes the changes importing the document would make: `add` for a task the store lacks,
 * `update` for one it has with different field values, and — only with `removeMissing` — `remove`
 * for a store task the document does not mention. Adds come parents-first, then updates, then
 * removes, which is also the order the apply runs them in (§1.5).
 */
export function diffDocument(
  doc: ImportDocument,
  view: ReadonlyDataView,
  options?: Pick<ImportOptions, "removeMissing">,
): ImportChange[] {
  const adds: Extract<ImportChange, { kind: "add" }>[] = [];
  const updates: ImportChange[] = [];
  const fields = statesParent(doc) ? ALWAYS : WITHOUT_PARENT;
  for (const incoming of doc.tasks) {
    const existing = view.byId.get(incoming.id);
    if (existing === undefined) {
      adds.push({ kind: "add", task: incoming });
    } else {
      const update = updateOf(existing, incoming, fields);
      if (update !== undefined) updates.push(update);
    }
  }
  const changes: ImportChange[] = [...orderAddsParentsFirst(adds), ...updates];
  if (options?.removeMissing === true) {
    const docIds = new Set(doc.tasks.map((t) => t.id));
    for (const id of view.byId.keys()) {
      if (!docIds.has(id)) changes.push({ kind: "remove", id });
    }
  }
  return changes;
}
