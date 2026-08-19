/**
 * The published surface of the `stargantt` meta-package.
 *
 * Runtime assertions on the
 * bundle's value exports, plus a handful of type-only imports as compile-time regression guards for
 * names that have no other nameable path for a `stargantt`-only consumer (see src/index.ts
 * "Standalone values contributed by preset plugins" / "Opt-in plugins" for why each group is here).
 *
 * This file resolves `@stargantt/*` workspace specifiers to their own `dist` (pnpm symlinks +
 * package.json "types"/"main"), so it already exercises every *dependency's* built output; it does
 * NOT exercise this package's own `dist/index.d.ts` — that is `test/type-probe.ts`'s job (wired
 * into `build`, not `test`), since `../src/index` and `dist/index.d.ts` are two different files.
 */
import { describe, expect, it } from "vitest";
import * as core from "@stargantt/core";
import * as bundle from "../src/index";
// Type-only imports so `tsc` fails this file if any of these names stops being re-exported by the
// bundle entry point — one representative name per group.
import type { CellRenderer, GridCell, ZoomLevelMetrics, A11yMessages, RegionCalendarInit } from "../src/index";
import type {
  BaselinesService,
  ResourcePoolService,
  DataSyncService,
  PortfolioService,
  I18nService,
  PerfToolsService,
} from "../src/index";

/** Compile-time-only check: never called, just keeps the imports "used". */
function _typeSurfaceCheck(
  cellRenderer: CellRenderer,
  gridCell: GridCell,
  zoomLevelMetrics: ZoomLevelMetrics,
  a11yMessages: A11yMessages,
  regionCalendarInit: RegionCalendarInit,
  baselinesService: BaselinesService,
  resourcePoolService: ResourcePoolService,
  dataSyncService: DataSyncService,
  portfolioService: PortfolioService,
  i18nService: I18nService,
  perfToolsService: PerfToolsService,
): unknown[] {
  return [
    cellRenderer,
    gridCell,
    zoomLevelMetrics,
    a11yMessages,
    regionCalendarInit,
    baselinesService,
    resourcePoolService,
    dataSyncService,
    portfolioService,
    i18nService,
    perfToolsService,
  ];
}
void _typeSurfaceCheck;

/** The complete runtime symbol set of the kernel (docs/specs/architecture.md). */
const CORE_VALUES = ["Gantt", "definePlugin"] as const;

describe("public symbols of the entry point", () => {
  it("re-exports every core value export it names explicitly", () => {
    for (const name of CORE_VALUES) {
      expect(bundle).toHaveProperty(name);
      expect(bundle[name]).toBe(core[name]);
    }
  });

  it("additionally exposes create and presetStandard", () => {
    expect(typeof bundle.create).toBe("function");
    expect(typeof bundle.presetStandard).toBe("function");
  });

  it("presetStandard() returns the nine official plugins in the documented order", () => {
    const ids = bundle.presetStandard().map((p) => p.meta.id);
    expect(ids).toEqual([
      "stargantt.data-store",
      "stargantt.view",
      "stargantt.tree-grid",
      "stargantt.task-bars",
      "stargantt.interaction",
      "stargantt.undo-redo",
      "stargantt.a11y",
      "stargantt.scheduling",
      "stargantt.export",
    ]);
  });

  it("exposes the six opt-in plugins as factories, outside the preset", () => {
    const factories = [
      ["tracking", "stargantt.tracking"],
      ["resource", "stargantt.resource"],
      ["dataSync", "stargantt.data-sync"],
      ["portfolio", "stargantt.portfolio"],
      ["i18n", "stargantt.i18n"],
      ["perfTools", "stargantt.perf-tools"],
    ] as const;
    const presetIds = bundle.presetStandard().map((p) => p.meta.id);
    for (const [name, id] of factories) {
      const factory = bundle[name] as () => { meta: { id: string } };
      expect(typeof factory, name).toBe("function");
      expect(factory().meta.id, name).toBe(id);
      // Each call yields its own instance, so two charts on a page never share plugin state.
      expect(factory(), name).not.toBe(factory());
      // Opt-in: never part of the standard preset.
      expect(presetIds, name).not.toContain(id);
    }
    // data-sync's hostless adapter/transport builders and i18n's pure dictionary builder.
    expect(typeof bundle.restAdapter).toBe("function");
    expect(typeof bundle.localAdapter).toBe("function");
    expect(typeof bundle.graphqlAdapter).toBe("function");
    expect(typeof bundle.webSocketTransport).toBe("function");
    expect(typeof bundle.sseTransport).toBe("function");
    expect(typeof bundle.createDictionary).toBe("function");
  });

  it("exposes the preset plugins' standalone values, with no service-typed path of their own", () => {
    expect(typeof bundle.dateEditor).toBe("function");
    expect(typeof bundle.selectEditor).toBe("function");
    expect(typeof bundle.regionCalendar).toBe("function");
    expect(bundle.regionCalendar({ id: "custom" }).id).toBe("custom");
    expect(typeof bundle.DEFAULT_MESSAGES).toBe("object");
    expect(typeof bundle.BUILT_IN_PRESETS).toBe("object");
    expect(typeof bundle.HIGH_CONTRAST_DARK).toBe("object");
    expect(typeof bundle.HIGH_CONTRAST_LIGHT).toBe("object");
    expect(typeof bundle.FORCED_COLOR_TOKENS).toBe("object");
    expect(typeof bundle.CANVAS_READ_TOKENS).toBe("object");
    expect(typeof bundle.NON_COLOR_CANVAS_TOKENS).toBe("object");
    expect(typeof bundle.RETIRED_TOKENS).toBe("object");
  });

  it("re-exports presetStandard's per-plugin config channel", () => {
    // A type, so the runtime check is that the argument is accepted and changes nothing about the
    // composition.
    const config: bundle.PresetStandardConfig = {
      treeGrid: { rowHeight: 40 },
      undoRedo: { limit: 50 },
    };
    const ids = bundle.presetStandard(config).map((p) => p.meta.id);
    expect(ids).toEqual(bundle.presetStandard().map((p) => p.meta.id));
  });

  it("create is an alias of Gantt.create, not a replacement for it", () => {
    expect(bundle.create).not.toBe(bundle.Gantt.create);
    expect(bundle.Gantt.create).toBe(core.Gantt.create);
  });
});

describe("declaration-carrying side-effect imports", () => {
  // Every one of the fifteen official plugins bundled here — preset-composed or opt-in — needs a
  // bare `import "<pkg>";` in the entry point, or its `declare module "@stargantt/core"`
  // augmentation never reaches a consumer who imports `stargantt` alone (src/index.ts file header).
  const bundledPlugins = [
    "@stargantt/plugin-data-store",
    "@stargantt/plugin-view",
    "@stargantt/plugin-tree-grid",
    "@stargantt/plugin-task-bars",
    "@stargantt/plugin-interaction",
    "@stargantt/plugin-undo-redo",
    "@stargantt/plugin-a11y",
    "@stargantt/plugin-scheduling",
    "@stargantt/plugin-export",
    "@stargantt/plugin-tracking",
    "@stargantt/plugin-resource",
    "@stargantt/plugin-data-sync",
    "@stargantt/plugin-portfolio",
    "@stargantt/plugin-i18n",
    "@stargantt/plugin-perf-tools",
  ] as const;

  it("side-effect imports every one of the fifteen official plugins", async () => {
    const { readFileSync } = await import("node:fs");
    const { dirname, resolve } = await import("node:path");
    const { fileURLToPath } = await import("node:url");
    const here = dirname(fileURLToPath(import.meta.url));
    const entrySource = readFileSync(resolve(here, "../src/index.ts"), "utf8");
    const sideEffectImports = new Set(
      [...entrySource.matchAll(/^import\s+"(@stargantt\/[^"]+)";$/gm)].map((m) => m[1]),
    );
    for (const pkg of bundledPlugins) {
      expect(sideEffectImports, `${pkg} has no bare side-effect import`).toContain(pkg);
    }
  });

  it("re-exports the COMPLETE export surface of every opt-in plugin (set equality)", async () => {
    // Guards the src/index.ts "Opt-in plugins" invariant: an opt-in package is never otherwise
    // imported by a stargantt-only program, so the bundle is the only place its names are
    // reachable — every export it gains must be re-exported here, and nothing internal may leak.
    // (Without this test the invariant would be true but unenforced — a new type added to an opt-in
    // package tomorrow would silently become unreachable with every gate green.)
    const { readFileSync } = await import("node:fs");
    const { dirname, resolve } = await import("node:path");
    const { fileURLToPath } = await import("node:url");
    const here = dirname(fileURLToPath(import.meta.url));
    const entrySource = readFileSync(resolve(here, "../src/index.ts"), "utf8");

    const OPT_IN = [
      "@stargantt/plugin-tracking",
      "@stargantt/plugin-resource",
      "@stargantt/plugin-data-sync",
      "@stargantt/plugin-portfolio",
      "@stargantt/plugin-i18n",
      "@stargantt/plugin-perf-tools",
    ] as const;

    /** Exported name from one entry of an `export { ... }` list (`x` or `x as y` → `y`). */
    const exportedName = (entry: string): string => {
      const parts = entry.split(/\s+as\s+/);
      return (parts[parts.length - 1] ?? "").trim();
    };

    /** Every exported name a built package declaration file publishes. */
    const packageExports = (pkg: string): Set<string> => {
      const dts = readFileSync(
        resolve(here, "../node_modules", pkg, "dist/index.d.ts"),
        "utf8",
      );
      if (/^export \*/m.test(dts)) {
        throw new Error(`${pkg} dist/index.d.ts uses "export *" — extend this parser`);
      }
      const names = new Set<string>();
      for (const m of dts.matchAll(/^export (?:type )?\{([^}]*)\}/gm)) {
        for (const entry of (m[1] ?? "").split(",")) {
          const name = exportedName(entry);
          if (name !== "") names.add(name);
        }
      }
      for (const m of dts.matchAll(/^export declare (?:function|const|class|enum) (\w+)/gm)) {
        if (m[1] !== undefined) names.add(m[1]);
      }
      for (const m of dts.matchAll(/^export (?:declare )?interface (\w+)/gm)) if (m[1] !== undefined) names.add(m[1]);
      for (const m of dts.matchAll(/^export type (\w+)\s*[=<]/gm)) if (m[1] !== undefined) names.add(m[1]);
      return names;
    };

    /** Every name the bundle entry re-exports from one specifier. */
    const bundleReexports = (pkg: string): Set<string> => {
      const names = new Set<string>();
      // [^}]* (never [\s\S]*?): the capture must stay inside ONE export statement — a lazy
      // any-char scan can start at an earlier package's `export {` and span across statements to
      // this package's closing brace, swallowing the genuine single-line factory export.
      const re = new RegExp(
        `export (?:type )?\\{([^}]*)\\}\\s*from\\s*"${pkg.replace("/", "\\/")}"`,
        "g",
      );
      for (const m of entrySource.matchAll(re)) {
        for (const entry of (m[1] ?? "").split(",")) {
          const name = exportedName(entry);
          if (name !== "") names.add(name);
        }
      }
      return names;
    };

    for (const pkg of OPT_IN) {
      const declared = packageExports(pkg);
      const reexported = bundleReexports(pkg);
      expect(declared.size, `${pkg}: parsed no exports — parser broken?`).toBeGreaterThan(0);
      const missing = [...declared].filter((n) => !reexported.has(n)).sort();
      const extra = [...reexported].filter((n) => !declared.has(n)).sort();
      expect(missing, `${pkg}: exported by the package but not re-exported by stargantt`).toEqual(
        [],
      );
      expect(extra, `${pkg}: re-exported by stargantt but not exported by the package`).toEqual([]);
    }
  });

  it("declares every bundled plugin package as its own dependency", async () => {
    const { readFileSync } = await import("node:fs");
    const { dirname, resolve } = await import("node:path");
    const { fileURLToPath } = await import("node:url");
    const here = dirname(fileURLToPath(import.meta.url));
    const own = JSON.parse(readFileSync(resolve(here, "../package.json"), "utf8")) as {
      dependencies?: Record<string, string>;
    };
    const declared = new Set(Object.keys(own.dependencies ?? {}));
    for (const pkg of bundledPlugins) {
      expect(declared, `${pkg} is bundled but not declared`).toContain(pkg);
    }
  });
});
