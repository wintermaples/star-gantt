/**
 * The unified over-allocation epsilon (docs/specs/plugins/resource.md §2.4 / §2.6 item 2).
 *
 * `overallocated = allocated > capacity × threshold + EPS`, EPS = 1e-6 ms — a deliberate unified
 * deviation from load-chart's exact comparison and utilization's 1e-9. The cases below pin the
 * boundary in both directions, that exactly-at-capacity keeps its not-over verdict on every
 * surface, that a zero-capacity cell is over once its allocation exceeds the epsilon at any
 * threshold, and that a 1e-12/2e-12 allocation-vs-capacity case still reads false.
 */
import { describe, expect, it } from "vitest";
import { OVERLOAD_EPSILON, computeUtilization } from "../src/internal/engine/compute";
import { MS_DAY, alwaysWorking, engineResource } from "./_engine";

const MON = Date.UTC(2024, 0, 1);

/** One always-working day whose allocated / capacity the hooks set outright. */
function verdict(allocated: number, capacity: number, threshold?: number): boolean {
  const matrix = computeUtilization({
    resources: [engineResource({ id: "r", workingIntervals: alwaysWorking })],
    demands: new Map(),
    start: MON,
    end: MON + MS_DAY,
    bucket: "day",
    edges: "clamped",
    weekStartDay: 1,
    ...(threshold === undefined ? {} : { threshold }),
    hooks: { resourceLoad: () => allocated, resourceCapacity: () => capacity },
  });
  return matrix.rows[0]!.cells[0]!.overallocated;
}

describe("the 1e-6 ms epsilon (§2.4)", () => {
  it("is exactly 1e-6", () => {
    expect(OVERLOAD_EPSILON).toBe(1e-6);
  });

  it("keeps an exactly-at-capacity cell not over", () => {
    expect(verdict(MS_DAY, MS_DAY)).toBe(false);
  });

  it("reads a cell over by less than the epsilon as not over", () => {
    expect(verdict(MS_DAY + 1e-7, MS_DAY)).toBe(false);
    expect(verdict(MS_DAY + OVERLOAD_EPSILON, MS_DAY)).toBe(false);
  });

  it("reads a cell over by more than the epsilon as over", () => {
    expect(verdict(MS_DAY + 1e-5, MS_DAY)).toBe(true);
    expect(verdict(MS_DAY + 1, MS_DAY)).toBe(true);
  });

  it("clears the measured accumulation-reorder error of §2.6 item 1 by an order of magnitude", () => {
    // ~6e-8 ms is the reported reorder artifact; 1e-6 sits above it, and 1e-9 would not.
    expect(verdict(MS_DAY + 6e-8, MS_DAY)).toBe(false);
    expect(OVERLOAD_EPSILON).toBeGreaterThan(6e-8 * 10);
  });

  it("scales the verdict by the threshold, epsilon and all", () => {
    expect(verdict(2 * MS_DAY, MS_DAY, 2)).toBe(false);
    expect(verdict(2 * MS_DAY + 1, MS_DAY, 2)).toBe(true);
  });

  it("marks a zero-capacity cell over once its allocation exceeds the epsilon, at any threshold", () => {
    expect(verdict(0, 0)).toBe(false);
    expect(verdict(1e-7, 0)).toBe(false);
    expect(verdict(1e-5, 0)).toBe(true);
    expect(verdict(1e-5, 0, 1000)).toBe(true);
  });

  // A tighter 1e-9 epsilon would judge this pair the same way; the unified 1e-6 keeps the very
  // same answer, which is what makes the widening safe.
  it("keeps the 1e-12 / 2e-12 case false", () => {
    expect(verdict(1e-12, 2e-12)).toBe(false);
  });

  it("still reports a ratio for a capacity below the epsilon — the null guard is `capacity > 0`", () => {
    const matrix = computeUtilization({
      resources: [engineResource({ id: "r", workingIntervals: alwaysWorking })],
      demands: new Map(),
      start: MON,
      end: MON + MS_DAY,
      bucket: "day",
      edges: "clamped",
      weekStartDay: 1,
      hooks: { resourceLoad: () => 1e-12, resourceCapacity: () => 2e-12 },
    });
    expect(matrix.rows[0]!.cells[0]!.ratio).toBe(0.5);
  });
});
