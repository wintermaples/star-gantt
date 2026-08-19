import snapshot from "./api.json";

export interface ApiMember {
  key: string;
  type: string;
  doc: string;
}

export interface ApiProperty {
  name: string;
  type: string;
  optional: boolean;
  doc: string;
}

export interface ApiPlugin {
  id: string;
  package: string;
  category: string;
  dir: string;
  factory: string | null;
  configType: string | null;
  config: ApiProperty[];
  dependsOn: string[];
  services: ApiMember[];
  events: ApiMember[];
  commands: ApiMember[];
  extensionPoints: ApiMember[];
  inPresetStandard: boolean;
  contract: string | null;
}

export interface ApiSnapshot {
  schemaVersion: number;
  core: { exports: string[]; interfaces: ApiProperty[] };
  plugins: ApiPlugin[];
}

/**
 * The library's API surface, extracted from its TypeScript sources by `tools/extract-api.ts`.
 *
 * Committed and verified: `test/api-json.test.ts` re-runs the extractor and fails on any
 * difference, so this file cannot quietly fall behind the code it describes.
 */
export const API = snapshot as ApiSnapshot;

export const PLUGINS: readonly ApiPlugin[] = API.plugins;

export const pluginById = (id: string): ApiPlugin | undefined => PLUGINS.find((p) => p.id === id);

/** Short name used in routes and headings: `stargantt.task-bars` → `task-bars`. */
export const shortName = (id: string): string => id.replace(/^stargantt\./, "");

export const CATEGORIES: readonly string[] = [...new Set(PLUGINS.map((p) => p.category))].sort();

/** Reading order for the sidebar: the plugins a default chart already has, then the opt-ins. */
export const CATEGORY_ORDER: readonly string[] = [
  "basic",
  "interaction",
  "scheduling",
  "resource",
  "export",
  "data",
  "dev",
  "portfolio",
];

export function pluginsByCategory(category: string): readonly ApiPlugin[] {
  return PLUGINS.filter((p) => p.category === category).sort((a, b) => a.id.localeCompare(b.id));
}

/** Total number of documented API members for a plugin, used for the tab counts. */
export function surfaceCounts(plugin: ApiPlugin): Record<string, number> {
  return {
    config: plugin.config.length,
    services: plugin.services.length,
    events: plugin.events.length,
    commands: plugin.commands.length,
    extensionPoints: plugin.extensionPoints.length,
  };
}
