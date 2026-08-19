// docs/specs/plugins/interaction.md §6.10 / §8 (the `panel*` renamed message keys).
/**
 * The detail pane's field catalog: the DOM skeleton of the built-in fields, the rendering of one
 * task into it, the optional date read-out, and the custom sections contributed through
 * `sidepanel/fields`.
 *
 * Nothing here reaches for a plugin context — a document, a message catalog and a few callbacks are
 * the whole input — so every piece is unit-testable without booting a host.
 *
 * `SidePanelFieldContribution` / `SidePanelFieldHandle` live in `./types.ts` (the
 * `sidepanel/fields` extension-point declaration site); `isoDay` comes from `@stargantt/sdk`.
 */
import { isoDay } from "@stargantt/sdk";
import type { LinkType, ReadonlyDataView, Task, TaskId } from "@stargantt/plugin-data-store";
import type { InteractionMessages } from "../../messages";
import type { FieldKey, SidePanelFieldContribution, SidePanelFieldHandle } from "./types";

/* ------------------------------------------------------------------ *
 * Small DOM / date helpers
 * ------------------------------------------------------------------ */

/** Creates an element carrying one class name and, when given, its text. */
export function el(doc: Document, tag: string, className: string, text?: string): HTMLElement {
  const node = doc.createElement(tag);
  node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

/* ------------------------------------------------------------------ *
 * The date read-out
 * ------------------------------------------------------------------ */

/** The `formatDate` display hook, guarded and latched. */
export interface DateReadout {
  /**
   * Whether the panel creates a read-out element per date field at all. False when no usable hook
   * was configured, in which case no empty node is left behind.
   */
  readonly enabled: boolean;
  /** The hook's text for one instant, or the empty string when there is nothing to show. */
  text(t: number): string;
}

/**
 * Wraps the host's `formatDate` hook.
 *
 * A value that is not a function is unusable, so no read-out is created. A non-finite instant is
 * never handed to the hook. The first throw is reported through `fault` and latches the hook off
 * for good, because it is called inside a per-frame-batched refresh and an unlatched barrier would
 * report at frame rate.
 */
export function createDateReadout(
  supplied: ((t: number) => string) | undefined,
  fault: (error: unknown) => void,
): DateReadout {
  const hook = typeof supplied === "function" ? supplied : undefined;
  let dead = false;
  return {
    enabled: hook !== undefined,
    text(t: number): string {
      if (hook === undefined || dead || !Number.isFinite(t)) return "";
      try {
        return hook(t);
      } catch (error) {
        dead = true;
        fault(error);
        return "";
      }
    },
  };
}

/* ------------------------------------------------------------------ *
 * The built-in field skeleton
 * ------------------------------------------------------------------ */

/** One built-in field: its wrapper, its input, and the date read-out when there is one. */
export interface Field {
  wrap: HTMLElement;
  input: HTMLInputElement;
  /** Read-out beside a date input, created only when `formatDate` is configured. */
  value?: HTMLElement;
  /**
   * Cause-text element a rejected edit appends under the input and references through
   * `aria-errormessage`. Created detached, so the default DOM carries no empty node; a
   * store-driven refresh detaches it again.
   */
  error?: HTMLElement;
}

/** What one labeled field needs to be built. */
export interface FieldBuildOptions {
  readonly label: string;
  /** The input's `type` attribute (`"text"`, `"date"`, `"number"`). */
  readonly type: string;
  /** The input's `id`, unique per panel instance, addressed by the label's `for`. */
  readonly inputId: string;
}

// The one field shape both the pane's form and the edit dialog build: label programmatically
// associated via `for`/`id`, and a detached cause-text element ready for the rejected-edit marking.
/**
 * Builds one labeled field: wrapper, associated label, input, and a detached error element whose
 * id is `<inputId>-error` — appended to the wrapper only while the field is marked invalid.
 */
export function buildField(doc: Document, options: FieldBuildOptions): Field {
  const wrap = el(doc, "div", "sg-side-panel-field");
  const labelEl = el(doc, "label", "sg-side-panel-label", options.label);
  labelEl.setAttribute("for", options.inputId);
  wrap.appendChild(labelEl);
  const input = doc.createElement("input") as HTMLInputElement;
  input.setAttribute("id", options.inputId);
  input.className = "sg-side-panel-input";
  input.setAttribute("type", options.type);
  wrap.appendChild(input);
  const error = el(doc, "div", "sg-side-panel-error");
  error.setAttribute("id", `${options.inputId}-error`);
  return { wrap, input, error };
}

/** The built-in fields, addressable by key. */
export type PanelFields = Readonly<Record<FieldKey, Field>>;

/** Every element of the panel's skeleton the plugin keeps a handle on. */
export interface PanelDom {
  /** Placeholder shown while nothing is selected. */
  readonly empty: HTMLElement;
  /** The selected-count line shown for a multi-selection. */
  readonly multi: HTMLElement;
  /** The single-task detail form. */
  readonly detail: HTMLElement;
  readonly fields: PanelFields;
  /** The built-in fields in DOM order — what a whole-form pass walks. */
  readonly editable: readonly Field[];
  readonly depsList: HTMLElement;
  readonly assignSection: HTMLElement;
  readonly assignList: HTMLElement;
}

/** What `buildPanelDom` needs to know. */
export interface PanelDomOptions {
  readonly messages: InteractionMessages;
  /**
   * Prefix for the built-in inputs' ids, unique per panel instance, so `<label for>` addresses the
   * right element even with several panels on the page.
   */
  readonly idPrefix: string;
  /** Whether each date field gets a read-out element after its input. */
  readonly dateReadouts: boolean;
}

/**
 * Builds the panel's skeleton once: placeholder, multi-selection line and the detail form holding
 * the four built-in fields plus the read-only dependencies and assignments sections.
 *
 * The elements are returned detached from any pane; the caller appends them to the container it
 * creates when the pane mounts.
 */
export function buildPanelDom(doc: Document, options: PanelDomOptions): PanelDom {
  const { messages, idPrefix, dateReadouts } = options;

  const empty = el(doc, "div", "sg-side-panel-empty", messages.noSelection);
  const multi = el(doc, "div", "sg-side-panel-multi");
  const detail = el(doc, "div", "sg-side-panel-detail");

  function field(key: FieldKey, label: string, type: string, withValue = false): Field {
    // The label element is programmatically associated with its input via `for`/`id`, so an
    // assistive technology announces the field name on focus.
    const built = buildField(doc, { label, type, inputId: `${idPrefix}-${key}` });
    detail.appendChild(built.wrap);
    // One read-out per date field, immediately after that field's input, and only when the hook
    // is there to fill it — an absent hook leaves no empty node behind.
    if (!withValue || !dateReadouts) return built;
    const value = el(doc, "div", "sg-side-panel-value");
    built.wrap.appendChild(value);
    return { ...built, value };
  }

  const name = field("name", messages.panelNameLabel, "text");
  const start = field("start", messages.panelStartLabel, "date", true);
  // `Task.end` is exclusive; the field shows and edits that stored instant as-is, so a round-trip
  // without edits changes nothing.
  const end = field("end", messages.panelEndLabel, "date", true);
  const progress = field("progress", messages.panelProgressLabel, "number");
  progress.input.setAttribute("min", "0");
  progress.input.setAttribute("max", "1");
  progress.input.setAttribute("step", "0.05");

  const depsSection = el(doc, "div", "sg-side-panel-section");
  depsSection.appendChild(el(doc, "div", "sg-side-panel-label", messages.dependenciesLabel));
  const depsList = el(doc, "div", "sg-side-panel-deps");
  depsSection.appendChild(depsList);
  detail.appendChild(depsSection);

  const assignSection = el(doc, "div", "sg-side-panel-section");
  assignSection.appendChild(el(doc, "div", "sg-side-panel-label", messages.resourcesLabel));
  const assignList = el(doc, "div", "sg-side-panel-assignments");
  assignSection.appendChild(assignList);
  detail.appendChild(assignSection);

  return {
    empty,
    multi,
    detail,
    fields: { name, start, end, progress },
    editable: [name, start, end, progress],
    depsList,
    assignSection,
    assignList,
  };
}

/* ------------------------------------------------------------------ *
 * Rendering one task into the skeleton
 * ------------------------------------------------------------------ */

/** What rendering one task needs besides the task itself. */
export interface RenderDeps {
  readonly doc: Document;
  readonly messages: InteractionMessages;
  /** The store snapshot the links and assignments are read from. */
  readonly view: ReadonlyDataView;
  readonly readout: DateReadout;
  /** The task's name, or its id rendered as a string when the store does not know it. */
  nameOf(id: TaskId): string;
}

/* ------------------------------------------------------------------ *
 * Links / assignments model — shared by the built-in detail form (`renderDetail` below) and
 * `SidePanelRenderContext` (`./wire.ts`), so the two never resolve counterpart names or the
 * assignment list differently.
 * ------------------------------------------------------------------ */

/** One dependency line's model: direction, the counterpart's resolved name, and the link type. */
export interface LinkModelEntry {
  readonly direction: "in" | "out";
  readonly name: string;
  readonly type: LinkType;
}

/** One resource-assignment line's model: the resolved resource name and its allocation. */
export interface AssignmentModelEntry {
  readonly name: string;
  readonly units: number;
}

/**
 * Resolves a task's incoming and outgoing links, incoming first, with each counterpart's name
 * resolved through `nameOf` (which itself falls back to the id when the store does not know it).
 */
export function buildLinksModel(
  task: Readonly<Task>,
  view: ReadonlyDataView,
  nameOf: (id: TaskId) => string,
): LinkModelEntry[] {
  const bucket = view.linksByTask.get(task.id);
  const model: LinkModelEntry[] = [];
  for (const link of bucket?.in ?? []) {
    model.push({ direction: "in", name: nameOf(link.sourceId), type: link.type });
  }
  for (const link of bucket?.out ?? []) {
    model.push({ direction: "out", name: nameOf(link.targetId), type: link.type });
  }
  return model;
}

/**
 * Resolves a task's resource assignments, each with the resource's name — falling back to the id
 * rendered as a string when the store does not know the resource.
 */
export function buildAssignmentsModel(
  task: Readonly<Task>,
  view: ReadonlyDataView,
): AssignmentModelEntry[] {
  const assignments = view.assignmentsByTask.get(task.id) ?? [];
  return assignments.map((a) => {
    const resource = view.resources.get(a.resourceId);
    return { name: resource === undefined ? String(a.resourceId) : resource.name, units: a.units };
  });
}

/**
 * Fills the detail form from one task: the editable values, the read-only dependency lines
 * (incoming then outgoing) and the resource-assignment lines, whose section is hidden when the
 * task has no assignment.
 */
export function renderDetail(dom: PanelDom, task: Readonly<Task>, deps: RenderDeps): void {
  const { doc, messages, view, readout, nameOf } = deps;
  const { name, start, end, progress } = dom.fields;

  name.input.value = task.name;
  start.input.value = isoDay(task.start) ?? "";
  end.input.value = isoDay(task.end) ?? "";
  // Display only: the stored instant, unmodified, beside the input that edits it.
  if (start.value !== undefined) start.value.textContent = readout.text(task.start);
  if (end.value !== undefined) end.value.textContent = readout.text(task.end);
  progress.input.value = String(task.progress ?? 0);

  // Dependencies (read-only): incoming then outgoing links, with the counterpart task's name.
  dom.depsList.textContent = "";
  const links = buildLinksModel(task, view, nameOf);
  if (links.length === 0) {
    dom.depsList.appendChild(el(doc, "div", "sg-side-panel-line", messages.noDependencies));
  } else {
    for (const link of links) {
      const text =
        link.direction === "in"
          ? messages.incomingLink({ name: link.name, type: link.type })
          : messages.outgoingLink({ name: link.name, type: link.type });
      dom.depsList.appendChild(el(doc, "div", "sg-side-panel-line", text));
    }
  }

  // Resource assignments (read-only), shown only when any exist.
  dom.assignList.textContent = "";
  const assignments = buildAssignmentsModel(task, view);
  dom.assignSection.style.display = assignments.length === 0 ? "none" : "";
  for (const a of assignments) {
    dom.assignList.appendChild(
      el(doc, "div", "sg-side-panel-line", messages.assignment({ name: a.name, units: a.units })),
    );
  }
}

/* ------------------------------------------------------------------ *
 * Custom sections (`sidepanel/fields`)
 * ------------------------------------------------------------------ */

/** One mounted section's handle, with its own latch for fault isolation. */
export interface LiveField {
  handle: SidePanelFieldHandle;
  dead: boolean;
}

/**
 * Mounts every contribution once, appending one section element per contribution below whatever is
 * already in `into`, in collect order.
 *
 * Each `mount` call is guarded on its own: a throw is reported through `fault` and never aborts the
 * mounting of the remaining contributions, its element stays in the DOM in whatever state it
 * reached, and that contribution acquires no handle, so it is never updated. A return value that is
 * not an object, or whose `update` is not a function, counts as no handle.
 *
 * The section elements live inside the pane element `stargantt.view` disposes, so nothing here is a
 * resource the side panel has to register.
 */
export function mountCustomFields(
  doc: Document,
  into: HTMLElement,
  contributions: readonly SidePanelFieldContribution[],
  fault: (error: unknown) => void,
): LiveField[] {
  const live: LiveField[] = [];
  for (const contribution of contributions) {
    const host = el(doc, "div", "sg-side-panel-field--custom");
    into.appendChild(host);
    try {
      host.setAttribute("data-field-id", String(contribution.id));
      const handle = contribution.mount(host);
      if (
        handle !== null &&
        typeof handle === "object" &&
        typeof (handle as SidePanelFieldHandle).update === "function"
      ) {
        live.push({ handle: handle as SidePanelFieldHandle, dead: false });
      }
    } catch (error) {
      fault(error);
    }
  }
  return live;
}

// The shape both `sidepanel/fields` updates and `SidePanelRenderContext.selected` are built from,
// so the two never disagree about what "selected" means.
/**
 * Resolves a selection to tasks, in selection iteration order, dropping any id the store no longer
 * knows.
 */
export function resolveSelected(
  selected: ReadonlySet<TaskId>,
  getTask: (id: TaskId) => Readonly<Task> | undefined,
): Readonly<Task>[] {
  const tasks: Readonly<Task>[] = [];
  for (const id of selected) {
    const task = getTask(id);
    if (task !== undefined) tasks.push(task);
  }
  return tasks;
}

/**
 * Calls `update` once per live handle, in collect order, with the selection resolved through the
 * store: selected ids in selection iteration order, ids the store does not know dropped, and the
 * empty array when nothing is selected.
 *
 * A throw is reported once and latches that handle off, because refreshes are frame-batched and an
 * unlatched barrier would report at frame rate. The store is not consulted at all while nothing is
 * mounted.
 */
export function updateCustomFields(
  fields: readonly LiveField[],
  selected: ReadonlySet<TaskId>,
  getTask: (id: TaskId) => Readonly<Task> | undefined,
  fault: (error: unknown) => void,
): void {
  if (fields.length === 0) return;
  const selectedTasks = resolveSelected(selected, getTask);
  for (const entry of fields) {
    if (entry.dead) continue;
    try {
      entry.handle.update(selectedTasks);
    } catch (error) {
      entry.dead = true;
      fault(error);
    }
  }
}
