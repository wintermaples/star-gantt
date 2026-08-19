// @vitest-environment happy-dom
/**
 * `internal/side-panel/fields.ts` — the detail pane's field skeleton, the built-in rendering of one
 * task into it, the links/assignments model, the `formatDate` read-out, and the `sidepanel/fields`
 * mounting/update machinery (docs/specs/plugins/interaction.md §3, §6.10).
 *
 * Covers this package's shared `InteractionMessages` catalog (the `panel*` renamed keys) and is
 * built on real DOM (happy-dom).
 */
import { describe, expect, it } from "vitest";
import type { Link, ReadonlyDataView, Resource, Task, TaskId } from "@stargantt/plugin-data-store";
import { DEFAULT_MESSAGES } from "../src/messages";
import {
  buildAssignmentsModel,
  buildLinksModel,
  buildPanelDom,
  createDateReadout,
  mountCustomFields,
  resolveSelected,
  renderDetail,
  updateCustomFields,
} from "../src/internal/side-panel/fields";
import type { LiveField } from "../src/internal/side-panel/fields";
import type { SidePanelFieldContribution, SidePanelFieldHandle } from "../src/internal/side-panel/types";

const DAY = 86_400_000;
const T0 = Date.UTC(2026, 0, 5);

function task(over: Partial<Task> = {}): Task {
  return { id: "t1", parentId: null, name: "Design", start: T0, end: T0 + 5 * DAY, progress: 0.4, ...over };
}

function emptyView(): ReadonlyDataView {
  return {
    byId: new Map(),
    children: new Map(),
    linksByTask: new Map(),
    calendars: new Map(),
    resources: new Map(),
    assignmentsByTask: new Map(),
  };
}

/* ------------------------------------------------------------------ *
 * `createDateReadout`
 * ------------------------------------------------------------------ */

describe("createDateReadout", () => {
  it("is disabled, and shows nothing, without a usable hook", () => {
    const readout = createDateReadout(undefined, () => {});
    expect(readout.enabled).toBe(false);
    expect(readout.text(T0)).toBe("");

    const notAFunction = createDateReadout("nope" as unknown as (t: number) => string, () => {});
    expect(notAFunction.enabled).toBe(false);
  });

  it("calls the hook only for a finite instant", () => {
    const calls: number[] = [];
    const readout = createDateReadout(
      (t) => {
        calls.push(t);
        return `t=${t}`;
      },
      () => {},
    );
    expect(readout.enabled).toBe(true);
    expect(readout.text(T0)).toBe(`t=${T0}`);
    expect(readout.text(Number.NaN)).toBe("");
    expect(calls).toEqual([T0]);
  });

  it("latches off after the first throw and reports it", () => {
    const faults: unknown[] = [];
    let calls = 0;
    const readout = createDateReadout(
      () => {
        calls += 1;
        throw new Error("boom");
      },
      (e) => faults.push(e),
    );
    expect(readout.text(T0)).toBe("");
    expect(readout.text(T0)).toBe("");
    expect(calls).toBe(1);
    expect(faults).toHaveLength(1);
  });
});

/* ------------------------------------------------------------------ *
 * `buildPanelDom` / `renderDetail`
 * ------------------------------------------------------------------ */

describe("buildPanelDom", () => {
  it("builds the placeholder, multi line and detail form with panel* labels", () => {
    const dom = buildPanelDom(document, { messages: DEFAULT_MESSAGES, idPrefix: "sg-side-panel-1", dateReadouts: false });
    expect(dom.empty.textContent).toBe(DEFAULT_MESSAGES.noSelection);
    expect(dom.fields.name.input.getAttribute("id")).toBe("sg-side-panel-1-name");
    expect(dom.fields.name.wrap.querySelector(".sg-side-panel-label")?.textContent).toBe(
      DEFAULT_MESSAGES.panelNameLabel,
    );
    expect(dom.fields.start.wrap.querySelector(".sg-side-panel-label")?.textContent).toBe(
      DEFAULT_MESSAGES.panelStartLabel,
    );
    expect(dom.fields.progress.input.getAttribute("min")).toBe("0");
    expect(dom.fields.progress.input.getAttribute("max")).toBe("1");
    // No read-out requested: date fields carry no `.value` node.
    expect(dom.fields.start.value).toBeUndefined();
  });

  it("adds a read-out node per date field only when configured", () => {
    const dom = buildPanelDom(document, { messages: DEFAULT_MESSAGES, idPrefix: "sg-side-panel-2", dateReadouts: true });
    expect(dom.fields.start.value).toBeDefined();
    expect(dom.fields.end.value).toBeDefined();
    expect(dom.fields.name.value).toBeUndefined();
    expect(dom.fields.progress.value).toBeUndefined();
  });
});

describe("renderDetail", () => {
  it("fills the editable fields, the date read-out, and hides assignments with none", () => {
    const dom = buildPanelDom(document, { messages: DEFAULT_MESSAGES, idPrefix: "sg-side-panel-3", dateReadouts: true });
    const readout = createDateReadout((t) => `on ${t}`, () => {});
    renderDetail(dom, task(), {
      doc: document,
      messages: DEFAULT_MESSAGES,
      view: emptyView(),
      readout,
      nameOf: (id) => String(id),
    });
    expect(dom.fields.name.input.value).toBe("Design");
    expect(dom.fields.start.input.value).toBe("2026-01-05");
    expect(dom.fields.end.input.value).toBe("2026-01-10");
    expect(dom.fields.progress.input.value).toBe("0.4");
    expect(dom.fields.start.value?.textContent).toBe(`on ${T0}`);
    expect(dom.depsList.textContent).toBe(DEFAULT_MESSAGES.noDependencies);
    expect(dom.assignSection.style.display).toBe("none");
  });

  it("renders dependency lines incoming then outgoing, and assignment lines", () => {
    const dom = buildPanelDom(document, { messages: DEFAULT_MESSAGES, idPrefix: "sg-side-panel-4", dateReadouts: false });
    const link1: Link = { id: "l1", sourceId: "up", targetId: "t1", type: "FS" };
    const link2: Link = { id: "l2", sourceId: "t1", targetId: "down", type: "SS" };
    const resource: Resource = { id: "r1", name: "Alice" };
    const view: ReadonlyDataView = {
      ...emptyView(),
      linksByTask: new Map([["t1", { in: [link1], out: [link2] }]]),
      resources: new Map([["r1", resource]]),
      assignmentsByTask: new Map([["t1", [{ taskId: "t1", resourceId: "r1", units: 0.5 }]]]),
    };
    renderDetail(dom, task(), {
      doc: document,
      messages: DEFAULT_MESSAGES,
      view,
      readout: createDateReadout(undefined, () => {}),
      nameOf: (id) => (id === "up" ? "Upstream" : id === "down" ? "Downstream" : String(id)),
    });
    const lines = Array.from(dom.depsList.querySelectorAll(".sg-side-panel-line")).map((l) => l.textContent);
    expect(lines).toEqual(["← Upstream (FS)", "→ Downstream (SS)"]);
    expect(dom.assignSection.style.display).toBe("");
    expect(dom.assignList.textContent).toBe("Alice × 0.5");
  });
});

describe("buildLinksModel / buildAssignmentsModel", () => {
  it("falls back to the id string when the counterpart or resource is unknown", () => {
    const link: Link = { id: "l1", sourceId: "ghost", targetId: "t1", type: "FF" };
    const view: ReadonlyDataView = {
      ...emptyView(),
      linksByTask: new Map([["t1", { in: [link], out: [] }]]),
      assignmentsByTask: new Map([["t1", [{ taskId: "t1", resourceId: "ghost-r", units: 1 }]]]),
    };
    // `nameOf` itself is what falls back to the id string for an unknown counterpart — the model
    // builder never invents a fallback of its own, it just forwards whatever `nameOf` answers —
    // so the fixture wires a `nameOf` that mirrors that fallback.
    const links = buildLinksModel(task(), view, (id) => (id === "ghost" ? "Ghost" : String(id)));
    expect(links).toEqual([{ direction: "in", name: "Ghost", type: "FF" }]);
    const assignments = buildAssignmentsModel(task(), view);
    expect(assignments).toEqual([{ name: "ghost-r", units: 1 }]);
  });
});

/* ------------------------------------------------------------------ *
 * `resolveSelected` / `mountCustomFields` / `updateCustomFields`
 * ------------------------------------------------------------------ */

describe("resolveSelected", () => {
  it("resolves in selection order, dropping ids the store no longer knows", () => {
    const byId = new Map<TaskId, Task>([
      ["a", task({ id: "a", name: "A" })],
      ["b", task({ id: "b", name: "B" })],
    ]);
    const resolved = resolveSelected(new Set(["b", "a", "ghost"]), (id) => byId.get(id));
    expect(resolved.map((t) => t.id)).toEqual(["b", "a"]);
  });
});

describe("mountCustomFields / updateCustomFields", () => {
  function contribution(
    id: string,
    opts: { throwOnMount?: boolean; throwOnUpdate?: boolean; noHandle?: boolean } = {},
  ): { c: SidePanelFieldContribution; updates: (readonly Task[])[] } {
    const updates: (readonly Task[])[] = [];
    return {
      updates,
      c: {
        id,
        mount(host): SidePanelFieldHandle | void {
          if (opts.throwOnMount === true) throw new Error(`mount ${id} boom`);
          host.setAttribute("data-mounted", id);
          if (opts.noHandle === true) return;
          return {
            update: (tasks) => {
              if (opts.throwOnUpdate === true) throw new Error(`update ${id} boom`);
              updates.push(tasks);
            },
          };
        },
      },
    };
  }

  it("mounts each contribution once, in order, with a `data-field-id` on its host", () => {
    const into = document.createElement("div");
    const a = contribution("a");
    const b = contribution("b");
    const faults: unknown[] = [];
    const live = mountCustomFields(document, into, [a.c, b.c], (e) => faults.push(e));
    expect(live).toHaveLength(2);
    const hosts = Array.from(into.querySelectorAll<HTMLElement>(".sg-side-panel-field--custom"));
    expect(hosts.map((h) => h.getAttribute("data-field-id"))).toEqual(["a", "b"]);
    expect(hosts.map((h) => h.getAttribute("data-mounted"))).toEqual(["a", "b"]);
    expect(faults).toEqual([]);
  });

  it("a throwing mount is reported and does not stop the remaining contributions from mounting", () => {
    const into = document.createElement("div");
    const bad = contribution("bad", { throwOnMount: true });
    const good = contribution("good");
    const faults: unknown[] = [];
    const live = mountCustomFields(document, into, [bad.c, good.c], (e) => faults.push(e));
    expect(faults).toHaveLength(1);
    expect(live).toHaveLength(1); // only "good" acquired a handle
    expect(into.querySelectorAll(".sg-side-panel-field--custom")).toHaveLength(2);
  });

  it("a non-object / handle-less return counts as no handle", () => {
    const into = document.createElement("div");
    const none = contribution("none", { noHandle: true });
    const live = mountCustomFields(document, into, [none.c], () => {});
    expect(live).toHaveLength(0);
  });

  it("updates every live handle in order with the resolved selection, and skips a dead one", () => {
    const a = contribution("a");
    const b = contribution("b", { throwOnUpdate: true });
    const into = document.createElement("div");
    const live = mountCustomFields(document, into, [a.c, b.c], () => {});
    const byId = new Map<TaskId, Task>([["t1", task()]]);
    const faults: unknown[] = [];
    updateCustomFields(live as LiveField[], new Set(["t1"]), (id) => byId.get(id), (e) => faults.push(e));
    expect(a.updates).toEqual([[task()]]);
    expect(faults).toHaveLength(1);
    // The dead handle from the first (throwing) update is skipped on the next round.
    updateCustomFields(live as LiveField[], new Set(["t1"]), (id) => byId.get(id), (e) => faults.push(e));
    expect(a.updates).toHaveLength(2);
    expect(faults).toHaveLength(1); // no new fault: "b" is latched off
  });

  it("does not touch the store at all while nothing is mounted", () => {
    let asked = false;
    updateCustomFields([], new Set(["t1"]), () => {
      asked = true;
      return undefined;
    }, () => {});
    expect(asked).toBe(false);
  });
});
