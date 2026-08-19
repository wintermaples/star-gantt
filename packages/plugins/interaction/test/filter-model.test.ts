/**
 * `FilterModel` — matching semantics, ancestor-keeping visibility, named views, and the latched
 * predicate/field-value fault barriers. Driven directly against the pure model instead of a
 * booted host (hostless decomposition — the grid/row-height side of this behavior is covered at
 * the wiring level in `filter-wire.test.ts`).
 */
import { describe, expect, it } from "vitest";
import type { Task } from "@stargantt/plugin-data-store";
import { FilterModel } from "../src/internal/filter/model";
import { SearchIndex } from "../src/internal/filter/search-index";
import { filterDataView, filterSampleData } from "./_filter-fakes";
import type { FilterFieldDef } from "../src/internal/filter/types";

const DAY = 86_400_000;

function builtInFields(dataView: ReturnType<typeof filterDataView>): Map<string, FilterFieldDef> {
  const fields: FilterFieldDef[] = [
    {
      id: "resource",
      label: "Resource",
      value: (task) => {
        const assignments = dataView.assignmentsByTask.get(task.id);
        if (assignments === undefined) return [];
        return assignments
          .map((a) => dataView.resources.get(a.resourceId)?.name)
          .filter((n): n is string => n !== undefined);
      },
    },
    { id: "type", label: "Type", value: (task) => task.type ?? "task" },
  ];
  return new Map(fields.map((f) => [f.id, f]));
}

/** A model over `filterSampleData()`, with a mutable underlying view for data-change tests. */
function harness(): {
  model: FilterModel;
  index: SearchIndex;
  faults: { where: string; error: unknown }[];
  setTasks(tasks: readonly Task[]): void;
} {
  let data = filterDataView(filterSampleData());
  const view = (): ReturnType<typeof filterDataView> => data;
  const index = new SearchIndex(view);
  const faults: { where: string; error: unknown }[] = [];
  const model = new FilterModel(view, index, builtInFields(data), (where, error) =>
    faults.push({ where, error }),
  );
  return {
    model,
    index,
    faults,
    setTasks(tasks) {
      data = filterDataView({ ...filterSampleData(), tasks: [...tasks] });
      index.invalidate();
      model.invalidate();
    },
  };
}

describe("row filtering (matching semantics)", () => {
  it("is inert by default: every task is visible and matchCount is the total", () => {
    const { model } = harness();
    expect(model.isActive()).toBe(false);
    for (const id of ["a", "a1", "a2", "b", "b1", "b2"]) {
      expect(model.isVisible(id)).toBe(true);
    }
    expect(model.matchCount()).toBe(6);
  });

  it("keeps ancestors of matches visible, hides the rest", () => {
    const { model } = harness();
    model.setQuery("wireframes");
    expect(model.isActive()).toBe(true);
    expect(model.matchCount()).toBe(1);
    expect(model.isVisible("a1")).toBe(true);
    expect(model.isVisible("a")).toBe(true); // ancestor kept for context
    expect(model.isVisible("a2")).toBe(false);
    expect(model.isVisible("b")).toBe(false);
    expect(model.isVisible("b1")).toBe(false);
    expect(model.isVisible("b2")).toBe(false);
  });

  it("restores every row after query + criteria are cleared", () => {
    const { model } = harness();
    model.setQuery("wireframes");
    model.setQuery("");
    model.setCriteria(null);
    expect(model.isActive()).toBe(false);
    expect(model.matchCount()).toBe(6);
  });

  it("searches resource names and tags through the index", () => {
    const { model } = harness();
    model.setQuery("alice");
    expect(model.matchCount()).toBe(2); // a1, b2
    expect(model.isVisible("a1")).toBe(true);
    expect(model.isVisible("b2")).toBe(true);
    expect(model.isVisible("b1")).toBe(false);
    model.setQuery("ux");
    expect(model.matchCount()).toBe(2); // tags on a1 and b2
  });

  it("filters by resource criteria", () => {
    const { model } = harness();
    model.setCriteria({ resources: ["r2"] });
    expect(model.matchCount()).toBe(1); // b1
    expect(model.isVisible("b1")).toBe(true);
    expect(model.isVisible("b")).toBe(true); // ancestor
    expect(model.isVisible("a1")).toBe(false);
  });

  it("filters by type, progress range and date range", () => {
    const { model } = harness();
    model.setCriteria({ types: ["summary"] });
    expect(model.matchCount()).toBe(2); // a, b

    model.setCriteria({ progressMin: 0.3, progressMax: 0.9 });
    expect(model.matchCount()).toBe(1); // a2 (0.4); a1 is 1, others 0/absent

    model.setCriteria({ startFrom: 10 * DAY });
    expect(model.matchCount()).toBe(3); // b, b1, b2
  });

  it("combines query and criteria with AND", () => {
    const { model } = harness();
    model.setQuery("phase");
    model.setCriteria({ types: ["summary"] });
    expect(model.matchCount()).toBe(2); // both phases are summaries
    model.setQuery("build");
    expect(model.matchCount()).toBe(1);
  });

  it("treats criteria with no usable member as inactive", () => {
    const { model } = harness();
    model.setCriteria({});
    expect(model.isActive()).toBe(false);
    model.setCriteria({ resources: [], fields: { resource: [] } });
    expect(model.isActive()).toBe(false);
    expect(model.matchCount()).toBe(6);
  });

  it("applies a custom predicate and latches it off after a throw", () => {
    const { model, faults } = harness();
    model.setCriteria({ predicate: (t: Readonly<Task>) => t.id === "b2" });
    expect(model.matchCount()).toBe(1);

    model.setCriteria({
      predicate: () => {
        throw new Error("boom");
      },
    });
    // The throwing predicate is reported once and then dropped: all tasks match.
    expect(model.matchCount()).toBe(6);
    expect(faults.filter((f) => f.where === "criteria.predicate")).toHaveLength(1);

    // Latched: a second recompute with the same throwing predicate reports nothing further.
    model.setCriteria({
      predicate: () => {
        throw new Error("boom again");
      },
    });
    model.matchCount();
    expect(faults.filter((f) => f.where === "criteria.predicate")).toHaveLength(1);
  });

  it("recomputes after a data change", () => {
    const { model, setTasks } = harness();
    model.setQuery("wireframes");
    expect(model.matchCount()).toBe(1);
    const tasks = filterSampleData().tasks.map((t) =>
      t.id === "b1" ? { ...t, name: "API wireframes" } : t,
    );
    setTasks(tasks);
    expect(model.matchCount()).toBe(2);
    expect(model.isVisible("b1")).toBe(true);
  });

  it("applies a query set before the underlying view carries any tasks", () => {
    const { model, setTasks } = harness();
    setTasks([]);
    model.setQuery("wireframes");
    // Against the still-empty view, nothing can match yet.
    expect(model.matchCount()).toBe(0);

    setTasks(filterSampleData().tasks);
    expect(model.isActive()).toBe(true);
    expect(model.matchCount()).toBe(1);
    expect(model.isVisible("a1")).toBe(true);
    expect(model.isVisible("b1")).toBe(false);
  });

  it("matches field selections against the built-in resource field, ignoring unknown keys", () => {
    const { model } = harness();
    model.setCriteria({ fields: { resource: ["Bob"] } });
    expect(model.matchCount()).toBe(1); // b1
    // A selection keyed to no composed field is ignored, not treated as match-nothing.
    model.setCriteria({ fields: { nonsense: ["x"] } });
    expect(model.matchCount()).toBe(6);
  });

  it("latches a throwing field value function per field, after a single report", () => {
    let calls = 0;
    const faults: { where: string; error: unknown }[] = [];
    const data = filterDataView(filterSampleData());
    const index = new SearchIndex(() => data);
    const fields = new Map<string, FilterFieldDef>([
      [
        "boom",
        {
          id: "boom",
          label: "Boom",
          value: () => {
            calls += 1;
            throw new Error("nope");
          },
        },
      ],
    ]);
    const model = new FilterModel(
      () => data,
      index,
      fields,
      (where, error) => faults.push({ where, error }),
    );
    model.setCriteria({ fields: { boom: ["x"] } });
    model.matchCount();
    expect(faults.filter((f) => f.where === "fields.boom.value")).toHaveLength(1);
    expect(calls).toBeGreaterThan(0);
    const callsAfterFirstFault = calls;
    model.invalidate();
    model.matchCount();
    // Latched: the value function is never called again once faulted.
    expect(calls).toBe(callsAfterFirstFault);
  });
});

describe("hasFilterInputs", () => {
  it("is true for a non-empty query or usable criteria, independent of the data view", () => {
    const { model } = harness();
    expect(model.hasFilterInputs()).toBe(false);
    model.setQuery("  ");
    expect(model.hasFilterInputs()).toBe(false); // whitespace-only counts as empty
    model.setQuery("x");
    expect(model.hasFilterInputs()).toBe(true);
    model.setQuery("");
    model.setCriteria({ types: ["summary"] });
    expect(model.hasFilterInputs()).toBe(true);
    model.setCriteria({ types: [] });
    expect(model.hasFilterInputs()).toBe(false);
  });
});

describe("named views", () => {
  it("saves, lists, applies and deletes views", () => {
    const { model } = harness();
    model.setQuery("phase");
    model.setCriteria({ types: ["summary"] });
    model.saveView("summaries");
    model.setQuery("");
    model.setCriteria(null);
    expect(model.isActive()).toBe(false);

    expect(model.viewNames()).toEqual(["summaries"]);
    expect(model.applyView("summaries")).toBe(true);
    expect(model.query()).toBe("phase");
    expect(model.criteria()).toEqual({ types: ["summary"] });
    expect(model.matchCount()).toBe(2);

    expect(model.deleteView("summaries")).toBe(true);
    expect(model.viewNames()).toEqual([]);
    expect(model.deleteView("summaries")).toBe(false);
  });

  it("returns false for an unknown view without touching the state", () => {
    const { model } = harness();
    model.setQuery("alice");
    expect(model.applyView("missing")).toBe(false);
    expect(model.query()).toBe("alice");
  });

  it("seeds initial views and skips unusable entries", () => {
    const { model } = harness();
    model.seedViews({
      bob: { criteria: { resources: ["r2"] } },
      junk: null as never,
      "": { query: "x" },
    });
    expect(model.viewNames()).toEqual(["bob"]);
    expect(model.applyView("bob")).toBe(true);
    expect(model.matchCount()).toBe(1);
  });

  it("replaces a same-named view on save", () => {
    const { model } = harness();
    model.setQuery("one");
    model.saveView("v");
    model.setQuery("two");
    model.saveView("v");
    model.setQuery("");
    model.applyView("v");
    expect(model.query()).toBe("two");
    expect(model.viewNames()).toEqual(["v"]);
  });

  it("snapshots criteria at save time: a later mutation does not affect the saved view", () => {
    const { model } = harness();
    const resources = ["r2"];
    model.setCriteria({ resources });
    model.saveView("v");

    resources.push("r1");
    model.setCriteria({ resources: ["r1"] });

    expect(model.applyView("v")).toBe(true);
    expect(model.criteria()).toEqual({ resources: ["r2"] });
    expect(model.matchCount()).toBe(1); // b1 only, not widened by the later mutation
  });

  it("silently ignores an unusable save name", () => {
    const { model } = harness();
    model.saveView("");
    model.saveView(42 as never);
    expect(model.viewNames()).toEqual([]);
  });
});
