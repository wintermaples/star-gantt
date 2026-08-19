import MANIFEST from "../generated/content-manifest.json";
import { PLUGINS, shortName } from "../generated/api";
import type { CoreDoc, GuideDoc, PluginDoc, TokensDoc } from "./types";

/**
 * Content is discovered, not listed — and loaded per page, not up front.
 *
 * Every plugin page is one module under `plugins/<category>/<name>.ts`, every guide one module
 * under `guides/`, every core chapter one under `core/`. Nothing enumerates them by hand: the
 * generator walks those directories and writes `content-manifest.json`, so a file that exists is
 * documentation that ships and a plugin with no file is a hole the coverage test reports by name.
 * There is no third state where a page exists but no link reaches it.
 *
 * The globs below are **not** eager. The content is roughly a megabyte of prose across 75 modules,
 * and importing all of it to render one page meant every reader downloaded the whole site to read
 * any of it. What the nav, the router and the route list need is identity — a slug, a title, which
 * module backs which plugin — and that is exactly what the manifest holds, so none of them touches
 * a content module at all. A page's own module is fetched when the reader navigates to it.
 */
const pluginModules = import.meta.glob<{ default: PluginDoc }>("./plugins/**/*.ts");
const guideModules = import.meta.glob<{ default: GuideDoc }>("./guides/*.ts");
const coreModules = import.meta.glob<{ default: CoreDoc }>("./core/*.ts");

/** Slug and title only — the sidebar's rows, with no prose behind them. */
export interface PageRef {
  slug: string;
  title: string;
}

export const GUIDES: readonly PageRef[] = MANIFEST.guides.map(({ slug, title }) => ({ slug, title }));
export const CORE: readonly PageRef[] = MANIFEST.core.map(({ slug, title }) => ({ slug, title }));

const documentedIds = new Set(MANIFEST.plugins.map((entry) => entry.id));

/** Whether a plugin has a content module, without loading it. */
export const isDocumented = (id: string): boolean => documentedIds.has(id);

/**
 * Resolves one module through its glob loader.
 *
 * A manifest entry naming a module the glob does not know can only mean the manifest is stale
 * against the filesystem — which the coverage test catches by regenerating it — so this reports
 * that rather than resolving to a page that silently renders nothing.
 */
async function load<T>(
  modules: Record<string, () => Promise<{ default: T }>>,
  path: string | undefined,
): Promise<T | undefined> {
  if (path === undefined) return undefined;
  const loader = modules[path];
  if (loader === undefined) {
    throw new Error(`content-manifest.json names "${path}", which no content module matches`);
  }
  return (await loader()).default;
}

export const loadPluginDoc = (id: string): Promise<PluginDoc | undefined> =>
  load(pluginModules, MANIFEST.plugins.find((entry) => entry.id === id)?.module);

export const loadGuide = (slug: string): Promise<GuideDoc | undefined> =>
  load(guideModules, MANIFEST.guides.find((entry) => entry.slug === slug)?.module);

export const loadCore = (slug: string): Promise<CoreDoc | undefined> =>
  load(coreModules, MANIFEST.core.find((entry) => entry.slug === slug)?.module);

/**
 * The token reference is one page rather than a corpus, so it is named here rather than discovered.
 *
 * Everything else in this file is derived because there are dozens of them and a hand-kept list
 * would go stale; there is exactly one of these, and the manifest machinery would buy nothing. The
 * title is duplicated from the content module, which a test compares — a title that drifts from
 * the page it labels is the only failure the shortcut could cause, and it cannot survive the suite.
 */
export const TOKENS_PAGE = { title: "CSS tokens" } as const;

export const loadTokensDoc = async (): Promise<TokensDoc> => (await import("./tokens")).default;

/* ------------------------------------------------------------------ *
 * Routes — the single definition of every URL the site can produce.
 * ------------------------------------------------------------------ */

export const routes = {
  home: () => "/",
  guide: (slug: string) => `/guides/${slug}`,
  core: (slug: string) => `/core/${slug}`,
  plugin: (id: string) => `/reference/${shortName(id)}`,
  pluginConfig: (id: string) => `/reference/${shortName(id)}/config`,
  tokens: () => "/tokens",
} as const;

/** Every route the site is expected to serve, whether or not its content module exists yet. */
export function expectedRoutes(): readonly string[] {
  return [
    routes.home(),
    ...CORE.map((page) => routes.core(page.slug)),
    ...GUIDES.map((page) => routes.guide(page.slug)),
    ...PLUGINS.flatMap((plugin) => [routes.plugin(plugin.id), routes.pluginConfig(plugin.id)]),
    routes.tokens(),
  ];
}

/** Plugins in `api.json` with no content module — the documentation debt, by name. */
export function undocumentedPlugins(): readonly string[] {
  return PLUGINS.filter((plugin) => !isDocumented(plugin.id)).map((plugin) => plugin.id);
}
