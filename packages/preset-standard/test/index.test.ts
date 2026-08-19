/**
 * `presetStandard()` — the composition itself, not the individual plugins' own behaviour (each
 * plugin's suite already covers that). What this file checks is mechanical and specific to the
 * composition function: the exact id sequence, that every plugin's declared `dependsOn` is
 * satisfiable by an earlier entry in the array (the "dependency order" the docstring promises),
 * that an omitted config nest reproduces the all-defaults composition, and that each config nest is
 * threaded to its own plugin and no other.
 */
// @vitest-environment happy-dom
import { describe, expect, it } from "vitest";
import { Gantt, definePlugin } from "@stargantt/core";
import type { AnyPlugin, PluginContext } from "@stargantt/core";
import { createTestHost } from "@stargantt/sdk";
import { dataStore } from "@stargantt/plugin-data-store";
import { presetStandard } from "../src/index";

/** The core references `HTMLElement` as a type only, so a plain object is enough under node. */
const fakeRoot = (): HTMLElement => ({}) as unknown as HTMLElement;

/* ------------------------------------------------------------------ *
 * Routing-proof harness (used by the interaction/a11y nest tests below)
 * ------------------------------------------------------------------ */

/**
 * An inert value safe to call, index, coerce or chain off of arbitrarily — every property access
 * and every call returns the same stub again, and numeric coercion answers `0`. Ported from
 * `@stargantt/sdk`'s own (package-internal, unexported) `harmlessStub()` behind
 * `expectDepsConsistency`: stands in for a service this test does not otherwise care about, so a
 * plugin's `setup()` can run to completion without a full sibling plugin behind every `ctx.use()`.
 */
function harmlessStub(): unknown {
  const fn = (): unknown => stub;
  const stub: unknown = new Proxy(fn, {
    get: (_target, p) =>
      p === Symbol.toPrimitive ? (hint: string): string | number => (hint === "string" ? "" : 0) : stub,
    apply: () => stub,
  });
  return stub;
}

/** `ctx.provide`, widened past the real `keyof Services` union for a harness-only stub plugin. */
function provide(ctx: PluginContext, key: string, value: unknown): void {
  (ctx.provide as unknown as (k: string, v: unknown) => void)(key, value);
}

/**
 * The three stub plugins that satisfy `stargantt.interaction`'s and `stargantt.a11y`'s shared hard
 * dependencies (`stargantt.view`, `stargantt.tree-grid`, `stargantt.task-bars` — `stargantt.data`
 * comes from the real `dataStore()` instead, since both routing proofs below want real task data).
 * Every service member is a harmless stub except `stargantt.timeline`'s `zoomLevel`, which carries
 * one realistic "day" scale row: the interaction proof calls the real `stargantt.snap` service,
 * whose default (`unit: "scale"`) rounding reads `zoomLevel.get().scales` to find the finest row —
 * a fully-stubbed store there would make `roundTo()` round against a garbage "unit" instead of
 * cleanly returning the input unchanged, muddying the very distinction ("rounds" vs "does not
 * round") the proof rests on.
 */
function routingProofSiblings(): AnyPlugin[] {
  const viewStub = definePlugin({
    meta: { id: "stargantt.view" },
    setup(ctx: PluginContext) {
      provide(ctx, "stargantt.view", harmlessStub());
      provide(ctx, "stargantt.theme", harmlessStub());
      provide(ctx, "stargantt.timeline", {
        tToX: harmlessStub(),
        xToT: harmlessStub(),
        pxPerMs: 1,
        zoomLevel: { get: () => ({ id: "day", pxPerDay: 24, scales: [{ unit: "day" }] }) },
      });
    },
  });
  const treeGridStub = definePlugin({
    meta: { id: "stargantt.tree-grid" },
    setup(ctx: PluginContext) {
      provide(ctx, "stargantt.rows", harmlessStub());
      provide(ctx, "stargantt.grid", harmlessStub());
    },
  });
  const taskBarsStub = definePlugin({
    meta: { id: "stargantt.task-bars" },
    setup(ctx: PluginContext) {
      provide(ctx, "stargantt.task-bars", harmlessStub());
    },
  });
  return [viewStub, treeGridStub, taskBarsStub];
}

/** One task, for the a11y/interaction routing proofs that need any store content at all. */
const ONE_TASK = [{ id: "a", parentId: null, name: "A", start: 0, end: 10 }];

/** The exact id sequence `presetStandard()` is documented to return (src/index.ts). */
const EXPECTED_IDS = [
  "stargantt.data-store",
  "stargantt.view",
  "stargantt.tree-grid",
  "stargantt.task-bars",
  "stargantt.interaction",
  "stargantt.undo-redo",
  "stargantt.a11y",
  "stargantt.scheduling",
  "stargantt.export",
];

function idsOf(plugins: readonly AnyPlugin[]): string[] {
  return plugins.map((p) => p.meta.id);
}

/** The one plugin instance carrying `id` in a `presetStandard()` array — never a positional index,
 *  which would silently start pointing at the wrong plugin the moment the array's order changes. */
function pluginById(plugins: readonly AnyPlugin[], id: string): AnyPlugin {
  const found = plugins.find((p) => p.meta.id === id);
  if (found === undefined) throw new Error(`presetStandard(): no plugin "${id}" in the returned array`);
  return found;
}

describe("presetStandard()", () => {
  it("returns the nine official plugins, in dependency order", () => {
    expect(idsOf(presetStandard())).toEqual(EXPECTED_IDS);
  });

  it("every plugin's declared dependsOn names a plugin earlier in the returned array", () => {
    const plugins = presetStandard();
    const seenSoFar = new Set<string>();
    for (const plugin of plugins) {
      for (const dep of plugin.meta.dependsOn ?? []) {
        expect(
          seenSoFar.has(dep),
          `"${plugin.meta.id}" depends on "${dep}", which must precede it in presetStandard()'s array`,
        ).toBe(true);
      }
      // The a11y and interaction plugins each declare the other as `optional`; an optional peer is
      // not required to precede its declarer, so only `dependsOn` (hard deps) is checked above.
      seenSoFar.add(plugin.meta.id);
    }
  });

  it("presetStandard() and presetStandard({}) produce identical plugin id sequences", () => {
    expect(idsOf(presetStandard())).toEqual(idsOf(presetStandard({})));
  });

  it("returns a fresh array of fresh plugin instances on every call", () => {
    const first = presetStandard();
    const second = presetStandard();
    expect(first).not.toBe(second);
    for (let i = 0; i < first.length; i += 1) {
      expect(first[i]).not.toBe(second[i]);
    }
  });

  it("composes without throwing when every key is given a config nest at once", () => {
    const configured = presetStandard({
      dataStore: {},
      view: {},
      treeGrid: { rowHeight: 40 },
      taskBars: {},
      interaction: { selection: { mode: "multi" } },
      undoRedo: { limit: 50 },
      a11y: { label: "Test chart" },
      scheduling: { autoSchedule: { enabled: true } },
      export: { viewerEmbed: { embed: true } },
    });
    expect(idsOf(configured)).toEqual(EXPECTED_IDS);
  });

  it("an omitted key composes that plugin with its own defaults (no crash on a fully empty config object)", () => {
    expect(() => presetStandard({})).not.toThrow();
    expect(() =>
      presetStandard({ interaction: {}, undoRedo: {}, a11y: {}, scheduling: {}, export: {} }),
    ).not.toThrow();
  });

  // Every plugin factory itself already proves it snapshots and forwards its own config (each
  // plugin's own "snapshots the config" test); what is specific to `presetStandard()` is that
  // `config.undoRedo` actually reaches the *undo-redo* factory's slot in the returned array, not a
  // neighboring one — a copy/paste or key-transposition bug (e.g. `undoRedo(config?.a11y)`) would
  // pass every test above (same ids, same order) while silently forwarding the wrong nest. Booted
  // for real here (`Gantt.create`, headless — undo-redo touches no DOM) rather than only inspected
  // structurally, so the proof is behavioral: the configured `limit` actually governs how many
  // steps the composed instance's history keeps.
  it("forwards config.undoRedo to the undo-redo plugin's own slot in the array", () => {
    const plugins = presetStandard({ undoRedo: { limit: 1 } });
    const undoRedoPlugin = pluginById(plugins, "stargantt.undo-redo");
    const gantt = Gantt.create({ element: fakeRoot(), plugins: [dataStore(), undoRedoPlugin] });
    try {
      const data = gantt.service("stargantt.data");
      const history = gantt.service("stargantt.history");
      data.load([{ id: "a", parentId: null, name: "A", start: 0, end: 10 }]);

      gantt.dispatch("task/move", { id: "a", start: 10, end: 20 });
      gantt.dispatch("task/move", { id: "a", start: 20, end: 30 });

      history.undo();
      // With the default limit (200) both moves would still be on the stack and this first undo
      // would leave a second one available; with `limit: 1` forwarded, only the most recent entry
      // (the 10→20 move) was ever kept, so one undo already empties the stack.
      expect(history.state.get().canUndo).toBe(false);
      expect(data.getTask("a")?.start).toBe(10);
    } finally {
      gantt.dispose();
    }
  });

  // Same transposition-catch pattern as the undo-redo proof above, for the two nests it did not
  // cover: `config.interaction` must reach the *interaction* factory's slot and `config.a11y` the
  // *a11y* factory's slot, not each other's or a neighbor's. Both plugins share the same four hard
  // dependencies (`routingProofSiblings()` + the real `dataStore()`), so one shared harness proves
  // both — a swap between the two config nests would leave one plugin's own observable at its
  // *default*, not merely absent, which the "vs. a default composition" comparison below is what
  // catches (a plugin that failed to compose at all would instead throw or leave the service/DOM
  // node missing outright).
  it("forwards config.interaction to the interaction plugin's own slot in the array", () => {
    const disabled = pluginById(
      presetStandard({ interaction: { snap: { enabled: false } } }),
      "stargantt.interaction",
    );
    const defaulted = pluginById(presetStandard(), "stargantt.interaction");
    // A noon instant: not a "day" boundary, so the default (enabled) rounding rule is guaranteed to
    // move it, and the disabled rule is guaranteed not to.
    const noon = 12 * 60 * 60 * 1000;

    const withDisabled = createTestHost({
      element: document.createElement("div"),
      plugins: [dataStore(), ...routingProofSiblings(), disabled],
    });
    try {
      withDisabled.host.service("stargantt.data").load(ONE_TASK);
      expect(withDisabled.host.service("stargantt.snap").snap(noon)).toBe(noon);
    } finally {
      withDisabled.dispose();
    }

    const withDefault = createTestHost({
      element: document.createElement("div"),
      plugins: [dataStore(), ...routingProofSiblings(), defaulted],
    });
    try {
      withDefault.host.service("stargantt.data").load(ONE_TASK);
      expect(withDefault.host.service("stargantt.snap").snap(noon)).not.toBe(noon);
    } finally {
      withDefault.dispose();
    }
  });

  it("forwards config.a11y to the a11y plugin's own slot in the array", () => {
    const labeled = pluginById(presetStandard({ a11y: { label: "Routing proof" } }), "stargantt.a11y");
    const defaulted = pluginById(presetStandard(), "stargantt.a11y");

    const labeledRoot = document.createElement("div");
    const withLabel = createTestHost({
      element: labeledRoot,
      plugins: [dataStore(), ...routingProofSiblings(), labeled],
    });
    try {
      withLabel.host.service("stargantt.data").load(ONE_TASK);
      expect(labeledRoot.querySelector(".sg-a11y")?.getAttribute("aria-label")).toBe("Routing proof");
    } finally {
      withLabel.dispose();
    }

    const defaultRoot = document.createElement("div");
    const withDefault = createTestHost({
      element: defaultRoot,
      plugins: [dataStore(), ...routingProofSiblings(), defaulted],
    });
    try {
      withDefault.host.service("stargantt.data").load(ONE_TASK);
      // The built-in default (a11y/src/internal/mirror.ts `GRID_LABEL`) — proves the omitted-config
      // path is a genuinely different outcome from the labeled one above, not the same value twice.
      expect(defaultRoot.querySelector(".sg-a11y")?.getAttribute("aria-label")).toBe("Gantt chart");
    } finally {
      withDefault.dispose();
    }
  });

  // Same transposition-catch pattern, for the eighth slot: `config.scheduling` must reach the
  // *scheduling* factory's own slot, not a neighbor's. `stargantt.scheduling`'s only HARD
  // dependency is data-store (its chart-surface edges are all optional-with-inert-degradation —
  // scheduling.md §14), so this proof needs no `routingProofSiblings()` composition at all: a bare
  // `dataStore()` is enough to boot it and observe `autoSchedule.enabled` through the public
  // `SchedulerService.propagationEnabled()` reader — off by default (spec §11.2), so a swap with a
  // neighboring nest (which carries no `autoSchedule` field at all) would leave this reading at the
  // default `false` for BOTH compositions below, which is exactly what the two-sided comparison
  // catches.
  it("forwards config.scheduling to the scheduling plugin's own slot in the array", () => {
    const enabled = pluginById(
      presetStandard({ scheduling: { autoSchedule: { enabled: true } } }),
      "stargantt.scheduling",
    );
    const defaulted = pluginById(presetStandard(), "stargantt.scheduling");

    const withEnabled = createTestHost({
      element: document.createElement("div"),
      plugins: [dataStore(), enabled],
    });
    try {
      withEnabled.host.service("stargantt.data").load(ONE_TASK);
      expect(withEnabled.host.service("stargantt.scheduler").propagationEnabled()).toBe(true);
    } finally {
      withEnabled.dispose();
    }

    const withDefault = createTestHost({
      element: document.createElement("div"),
      plugins: [dataStore(), defaulted],
    });
    try {
      withDefault.host.service("stargantt.data").load(ONE_TASK);
      expect(withDefault.host.service("stargantt.scheduler").propagationEnabled()).toBe(false);
    } finally {
      withDefault.dispose();
    }
  });

  // Same transposition-catch pattern, for the ninth slot: `config.export` must reach the *export*
  // factory's own slot, not a neighbor's. `stargantt.export`'s hard dependencies are data-store and
  // view (docs/specs/plugins/export.md §10), so this proof reuses `routingProofSiblings()` exactly
  // as the interaction/a11y proofs above do. The observable is `ExportService.isReadOnly()` under
  // `viewerEmbed.readOnly` — config-driven only (the guard reads the resolved config at `setup()`
  // and never touches the view/timeline/theme stubs), so it needs no capture/print pipeline and no
  // real canvas. Default `false` (export.md §7) makes the two-sided comparison catch a swap with a
  // neighboring nest exactly as the scheduling proof's does: a neighbor's config carries no
  // `viewerEmbed` field at all, so a transposition bug would leave both sides reading `false`.
  it("forwards config.export to the export plugin's own slot in the array", () => {
    const readOnly = pluginById(
      presetStandard({ export: { viewerEmbed: { readOnly: true } } }),
      "stargantt.export",
    );
    const defaulted = pluginById(presetStandard(), "stargantt.export");

    const withReadOnly = createTestHost({
      element: document.createElement("div"),
      plugins: [dataStore(), ...routingProofSiblings(), readOnly],
    });
    try {
      withReadOnly.host.service("stargantt.data").load(ONE_TASK);
      expect(withReadOnly.host.service("stargantt.export").isReadOnly()).toBe(true);
    } finally {
      withReadOnly.dispose();
    }

    const withDefault = createTestHost({
      element: document.createElement("div"),
      plugins: [dataStore(), ...routingProofSiblings(), defaulted],
    });
    try {
      withDefault.host.service("stargantt.data").load(ONE_TASK);
      expect(withDefault.host.service("stargantt.export").isReadOnly()).toBe(false);
    } finally {
      withDefault.dispose();
    }
  });
});
