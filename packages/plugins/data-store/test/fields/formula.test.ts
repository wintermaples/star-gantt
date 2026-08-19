import { describe, expect, it } from "vitest";
import { evaluateFormula, parseFormula } from "../../src/internal/custom-fields/formula";
import type { FormulaResolver, FormulaValue } from "../../src/internal/custom-fields/formula";

function run(text: string, env: Record<string, FormulaValue> = {}): FormulaValue | undefined {
  const ast = parseFormula(text);
  if (ast === undefined) throw new Error(`parse failure: ${text}`);
  const resolve: FormulaResolver = (name) => env[name];
  return evaluateFormula(ast, resolve);
}

describe("formula parser", () => {
  it("rejects unusable texts", () => {
    for (const bad of ["", "   ", "1 +", "(1", '"open', "1 @ 2", "FOO(1)", "1 2", 42, null]) {
      expect(parseFormula(bad as never)).toBeUndefined();
    }
  });

  it("accepts the documented grammar", () => {
    for (const good of [
      "1 + 2 * 3",
      "-(a + b) / 2",
      '"a" & \'b\'',
      "IF(a > 1, \"big\", \"small\")",
      "ROUND(duration, 1)",
      "MIN(1, 2, 3)",
      "if(1 = 1, 1, 0)", // function names are case-insensitive
    ]) {
      expect(parseFormula(good)).toBeDefined();
    }
  });
});

describe("formula evaluation", () => {
  it("applies precedence: comparisons < concat < additive < multiplicative < unary", () => {
    expect(run("1 + 2 * 3")).toBe(7);
    expect(run("(1 + 2) * 3")).toBe(9);
    expect(run("-2 * 3")).toBe(-6);
    expect(run('"x" & 1 + 1')).toBe("x2");
    expect(run("1 + 1 = 2")).toBe(true);
  });

  it("concatenates with display-text coercion", () => {
    expect(run('"v" & 1.256')).toBe("v1.26"); // numbers use the two-decimal cell format
    expect(run("a & b", { a: "x", b: "y" })).toBe("xy");
  });

  it("compares within a type; mixed types are unequal, unordered", () => {
    expect(run('"a" = "a"')).toBe(true);
    expect(run('"a" <> 1')).toBe(true);
    expect(run('1 = "1"')).toBe(false);
    expect(run('1 < "a"')).toBeUndefined();
    expect(run('"a" < "b"')).toBe(true);
  });

  it("evaluates the functions", () => {
    expect(run('IF(2 > 1, "y", "n")')).toBe("y");
    expect(run("ROUND(1.256, 2)")).toBe(1.26);
    expect(run("ROUND(1.5)")).toBe(2);
    expect(run("ABS(-3)")).toBe(3);
    expect(run("MIN(3, 1, 2)")).toBe(1);
    expect(run("MAX(3, 1, 2)")).toBe(3);
    expect(run('LEN("abc")')).toBe(3);
    expect(run('CONCAT("a", 1, "b")')).toBe("a1b");
  });

  it("fails softly on every documented failure mode", () => {
    expect(run("1 / 0")).toBeUndefined();
    expect(run("missing + 1")).toBeUndefined();
    expect(run('"a" + 1')).toBeUndefined(); // arithmetic needs numbers
    expect(run('IF(1, "y", "n")')).toBeUndefined(); // cond must be boolean
    expect(run("ROUND(1.5, 0.5)")).toBeUndefined();
    expect(run("LEN(1)")).toBeUndefined();
    expect(run("MIN()")).toBeUndefined();
  });
});
