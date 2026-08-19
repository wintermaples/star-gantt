/**
 * `internal/evm/formulas.ts` — the custom KPI-tile registry (docs/specs/plugins/tracking.md §2.15).
 * Driven directly against the two pure functions rather than through a booted panel (the panel-level
 * rendering of the same rules lives in `evm-panels.test.ts`).
 */
import { describe, expect, it } from "vitest";
import { formulaTiles, normalizeFormulas } from "../src/internal/evm/formulas";
import type { EvmFormulaInput } from "../src/types";
import { formatAmount } from "../src/internal/shared/format";

const INPUT: EvmFormulaInput = {
  indices: { bac: 1000, pv: 500, ev: 500, ac: 800, sv: 0, cv: -300, eac: 1600, etc: 800 },
  curve: [],
  statusDate: 0,
};

describe("normalizeFormulas (setup-time)", () => {
  it("drops unusable inits and keeps the usable ones in configuration order", () => {
    const entries = normalizeFormulas([
      { id: "a", evaluate: () => 1 },
      undefined as unknown as { evaluate: () => number },
      { id: "no-evaluate" } as unknown as { evaluate: () => number },
      { id: "b", evaluate: () => 2 },
    ]);
    expect(entries.map((e) => e.id)).toEqual(["a", "b"]);
  });

  it("generates `formula-<n>` counting over the USABLE inits only", () => {
    const entries = normalizeFormulas([
      { id: "kept" } as unknown as { evaluate: () => number }, // unusable, does not consume an n
      { evaluate: () => 1 },
      { evaluate: () => 2 },
    ]);
    expect(entries.map((e) => e.id)).toEqual(["formula-1", "formula-2"]);
  });

  it("defaults the label to the RESOLVED id — deliberately not the `formulaName` builder", () => {
    const entries = normalizeFormulas([{ evaluate: () => 1 }, { id: "burn", evaluate: () => 2 }]);
    expect(entries.map((e) => e.label)).toEqual(["formula-1", "burn"]);
  });

  it("replaces a colliding id in place, keeping the original position", () => {
    const entries = normalizeFormulas([
      { id: "x", label: "first", evaluate: () => 1 },
      { id: "y", label: "second", evaluate: () => 2 },
      { id: "x", label: "third", evaluate: () => 3 },
    ]);
    expect(entries.map((e) => [e.id, e.label])).toEqual([
      ["x", "third"],
      ["y", "second"],
    ]);
  });

  it("answers an empty list for a non-array", () => {
    expect(normalizeFormulas(undefined)).toEqual([]);
    expect(normalizeFormulas("nope" as unknown as [])).toEqual([]);
  });
});

describe("formulaTiles (per panel open, CONTAINED but UNLATCHED)", () => {
  it("evaluates in order and formats through the plugin's rounding by default", () => {
    const tiles = formulaTiles(
      normalizeFormulas([
        { id: "burn", label: "Burn", evaluate: (i) => i.indices.ac - i.indices.ev },
        { id: "tcpi", label: "TCPI", evaluate: () => 1.25, format: (v) => v.toFixed(2) },
        { evaluate: () => 12_345.6 },
      ]),
      INPUT,
      formatAmount,
      () => undefined,
    );
    expect(tiles).toEqual([
      { label: "Burn", value: "300" },
      { label: "TCPI", value: "1.25" },
      // `n` counts every USABLE init, explicit ids included — the third one is `formula-3`.
      { label: "formula-3", value: "12,346" },
    ]);
  });

  it("carries no gloss and no flag — those are the ten built-in tiles' alone", () => {
    const [tile] = formulaTiles(
      normalizeFormulas([{ id: "x", evaluate: () => 1 }]),
      INPUT,
      formatAmount,
      () => undefined,
    );
    expect(tile).toEqual({ label: "x", value: "1" });
  });

  it("reports a throwing evaluate and drops that tile — per call, never latched", () => {
    const seen: string[] = [];
    let calls = 0;
    const entries = normalizeFormulas([
      {
        id: "bad",
        evaluate: () => {
          calls += 1;
          throw new Error("boom");
        },
      },
      { id: "good", evaluate: () => 7 },
    ]);
    const first = formulaTiles(entries, INPUT, formatAmount, (where) => seen.push(where));
    expect(first.map((t) => t.label)).toEqual(["good"]);
    expect(seen).toEqual(["formulas.bad.evaluate"]);
    // UNLATCHED: the next render calls the broken rule again and reports again.
    const second = formulaTiles(entries, INPUT, formatAmount, (where) => seen.push(where));
    expect(second.map((t) => t.label)).toEqual(["good"]);
    expect(calls).toBe(2);
    expect(seen).toEqual(["formulas.bad.evaluate", "formulas.bad.evaluate"]);
  });

  it("drops a non-finite result silently and falls back on a throwing format", () => {
    const seen: string[] = [];
    const tiles = formulaTiles(
      normalizeFormulas([
        { id: "nan", evaluate: () => Number.NaN },
        { id: "inf", evaluate: () => Number.POSITIVE_INFINITY },
        {
          id: "fmt",
          evaluate: () => 5,
          format: () => {
            throw new Error("boom");
          },
        },
        { id: "wrong", evaluate: () => 6, format: () => 42 as unknown as string },
      ]),
      INPUT,
      formatAmount,
      (where) => seen.push(where),
    );
    expect(tiles).toEqual([
      { label: "fmt", value: "5" },
      { label: "wrong", value: "6" },
    ]);
    expect(seen).toEqual(["formulas.fmt.format"]);
  });
});
