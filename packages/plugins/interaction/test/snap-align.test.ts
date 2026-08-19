/**
 * Task-edge alignment arithmetic (docs/specs/plugins/interaction.md §6.3 `alignToTasks`) — the
 * sorted edge set and the tolerance lookup, both pure and host-free.
 *
 * ("taskEdges / nearestEdge (pure, §3.7)"); only the import path moved.
 */
import { describe, expect, it } from "vitest";
import { nearestEdge, taskEdges } from "../src/internal/snap/align";

describe("taskEdges / nearestEdge", () => {
  const edges = taskEdges([
    { start: 100, end: 300 },
    { start: 300, end: Number.NaN }, // duplicate start deduped, NaN dropped
    { start: 500, end: 700 },
  ]);

  it("builds a sorted, deduplicated, finite edge set", () => {
    expect(edges).toEqual([100, 300, 500, 700]);
  });

  it("finds the nearest edge within tolerance", () => {
    expect(nearestEdge(edges, 290, 20)).toBe(300);
    expect(nearestEdge(edges, 310, 20)).toBe(300);
  });

  it("returns undefined when no edge is in tolerance", () => {
    expect(nearestEdge(edges, 400, 20)).toBeUndefined();
    expect(nearestEdge([], 100, 20)).toBeUndefined();
  });

  it("resolves an exact tie to the later edge", () => {
    expect(nearestEdge(edges, 400, 200)).toBe(500);
  });

  it("rejects a non-finite instant", () => {
    expect(nearestEdge(edges, Number.NaN, 1_000)).toBeUndefined();
    expect(nearestEdge(edges, Number.POSITIVE_INFINITY, 1_000)).toBeUndefined();
  });

  it("rejects an unusable tolerance", () => {
    expect(nearestEdge(edges, 300, Number.NaN)).toBeUndefined();
    expect(nearestEdge(edges, 300, -1)).toBeUndefined();
  });

  it("accepts a zero tolerance, matching only an exact edge", () => {
    expect(nearestEdge(edges, 300, 0)).toBe(300);
    expect(nearestEdge(edges, 301, 0)).toBeUndefined();
  });
});
