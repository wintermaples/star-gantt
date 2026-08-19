/**
 * `src/internal/conditional-format/color.ts` — theme-token color resolution, the latched report of
 * a color that cannot be resolved, and the CSS spelling used by the legend swatches.
 */
import { describe, expect, it } from "vitest";
import { createColorResolver, cssColor } from "../src/internal/conditional-format/color";

function withTokens(tokens: Record<string, string>): {
  resolve: (raw: string) => string;
  unresolved: string[];
  tokens: Record<string, string>;
} {
  const unresolved: string[] = [];
  const resolve = createColorResolver({
    theme: { get: (token: string): string => tokens[token] ?? "" },
    onUnresolved: (raw) => unresolved.push(raw),
  });
  return { resolve, unresolved, tokens };
}

describe("createColorResolver", () => {
  it("passes a literal color through untouched", () => {
    const c = withTokens({});
    expect(c.resolve("#c53030")).toBe("#c53030");
    expect(c.resolve("rgba(1, 2, 3, 0.5)")).toBe("rgba(1, 2, 3, 0.5)");
    expect(c.unresolved).toEqual([]);
  });

  it("resolves a bare token and a var() wrapper through the theme", () => {
    const c = withTokens({ "--sg-danger": "#ff0000" });
    expect(c.resolve("--sg-danger")).toBe("#ff0000");
    expect(c.resolve("var(--sg-danger)")).toBe("#ff0000");
    expect(c.resolve(" var( --sg-danger ) ")).toBe("#ff0000");
    expect(c.unresolved).toEqual([]);
  });

  it("re-reads the theme on every call, so a token follows a theme change", () => {
    const c = withTokens({ "--sg-danger": "#ff0000" });
    expect(c.resolve("var(--sg-danger)")).toBe("#ff0000");
    c.tokens["--sg-danger"] = "#00ff00";
    expect(c.resolve("var(--sg-danger)")).toBe("#00ff00");
  });

  it("uses the var() fallback when the token resolves empty, including a nested one", () => {
    const c = withTokens({ "--sg-b": "#0000ff" });
    expect(c.resolve("var(--sg-missing, #c00)")).toBe("#c00");
    expect(c.resolve("var(--sg-missing, rgb(1, 2, 3))")).toBe("rgb(1, 2, 3)");
    expect(c.resolve("var(--sg-missing, var(--sg-b, #fff))")).toBe("#0000ff");
    expect(c.resolve("var(--sg-missing, var(--sg-other, #fff))")).toBe("#fff");
    expect(c.unresolved).toEqual([]);
  });

  it("prefers the token over the fallback when the token has a value", () => {
    const c = withTokens({ "--sg-danger": "#ff0000" });
    expect(c.resolve("var(--sg-danger, #c00)")).toBe("#ff0000");
  });

  it("resolves nothing from a theme where no token has a value, and reports it", () => {
    const unresolved: string[] = [];
    const resolve = createColorResolver({
      theme: { get: () => "" },
      onUnresolved: (raw) => unresolved.push(raw),
    });
    expect(resolve("--sg-danger")).toBe("");
    expect(resolve("var(--sg-danger, #c00)")).toBe("#c00");
    expect(resolve("#c53030")).toBe("#c53030");
    expect(unresolved).toEqual(["--sg-danger"]);
  });

  it("reports an unresolvable color once per distinct string, however often it is asked", () => {
    const c = withTokens({});
    for (let i = 0; i < 50; i += 1) {
      expect(c.resolve("--sg-missing")).toBe("");
      expect(c.resolve("var(--sg-other)")).toBe("");
    }
    expect(c.unresolved).toEqual(["--sg-missing", "var(--sg-other)"]);
  });

  it("treats a malformed reference as unresolvable rather than painting it", () => {
    const c = withTokens({ "--sg-danger": "#ff0000" });
    expect(c.resolve("var(--sg-danger")).toBe("");
    expect(c.resolve("var(sg-danger)")).toBe("");
    expect(c.resolve("")).toBe("");
    expect(c.unresolved).toEqual(["var(--sg-danger", "var(sg-danger)", ""]);
  });
});

describe("cssColor", () => {
  it("wraps a bare token and keeps a literal as written", () => {
    expect(cssColor("#c53030")).toBe("#c53030");
    expect(cssColor("--sg-danger")).toBe("var(--sg-danger)");
    expect(cssColor("var(--sg-danger)")).toBe("var(--sg-danger)");
    expect(cssColor("var(--sg-danger, #c00)")).toBe("var(--sg-danger, #c00)");
    expect(cssColor("var(--a, var(--b, #c00))")).toBe("var(--a, var(--b, #c00))");
  });

  it("answers the empty string for something that cannot name a color", () => {
    expect(cssColor("var(--sg-danger")).toBe("");
    expect(cssColor("  ")).toBe("");
  });
});
