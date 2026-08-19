// docs/specs/plugins/scheduling.md §5.7
/**
 * The dependency inspector: one `sidepanel/fields` section listing the selected task's predecessor
 * and successor links, plus one static editor row — link picker, type selector, lag field, remove
 * button.
 *
 * Every control is created once at mount and wired exactly once through the `ctx.own()`-registered
 * `listen`, so a re-render repopulates but never re-registers a listener. A retype or a re-lag is
 * one `link/update` command — one transaction, therefore one undo step, with the link's id and
 * endpoints preserved.
 */
import type { DataService, Link, LinkType, Task } from "@stargantt/plugin-data-store";
import type {
  SidePanelFieldContribution,
  SidePanelFieldHandle,
} from "@stargantt/plugin-interaction";
import { MS_DAY } from "@stargantt/sdk";
import type { SchedulingMessages } from "../messages";

/** The four link types, in the order the type selector lists them. */
export const LINK_TYPES: readonly LinkType[] = ["FS", "SS", "FF", "SF"];

/** The section's stable id, reflected on the section element as `data-field-id`. */
export const INSPECTOR_SECTION_ID = "stargantt.scheduling.links";

/** A link's lag in whole-or-fractional days, `0` when it has none. */
export function lagToDays(lag: number | undefined): number {
  return (lag ?? 0) / MS_DAY;
}

/** Days back to a lag in milliseconds, `undefined` for zero (a lag of none). */
export function daysToLag(days: number): number | undefined {
  const ms = Math.round(days * MS_DAY);
  return ms === 0 ? undefined : ms;
}

/** What the inspector needs from its area. */
export interface InspectorDeps {
  messages: SchedulingMessages;
  /** The store reads the section makes. */
  data: Pick<DataService, "query" | "getTask">;
  /** Removes a link (dispatches `link/remove`) and announces it. */
  removeLink(link: Link): void;
  /** Retypes and re-lags a link in one transaction (dispatches `link/update`) and announces it. */
  updateLink(link: Link, type: LinkType, lag: number | undefined): void;
  /** Registers a DOM listener whose removal is owned by `ctx.own()`. */
  listen(target: HTMLElement, type: string, fn: (e: Event) => void): void;
}

function nameOf(data: InspectorDeps["data"], id: Link["sourceId"]): string {
  return data.getTask(id)?.name ?? String(id);
}

// Minor fix (P4 review ruling) — `<label>`/control pairing: a bare `textContent` label announces
// nothing to a screen reader and does not extend the click target onto its control. A monotonic
// per-mount counter, not a fixed literal, because more than one chart instance can be on the same
// page at once and HTML `id`s must be document-unique; each mount's three controls share one
// instance number so they never collide with a sibling chart's own inspector section.
let mountCounter = 0;

/** Builds the `sidepanel/fields` contribution. */
export function makeInspectorContribution(deps: InspectorDeps): SidePanelFieldContribution {
  const { messages, data } = deps;
  return {
    id: INSPECTOR_SECTION_ID,
    mount(host: HTMLElement): SidePanelFieldHandle {
      const doc = host.ownerDocument;
      const instance = (mountCounter += 1);
      /** The selected task's links, incoming first — what the picker's option values index. */
      let links: Link[] = [];

      const heading = doc.createElement("div");
      heading.className = "sg-deps-heading";
      heading.textContent = messages.inspectorLabel;
      host.appendChild(heading);

      const list = doc.createElement("div");
      list.className = "sg-deps-list";
      host.appendChild(list);

      const labelled = (text: string, control: HTMLElement, idSuffix: string): HTMLElement => {
        const wrap = doc.createElement("div");
        wrap.className = "sg-deps-row";
        const label = doc.createElement("label");
        label.className = "sg-deps-label";
        label.textContent = text;
        const controlId = `sg-deps-${String(instance)}-${idSuffix}`;
        control.id = controlId;
        label.htmlFor = controlId;
        wrap.appendChild(label);
        wrap.appendChild(control);
        return wrap;
      };

      const picker = doc.createElement("select");
      host.appendChild(labelled(messages.linkPickerLabel, picker, "picker"));

      const typeSelect = doc.createElement("select");
      for (const t of LINK_TYPES) {
        const option = doc.createElement("option");
        option.value = t;
        option.textContent = t;
        typeSelect.appendChild(option);
      }
      host.appendChild(labelled(messages.typeLabel, typeSelect, "type"));

      const lagInput = doc.createElement("input");
      lagInput.type = "number";
      host.appendChild(labelled(messages.lagLabel, lagInput, "lag"));

      const remove = doc.createElement("button");
      remove.type = "button";
      remove.textContent = messages.removeLink;
      host.appendChild(remove);

      /** The link the editor row currently addresses, or `undefined` when there is none. */
      const picked = (): Link | undefined => {
        const index = Number(picker.value);
        return Number.isInteger(index) ? links[index] : undefined;
      };

      const syncEditor = (): void => {
        const link = picked();
        const usable = link !== undefined;
        picker.disabled = !usable;
        typeSelect.disabled = !usable;
        lagInput.disabled = !usable;
        remove.disabled = !usable;
        typeSelect.value = link?.type ?? "FS";
        lagInput.value = link === undefined ? "" : String(lagToDays(link.lag));
      };

      const lineText = (link: Link, incoming: boolean): string => {
        const farId = incoming ? link.sourceId : link.targetId;
        const parts = { name: nameOf(data, farId), type: link.type, lagDays: lagToDays(link.lag) };
        return incoming ? messages.incomingLink(parts) : messages.outgoingLink(parts);
      };

      const render = (selected: Readonly<Task> | undefined): void => {
        while (list.firstChild !== null) list.removeChild(list.firstChild);
        while (picker.firstChild !== null) picker.removeChild(picker.firstChild);
        links = [];
        if (selected !== undefined) {
          const entry = data.query().linksByTask.get(selected.id);
          const incoming = entry?.in ?? [];
          const outgoing = entry?.out ?? [];
          // Predecessors first, then successors (§5.7).
          links = [...incoming, ...outgoing];
          links.forEach((link, index) => {
            const text = lineText(link, index < incoming.length);
            const line = doc.createElement("div");
            line.className = "sg-deps-line";
            line.textContent = text;
            list.appendChild(line);
            const option = doc.createElement("option");
            option.value = String(index);
            option.textContent = text;
            picker.appendChild(option);
          });
        }
        if (links.length === 0) {
          const none = doc.createElement("div");
          none.className = "sg-deps-line";
          none.textContent = messages.noLinks;
          list.appendChild(none);
        }
        if (links.length > 0) picker.value = "0";
        syncEditor();
      };

      deps.listen(picker, "change", syncEditor);
      deps.listen(typeSelect, "change", () => {
        const link = picked();
        if (link === undefined) return;
        const type = typeSelect.value as LinkType;
        if (!LINK_TYPES.includes(type) || type === link.type) return;
        deps.updateLink(link, type, link.lag);
      });
      deps.listen(lagInput, "change", () => {
        const link = picked();
        if (link === undefined) return;
        const days = Number(lagInput.value);
        // §5.7 — unparsable input resets the field to the stored value and dispatches nothing.
        if (!Number.isFinite(days)) {
          lagInput.value = String(lagToDays(link.lag));
          return;
        }
        const lag = daysToLag(days);
        if (lag === link.lag || (lag === undefined && (link.lag ?? 0) === 0)) return;
        deps.updateLink(link, link.type, lag);
      });
      deps.listen(remove, "click", () => {
        const link = picked();
        if (link === undefined) return;
        deps.removeLink(link);
      });

      render(undefined);
      return {
        // Like the side panel's built-in fields, the editor addresses a single selected task and
        // stands down for an empty or multiple selection (§5.7).
        update(selectedTasks: readonly Readonly<Task>[]): void {
          render(selectedTasks.length === 1 ? selectedTasks[0] : undefined);
        },
      };
    },
  };
}
