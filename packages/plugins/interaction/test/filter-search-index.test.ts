/**
 * `SearchIndex` — bigram search over task names, resource names and tags.
 */
import { describe, expect, it } from "vitest";
import type { Task } from "@stargantt/plugin-data-store";
import { SearchIndex, queryTerms, tagStrings } from "../src/internal/filter/search-index";
import { filterDataView } from "./_filter-fakes";

function view(
  tasks: Partial<Task>[],
  resources: { id: string; name: string }[] = [],
  assignments: { taskId: string; resourceId: string; units: number }[] = [],
): ReturnType<typeof filterDataView> {
  const full = tasks.map(
    (t, i) => ({ id: String(t.id ?? i), parentId: null, name: "", start: 0, end: 1, ...t }) as Task,
  );
  return filterDataView({ tasks: full, resources, assignments });
}

describe("queryTerms", () => {
  it("splits on whitespace, lowercases, and drops empties", () => {
    expect(queryTerms("  Foo   BAR\tbaz ")).toEqual(["foo", "bar", "baz"]);
    expect(queryTerms("   ")).toEqual([]);
  });
});

describe("tagStrings", () => {
  it("reads string arrays, single strings, and tolerates junk", () => {
    expect(tagStrings({ tags: ["a", "b"] })).toEqual(["a", "b"]);
    expect(tagStrings({ tags: "solo" })).toEqual(["solo"]);
    expect(tagStrings({ tags: [1, "ok", null] })).toEqual(["ok"]);
    expect(tagStrings({ tags: 42 })).toEqual([]);
    expect(tagStrings(undefined)).toEqual([]);
  });
});

describe("SearchIndex", () => {
  it("matches task names as case-insensitive substrings", () => {
    const index = new SearchIndex(() =>
      view([
        { id: "1", name: "Design phase" },
        { id: "2", name: "Build phase" },
      ]),
    );
    expect(index.search(["design"])).toEqual(new Set(["1"]));
    expect(index.search(["PHASE"])).toEqual(new Set(["1", "2"]));
    expect(index.search(["esign"])).toEqual(new Set(["1"])); // mid-word substring
    expect(index.search(["nothing"])).toEqual(new Set());
  });

  it("requires every term (AND)", () => {
    const index = new SearchIndex(() =>
      view([
        { id: "1", name: "Design phase" },
        { id: "2", name: "Design review" },
      ]),
    );
    expect(index.search(["design", "review"])).toEqual(new Set(["2"]));
  });

  it("indexes assigned resource names and meta tags", () => {
    const index = new SearchIndex(() =>
      view(
        [
          { id: "1", name: "API" },
          { id: "2", name: "Client", meta: { tags: ["frontend"] } },
        ],
        [{ id: "r1", name: "Alice" }],
        [{ taskId: "1", resourceId: "r1", units: 1 }],
      ),
    );
    expect(index.search(["alice"])).toEqual(new Set(["1"]));
    expect(index.search(["frontend"])).toEqual(new Set(["2"]));
  });

  it("matches CJK text without word segmentation", () => {
    const index = new SearchIndex(() =>
      view([
        { id: "1", name: "設計フェーズ" },
        { id: "2", name: "実装フェーズ" },
      ]),
    );
    expect(index.search(["設計"])).toEqual(new Set(["1"]));
    expect(index.search(["フェーズ"])).toEqual(new Set(["1", "2"]));
  });

  it("answers single-character terms by scan", () => {
    const index = new SearchIndex(() =>
      view([
        { id: "1", name: "abc" },
        { id: "2", name: "xyz" },
      ]),
    );
    expect(index.search(["x"])).toEqual(new Set(["2"]));
  });

  it("returns every task for an empty term list", () => {
    const index = new SearchIndex(() => view([{ id: "1" }, { id: "2" }]));
    expect(index.search([]).size).toBe(2);
  });

  it("rebuilds only after invalidate()", () => {
    let tasks: Partial<Task>[] = [{ id: "1", name: "old" }];
    const index = new SearchIndex(() => view(tasks));
    expect(index.search(["old"])).toEqual(new Set(["1"]));
    tasks = [{ id: "1", name: "new" }];
    // Stale until invalidated — the rebuild is lazy.
    expect(index.search(["new"])).toEqual(new Set());
    index.invalidate();
    expect(index.search(["new"])).toEqual(new Set(["1"]));
    expect(index.search(["old"])).toEqual(new Set());
  });

  // Behavioral check for the smallest-candidate-set seed: a one-character first term matches
  // almost every task on its own, but AND-ing in a rare second term must still narrow correctly
  // to the task(s) satisfying both — proving the scan didn't silently drop the rare term's rows
  // when it seeded from the cheaper set instead of the first one.
  it("still matches correctly when the first term is single-character and the second is rare", () => {
    const index = new SearchIndex(() =>
      view([
        { id: "1", name: "a design phase" },
        { id: "2", name: "a build phase" },
        { id: "3", name: "a review phase" },
      ]),
    );
    expect(index.search(["a", "design"])).toEqual(new Set(["1"]));
    expect(index.search(["a", "review"])).toEqual(new Set(["3"]));
    expect(index.search(["a", "nonexistent"])).toEqual(new Set());
  });
});
