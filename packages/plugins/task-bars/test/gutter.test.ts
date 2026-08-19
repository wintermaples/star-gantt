/**
 * `src/internal/gutter.ts` — the `taskbars/endGutter` reduction.
 *
 * The resolved amount per end is the largest size among the active contributions covering that end,
 * an unusable contribution is ignored rather than faulting the point, `active()` is read once per
 * resolution, and a throwing `active()` is reported once and then treated as inactive for good.
 */
import { describe, expect, it, vi } from "vitest";
import type { EndGutterContribution } from "../src/index";
import { createEndGutter, resolveEndGutter } from "../src/internal/gutter";

function gutter(over: Partial<EndGutterContribution> = {}): EndGutterContribution {
  return { id: "test", end: "both", size: 10, active: () => true, ...over };
}

describe("resolveEndGutter", () => {
  it("reserves nothing with no contributions at all", () => {
    expect(resolveEndGutter([])).toEqual({ start: 0, end: 0 });
    expect(resolveEndGutter(undefined)).toEqual({ start: 0, end: 0 });
  });

  it("reserves one contribution's size on the ends it names", () => {
    expect(resolveEndGutter([gutter({ end: "both", size: 17 })])).toEqual({ start: 17, end: 17 });
    expect(resolveEndGutter([gutter({ end: "start", size: 17 })])).toEqual({ start: 17, end: 0 });
    expect(resolveEndGutter([gutter({ end: "end", size: 17 })])).toEqual({ start: 0, end: 17 });
  });

  it("takes the maximum per end, not the sum", () => {
    const resolved = resolveEndGutter([
      gutter({ id: "ports", end: "both", size: 17 }),
      gutter({ id: "badges", end: "end", size: 24 }),
      gutter({ id: "small", end: "start", size: 4 }),
    ]);
    expect(resolved).toEqual({ start: 17, end: 24 });
  });

  it("excludes an inactive contribution from both ends", () => {
    const resolved = resolveEndGutter([
      gutter({ id: "off", end: "both", size: 40, active: () => false }),
      gutter({ id: "on", end: "both", size: 9 }),
    ]);
    expect(resolved).toEqual({ start: 9, end: 9 });
  });

  it("ignores a contribution whose size or active member is unusable", () => {
    const unusable = [
      gutter({ size: 0 }),
      gutter({ size: -5 }),
      gutter({ size: Number.NaN }),
      gutter({ size: Number.POSITIVE_INFINITY }),
      gutter({ size: "17" as unknown as number }),
      gutter({ active: undefined as unknown as () => boolean }),
      gutter({ end: "middle" as unknown as "both" }),
    ];
    for (const contribution of unusable) {
      expect(resolveEndGutter([contribution])).toEqual({ start: 0, end: 0 });
    }
    // One unusable contribution does not take the usable ones with it.
    expect(resolveEndGutter([...unusable, gutter({ size: 6 })])).toEqual({ start: 6, end: 6 });
  });
});

describe("createEndGutter", () => {
  it("resolves as the point is reduced and answers with the result afterwards", () => {
    const held = createEndGutter(() => undefined);
    expect(held.current()).toEqual({ start: 0, end: 0 });
    expect(held.reduce([gutter({ end: "end", size: 17 })])).toEqual({ start: 0, end: 17 });
    expect(held.current()).toEqual({ start: 0, end: 17 });
  });

  it("re-reads active() on refresh, once per resolution rather than once per read", () => {
    let calls = 0;
    let enabled = true;
    const held = createEndGutter(() => undefined);
    held.reduce([gutter({ size: 17, active: () => (calls += 1, enabled) })]);
    expect(calls).toBe(1);
    // Reading the resolved pair costs nothing: the reservation is fixed until the next refresh.
    for (let i = 0; i < 5; i += 1) expect(held.current().end).toBe(17);
    expect(calls).toBe(1);
    enabled = false;
    held.refresh();
    expect(calls).toBe(2);
    expect(held.current()).toEqual({ start: 0, end: 0 });
  });

  it("reports a throwing active() once and treats it as inactive from then on", () => {
    const fault = vi.fn();
    const held = createEndGutter(fault);
    held.reduce([
      gutter({
        id: "boom",
        size: 17,
        active: () => {
          throw new Error("boom");
        },
      }),
      gutter({ id: "fine", size: 5 }),
    ]);
    for (let i = 0; i < 3; i += 1) held.refresh();
    expect(fault).toHaveBeenCalledTimes(1);
    // The healthy contribution keeps reserving its own strip.
    expect(held.current()).toEqual({ start: 5, end: 5 });
  });
});
