import type { CoreDoc, GuideDoc, PluginDoc } from "../src/content/types";

/**
 * Every content module, imported eagerly — for the tests, and only for the tests.
 *
 * The site itself fetches one page's module at a time (`src/content/registry.ts`), so the eager
 * globs live here rather than there: an eager glob compiles to a static import of everything it
 * matches, and one left in `src/` would put the whole megabyte of prose back in the bundle no
 * matter how the site loads it. Nothing under `src/` imports this file.
 *
 * The tests want the opposite of what the site wants — every document at once, synchronously, so a
 * `describe.each` can name each one — which is exactly what this gives them.
 */
const collect = <T>(modules: Record<string, { default: T }>): readonly T[] =>
  Object.keys(modules)
    .sort()
    .map((path) => modules[path]!.default);

export const PLUGIN_DOCS: readonly PluginDoc[] = collect(
  import.meta.glob<{ default: PluginDoc }>("../src/content/plugins/**/*.ts", { eager: true }),
);
export const GUIDE_DOCS: readonly GuideDoc[] = collect(
  import.meta.glob<{ default: GuideDoc }>("../src/content/guides/*.ts", { eager: true }),
);
export const CORE_DOCS: readonly CoreDoc[] = collect(
  import.meta.glob<{ default: CoreDoc }>("../src/content/core/*.ts", { eager: true }),
);
