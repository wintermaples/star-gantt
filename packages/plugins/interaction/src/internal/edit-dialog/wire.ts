// docs/specs/plugins/interaction.md §6.9 — the modal task-edit dialog
/**
 * Wiring entry point of the `edit-dialog` feature.
 *
 * Registers the `edit-dialog/open` command (the only way in with `openOnDoubleClick: false`), and
 * — unless turned off — installs the double-activation detector the gesture arbiter drives via
 * `deps.setEditDialog`: the arbiter has already decided (`internal/gesture/arbiter.ts`,
 * `activationCounts`) which presses count and reduced each one to a `"bar:<id>"` / `"row:<id>"`
 * target string, so this module's whole job is running that stream through the double-press
 * detector (`./dblclick.ts`) and opening the dialog when it fires.
 *
 * The arbiter is the one dispatch point for `pointer/barDown` / `grid/rowPointerDown` events and
 * the press-filtering itself, across every feature, per architecture.md ch. 5 — see
 * `docs/specs/plugins/interaction.md` §1.
 */
import type { TaskId } from "@stargantt/plugin-data-store";
import type { PeripheralWiring } from "../peripheral";
import { focusChannel } from "../upward";
import { DOUBLE_ACTIVATION_MS, createDoubleActivation } from "./dblclick";
import { createEditDialog } from "./dialog";
import type { EditDialogConfig } from "../../config";

// docs/specs/plugins/interaction.md §5 — the dialog's `<input>` ids must be unique across every
// instance on the page (a host may mount more than one Gantt), so each call claims the next number.
let instanceSeq = 0;

/** Wires the edit-dialog feature into the composition. */
export function wireEditDialog(deps: PeripheralWiring): void {
  const { ctx, messages, selection } = deps;
  const config = deps.config as EditDialogConfig;
  const data = ctx.use("stargantt.data");
  const focus = focusChannel(ctx);

  const dialog = createEditDialog({
    // The backdrop is appended to the widget root, not the chart pane: a modal that leaves the
    // tree grid clickable underneath is not modal.
    host: ctx.root,
    messages,
    idPrefix: `sg-edit-dialog-${++instanceSeq}`,
    getTask: (id) => data.getTask(id),
    // One `task/update` carrying every changed field — one undo step per dialog commit.
    apply: (id, after) => ctx.dispatch("task/update", { id, after }),
    // Resolved at call time (never at setup()): the a11y plugin, which owns `stargantt.focus`,
    // starts after this one.
    announcer: () => focus(),
    // §6 rule 3: a value that is not a function counts as absent.
    renderBody: typeof config.renderBody === "function" ? config.renderBody : undefined,
    fault: deps.reportError,
  });
  // The dialog's backdrop lives in `ctx.root` only while open, so this feature owns exactly one
  // disposer that closes it; the chrome's own listeners go with the removed subtree.
  ctx.own({ dispose: () => dialog.dispose() });

  function openFor(id: TaskId): void {
    if (!dialog.open(id)) return;
    // What is being edited is what is selected, so the chart, the tree grid and any detail pane
    // agree with the dialog. On the double-activation path the press already selected the task, so
    // the guard below makes this a no-op there rather than a second selection publish.
    const current = selection.state.get().taskIds;
    if (current.size !== 1 || !current.has(id)) selection.select([id]);
  }

  // docs/specs/plugins/interaction.md §4 — the programmatic way in, and the only way in when
  // `openOnDoubleClick` is off.
  ctx.registerCommand("edit-dialog/open", (payload) => openFor(payload.id));

  if (config.openOnDoubleClick === false) return;

  // The arbiter feeds every press — filtered or not — through `press(target, id, counts)`, and
  // every non-bar hit through `reset()` (§1.3's `idle` row), driving the `createDoubleActivation`
  // detector. `target` is only ever used as the detector's pairing key: the raw `id` the arbiter
  // names alongside it is what actually opens, so a
  // numeric `TaskId` — which `"bar:<id>".slice(...)` could never reconstruct, always yielding a
  // string — opens correctly too.
  const doubles = createDoubleActivation(DOUBLE_ACTIVATION_MS, () => Date.now());
  deps.setEditDialog({
    press(target, id, counts): void {
      if (!doubles.press(target, counts)) return;
      openFor(id);
    },
    reset(): void {
      doubles.reset();
    },
  });
}
