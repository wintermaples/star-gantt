// @vitest-environment happy-dom
/**
 * `internal/links/inspector.ts` — the §5.7 dependency inspector: hostless mounting behavior against
 * real DOM (`happy-dom`), plus a round trip through a real `@stargantt/core` host, covering an
 * 8-case behavioral suite that `links-wire.test.ts` had previously covered only with a shape
 * assertion.
 *
 * The DOM layout is fixed: `host.children` is `[heading, list, pickerRow, typeRow, lagRow,
 * removeButton]`, each row itself `[label, control]` — so this file's `mountInspector` helper
 * walks it that way, driving real `happy-dom` nodes (every other hostless DOM test in this
 * package — `calendars-editor.test.ts` — drives real elements the same way).
 */
import { afterEach, describe, expect, it } from "vitest";
import { collect, definePlugin } from "@stargantt/core";
import type { AnyPlugin } from "@stargantt/core";
import { createTestHost } from "@stargantt/sdk";
import type { TestHost } from "@stargantt/sdk";
import { dataStore } from "@stargantt/plugin-data-store";
import type { DataService, Link, LinkType, Task, Transaction } from "@stargantt/plugin-data-store";
import type { SidePanelFieldContribution } from "@stargantt/plugin-interaction";
import { scheduling } from "../src/index";
import { makeInspectorContribution } from "../src/internal/links/inspector";
import { resolveMessages } from "../src/internal/messages";
import { DAY } from "./_helpers";
import { stubData, stubTask } from "./links-doubles";

const MESSAGES = resolveMessages(undefined, () => undefined);

/* ------------------------------------------------------------------ *
 * Hostless mounting (§5.7) — `makeInspectorContribution` against real DOM directly
 * ------------------------------------------------------------------ */

let mounts: HTMLElement[] = [];
afterEach(() => {
  for (const m of mounts) m.remove();
  mounts = [];
});

function mount(): HTMLElement {
  const el = document.createElement("div");
  document.body.appendChild(el);
  mounts.push(el);
  return el;
}

function mountInspector(tasks: Task[], links: Link[]) {
  const host = mount();
  const removed: Link[] = [];
  const updated: { link: Link; type: LinkType; lag: number | undefined }[] = [];
  const contribution = makeInspectorContribution({
    messages: MESSAGES,
    data: stubData(tasks, links),
    removeLink: (link) => void removed.push(link),
    updateLink: (link, type, lag) => void updated.push({ link, type, lag }),
    listen: (target, type, fn) => target.addEventListener(type, fn),
  });
  const handle = contribution.mount(host);
  if (handle === undefined) throw new Error("expected a handle");
  // Children: heading, list, picker row, type row, lag row, remove button.
  const control = (index: number): HTMLInputElement | HTMLSelectElement => {
    const row = host.children[index + 2];
    const c = row?.children[1];
    if (c === undefined) throw new Error(`missing control ${String(index)}`);
    return c as HTMLInputElement | HTMLSelectElement;
  };
  return {
    host,
    handle,
    removed,
    updated,
    list: () => host.children[1] as HTMLElement,
    picker: () => control(0) as HTMLSelectElement,
    type: () => control(1) as HTMLSelectElement,
    lag: () => control(2) as HTMLInputElement,
    remove: () => host.children[5] as HTMLButtonElement,
    fireChange: (el: HTMLElement) => el.dispatchEvent(new Event("change", { bubbles: true })),
    fireClick: (el: HTMLElement) => el.dispatchEvent(new Event("click", { bubbles: true })),
  };
}

const A_B_LINK: Link = { id: "ab", sourceId: "a", targetId: "b", type: "FS", lag: DAY };

/**
 * Forces `el.value` to read back `raw` verbatim on the NEXT read, bypassing a real
 * `<input type="number">`'s own value-sanitization algorithm (a non-numeric string assigned
 * through the ordinary `.value` setter is coerced to `""` by both real browsers and `happy-dom` —
 * confirmed empirically — so `.value = "bogus"` alone cannot exercise an unsanitized raw value).
 * The inspector's own change handler only ever reads `.value` once
 * per "change", so a single overridden read is all this needs; the override is removed right after.
 */
function forceRawValue(el: HTMLInputElement, raw: string): void {
  const descriptor = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value");
  Object.defineProperty(el, "value", {
    configurable: true,
    get: () => raw,
    set(v: string) {
      Object.defineProperty(el, "value", descriptor!);
      el.value = v;
    },
  });
}

describe("dependency inspector (§5.7)", () => {
  it("mounts heading, list and one static editor row from the catalog", () => {
    const p = mountInspector([stubTask("a"), stubTask("b")], [A_B_LINK]);
    expect(p.host.children[0]?.textContent).toBe("Dependencies");
    expect(p.host.children).toHaveLength(6);
    expect(p.remove().textContent).toBe("Remove");
    // Nothing selected yet: the list shows the none placeholder, controls are disabled.
    expect(p.list().textContent).toBe("None");
    expect(p.type().disabled).toBe(true);
  });

  // Minor fix (P4 review ruling) — each row's `<label>` is now paired to its control via `for`/`id`
  // (WCAG 1.3.1 / 4.1.2: a bare `textContent` label announces nothing to a screen reader and does
  // not extend the click target onto the control it visually labels).
  it("pairs each row's label to its control via for/id", () => {
    const p = mountInspector([stubTask("a"), stubTask("b")], [A_B_LINK]);
    for (const control of [p.picker(), p.type(), p.lag()]) {
      const id = control.id;
      expect(id).not.toBe("");
      const label = p.host.querySelector(`label[for="${id}"]`);
      expect(label).not.toBeNull();
      expect(label?.parentElement).toBe(control.parentElement);
    }
    // Two independently mounted sections (two chart instances on one page) never collide.
    const q = mountInspector([stubTask("a"), stubTask("b")], [A_B_LINK]);
    expect(q.picker().id).not.toBe(p.picker().id);
  });

  it("lists predecessors then successors with type and lag in days", () => {
    const links: Link[] = [A_B_LINK, { id: "bc", sourceId: "b", targetId: "c", type: "SS" }];
    const p = mountInspector([stubTask("a"), stubTask("b"), stubTask("c")], links);
    p.handle.update([stubTask("b")]);
    const lines = [...p.list().children].map((c) => c.textContent);
    expect(lines).toEqual(["← a (FS, +1d)", "→ c (SS)"]);
    // The picker mirrors the list and the editor shows the first link's values.
    expect(p.picker().children).toHaveLength(2);
    expect(p.type().value).toBe("FS");
    expect(p.lag().value).toBe("1");
  });

  it("stands down for empty and multiple selections", () => {
    const p = mountInspector([stubTask("a"), stubTask("b")], [A_B_LINK]);
    p.handle.update([stubTask("a"), stubTask("b")]);
    expect(p.list().textContent).toBe("None");
    expect(p.remove().disabled).toBe(true);
  });

  it("retypes, re-lags and removes the picked link", () => {
    const p = mountInspector([stubTask("a"), stubTask("b")], [A_B_LINK]);
    p.handle.update([stubTask("b")]);

    p.type().value = "SS";
    p.fireChange(p.type());
    expect(p.updated).toEqual([{ link: A_B_LINK, type: "SS", lag: DAY }]);

    p.lag().value = "2";
    p.fireChange(p.lag());
    expect(p.updated[1]).toEqual({ link: A_B_LINK, type: "FS", lag: 2 * DAY });

    p.lag().value = "0";
    p.fireChange(p.lag());
    expect(p.updated[2]).toEqual({ link: A_B_LINK, type: "FS", lag: undefined });

    p.fireClick(p.remove());
    expect(p.removed).toEqual([A_B_LINK]);
  });

  it("resets an unparsable lag instead of committing", () => {
    const p = mountInspector([stubTask("a"), stubTask("b")], [A_B_LINK]);
    p.handle.update([stubTask("b")]);
    forceRawValue(p.lag(), "bogus");
    p.fireChange(p.lag());
    expect(p.updated).toEqual([]);
    expect(p.lag().value).toBe("1");
  });
});

/* ------------------------------------------------------------------ *
 * Inspector wired through a real host, under `inspector: true` (§5.7)
 * ------------------------------------------------------------------ */

let booted: TestHost | undefined;
afterEach(() => {
  booted?.dispose();
  booted = undefined;
});

/** A probe plugin that defines `sidepanel/fields` (`collect`) so a test can read back what landed. */
function sidePanelProbe(sink: { fields?: () => SidePanelFieldContribution[] }): AnyPlugin {
  return definePlugin<void>({
    meta: { id: "test.side-panel" },
    setup(ctx) {
      const point = ctx.defineExtensionPoint(
        "sidepanel/fields",
        collect<SidePanelFieldContribution>(),
      );
      sink.fields = () => point.get();
    },
  });
}

describe("inspector wired through the booted stack (§5.7)", () => {
  it("contributes only under inspector: true and edits through the command bus", () => {
    const sink: { fields?: () => SidePanelFieldContribution[] } = {};
    booted = createTestHost({ plugins: [dataStore(), scheduling({ dependencies: { inspector: true } }), sidePanelProbe(sink)] });
    const data = booted.host.service("stargantt.data") as DataService;
    data.load({
      tasks: [
        { id: "t0", name: "t0", start: 0, end: DAY },
        { id: "t1", name: "t1", start: DAY, end: 2 * DAY },
      ],
      links: [{ id: "l0", sourceId: "t0", targetId: "t1", type: "FS" }],
    });
    const contributions = sink.fields!();
    expect(contributions).toHaveLength(1);

    const host = document.createElement("div");
    mounts.push(host);
    const handle = contributions[0]!.mount(host);
    if (handle === undefined) throw new Error("expected a handle");
    const t1 = data.getTask("t1");
    expect(t1).toBeDefined();
    handle.update([t1 as Task]);

    // Retype through the editor: the store's link keeps its id but changes type.
    const typeSelect = host.children[3]?.children[1] as HTMLSelectElement;
    typeSelect.value = "SS";
    typeSelect.dispatchEvent(new Event("change", { bubbles: true }));
    const links = [...data.links.get().values()];
    expect(links).toHaveLength(1);
    expect(links[0]).toMatchObject({ id: "l0", sourceId: "t0", targetId: "t1", type: "SS" });
  });

  // docs/specs/plugins/scheduling.md §5.7 — one user-visible commit, one transaction, one undo
  // step: the retype+re-lag pair is one `link/update` command, not a remove+add pair.
  it("retypes and re-lags as one transaction each", () => {
    const sink: { fields?: () => SidePanelFieldContribution[] } = {};
    booted = createTestHost({ plugins: [dataStore(), scheduling({ dependencies: { inspector: true } }), sidePanelProbe(sink)] });
    const data = booted.host.service("stargantt.data") as DataService;
    data.load({
      tasks: [
        { id: "t0", name: "t0", start: 0, end: DAY },
        { id: "t1", name: "t1", start: DAY, end: 2 * DAY },
      ],
      links: [{ id: "l0", sourceId: "t0", targetId: "t1", type: "FS", lag: DAY }],
    });
    const transactions: Transaction[] = [];
    booted.host.on("data/didApplyTransaction", (e) => transactions.push(e.transaction));

    const host = document.createElement("div");
    mounts.push(host);
    const handle = sink.fields!()[0]!.mount(host);
    if (handle === undefined) throw new Error("expected a handle");
    handle.update([data.getTask("t1") as Task]);

    const typeSelect = host.children[3]?.children[1] as HTMLSelectElement;
    typeSelect.value = "FF";
    typeSelect.dispatchEvent(new Event("change", { bubbles: true }));
    expect(transactions).toHaveLength(1);
    expect(transactions[0]?.patches).toHaveLength(1);
    expect([...data.links.get().values()][0]).toEqual({
      id: "l0",
      sourceId: "t0",
      targetId: "t1",
      type: "FF",
      lag: DAY,
    });

    // Re-lagging to zero is the same single-transaction path and drops the lag entirely.
    handle.update([data.getTask("t1") as Task]);
    const lagInput = host.children[4]?.children[1] as HTMLInputElement;
    lagInput.value = "0";
    lagInput.dispatchEvent(new Event("change", { bubbles: true }));
    expect(transactions).toHaveLength(2);
    expect([...data.links.get().values()][0]).toEqual({
      id: "l0",
      sourceId: "t0",
      targetId: "t1",
      type: "FF",
    });
  });

  it("contributes nothing by default", () => {
    const sink: { fields?: () => SidePanelFieldContribution[] } = {};
    booted = createTestHost({ plugins: [dataStore(), scheduling(), sidePanelProbe(sink)] });
    expect(sink.fields!()).toHaveLength(0);
  });
});
