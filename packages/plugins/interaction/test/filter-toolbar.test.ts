// @vitest-environment happy-dom
/**
 * The opt-in search box + filter panel DOM (`internal/filter/toolbar.ts`), exercised directly
 * against a real (happy-dom) host element with a real `FilterModel` underneath — hostless: no
 * `ctx`, no plugin host.
 *
 * The outside-press-closes-the-panel wiring is `wire.ts`'s own resource (not `toolbar.ts`'s), so
 * this harness reproduces that one document-level listener itself, mirroring exactly what
 * `wireFilter` installs, to keep the rest of the panel behavior together.
 */
import { afterEach, describe, expect, it } from "vitest";
import type { Task } from "@stargantt/plugin-data-store";
import type { SlotGrant } from "@stargantt/core";
import { FilterModel } from "../src/internal/filter/model";
import { resolveCorner } from "../src/internal/filter/wire";
import { SearchIndex } from "../src/internal/filter/search-index";
import { createToolbar, slotStyles } from "../src/internal/filter/toolbar";
import type { Toolbar } from "../src/internal/filter/toolbar";
import type { FilterFieldDef } from "../src/internal/filter/types";
import { filterDataView, filterSampleData } from "./_filter-fakes";

// docs/specs/plugins/interaction.md §3 — the corner→CSS mapping, tested as pure data
// so it does not depend on happy-dom's CSSOM validating `calc(var(...))` values for offset
// properties (it does not, in the pinned happy-dom version — see filter-wire.test.ts's header note).
describe("slotStyles", () => {
  it("anchors each corner to its two adjacent safe-area edges, 8px margin", () => {
    expect(slotStyles("top-right")).toEqual({
      top: "calc(var(--sg-safe-top, 0px) + 8px)",
      right: "calc(var(--sg-safe-right, 0px) + 8px)",
    });
    expect(slotStyles("top-left")).toEqual({
      top: "calc(var(--sg-safe-top, 0px) + 8px)",
      left: "calc(var(--sg-safe-left, 0px) + 8px)",
    });
    expect(slotStyles("bottom-right")).toEqual({
      bottom: "calc(var(--sg-safe-bottom, 0px) + 8px)",
      right: "calc(var(--sg-safe-right, 0px) + 8px)",
    });
    expect(slotStyles("bottom-left")).toEqual({
      bottom: "calc(var(--sg-safe-bottom, 0px) + 8px)",
      left: "calc(var(--sg-safe-left, 0px) + 8px)",
    });
  });
});

describe("resolveCorner", () => {
  it("uses the requested corner when granted", () => {
    expect(resolveCorner({ granted: true })).toBe("top-right");
  });

  it("follows a usable alternative when refused", () => {
    const grant: SlotGrant = { granted: false, alternative: "bottom-left" };
    expect(resolveCorner(grant)).toBe("bottom-left");
  });

  it("falls back to top-right when refused with no usable alternative", () => {
    expect(resolveCorner({ granted: false })).toBe("top-right");
    expect(resolveCorner({ granted: false, alternative: "not-a-corner" })).toBe("top-right");
  });
});

const MESSAGES = {
  searchPlaceholder: "Search tasks",
  searchLabel: "Search tasks",
  filterButton: "Filter",
  filterPanelLabel: "Filters",
  clearFilters: "Clear filters",
  matchCount: (count: number) => `${count} matches`,
};

function builtInFields(view: ReturnType<typeof filterDataView>): FilterFieldDef[] {
  return [
    {
      id: "resource",
      label: "Resource",
      value: (task) => {
        const assignments = view.assignmentsByTask.get(task.id);
        if (assignments === undefined) return [];
        return assignments
          .map((a) => view.resources.get(a.resourceId)?.name)
          .filter((n): n is string => n !== undefined);
      },
    },
    { id: "type", label: "Type", value: (task) => task.type ?? "task" },
  ];
}

interface Harness {
  host: HTMLElement;
  toolbar: Toolbar;
  model: FilterModel;
  dispose(): void;
}

function harness(
  opts: {
    searchBox?: boolean;
    filterPanel?: boolean;
    fields?: FilterFieldDef[];
    messages?: Partial<typeof MESSAGES>;
  } = {},
): Harness {
  const host = document.createElement("div");
  document.body.appendChild(host);
  const view = filterDataView(filterSampleData());
  const index = new SearchIndex(() => view);
  const fields = opts.fields ?? builtInFields(view);
  const fieldsById = new Map(fields.map((f) => [f.id, f]));
  const model = new FilterModel(() => view, index, fieldsById, () => {});
  const messages = { ...MESSAGES, ...opts.messages };

  const toolbar = createToolbar(
    host,
    { searchBox: opts.searchBox ?? false, filterPanel: opts.filterPanel ?? false, fields, messages },
    {
      setQuery(text) {
        model.setQuery(text);
        toolbar.refreshCounter();
      },
      setFieldSelections(selections) {
        const current = model.criteria() ?? {};
        model.setCriteria({ ...current, fields: selections });
        toolbar.refreshCounter();
      },
      fieldValues: (def, task) => model.fieldValues(def, task),
      view: () => view,
      counterText: () => (model.isActive() ? messages.matchCount(model.matchCount()) : ""),
    },
  );
  host.appendChild(toolbar.root);

  // Mirrors `wireFilter`'s own document-level outside-press listener.
  const onDocPointerDown = (event: Event): void => {
    if (!toolbar.contains(event.target)) toolbar.closePanel();
  };
  document.addEventListener("pointerdown", onDocPointerDown);

  return {
    host,
    toolbar,
    model,
    dispose() {
      document.removeEventListener("pointerdown", onDocPointerDown);
      toolbar.root.remove();
      host.remove();
    },
  };
}

let current: Harness | undefined;
afterEach(() => {
  current?.dispose();
  current = undefined;
});

function searchInput(h: Harness): HTMLInputElement {
  const input = h.toolbar.root.querySelector<HTMLInputElement>(".sg-filter-search-input");
  if (input === null) throw new Error("search input missing");
  return input;
}

describe("search box", () => {
  it("mounts no DOM at all by default", () => {
    current = harness();
    expect(current.host.querySelector(".sg-filter-toolbar")).not.toBeNull();
    expect(current.host.querySelector(".sg-filter-search-input")).toBeNull();
    expect(current.host.querySelector(".sg-filter-button")).toBeNull();
  });

  it("mounts into the host when enabled, with placeholder and accessible name", () => {
    current = harness({ searchBox: true });
    const input = searchInput(current);
    expect(input.getAttribute("placeholder")).toBe("Search tasks");
    expect(input.getAttribute("aria-label")).toBe("Search tasks");
    // Not enabled → no filter button.
    expect(current.host.querySelector(".sg-filter-button")).toBeNull();
  });

  it("filters incrementally on input and shows the match counter", () => {
    current = harness({ searchBox: true });
    const input = searchInput(current);
    input.value = "alice";
    input.dispatchEvent(new Event("input"));
    expect(current.model.query()).toBe("alice");
    expect(current.model.isVisible("b1")).toBe(false);
    const counter = current.host.querySelector(".sg-filter-match-count");
    expect(counter?.textContent).toBe("2 matches");
  });

  it("clears the search on Escape", () => {
    current = harness({ searchBox: true });
    const input = searchInput(current);
    input.value = "alice";
    input.dispatchEvent(new Event("input"));
    input.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    expect(input.value).toBe("");
    expect(current.model.isActive()).toBe(false);
  });

  it("uses a replaced matchCount message", () => {
    current = harness({ searchBox: true, messages: { matchCount: (count) => `${count} 件` } });
    const input = searchInput(current);
    input.value = "alice";
    input.dispatchEvent(new Event("input"));
    expect(current.host.querySelector(".sg-filter-match-count")?.textContent).toBe("2 件");
  });
});

describe("filter panel", () => {
  function openPanel(h: Harness): { button: HTMLElement; panel: HTMLElement } {
    const button = h.toolbar.root.querySelector<HTMLElement>(".sg-filter-button");
    if (button === null) throw new Error("filter button missing");
    button.dispatchEvent(new Event("click"));
    const panel = h.toolbar.root.querySelector<HTMLElement>(".sg-filter-panel");
    if (panel === null) throw new Error("filter panel missing");
    return { button, panel };
  }

  it("opens on the button, listing the built-in fields' distinct values", () => {
    current = harness({ filterPanel: true });
    const { button, panel } = openPanel(current);
    expect(button.getAttribute("aria-expanded")).toBe("true");
    expect(panel.style.display).toBe("block");
    const sections = [...panel.querySelectorAll<HTMLElement>(".sg-filter-panel-section")];
    expect(sections.map((s) => s.getAttribute("data-field-id"))).toEqual(["resource", "type"]);
    const resourceValues = [
      ...(sections[0]?.querySelectorAll<HTMLElement>(".sg-filter-panel-value") ?? []),
    ].map((v) => v.textContent);
    expect(resourceValues).toEqual(["Alice", "Bob"]);
    const typeValues = [
      ...(sections[1]?.querySelectorAll<HTMLElement>(".sg-filter-panel-value") ?? []),
    ].map((v) => v.textContent);
    expect(typeValues).toEqual(["summary", "task"]);
  });

  it("filters rows when a value is checked and clears via the clear button", () => {
    current = harness({ filterPanel: true });
    const { panel } = openPanel(current);
    const values = [...panel.querySelectorAll<HTMLElement>(".sg-filter-panel-value")];
    const bob = values[1]; // Alice, Bob sorted
    const box = bob?.querySelector<HTMLInputElement>("input[type=checkbox]");
    if (box === undefined || box === null) throw new Error("checkbox missing");
    box.checked = true;
    box.dispatchEvent(new Event("change"));
    expect(current.model.criteria()?.fields).toEqual({ resource: ["Bob"] });
    expect(current.model.matchCount()).toBe(1);
    expect(current.model.isVisible("b1")).toBe(true);
    expect(current.model.isVisible("a1")).toBe(false);

    const clear = panel.querySelector<HTMLElement>(".sg-filter-clear");
    clear?.dispatchEvent(new Event("click"));
    expect(current.model.criteria()?.fields).toEqual({});
    expect(current.model.isActive()).toBe(false);
  });

  it("closes on an outside pointerdown", () => {
    current = harness({ filterPanel: true });
    const { button, panel } = openPanel(current);
    document.body.dispatchEvent(new Event("pointerdown", { bubbles: true }));
    expect(panel.style.display).toBe("none");
    expect(button.getAttribute("aria-expanded")).toBe("false");
  });

  it("closes on Escape fired at the toolbar root", () => {
    current = harness({ filterPanel: true });
    const { button, panel } = openPanel(current);
    current.toolbar.root.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    expect(panel.style.display).toBe("none");
    expect(button.getAttribute("aria-expanded")).toBe("false");
  });

  // The Filter button, not the panel, has focus in this scenario (e.g. the user tabbed to it
  // after opening the panel with a click) — Escape must still close the panel from there.
  it("closes on Escape while focus is on the Filter button, not inside the panel", () => {
    current = harness({ filterPanel: true });
    const { button, panel } = openPanel(current);
    button.focus();
    current.toolbar.root.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    expect(panel.style.display).toBe("none");
    expect(button.getAttribute("aria-expanded")).toBe("false");
  });

  // Closing while focus is inside the panel (e.g. a checkbox) must not strand focus in a hidden
  // subtree: it moves to the trigger button so keyboard use continues from a known, visible spot.
  it("moves focus to the Filter button when the panel closes while focus is inside it", () => {
    current = harness({ filterPanel: true });
    const { button, panel } = openPanel(current);
    const checkbox = panel.querySelector<HTMLInputElement>(".sg-filter-panel-value input");
    if (checkbox === null) throw new Error("checkbox missing");
    checkbox.focus();
    expect(document.activeElement).toBe(checkbox);

    current.toolbar.root.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    expect(panel.style.display).toBe("none");
    expect(document.activeElement).toBe(button);
  });

  it("lists a configured replacement field instead of the built-ins", () => {
    current = harness({
      filterPanel: true,
      fields: [
        {
          id: "phase",
          label: "Phase",
          value: (t: Readonly<Task>) => (String(t.id).startsWith("a") ? "design" : "build"),
        },
      ],
    });
    const { panel } = openPanel(current);
    const sections = [...panel.querySelectorAll<HTMLElement>(".sg-filter-panel-section")];
    expect(sections.map((s) => s.getAttribute("data-field-id"))).toEqual(["phase"]);
  });

  it("the harness's own dispose() (mirroring wireFilter's cleanup) removes the toolbar's DOM", () => {
    // Review round 1 minor-6 rename: `dispose()` here is this test file's own teardown, hand-mirroring
    // `wireFilter`'s two `ctx.own()` disposers (the document listener + the DOM removal) rather than
    // a lifecycle method on `Toolbar` itself — the previous name ("...on destroy") implied the
    // toolbar owns and exercises its own teardown, and the assertion never verified the document
    // listener was actually gone (only that the DOM was).
    current = harness({ searchBox: true, filterPanel: true });
    const h = current;
    h.dispose();
    current = undefined;
    expect(document.querySelector(".sg-filter-toolbar")).toBeNull();
  });
});
