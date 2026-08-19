/**
 * `@stargantt/plugin-i18n` — plugin id `stargantt.i18n`.
 *
 * A multilingual label dictionary: per-locale translation tables with a configurable fallback
 * chain, published as the `stargantt.i18n` service so hosts can resolve user-visible strings in
 * the chart's language and build other plugins' message-catalog configs from one bundled
 * dictionary. With no configuration the dictionary is empty, every lookup misses, and the chart
 * renders exactly as if the plugin were absent.
 *
 * Composing this plugin alone changes no text on screen: every other plugin resolves its
 * `messages` catalog once, at its own `setup()`, and never consults this dictionary afterwards
 * (docs/specs/plugins/i18n.md §2). Build a chart's translated `messages` configs with the
 * hostless {@link createDictionary} instead, before `Gantt.create()`.
 */
import { definePlugin } from "@stargantt/core";
import type { Plugin, PluginContext } from "@stargantt/core";
import { createDictionaryEngine } from "./internal/dictionary";
import type { I18nConfig, I18nService } from "./types";

export type { I18nConfig, I18nService, I18nState, TranslationEntries } from "./types";

const PLUGIN_ID = "stargantt.i18n";

function setup(ctx: PluginContext, config: I18nConfig | undefined): void {
  // docs/specs/plugins/i18n.md §1.2 — the active locale defaults to the chart-wide locale; a
  // usable config.locale overrides it.
  const service = createDictionaryEngine(config, ctx.locale);
  ctx.provide("stargantt.i18n", service);
}

/**
 * Creates the i18n plugin: a registry of per-locale translation tables, published as the
 * `stargantt.i18n` service, that a host reads translations out of (typically via `catalog()`) to
 * build the `messages` configs it hands to the other plugin factories.
 *
 * Lookups scan the active locale, its shortened prefixes (`"ja-JP"` then `"ja"`), each configured
 * fallback likewise, and finally `"en"`; a key found nowhere resolves to `undefined` so callers
 * keep their own defaults. Every option is optional; omitting the config produces an empty
 * dictionary and leaves the rendered chart unchanged.
 */
export function i18n(config?: I18nConfig): Plugin<void> {
  // docs/specs/plugins/i18n.md § Config — the config is resolved once, at setup(): the engine
  // copies every field into its own state and never re-reads the object.
  const snapshot = typeof config === "object" && config !== null ? config : undefined;
  return definePlugin({
    meta: { id: PLUGIN_ID, dependsOn: [] },
    setup: (ctx: PluginContext): void => setup(ctx, snapshot),
  });
}

/**
 * Creates a standalone dictionary with the same lookup semantics as the plugin's service, usable
 * before `Gantt.create()`. This is the function that actually localizes a chart: composing the
 * i18n plugin puts no text on screen by itself, because each plugin's text comes from its own
 * `messages` config — and those plugin factories run before `Gantt.create()`, too early for the
 * plugin's service to feed them. Build the dictionary here first, derive each plugin's `messages`
 * object from it (typically via `catalog()`), and pass those objects to the sibling factories.
 * The default active locale is `"en"`, and its `state` store is fully functional
 * (docs/specs/plugins/i18n.md §1.5).
 */
export function createDictionary(config?: I18nConfig): I18nService {
  return createDictionaryEngine(config, "en");
}
