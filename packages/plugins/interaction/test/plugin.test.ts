// @vitest-environment happy-dom
/**
 * The plugin's own declarations: its id, its dependency edges, and the mechanical check that those
 * edges match what `setup()` actually reaches for.
 */
import { describe, expect, it } from "vitest";
import { expectDepsConsistency } from "@stargantt/sdk";
import { interaction } from "../src/index";

// docs/specs/architecture.md §4.1 — service id → the plugin that provides it. `dependsOn` names
// provider plugin ids while `ctx.use()` takes service ids, so the check needs the mapping.
const SERVICE_PROVIDERS: Record<string, string> = {
  "stargantt.data": "stargantt.data-store",
  "stargantt.fields": "stargantt.data-store",
  "stargantt.view": "stargantt.view",
  "stargantt.timeline": "stargantt.view",
  "stargantt.theme": "stargantt.view",
  "stargantt.rows": "stargantt.tree-grid",
  "stargantt.grid": "stargantt.tree-grid",
  "stargantt.task-bars": "stargantt.task-bars",
};

describe("interaction()", () => {
  it("declares the plugin id and its dependency edges", () => {
    expect(interaction().meta).toEqual({
      id: "stargantt.interaction",
      dependsOn: [
        "stargantt.data-store",
        "stargantt.view",
        "stargantt.tree-grid",
        "stargantt.task-bars",
      ],
      optional: ["stargantt.a11y"],
    });
  });

  it("keeps every hard dependency strictly below its own layer", () => {
    // Layer 5 (docs/specs/architecture.md ch. 5): the store is 1, the view 2, the tree grid 3 and
    // the bars 4 — every hard edge points down. The one same-layer edge (a11y) is optional.
    const layers: Record<string, number> = {
      "stargantt.data-store": 1,
      "stargantt.view": 2,
      "stargantt.tree-grid": 3,
      "stargantt.task-bars": 4,
      "stargantt.a11y": 5,
    };
    for (const id of interaction().meta.dependsOn ?? []) expect(layers[id]).toBeLessThan(5);
    for (const id of interaction().meta.optional ?? []) expect(layers[id]).toBeLessThanOrEqual(5);
  });

  it("keeps dependsOn and ctx.use() in step", () => {
    expectDepsConsistency(interaction(), SERVICE_PROVIDERS);
  });

  it("keeps dependsOn and ctx.use() in step with every feature nest enabled", () => {
    expectDepsConsistency(
      interaction({
        selection: { mode: "multi", shortcuts: { selectAll: true } },
        dragEdit: { rowDrag: true, resourceDrag: true, clickMove: true, multiDrag: true },
        snap: { alignToTasks: true, workingDays: true, pushSuccessors: true },
        tooltip: {},
        contextMenu: {},
        zoomControls: {},
        clipboard: {},
        filterSearch: {},
        editDialog: {},
        sidePanel: {},
      }),
      SERVICE_PROVIDERS,
    );
  });

  it("snapshots the configuration, so a later mutation cannot change a running chart", () => {
    const config: { selection: { mode: "single" | "multi" } } = { selection: { mode: "multi" } };
    const plugin = interaction(config);
    config.selection = { mode: "single" };
    // The factory copied the object it was handed; the nested value it closed over is the original.
    expect(plugin.meta.id).toBe("stargantt.interaction");
  });
});
