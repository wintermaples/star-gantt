/** Hostless unit tests for the measureText cache (contract §6.6). */
import { describe, expect, it } from "vitest";
import { createTextMeasureCache } from "../../src/internal/render/text";
import type { TextMeasurer } from "../../src/internal/render/text";

function measurer(): TextMeasurer & { calls: string[] } {
  const calls: string[] = [];
  return {
    font: "12px sans-serif",
    calls,
    measureText(text: string) {
      calls.push(text);
      return { width: text.length * 7 };
    },
  };
}

describe("createTextMeasureCache", () => {
  it("measures a font+string pair once and serves repeats from the cache", () => {
    const cache = createTextMeasureCache();
    const g = measurer();
    expect(cache.width(g, "Task A")).toBe(42);
    expect(cache.width(g, "Task A")).toBe(42);
    expect(cache.width(g, "Task A")).toBe(42);
    expect(g.calls).toEqual(["Task A"]);
  });

  it("keys on the font, so a font change re-measures", () => {
    const cache = createTextMeasureCache();
    const g = measurer();
    cache.width(g, "Task A");
    g.font = "14px sans-serif";
    cache.width(g, "Task A");
    expect(g.calls).toEqual(["Task A", "Task A"]);
  });

  it("evicts the least recently used entry at capacity", () => {
    const cache = createTextMeasureCache(2);
    const g = measurer();
    cache.width(g, "a");
    cache.width(g, "b");
    cache.width(g, "a"); // refresh "a": "b" is now the LRU entry
    cache.width(g, "c"); // evicts "b"
    expect(cache.size()).toBe(2);
    cache.width(g, "a");
    expect(g.calls).toEqual(["a", "b", "c"]); // "a" stayed cached
    cache.width(g, "b"); // re-measured after eviction
    expect(g.calls).toEqual(["a", "b", "c", "b"]);
  });

  it("clear() drops everything", () => {
    const cache = createTextMeasureCache();
    const g = measurer();
    cache.width(g, "x");
    cache.clear();
    expect(cache.size()).toBe(0);
    cache.width(g, "x");
    expect(g.calls).toEqual(["x", "x"]);
  });
});
