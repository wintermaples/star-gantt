// docs/specs/plugins/interaction.md §6.10 — the right-hand detail pane and its field contributions
/**
 * Wiring entry point of the `side-panel` feature.
 *
 * A right-hand detail pane that follows the current selection. With exactly one task selected it
 * shows the task's name, period, progress, dependencies and resource assignments, and lets the
 * user edit name, start, end and progress; every edit goes through the command bus, so it is
 * undoable and the panel holds no state of its own. With an empty selection it shows a
 * placeholder, and with a multi-selection only the selected count. Dependencies and assignments
 * are read-only.
 *
 * Two substitutions beyond the mechanical service/event renames below: `createFrameScheduler` /
 * `listen` / `latchedSeam` come from `@stargantt/sdk`, and the pane itself is contributed to
 * `view/panes` (owned by `stargantt.view`) rather than a dedicated panes plugin — same
 * contribution shape (`side`/`order`/`initialWidth`/`minWidth`/`label`/`mount`), promoted per
 * architecture.md ch. 4.
 *
 * Selection following is a store subscription here rather than an event: `SelectionService` is
 * store-shaped (§2.1), so `deps.selection.state.subscribe(...)` is the mapping. Likewise there is
 * no `data/tasksChanged` event (see `@stargantt/plugin-data-store`'s `types.ts`) — this uses
 * `data.tasks.subscribe(...)` instead.
 */
import { collect } from "@stargantt/core";
import { createFrameScheduler, latchedSeam, listen } from "@stargantt/sdk";
import type { Task, TaskId } from "@stargantt/plugin-data-store";
import type { PeripheralWiring } from "../peripheral";
import { focusChannel } from "../upward";
import {
  buildLinksModel,
  buildAssignmentsModel,
  buildPanelDom,
  createDateReadout,
  el,
  mountCustomFields,
  renderDetail,
  resolveSelected,
  updateCustomFields,
} from "./fields";
import type { LiveField } from "./fields";
import { createEditController, createInvalidMarks } from "./edit";
import type { FieldKey, SidePanelFieldContribution, SidePanelRenderContext } from "./types";
import type { SidePanelConfig } from "../../config";

// docs/specs/plugins/interaction.md §3 — `view/panes` pane geometry.
const PANE_WIDTH = 280;
const PANE_MIN_WIDTH = 200;

const PLUGIN_ID = "stargantt.interaction";

// docs/specs/plugins/interaction.md §6.10 — the built-in fields' `<input>` ids need to be unique
// across every side-panel instance on the page (a host may mount more than one Gantt), so each
// call claims the next number.
let instanceSeq = 0;

/** Wires the side-panel feature into the composition. */
export function wireSidePanel(deps: PeripheralWiring): void {
  const { ctx, messages, selection } = deps;
  const config = deps.config as SidePanelConfig;
  const data = ctx.use("stargantt.data");
  const doc = ctx.root.ownerDocument;
  const focus = focusChannel(ctx);

  // Foreign code this feature calls is guarded and reported under the plugin's id, since a
  // contributor's own id is not observable through the public API.
  const fault = deps.reportError;

  // A non-function value counts as absent (§6 rule 3).
  const readout = createDateReadout(
    typeof config.formatDate === "function" ? config.formatDate : undefined,
    fault,
  );
  const bodySeam =
    typeof config.renderBody === "function" ? latchedSeam(config.renderBody, fault) : undefined;
  // Sticks once the seam has thrown once, for the life of the instance.
  let bodyFallback = false;

  // The panel's own point: custom sections appended below the built-in content, in collect
  // (registration) order. Purely additive: built-in fields are neither removable nor reorderable
  // through it.
  const fieldsPoint = ctx.defineExtensionPoint("sidepanel/fields", collect<SidePanelFieldContribution>());
  let customFields: readonly LiveField[] = [];

  // The pane element itself is created (and disposed) by `stargantt.view`; everything below lives
  // inside it, so it is torn down with the pane and needs no own() of its own.
  const dom = buildPanelDom(doc, {
    messages,
    idPrefix: `sg-side-panel-${++instanceSeq}`,
    dateReadouts: readout.enabled,
  });
  let container: HTMLElement | null = null;
  // The empty body element handed to the seam; created only when `renderBody` is configured, so
  // the built-in path's DOM stays byte-identical to before the seam existed.
  let bodyHost: HTMLElement | null = null;

  const marks = createInvalidMarks(dom.editable);

  /** The task shown by the detail form, if any — the dispatch target of the field handlers. */
  let current: TaskId | null = null;

  /* --- rendering ------------------------------------------------------ */

  function nameOf(id: TaskId): string {
    const task = data.getTask(id);
    return task === undefined ? String(id) : task.name;
  }

  /** Fills the built-in placeholder/multi/detail content from the current selection state. */
  function renderBuiltIn(sel: ReadonlySet<TaskId>, task: Readonly<Task> | undefined): void {
    dom.empty.style.display =
      sel.size === 0 || (sel.size === 1 && task === undefined) ? "" : "none";
    dom.multi.style.display = sel.size > 1 ? "" : "none";
    dom.detail.style.display = task === undefined ? "none" : "";

    if (sel.size > 1) dom.multi.textContent = messages.multiSelection(sel.size);
    if (task !== undefined) {
      renderDetail(dom, task, { doc, messages, view: data.query(), readout, nameOf });
    }
  }

  /** The cause-text snapshot `SidePanelRenderContext.invalid` exposes, mirroring the DOM marking
   *  on the same fields and the same clear schedule. */
  function invalidSnapshot(): Partial<Record<FieldKey, string>> {
    const snapshot: Partial<Record<FieldKey, string>> = {};
    for (const key of ["name", "start", "end", "progress"] as const) {
      const cause = marks.causeOf(dom.fields[key]);
      if (cause !== undefined) snapshot[key] = cause;
    }
    return snapshot;
  }

  /** The render context handed to `renderBody` on every call: the selection resolved the same way
   *  `sidepanel/fields` sees it, the single task's links/assignments built through the same model
   *  functions `renderDetail` uses, and `commit` routed through the same edit controller a
   *  `change` event on the built-in form dispatches through. */
  function buildRenderContext(
    sel: ReadonlySet<TaskId>,
    task: Readonly<Task> | undefined,
  ): SidePanelRenderContext {
    const view = data.query();
    return {
      selected: resolveSelected(sel, (id) => data.getTask(id)),
      task,
      links: task === undefined ? [] : buildLinksModel(task, view, nameOf),
      assignments: task === undefined ? [] : buildAssignmentsModel(task, view),
      messages,
      invalid: invalidSnapshot(),
      commit: (field, value) => edits.change(field, value),
    };
  }

  function render(): void {
    if (container === null) return;
    // A store-driven refresh clears the rejected-edit marking; the cosmetic reset render a
    // rejection itself schedules does not.
    marks.applyPending();
    // The selection is read *here*, at render time, never off an event payload, so the panel does
    // not depend on subscriber invocation order.
    const sel = selection.state.get().taskIds;
    const one = sel.size === 1 ? [...sel][0] : undefined;
    const task = one === undefined ? undefined : data.getTask(one);

    current = task === undefined ? null : task.id;

    if (bodySeam === undefined || bodyFallback) {
      renderBuiltIn(sel, task);
    } else if (bodyHost !== null) {
      // The body is emptied before every call, so "returning without appending anything" is not a
      // fallback signal: the seam asked for an empty body and gets one.
      bodyHost.textContent = "";
      const ok = bodySeam(bodyHost, buildRenderContext(sel, task));
      if (!ok) {
        bodyFallback = true;
        // Whatever the throwing call had appended to `bodyHost` before it threw is discarded here,
        // so a half-built custom body leaves nothing behind.
        bodyHost.textContent = "";
        bodyHost.appendChild(dom.empty);
        bodyHost.appendChild(dom.multi);
        bodyHost.appendChild(dom.detail);
        renderBuiltIn(sel, task);
      }
    }

    // Custom sections update after the built-in fields, in collect order, inside the same frame
    // callback, and are never hidden by the panel. Unaffected by `renderBody`: a custom body and
    // custom sections compose.
    updateCustomFields(customFields, sel, (id) => data.getTask(id), fault);
  }

  // Every trigger schedules at most one render per frame, and the cancellation is owned once so a
  // queued refresh never outlives the plugin.
  const refresh = createFrameScheduler(render);
  ctx.own(refresh);

  /* --- editing: every change is a command dispatch -------------------- */
  // No local echo: the panel re-renders from the store via the `tasks` store publish the dispatch
  // causes. Invalid input is not dispatched; the controller marks the field, announces the
  // rejection and schedules the render that resets the field to the stored value.
  const edits = createEditController({
    messages,
    fields: dom.fields,
    marks,
    currentTask: (): Readonly<Task> | undefined =>
      current === null ? undefined : data.getTask(current),
    commands: {
      update: (id, name) => ctx.dispatch("task/update", { id, after: { name } }),
      move: (id, start, end) => ctx.dispatch("task/move", { id, start, end }),
      setProgress: (id, progress) => ctx.dispatch("task/setProgress", { id, progress }),
    },
    // Resolved at call time (never at setup()): the a11y plugin, which owns `stargantt.focus`,
    // starts after this one. A composition without it announces nothing while the marking still
    // applies.
    announcer: () => focus(),
    schedule: () => refresh.schedule(),
  });

  // Registered unconditionally even with a seam configured: `bodyFallback` re-attaches these same
  // built-in inputs into the live DOM the moment the seam throws, so the listeners must already be
  // wired for that first fallback render to be interactive.
  listen(ctx, dom.fields.name.input, "change", () => edits.change("name"));
  listen(ctx, dom.fields.start.input, "change", () => edits.change("start"));
  listen(ctx, dom.fields.end.input, "change", () => edits.change("end"));
  listen(ctx, dom.fields.progress.input, "change", () => edits.change("progress"));

  /* --- the pane contribution ------------------------------------------ */
  // `mount()` is called by `stargantt.view` exactly once, after every plugin's setup() has
  // completed, with the pane element it owns. The `sidepanel/fields` point is read at that single
  // moment, after the built-in skeleton is in place and before the first render, so a contribution
  // registered later is never mounted.
  ctx.contribute("view/panes", {
    id: PLUGIN_ID,
    side: "right",
    order: 0,
    initialWidth: PANE_WIDTH,
    minWidth: PANE_MIN_WIDTH,
    // The divider's accessible name follows this plugin's own message catalog, taken verbatim per
    // the shared §8 merge rule (the empty string is usable — no special-case fallback here).
    label: messages.panelPaneResizeLabel,
    mount: (paneEl: HTMLElement) => {
      container = el(doc, "div", "sg-side-panel");
      // With a seam configured, the built-in empty/multi/detail content is not created at all; the
      // seam gets an empty `div.sg-side-panel__body` instead. Without one, the panel's DOM is
      // byte-identical to the pre-seam panel.
      if (bodySeam !== undefined) {
        bodyHost = el(doc, "div", "sg-side-panel__body");
        container.appendChild(bodyHost);
      } else {
        container.appendChild(dom.empty);
        container.appendChild(dom.multi);
        container.appendChild(dom.detail);
      }
      customFields = mountCustomFields(doc, container, fieldsPoint.get(), fault);
      paneEl.appendChild(container);
      render();
    },
  });

  /* --- selection following -------------------------------------------- */
  // The panel subscribes directly to the selection store, which publishes after every effective
  // selection mutation (pointer, keyboard, and programmatic select()/toggle()/clear()), plus the
  // `tasks` store for edits to the shown task's fields. These are the *store-driven* refreshes: the
  // ones that clear a rejected edit's marking.
  const storeDriven = (): void => {
    marks.arm();
    refresh.schedule();
  };
  ctx.own(selection.state.subscribe(storeDriven));
  ctx.own(data.tasks.subscribe(storeDriven));
}
