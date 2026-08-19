/*
 * e2e/oa/boot-code.ts — turns one orthogonal-array run into playground-shell boot source.
 *
 * The shell evaluates a
 * `function boot({ mount, chrome, dataset, StarGantt })` block (examples/playground.js) — a run is
 * expressed as source text rather than a config object, because the level values in `catalog.json`
 * are JavaScript expressions (callbacks, adapters, canvas renderers) that no JSON round-trip could
 * carry. Every run loads all 15 official plugins — the 9 preset ones through `presetStandard(config)`
 * and the 6 opt-in ones as appended factories in dependency order — so plugin presence is a constant
 * of the experiment and only the config values vary (CLAUDE.md §0).
 *
 * The generated `boot` function only destructures `{ mount, StarGantt }`; the shell always calls it
 * with `{ mount, chrome, dataset, StarGantt }`, and JS object destructuring tolerates the extra
 * `chrome`/`dataset` properties silently, so this stays compatible with the real shell signature
 * without the generated code needing to reference them.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import { levelsForRun } from "./oa-array";

const HERE = dirname(fileURLToPath(import.meta.url));

export interface CatalogPlugin {
  id: string;
  factory: string;
  /**
   * The property key under `presetStandard({ ... })`'s config object, for preset plugins only.
   * Usually equal to `factory`, except `stargantt.export` (`factory: "exportPlugin"`, keyed
   * `export` in `PresetStandardConfig` — `export` is a reserved word as an identifier but not as
   * a property key, per `@stargantt/preset-standard`'s own doc comment on that field).
   */
  presetKey: string;
  category: string;
  inPreset: boolean;
  dependsOn: string[];
}

export interface CatalogFactor {
  id: string;
  plugin: string;
  field: string;
  type: string;
  /** `["(omit)", <L2 expression>, <L3 expression>]`. */
  levels: string[];
}

export interface Catalog {
  fixtures: string;
  plugins: CatalogPlugin[];
  factors: CatalogFactor[];
}

export const CATALOG: Catalog = JSON.parse(readFileSync(join(HERE, "catalog.json"), "utf8"));

/** The non-preset plugins, ordered so every plugin follows the ones it declares a dependency on. */
function appendedPluginOrder(): CatalogPlugin[] {
  const preset = new Set(CATALOG.plugins.filter((p) => p.inPreset).map((p) => p.id));
  const rest = CATALOG.plugins.filter((p) => !p.inPreset);
  const byId = new Map(rest.map((p) => [p.id, p]));
  const done = new Set<string>();
  const out: CatalogPlugin[] = [];
  const visit = (p: CatalogPlugin, seen: Set<string>): void => {
    if (done.has(p.id)) return;
    if (seen.has(p.id)) throw new Error(`dependency cycle at ${p.id}`);
    seen.add(p.id);
    for (const dep of p.dependsOn) {
      if (preset.has(dep)) continue; // already composed by the preset
      const next = byId.get(dep);
      if (next) visit(next, seen);
    }
    seen.delete(p.id);
    done.add(p.id);
    out.push(p);
  };
  for (const p of rest) visit(p, new Set());
  return out;
}

const APPENDED = appendedPluginOrder();

export interface RunConfig {
  run: number;
  /** Level index (0/1/2) per factor, in catalog order. */
  levels: number[];
  /** Factors the run moves off their default, as `factorId -> level index`. */
  nonDefault: { id: string; level: number; value: string }[];
  /** The `function boot(...)` source the playground shell evaluates. */
  code: string;
}

const indent = (text: string, pad: string): string =>
  text
    .split("\n")
    .map((line) => (line.length > 0 ? pad + line : line))
    .join("\n");

function configLiteral(fields: { field: string; expr: string }[], pad: string): string {
  const body = fields.map((f) => `${pad}  ${f.field}: ${indent(f.expr, pad + "  ").trimStart()},`);
  return `{\n${body.join("\n")}\n${pad}}`;
}

/**
 * Builds the boot source for one run of the array.
 *
 * The dataset is embedded in the source rather than handed to the shell's `applyDataset`, so a run
 * is one shell call (`__pg.run`) against one chart: no intermediate boot of the host page's own
 * demo code runs in between to muddy the console or the screenshot.
 */
export function buildRun(run: number, dataset: unknown): RunConfig {
  const levels = levelsForRun(run, CATALOG.factors.length);

  const perPlugin = new Map<string, { field: string; expr: string }[]>();
  const nonDefault: RunConfig["nonDefault"] = [];
  CATALOG.factors.forEach((factor, i) => {
    const level = levels[i]!;
    if (level === 0) return; // key omitted — the library default
    const expr = factor.levels[level]!;
    const list = perPlugin.get(factor.plugin) ?? [];
    list.push({ field: factor.field, expr });
    perPlugin.set(factor.plugin, list);
    nonDefault.push({ id: factor.id, level, value: expr });
  });

  const presetEntries = CATALOG.plugins
    .filter((p) => p.inPreset && perPlugin.has(p.id))
    .map((p) => `    ${p.presetKey}: ${indent(configLiteral(perPlugin.get(p.id)!, "    "), "    ").trimStart()},`);

  const appended = APPENDED.map((p) => {
    const fields = perPlugin.get(p.id);
    const arg = fields ? indent(configLiteral(fields, "    "), "    ").trimStart() : "";
    return `    StarGantt.${p.factory}(${arg}),`;
  });

  const code = `function boot({ mount, StarGantt }) {
${indent(CATALOG.fixtures, "  ")}

  const OA_RUN_DATASET = ${JSON.stringify(dataset)};

  const preset = StarGantt.presetStandard({
${presetEntries.join("\n")}
  });

  const gantt = StarGantt.create({
    element: mount,
    plugins: [
      ...preset,
${appended.map((line) => "  " + line).join("\n")}
    ],
  });

  gantt.service("stargantt.data").load(OA_RUN_DATASET);
  return gantt;
}`;

  return { run, levels, nonDefault, code };
}
