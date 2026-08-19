/**
 * Hostless unit tests for the scrollable range: the content-extent reduction and the
 * per-axis clamp every scroll path shares.
 */
import { describe, expect, it } from "vitest";
import { UNBOUNDED, clampAxis, resolveContentExtent, resolveWheelDelta } from "../../src/internal/render/scroll";
import type { ContentExtentContribution } from "../../src/internal/render/index";

const extent = (
  id: string,
  measure: () => { width?: number; height?: number },
): ContentExtentContribution => ({ id, measure });

describe("resolveContentExtent", () => {
  it("takes the maximum of the finite values per axis, not the sum", () => {
    const resolved = resolveContentExtent(
      [
        extent("a", () => ({ height: 1000 })),
        extent("b", () => ({ height: 600, width: 2000 })),
        extent("c", () => ({ width: 300 })),
      ],
      () => {},
    );
    expect(resolved).toEqual({ width: 2000, height: 1000 });
  });

  it("leaves an axis nothing reports a finite value for unbounded", () => {
    const resolved = resolveContentExtent(
      [extent("a", () => ({ height: 500, width: Number.NaN }))],
      () => {},
    );
    expect(resolved.width).toBeUndefined();
    expect(resolved.height).toBe(500);
    expect(resolveContentExtent(undefined, () => {})).toEqual(UNBOUNDED);
    expect(resolveContentExtent([], () => {})).toEqual(UNBOUNDED);
  });

  it("re-invokes measure on every call rather than caching a size", () => {
    let height = 100;
    const list = [extent("a", () => ({ height }))];
    expect(resolveContentExtent(list, () => {}).height).toBe(100);
    height = 250;
    expect(resolveContentExtent(list, () => {}).height).toBe(250);
  });

  it("isolates a throwing measure, reports it, and keeps the other contributions", () => {
    const faults: unknown[] = [];
    const resolved = resolveContentExtent(
      [
        extent("bad", () => {
          throw new Error("measure failed");
        }),
        extent("good", () => ({ height: 700 })),
      ],
      (error) => faults.push(error),
    );
    expect(resolved.height).toBe(700);
    expect((faults[0] as Error).message).toBe("measure failed");
  });

  it("skips values that are not usable contributions, without reporting a fault", () => {
    const faults: unknown[] = [];
    const bad = [null, 42, { id: "x" }, extent("weird", () => 7 as unknown as { width: number })];
    const resolved = resolveContentExtent(
      [...(bad as unknown as ContentExtentContribution[]), extent("ok", () => ({ width: 42 }))],
      (error) => faults.push(error),
    );
    expect(resolved.width).toBe(42);
    expect(faults).toEqual([]);
  });
});

describe("clampAxis", () => {
  it("clamps to [0, extent - viewport]", () => {
    expect(clampAxis(900, 1000, 400)).toBe(600);
    expect(clampAxis(-5, 1000, 400)).toBe(0);
    expect(clampAxis(250, 1000, 400)).toBe(250);
  });

  it("pins the axis at the origin when the content fits", () => {
    expect(clampAxis(500, 300, 400)).toBe(0);
  });

  it("leaves an unbounded axis unbounded above, but never below zero", () => {
    expect(clampAxis(10_000, undefined, 400)).toBe(10_000);
    expect(clampAxis(-1, undefined, 400)).toBe(0);
  });
});

describe("resolveWheelDelta", () => {
  it("passes an ordinary notch through untouched", () => {
    expect(resolveWheelDelta({ deltaX: 0, deltaY: 120, shiftKey: false })).toEqual({
      dx: 0,
      dy: 120,
    });
    expect(resolveWheelDelta({ deltaX: -40, deltaY: 10, shiftKey: false })).toEqual({
      dx: -40,
      dy: 10,
    });
  });

  it("swaps the axes for the Shift+wheel a browser dispatches on deltaY alone", () => {
    expect(resolveWheelDelta({ deltaX: 0, deltaY: 120, shiftKey: true })).toEqual({ dx: 120, dy: 0 });
    expect(resolveWheelDelta({ deltaX: 0, deltaY: -120, shiftKey: true })).toEqual({
      dx: -120,
      dy: 0,
    });
  });

  it("is idempotent: an event that already carries a horizontal component is left alone", () => {
    // Swapping twice would send the vertical component sideways on engines that swap for us.
    expect(resolveWheelDelta({ deltaX: 30, deltaY: 40, shiftKey: true })).toEqual({ dx: 30, dy: 40 });
  });
});
