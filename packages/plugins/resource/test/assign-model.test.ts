/**
 * `internal/assign/model.ts` — hostless assignment arithmetic (docs/specs/plugins/resource.md
 * §3.3): id equality, percent <-> units conversion, editor-commit diffing, choice merging.
 */
import { describe, expect, it } from "vitest";
import {
  diffAssignments,
  idKey,
  mergeChoices,
  percentToUnits,
  sameId,
  toUnitsPercent,
  unitsOf,
} from "../src/internal/assign/model";

describe("idKey / sameId", () => {
  it("compares ids by string form across numeric/string spellings", () => {
    expect(idKey(5)).toBe("5");
    expect(idKey("5")).toBe("5");
    expect(sameId(5, "5")).toBe(true);
    expect(sameId(5, "6")).toBe(false);
  });
});

describe("toUnitsPercent", () => {
  it("rounds a units fraction to the nearest whole percent", () => {
    expect(toUnitsPercent(1)).toBe(100);
    expect(toUnitsPercent(0.5)).toBe(50);
    expect(toUnitsPercent(0.335)).toBe(34); // rounds, doesn't truncate
  });
});

describe("percentToUnits", () => {
  it("parses a usable string or number percent into a units fraction", () => {
    expect(percentToUnits("50")).toBe(0.5);
    expect(percentToUnits(100)).toBe(1);
    expect(percentToUnits("25.5")).toBeCloseTo(0.255);
  });

  it("rejects non-finite, zero, negative, blank and non-numeric text", () => {
    expect(percentToUnits("")).toBeUndefined();
    expect(percentToUnits("   ")).toBeUndefined();
    expect(percentToUnits("junk")).toBeUndefined();
    expect(percentToUnits(0)).toBeUndefined();
    expect(percentToUnits(-5)).toBeUndefined();
    expect(percentToUnits(Number.NaN)).toBeUndefined();
    expect(percentToUnits(Number.POSITIVE_INFINITY)).toBeUndefined();
  });

  it("clamps values above 1000% (ten FTE) rather than rejecting them", () => {
    expect(percentToUnits("5000")).toBe(10);
    expect(percentToUnits(1000)).toBe(10);
    expect(percentToUnits("1001")).toBe(10);
  });
});

describe("diffAssignments", () => {
  it("produces nothing for an unchanged desired state", () => {
    const current = [{ resourceId: "r1", units: 0.5 }];
    const diff = diffAssignments(current, new Map([["r1", 0.5]]));
    expect(diff).toEqual({ set: [], remove: [] });
  });

  it("sets new pairs and pairs whose units changed", () => {
    const current = [{ resourceId: "r1", units: 0.5 }];
    const diff = diffAssignments(
      current,
      new Map<string, number>([
        ["r1", 0.75], // changed
        ["r2", 1], // new
      ]),
    );
    expect(diff.set).toEqual([
      { resourceId: "r1", units: 0.75 },
      { resourceId: "r2", units: 1 },
    ]);
    expect(diff.remove).toEqual([]);
  });

  it("removes pairs missing from desired", () => {
    const current = [
      { resourceId: "r1", units: 0.5 },
      { resourceId: "r2", units: 1 },
    ];
    const diff = diffAssignments(current, new Map([["r1", 0.5]]));
    expect(diff.set).toEqual([]);
    expect(diff.remove).toEqual(["r2"]);
  });

  it("compares ids by string form, not Map key identity", () => {
    // Current carries numeric 5; desired carries string "5" — the same resource under the
    // plugin's id-equality rule, so this must diff as "no change", never as add+leftover.
    const current = [{ resourceId: 5, units: 0.5 }];
    const diff = diffAssignments(current, new Map([["5", 0.5]]));
    expect(diff).toEqual({ set: [], remove: [] });
  });
});

describe("unitsOf", () => {
  it("finds an assignment's units by string-form id, undefined when absent", () => {
    const assignments = [{ resourceId: 5, units: 0.4 }];
    expect(unitsOf(assignments, "5")).toBe(0.4);
    expect(unitsOf(assignments, "6")).toBeUndefined();
  });
});

describe("mergeChoices", () => {
  it("lists pool entries first, in pool order, then store-only resources in store order", () => {
    const pool = [
      { id: "p1", name: "Ana" },
      { id: "p2", name: "Bo" },
    ];
    const store = [
      { id: "p1", name: "Ana (stale store name)" },
      { id: "s1", name: "StoreOnly" },
    ];
    expect(mergeChoices(pool, store)).toEqual([
      { id: "p1", name: "Ana" },
      { id: "p2", name: "Bo" },
      { id: "s1", name: "StoreOnly" },
    ]);
  });

  it("dedupes across the pool/store seam by string-form id", () => {
    const pool = [{ id: 5, name: "Num" }];
    const store = [{ id: "5", name: "Num (store spelling)" }];
    expect(mergeChoices(pool, store)).toEqual([{ id: 5, name: "Num" }]);
  });
});
