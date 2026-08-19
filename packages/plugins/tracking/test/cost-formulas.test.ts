/**
 * `internal/cost/formulas.ts` — custom cost formulas, hostless (docs/specs/plugins/tracking.md
 * §2.12): id-defaulting and collision on `resolveCostFormulas`, and the PER-CALL,
 * UNLATCHED containment of `filter` / `evaluate` / `format` on `evaluateCostFormulas`.
 */
import { describe, expect, it } from "vitest";
import type { Task } from "@stargantt/plugin-data-store";
import {
  evaluateCostFormulas,
  groupCostValuesByCode,
  resolveCostFormulas,
  sumCostValues,
} from "../src/internal/cost/formulas";
import type { CostFormulaEntry, CostFormulaRow } from "../src/internal/cost/formulas";
import type { CostFormulaInit, CostFormulaInput, CostValues } from "../src/types";

const nameOf = (n: number): string => `Formula ${String(n)}`;

function row(id: string, values: Readonly<CostValues> = {}): CostFormulaRow {
  return { task: { id, parentId: null, name: `task ${id}`, start: 0, end: 0 } as Task, values };
}

describe("resolveCostFormulas (§2.12 setup-time resolution)", () => {
  it("defaults id and label from the ordinal when omitted", () => {
    const entries = resolveCostFormulas([{ evaluate: () => 1 }], nameOf);
    expect(entries).toEqual([expect.objectContaining({ id: "formula-1", label: "Formula 1" })]);
  });

  it("keeps a given id and label", () => {
    const entries = resolveCostFormulas(
      [{ id: "total-actual", label: "Total actual", evaluate: () => 1 }],
      nameOf,
    );
    expect(entries[0]).toMatchObject({ id: "total-actual", label: "Total actual" });
  });

  it("a colliding id replaces its holder rather than adding a second entry", () => {
    const second: CostFormulaInit = { id: "x", label: "second", evaluate: () => 2 };
    const entries = resolveCostFormulas(
      [{ id: "x", label: "first", evaluate: () => 1 }, second],
      nameOf,
    );
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ id: "x", label: "second" });
    expect(entries[0]?.evaluate({} as CostFormulaInput)).toBe(2);
  });

  it("drops an init without a function evaluate, and counts n over the USABLE inits only", () => {
    const entries = resolveCostFormulas(
      [
        { evaluate: "nope" } as unknown as CostFormulaInit,
        null as unknown as CostFormulaInit,
        { evaluate: () => 1 },
      ],
      nameOf,
    );
    expect(entries).toHaveLength(1);
    // The two dropped inits never advanced the counter.
    expect(entries[0]).toMatchObject({ id: "formula-1", label: "Formula 1" });
  });
});

describe("sumCostValues / groupCostValuesByCode", () => {
  it("sums fixedCost/materialCost/actualCost only; costCode and items are not aggregated", () => {
    const rows = [
      row("a", { fixedCost: 10, materialCost: 5, actualCost: 1 }),
      row("b", { fixedCost: 20 }),
    ];
    expect(sumCostValues(rows)).toEqual({ fixedCost: 30, materialCost: 5, actualCost: 1 });
  });

  it("groups by trimmed cost code, uncoded rows under an empty string", () => {
    const rows = [
      row("a", { fixedCost: 10, costCode: "CC1" }),
      row("b", { fixedCost: 5, costCode: "CC1" }),
      row("c", { fixedCost: 7 }),
    ];
    const byCode = groupCostValuesByCode(rows);
    expect(byCode.get("CC1")).toEqual({ fixedCost: 15, materialCost: 0, actualCost: 0 });
    expect(byCode.get("")).toEqual({ fixedCost: 7, materialCost: 0, actualCost: 0 });
  });
});

describe("evaluateCostFormulas (§2.12 per-call containment)", () => {
  const format = (v: number): string => `$${String(v)}`;

  it("a formula's value reaches the caller with the default formatting", () => {
    const entries: CostFormulaEntry[] = [
      {
        id: "sum",
        label: "Sum of actuals",
        filter: undefined,
        evaluate: (input) => input.totals.actualCost ?? 0,
        format: undefined,
      },
    ];
    const rows = [row("a", { actualCost: 40 }), row("b", { actualCost: 10 })];
    const errors: { id: string; cause: unknown }[] = [];
    const out = evaluateCostFormulas(entries, rows, undefined, format, (id, cause) =>
      errors.push({ id, cause }),
    );
    expect(out).toEqual([{ id: "sum", label: "Sum of actuals", value: 50, text: "$50" }]);
    expect(errors).toHaveLength(0);
  });

  it("a formula's own format overrides the default", () => {
    const entries: CostFormulaEntry[] = [
      { id: "sum", label: "Sum", filter: undefined, evaluate: () => 50, format: (v) => `£${String(v)}` },
    ];
    const out = evaluateCostFormulas(entries, [row("a")], undefined, format, () => undefined);
    expect(out[0]?.text).toBe("£50");
  });

  it("filter narrows the rows and totals reaching evaluate", () => {
    let seen: CostFormulaInput | undefined;
    const entries: CostFormulaEntry[] = [
      {
        id: "coded-only",
        label: "Coded only",
        filter: (_task, values) => values.costCode === "CC1",
        evaluate: (input) => {
          seen = input;
          return input.rows.length;
        },
        format: undefined,
      },
    ];
    const rows = [row("a", { costCode: "CC1", fixedCost: 10 }), row("b", { fixedCost: 20 })];
    const out = evaluateCostFormulas(entries, rows, 12345, format, () => undefined);
    expect(out[0]?.value).toBe(1);
    expect(seen?.rows).toHaveLength(1);
    expect(seen?.totals).toEqual({ fixedCost: 10, materialCost: 0, actualCost: 0 });
    expect(seen?.statusDate).toBe(12345);
  });

  it("statusDate is undefined when none was configured", () => {
    let seen: CostFormulaInput | undefined;
    const entries: CostFormulaEntry[] = [
      {
        id: "f",
        label: "F",
        filter: undefined,
        evaluate: (input) => {
          seen = input;
          return 1;
        },
        format: undefined,
      },
    ];
    evaluateCostFormulas(entries, [row("a")], undefined, format, () => undefined);
    expect(seen?.statusDate).toBeUndefined();
  });

  it.each(["filter", "evaluate", "format"] as const)(
    "a throwing %s is reported exactly once and the formula is skipped",
    (which) => {
      const boom = (): never => {
        throw new Error("boom");
      };
      const entries: CostFormulaEntry[] = [
        {
          id: "boom",
          label: "Boom",
          filter: which === "filter" ? boom : undefined,
          evaluate: which === "evaluate" ? boom : () => 1,
          format: which === "format" ? boom : undefined,
        },
      ];
      const errors: { id: string; cause: unknown }[] = [];
      const out = evaluateCostFormulas(entries, [row("a")], undefined, format, (id, cause) =>
        errors.push({ id, cause }),
      );
      expect(out).toHaveLength(0);
      expect(errors).toHaveLength(1);
      expect(errors[0]?.id).toBe("boom");
    },
  );

  it("containment is UNLATCHED: a formula that keeps throwing reports on every call", () => {
    const entries: CostFormulaEntry[] = [
      {
        id: "boom",
        label: "Boom",
        filter: undefined,
        evaluate: () => {
          throw new Error("boom");
        },
        format: undefined,
      },
    ];
    const errors: string[] = [];
    for (let i = 0; i < 3; i++) {
      evaluateCostFormulas(entries, [row("a")], undefined, format, (id) => errors.push(id));
    }
    expect(errors).toEqual(["boom", "boom", "boom"]);
  });

  it("one throwing formula does not affect the others; each fault is independently identified", () => {
    const entries: CostFormulaEntry[] = [
      { id: "ok", label: "OK", filter: undefined, evaluate: () => 5, format: undefined },
      {
        id: "bad",
        label: "Bad",
        filter: undefined,
        evaluate: () => {
          throw new Error("boom");
        },
        format: undefined,
      },
    ];
    const errors: string[] = [];
    const out = evaluateCostFormulas(entries, [row("a")], undefined, format, (id) =>
      errors.push(id),
    );
    expect(out).toEqual([{ id: "ok", label: "OK", value: 5, text: "$5" }]);
    expect(errors).toEqual(["bad"]);
  });

  it("a non-finite evaluate result is silently skipped (no fault report)", () => {
    const entries: CostFormulaEntry[] = [
      { id: "nan", label: "NaN", filter: undefined, evaluate: () => NaN, format: undefined },
    ];
    const errors: string[] = [];
    const out = evaluateCostFormulas(entries, [row("a")], undefined, format, (id) =>
      errors.push(id),
    );
    expect(out).toHaveLength(0);
    expect(errors).toHaveLength(0);
  });
});
