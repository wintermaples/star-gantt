// @vitest-environment happy-dom
/**
 * The plugin's own declarations: its id, its dependency edges, and the mechanical check that those
 * edges match what `setup()` actually reaches for.
 */
import { describe, expect, it } from "vitest";
import { expectDepsConsistency } from "@stargantt/sdk";
import { a11y } from "../src/index";

// docs/specs/architecture.md §4.1 — service id → the plugin that provides it. `dependsOn` names
// provider plugin ids while `ctx.use()` takes service ids, so the check needs the mapping.
const SERVICE_PROVIDERS: Record<string, string> = {
  "stargantt.data": "stargantt.data-store",
  "stargantt.view": "stargantt.view",
  "stargantt.timeline": "stargantt.view",
  "stargantt.theme": "stargantt.view",
  "stargantt.rows": "stargantt.tree-grid",
  "stargantt.grid": "stargantt.tree-grid",
  "stargantt.task-bars": "stargantt.task-bars",
};

describe("a11y()", () => {
  it("declares the plugin id and its dependency edges", () => {
    expect(a11y().meta).toEqual({
      id: "stargantt.a11y",
      dependsOn: [
        "stargantt.data-store",
        "stargantt.view",
        "stargantt.tree-grid",
        "stargantt.task-bars",
      ],
      optional: ["stargantt.interaction"],
    });
  });

  it("keeps every hard dependency strictly below its own layer", () => {
    // Layer 5 (docs/specs/architecture.md ch. 5): the store is 1, the view 2, the tree grid 3 and
    // the bars 4 — every hard edge points down. The one same-layer edge (interaction, which
    // provides `stargantt.selection`) is optional.
    const layers: Record<string, number> = {
      "stargantt.data-store": 1,
      "stargantt.view": 2,
      "stargantt.tree-grid": 3,
      "stargantt.task-bars": 4,
      "stargantt.interaction": 5,
    };
    for (const id of a11y().meta.dependsOn ?? []) expect(layers[id]).toBeLessThan(5);
    for (const id of a11y().meta.optional ?? []) expect(layers[id]).toBeLessThanOrEqual(5);
  });

  it("keeps dependsOn and ctx.use() in step", () => {
    expectDepsConsistency(a11y(), SERVICE_PROVIDERS);
  });

  it("keeps dependsOn and ctx.use() in step with every opt-in feature enabled", () => {
    expectDepsConsistency(
      a11y({
        label: "Plan",
        syncSelection: false,
        describeDependencies: true,
        shortcutHelp: true,
        zoomKeys: true,
        summaryTable: true,
      }),
      SERVICE_PROVIDERS,
    );
  });

  it("never resolves the same-layer selection service at setup()", () => {
    // `expectDepsConsistency` answers every `useOptional` with `undefined`; the plugin must still
    // set up cleanly, which is what "resolved late, at use time" buys.
    expect(() => expectDepsConsistency(a11y(), SERVICE_PROVIDERS)).not.toThrow();
  });
});
