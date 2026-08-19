// docs/specs/plugins/resource.md §3.3 — entry point of the ASSIGN area: the "Resources" grid
// column, the per-task assignment editor dialog, and (when enabled) chip drag-and-drop between
// tasks' cells of that column.
//
// Dormant while `config.assign` is omitted (§6): no column, no editor, no drag wiring, no claim.
// Column off (`assign.column === false`) still creates the editor session but
// contributes no column and wires no delegated listener, so nothing can ever open it in practice —
// none of the editor/drag machinery has anywhere to render without the column.
import type { ColumnDef } from "@stargantt/plugin-tree-grid";
import type { ResourceId, TaskId } from "@stargantt/plugin-data-store";
import { createTransactionBatcher, findUp, listen } from "@stargantt/sdk";
import type { ResourceAreaDeps } from "../areas";
import { cellText, renderResourcesCell } from "./cell";
import type { CellDeps } from "./cell";
import { buildEditorApplyPatches, buildReassignPatches, runAssignPatches } from "./commit";
import type { AssignStoreView } from "./commit";
import { createEditorSession } from "./editor";
import type { AssignmentLike, Id } from "./model";
import { mergeChoices } from "./model";
import type { ChoiceLike } from "./model";
import { DROP_OUTLINE } from "./style";

/** The batched transaction's provenance label (§10) — the plugin's own mirror-then-set / apply
 * origin family, shared by the editor's Apply and by drag-reassign so both read as the same kind
 * of user-visible commit in undo history / telemetry. */
const APPLY_ORIGIN = "stargantt.resource/assign-apply";

/** Walks from an event target up to (excluding) `root`, returning the first element carrying
 * `attr` — `findUp` with the attribute test as its predicate. */
function findAttrUp(start: unknown, attr: string, root: HTMLElement): HTMLElement | null {
  return findUp(start, (el) => typeof el.getAttribute === "function" && el.getAttribute(attr) !== null, root);
}

/** Wires the assign area. */
export function wireAssign(deps: ResourceAreaDeps): void {
  const { ctx, config, data, messages } = deps;
  const nestOrUndefined = config.assign;
  if (nestOrUndefined === undefined) return; // §6 — dormant: no column, no editor, no claim.
  // Re-bound to a non-optional name: TS's control-flow narrowing of a `const` does not carry into
  // a function declared later in the same scope (`wireDelegatedInteraction` below).
  const nest = nestOrUndefined;

  // `deps.resourcePool()`, not `ctx.use("stargantt.resource-pool")`: the pool is provided
  // UNCONDITIONALLY by `wirePool`, which runs before this area in `index.ts`'s single `setup()` —
  // but routing a self-provided lookup through the public service registry makes
  // `expectDepsConsistency`'s mock context (which does not model the real core's `consumer ===
  // provider` self-use exemption) misreport it as an undeclared hard dependency; `meta.dependsOn`
  // must stay exactly `["stargantt.data-store"]` (§9). `bindResourcePool`/`resourcePool` in
  // `areas.ts` is the sanctioned cross-area path instead. Unreachable `undefined` in the real host.
  const poolOrUndefined = deps.resourcePool();
  if (poolOrUndefined === undefined) return;
  // Re-bound to a non-optional name: TS's control-flow narrowing of a `const` does not carry into
  // a function declared later in the same scope (`nameOf`/`choices` below).
  const pool = poolOrUndefined;

  const chipText = (name: string, unitsPercent: number): string => messages.chipLabel({ name, unitsPercent });
  const toggleLabel = messages.assignToggleLabel;
  const unitsLabel = messages.unitsInputLabel;

  /* --- lookups ----------------------------------------------------------------------------- */

  // DOM data attributes are strings, but `TaskId` / `ResourceId` may be numbers — these maps
  // recover the real ids from the attribute keys the cells stamp. Entries are overwritten as cells
  // re-render; bounded by the task/resource sets.
  const taskByKey = new Map<string, TaskId>();
  const resByKey = new Map<string, ResourceId>();

  function nameOf(resourceId: Id): string {
    const stored = data.query().resources.get(resourceId as ResourceId);
    if (stored !== undefined) return stored.name;
    return pool.get(resourceId as ResourceId)?.name ?? String(resourceId);
  }

  function assignmentsOf(taskId: Id): readonly AssignmentLike[] {
    return data.query().assignmentsByTask.get(taskId as TaskId) ?? [];
  }

  function choices(): readonly ChoiceLike[] {
    const fromPool: ChoiceLike[] = pool.entries().map((e) => ({ id: e.id, name: e.name }));
    const fromStore: ChoiceLike[] = [];
    for (const r of data.query().resources.values()) fromStore.push({ id: r.id, name: r.name });
    return mergeChoices(fromPool, fromStore);
  }

  /** Whether the store already carries this resource id — matched by string form, not the `Map`'s
   * own key equality, because the id may come back typed differently than the store's own key
   * (e.g. a pool id typed as a `number` against a store id the loader typed as a numeric string). */
  function hasResource(resourceId: Id): boolean {
    const resources = data.query().resources;
    if (resources.has(resourceId as ResourceId)) return true;
    for (const id of resources.keys()) if (String(id) === String(resourceId)) return true;
    return false;
  }

  const storeView: AssignStoreView = {
    hasResource,
    assignmentsOf,
    poolEntry: (resourceId) => pool.get(resourceId as ResourceId),
  };

  /* --- commit path (§3.3 Editor / Drag reassign) -------------------------------------------- */

  const batch = createTransactionBatcher(ctx, APPLY_ORIGIN);

  function commitEditor(taskId: Id, desired: Map<Id, number>): void {
    // The task may have been removed while the dialog was open (data-layer transactions apply
    // regardless of UI state): appended raw patches skip the command builders' endpoint checks, so
    // re-validate here or a dangling assignment for a nonexistent task could be installed.
    if (data.getTask(taskId as TaskId) === undefined) return;
    const patches = buildEditorApplyPatches(storeView, taskId, desired);
    runAssignPatches(ctx, batch, patches);
  }

  function commitReassign(fromTaskId: Id, toTaskId: Id, resourceId: Id): void {
    const patches = buildReassignPatches(storeView, fromTaskId, toTaskId, resourceId);
    runAssignPatches(ctx, batch, patches);
  }

  /* --- editor session ------------------------------------------------------------------------ */

  const editor = createEditorSession({
    root: ctx.root,
    title: messages.editorTitle,
    emptyChoices: messages.emptyChoices,
    applyLabel: messages.applyLabel,
    cancelLabel: messages.cancelLabel,
    toggleLabel,
    unitsLabel,
    choices,
    assignmentsOf: (taskId) => assignmentsOf(taskId),
    commit: commitEditor,
  });
  // The one owned disposable of the dialog (code-quality §3's "one owned disposable that closes
  // whatever's currently open" idiom, `packages/plugins/tracking/src/internal/cost/wire.ts`
  // precedent): closing removes the element and everything on it, so a plugin disposed mid-open
  // never leaves a dangling dialog behind.
  ctx.own({ dispose: () => editor.cancel() });

  if (!nest.column) return;

  /* --- the grid column (§3.3 "Grid column") -------------------------------------------------- */

  const cellDeps: CellDeps = {
    assignmentsOf,
    nameOf,
    chipText,
    openLabel: messages.openEditorLabel,
    draggable: nest.dragReassign,
  };
  const column: ColumnDef = {
    id: "resource.resources",
    header: messages.assignColumnHeader,
    width: nest.columnWidth,
    render: (el, task) => {
      taskByKey.set(String(task.id), task.id);
      for (const a of assignmentsOf(task.id)) resByKey.set(String(a.resourceId), a.resourceId as ResourceId);
      renderResourcesCell(el, task.id, cellDeps);
    },
    getValue: (task) => cellText(task.id, cellDeps),
    // No `setValue` / `editor`: the tree-grid's shared edit pipeline never opens on this column;
    // editing goes through this area's own dialog above.
  };
  ctx.contribute("grid/columns", column);

  /* --- delegated interaction (§3.3 "Editor" / "Drag reassign") ------------------------------- */
  // One owned listener per event type on the gantt root; cells re-render freely without
  // registering anything. Deferred to `lifecycle/ready` and gated on the tree-grid plugin's own
  // service (`stargantt.grid` — tree-grid's service id, not its plugin id) actually resolving
  // (§9's optional-inert timing rule): without tree-grid the column never renders and no cell can
  // ever be clicked or dragged, and — headless above all — `ctx.root` may not even be a real DOM
  // node for `listen()` to attach to.
  // `ctx.on()` already auto-owns its own subscription (`packages/core/src/internal/context.ts`);
  // the `ctx.own()` wrap is stylistic consistency with the other `ctx.on` call sites across this
  // plugin's five areas, not a functional requirement.
  ctx.own(
    ctx.on("lifecycle/ready", () => {
      if (ctx.useOptional("stargantt.grid") === undefined) return;
      wireDelegatedInteraction();
    }),
  );

  function wireDelegatedInteraction(): void {
  listen(ctx, ctx.root, "click", (e) => {
    if (findAttrUp(e.target, "data-sg-ra-editor", ctx.root) !== null) return;
    const cell = findAttrUp(e.target, "data-sg-ra-cell", ctx.root);
    if (cell === null) return;
    const taskId = taskByKey.get(cell.getAttribute("data-sg-ra-cell") ?? "");
    if (taskId === undefined) return;
    editor.open(cell, taskId);
  });

  // A pointerdown outside the editor card cancels the editor, the same no-write path as Escape. On
  // the *document* (not the gantt root), so a click on the page around the widget dismisses too; a
  // pointerdown inside the card (its scrollbar included) does not. The dismissal happens at
  // pointerdown, before the click above could re-open on a cell — clicking another task's cell
  // therefore closes this dialog and opens that one, as two steps of the same gesture.
  listen(ctx, ctx.root.ownerDocument, "pointerdown", (e) => {
    if (!editor.isOpen()) return;
    const card = editor.element();
    if (card !== null && findUp(e.target, (el) => el === card) !== null) return;
    editor.cancel();
  });

  if (!nest.dragReassign) return;

  // Drag state: one session object, cleared on drop/dragend; Escape is the native HTML5
  // drag-and-drop cancel (no drop event fires), so cancelling changes nothing.
  let drag: { from: TaskId; resourceId: ResourceId } | null = null;
  let dropCell: HTMLElement | null = null;

  function markDrop(cell: HTMLElement | null): void {
    if (dropCell === cell) return;
    if (dropCell !== null) {
      dropCell.classList.remove("sg-ra-drop");
      dropCell.style.outline = "";
    }
    dropCell = cell;
    if (cell !== null) {
      cell.classList.add("sg-ra-drop");
      // >=3:1 against both light and dark grounds — a UI-component affordance, not text; the class
      // rides along so a host stylesheet can add a second, non-color cue too.
      cell.style.outline = DROP_OUTLINE;
    }
  }

  listen(ctx, ctx.root, "dragstart", (e) => {
    const chip = findAttrUp(e.target, "data-sg-ra-res", ctx.root);
    if (chip === null) return;
    const from = taskByKey.get(chip.getAttribute("data-sg-ra-task") ?? "");
    const resourceId = resByKey.get(chip.getAttribute("data-sg-ra-res") ?? "");
    if (from === undefined || resourceId === undefined) return;
    drag = { from, resourceId };
    e.dataTransfer?.setData?.("text/plain", `${String(from)}:${String(resourceId)}`);
  });

  listen(ctx, ctx.root, "dragover", (e) => {
    if (drag === null) return;
    const cell = findAttrUp(e.target, "data-sg-ra-cell", ctx.root);
    const target = taskByKey.get(cell?.getAttribute("data-sg-ra-cell") ?? "");
    if (cell !== null && target !== undefined && target !== drag.from) {
      e.preventDefault();
      markDrop(cell);
    } else {
      markDrop(null);
    }
  });

  listen(ctx, ctx.root, "drop", (e) => {
    if (drag === null) return;
    const cell = findAttrUp(e.target, "data-sg-ra-cell", ctx.root);
    const target = taskByKey.get(cell?.getAttribute("data-sg-ra-cell") ?? "");
    if (target !== undefined && target !== drag.from) {
      e.preventDefault();
      commitReassign(drag.from, target, drag.resourceId);
    }
    drag = null;
    markDrop(null);
  });

  listen(ctx, ctx.root, "dragend", () => {
    drag = null;
    markDrop(null);
  });
  }
}
