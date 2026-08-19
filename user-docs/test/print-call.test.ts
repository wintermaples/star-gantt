import { describe, expect, it } from "vitest";
import type { DemoSpec, StarGanttApi } from "../src/content/types";
import { printCall } from "../src/lib/printSpec";

/**
 * `printCall` is what a runnable cell shows under "the call this makes", and its whole job is to be
 * copyable. These assert the shape a reader would paste, not an internal representation: the
 * generated text has to name `create()`, `presetStandard()` and the factories the cell asked for.
 */
describe("printCall", () => {
  it("calls the preset with no argument when the cell configures nothing", () => {
    expect(printCall({})).toBe(
      [
        "const gantt = StarGantt.create({",
        '  element: document.getElementById("chart"),',
        "  plugins: [",
        "    ...StarGantt.presetStandard(),",
        "  ],",
        "});",
        "",
        'gantt.service("stargantt.data").load(tasks);',
      ].join("\n"),
    );
  });

  it("writes preset options as source rather than as JSON", () => {
    const printed = printCall({ preset: { treeGrid: { rowHeight: 36 } } });
    expect(printed).toContain("...StarGantt.presetStandard({");
    expect(printed).toContain("treeGrid: {");
    expect(printed).toContain("rowHeight: 36");
    // Quoted keys are what `JSON.stringify` produces and not what anyone writes.
    expect(printed).not.toContain('"treeGrid"');
  });

  it("names the factories an opt-in cell calls", () => {
    const spec: DemoSpec = {
      plugins: (sg) => [sg.perfTools()],
    };
    expect(printCall(spec)).toContain("    StarGantt.perfTools(),");
  });

  it("keeps the line breaks of a multi-line plugins list", () => {
    const spec: DemoSpec = {
      plugins: (sg) => [
        sg.perfTools(),
        sg.i18n({ locale: "ja" }),
      ],
    };
    const printed = printCall(spec);
    expect(printed).toContain("    StarGantt.perfTools(),");
    expect(printed).toContain('    StarGantt.i18n({ locale: "ja" }),');
  });

  it("falls back to a placeholder rather than guessing at a shape it cannot read", () => {
    const opaque = { plugins: (() => []) as unknown as DemoSpec["plugins"] } satisfies DemoSpec;
    expect(printCall(opaque)).toContain("    ...extraPlugins,");
  });

  it("does not print an empty entry for a plugins function that adds nothing", () => {
    const spec: DemoSpec = { plugins: (_sg: StarGanttApi) => [] };
    expect(printCall(spec)).toContain("    ...StarGantt.presetStandard(),\n  ],");
  });
});
