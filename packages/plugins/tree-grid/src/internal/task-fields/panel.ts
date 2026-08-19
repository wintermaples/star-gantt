// docs/specs/plugins/tree-grid.md § Extension points — the `sidepanel/fields` section:
// status/priority selects, tags input, three date inputs, notes textarea. Edits the first
// selected task (the side panel's own built-ins set the precedent) and disables itself when
// nothing is selected. Commits happen per `change`, one `task/update` (= one undo step) each.
import type { Task, TaskId } from "@stargantt/plugin-data-store";
import type { SidePanelFieldContribution, SidePanelFieldHandle } from "../upward";
import { isoDay, parseIsoDateStrict } from "@stargantt/sdk";
import type { TaskFieldsPatch, TaskPriority, TaskStatus, TreeGridMessages } from "../../types";
import { PRIORITY_VALUES, STATUS_VALUES, fieldsOfTask, normalizeTags, priorityLabel, statusLabel } from "./fields";

export interface PanelDeps {
  messages: TreeGridMessages;
  /** Merges a field patch into the given task via one `task/update` transaction. */
  commit(id: TaskId, patch: Readonly<TaskFieldsPatch>): void;
  /** Registers a listener removal with `ctx.own()`. */
  listen(target: HTMLElement, type: string, fn: (e: Event) => void): void;
}

const NONE = "";

function option(doc: Document, value: string, label: string): HTMLOptionElement {
  const o = doc.createElement("option") as HTMLOptionElement;
  o.value = value;
  o.textContent = label;
  return o;
}

// docs/specs/plugins/tree-grid.md § Extension points — natively labelled controls: the label is
// programmatically associated via `for`/`id` (the pattern the side panel's own built-ins use), so
// every control has an accessible name.
function labelled(doc: Document, text: string, control: HTMLElement, controlId: string): HTMLElement {
  const wrap = doc.createElement("div");
  wrap.className = "sg-taskfields-row";
  const label = doc.createElement("label");
  label.className = "sg-taskfields-label";
  label.textContent = text;
  label.setAttribute("for", controlId);
  control.setAttribute("id", controlId);
  wrap.appendChild(label);
  wrap.appendChild(control);
  return wrap;
}

/** Monotonic mount counter, keeping control ids unique across panel instances. */
let mountSeq = 0;

// The strict shared parse: a calendar-invalid date (`2024-02-30`) is rejected, not rolled over
// onto a neighboring date.
function parsePanelDate(raw: string): number | "clear" | undefined {
  const text = raw.trim();
  if (text === "") return "clear";
  return parseIsoDateStrict(text);
}

/** Builds the contribution. All listeners go through `deps.listen` (ctx.own-registered). */
export function makePanelContribution(deps: PanelDeps): SidePanelFieldContribution {
  const { messages } = deps;
  return {
    id: "stargantt.tree-grid",
    mount(host: HTMLElement): SidePanelFieldHandle {
      const doc = host.ownerDocument;
      /** Per-mount id prefix so `for`/`id` pairs stay unique across panel instances. */
      const idPrefix = `sg-taskfields-${++mountSeq}`;
      /** The first selected task's id, or `undefined` when the selection is empty. */
      let current: TaskId | undefined;

      const heading = doc.createElement("div");
      heading.className = "sg-taskfields-heading";
      heading.textContent = messages.fieldsSection;
      host.appendChild(heading);

      const status = doc.createElement("select") as HTMLSelectElement;
      status.appendChild(option(doc, NONE, messages.noneOption));
      for (const s of STATUS_VALUES) status.appendChild(option(doc, s, statusLabel(messages, s)));
      host.appendChild(labelled(doc, messages.statusLabel, status, `${idPrefix}-status`));

      const priority = doc.createElement("select") as HTMLSelectElement;
      priority.appendChild(option(doc, NONE, messages.noneOption));
      for (const p of PRIORITY_VALUES) {
        priority.appendChild(option(doc, p, priorityLabel(messages, p)));
      }
      host.appendChild(labelled(doc, messages.priorityLabel, priority, `${idPrefix}-priority`));

      const tags = doc.createElement("input") as HTMLInputElement;
      tags.setAttribute("type", "text");
      tags.setAttribute("placeholder", messages.tagsPlaceholder);
      host.appendChild(labelled(doc, messages.tagsLabel, tags, `${idPrefix}-tags`));

      const dateInput = (): HTMLInputElement => {
        const input = doc.createElement("input") as HTMLInputElement;
        input.setAttribute("type", "date");
        return input;
      };
      const deadline = dateInput();
      host.appendChild(labelled(doc, messages.deadlineLabel, deadline, `${idPrefix}-deadline`));
      // actual-start/actual-end are the section's only departure from the one-field-per-row
      // rhythm: a 2-column grid holding both date rows side by side. The grid layout itself is
      // CSS owned by the bundle stylesheet; this wrapper class is the hook it targets.
      const actualDatesGrid = doc.createElement("div");
      actualDatesGrid.className = "sg-taskfields-row-grid";
      const actualStart = dateInput();
      actualDatesGrid.appendChild(
        labelled(doc, messages.actualStartLabel, actualStart, `${idPrefix}-actual-start`),
      );
      const actualEnd = dateInput();
      actualDatesGrid.appendChild(
        labelled(doc, messages.actualEndLabel, actualEnd, `${idPrefix}-actual-end`),
      );
      host.appendChild(actualDatesGrid);

      const notes = doc.createElement("textarea") as HTMLTextAreaElement;
      notes.setAttribute("placeholder", messages.notesPlaceholder);
      host.appendChild(labelled(doc, messages.notesLabel, notes, `${idPrefix}-notes`));

      const controls: (HTMLSelectElement | HTMLInputElement | HTMLTextAreaElement)[] = [
        status,
        priority,
        tags,
        deadline,
        actualStart,
        actualEnd,
        notes,
      ];

      const commitDate =
        (key: "deadline" | "actualStart" | "actualEnd", input: HTMLInputElement) => (): void => {
          if (current === undefined) return;
          const parsed = parsePanelDate(input.value);
          // Unparsable input is ignored; the next refresh re-fills the input.
          if (parsed === undefined) return;
          deps.commit(current, { [key]: parsed === "clear" ? undefined : parsed });
        };

      deps.listen(status, "change", () => {
        if (current === undefined) return;
        const value = status.value as TaskStatus | typeof NONE;
        deps.commit(current, { status: value === NONE ? undefined : value });
      });
      deps.listen(priority, "change", () => {
        if (current === undefined) return;
        const value = priority.value as TaskPriority | typeof NONE;
        deps.commit(current, { priority: value === NONE ? undefined : value });
      });
      deps.listen(tags, "change", () => {
        if (current === undefined) return;
        deps.commit(current, { tags: normalizeTags(tags.value.split(",")) });
      });
      deps.listen(deadline, "change", commitDate("deadline", deadline));
      deps.listen(actualStart, "change", commitDate("actualStart", actualStart));
      deps.listen(actualEnd, "change", commitDate("actualEnd", actualEnd));
      deps.listen(notes, "change", () => {
        if (current === undefined) return;
        const text = notes.value;
        deps.commit(current, { notes: text === "" ? undefined : text });
      });

      return {
        update(selectedTasks: readonly Readonly<Task>[]): void {
          const task = selectedTasks[0];
          current = task?.id;
          const disabled = task === undefined;
          for (const c of controls) {
            if (disabled) c.setAttribute("disabled", "");
            else c.removeAttribute("disabled");
          }
          const fields = task === undefined ? {} : fieldsOfTask(task);
          status.value = fields.status ?? NONE;
          priority.value = fields.priority ?? NONE;
          tags.value = (fields.tags ?? []).join(", ");
          deadline.value = fields.deadline === undefined ? "" : (isoDay(fields.deadline) ?? "");
          actualStart.value =
            fields.actualStart === undefined ? "" : (isoDay(fields.actualStart) ?? "");
          actualEnd.value = fields.actualEnd === undefined ? "" : (isoDay(fields.actualEnd) ?? "");
          notes.value = fields.notes ?? "";
        },
      };
    },
  };
}
