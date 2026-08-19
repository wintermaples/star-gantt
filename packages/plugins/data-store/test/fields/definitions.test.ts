import { describe, expect, it } from "vitest";
import { DEFAULT_WIDTH, resolveFields } from "../../src/internal/custom-fields/definitions";

describe("definition resolution", () => {
  it("yields no fields for a non-array", () => {
    for (const bad of [undefined, null, "x", 1, {}]) {
      expect(resolveFields(bad)).toEqual([]);
    }
  });

  it("fills defaults: type text, label = key, width 110, column on", () => {
    const [f] = resolveFields([{ key: "cost" }]);
    expect(f).toMatchObject({
      key: "cost",
      type: "text",
      label: "cost",
      width: DEFAULT_WIDTH,
      options: [],
      formula: "",
      column: true,
    });
  });

  it("drops unusable entries and duplicate keys, keeping order", () => {
    const fields = resolveFields([
      null,
      { key: "" },
      { key: "a", type: "number" },
      { key: "a", type: "text" }, // duplicate — first wins
      { key: "b", type: "bogus" }, // unknown type
      { key: "c", type: "select", options: [] }, // select without options
      { key: "d", type: "formula", formula: "1 +" }, // unparsable formula
      { key: "e", type: "date", width: -5, label: 7 }, // unusable width/label fall back
    ]);
    expect(fields.map((f) => f.key)).toEqual(["a", "e"]);
    expect(fields[0]!.type).toBe("number");
    expect(fields[1]).toMatchObject({ type: "date", width: DEFAULT_WIDTH, label: "e" });
  });

  it("normalizes select options and keeps usable formulas parsed", () => {
    const [sel, formula] = resolveFields([
      { key: "s", type: "select", options: ["High", "", "High", 3, "Low"] },
      { key: "f", type: "formula", formula: "duration * 2" },
    ]);
    expect(sel!.options).toEqual(["High", "Low"]);
    expect(formula!.formula).toBe("duration * 2");
    expect(formula!.ast).toBeDefined();
  });
});
