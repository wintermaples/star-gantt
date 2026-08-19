// docs/specs/plugins/scheduling.md §2.8 — the topological-order memo.
import { describe, expect, it } from "vitest";
import { TopoCache } from "../src/engine/topo-cache";
import { DAY, link, task, view } from "./_helpers";

describe("TopoCache", () => {
  it("returns the identical memoized order until invalidated", () => {
    const v = view([task("a", 0, DAY), task("b", 0, DAY)], [link("l1", "a", "b")]);
    const cache = new TopoCache();
    const nodes = new Set<string | number>(["a", "b"]);
    const first = cache.order(v, nodes, true);
    expect(first).toEqual(["a", "b"]);
    expect(cache.order(v, nodes, true)).toBe(first);
    cache.invalidate();
    const recomputed = cache.order(v, nodes, true);
    expect(recomputed).toEqual(first);
    expect(recomputed).not.toBe(first);
  });

  it("keys the hierarchy flag and id types apart", () => {
    const v = view([task("a", 0, DAY), task(1, 0, DAY), task("1", 0, DAY)]);
    const cache = new TopoCache();
    const withHierarchy = cache.order(v, new Set(["a"]), true);
    const withoutHierarchy = cache.order(v, new Set(["a"]), false);
    expect(withHierarchy).not.toBe(withoutHierarchy);
    // The numeric id 1 and the string id "1" must not share an entry.
    expect(cache.order(v, new Set([1]), false)).toEqual([1]);
    expect(cache.order(v, new Set(["1"]), false)).toEqual(["1"]);
  });

  it("evicts the oldest entry once the bound is reached, keeping the newer ones", () => {
    const ids = Array.from({ length: 70 }, (_, i) => `t${String(i)}`);
    const v = view(ids.map((id) => task(id, 0, DAY)));
    const cache = new TopoCache();
    const first = cache.order(v, new Set(["t0"]), false);
    // Fill past the 64-entry bound with distinct single-node keys.
    for (let i = 1; i < 70; i += 1) cache.order(v, new Set([`t${String(i)}`]), false);
    // The oldest entry was evicted: the same query recomputes (fresh array, equal value)…
    const again = cache.order(v, new Set(["t0"]), false);
    expect(again).not.toBe(first);
    expect(again).toEqual(first);
    // …while a recent entry is still the memoized array itself.
    const recent = cache.order(v, new Set(["t69"]), false);
    expect(cache.order(v, new Set(["t69"]), false)).toBe(recent);
  });
});
