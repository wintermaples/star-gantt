/**
 * Hostless dictionary engine: locale tables, fallback-chain resolution, the `state` store and the
 * catalog builder. No `@stargantt/core` runtime import beyond `createStore` — unit-testable
 * without booting a host.
 */
// docs/specs/plugins/i18n.md §1.1-§1.5
import { createStore } from "@stargantt/core";
import type { I18nConfig, I18nService, I18nState, TranslationEntries } from "../types";

/** A usable locale tag: a non-empty string. */
function usableTag(v: unknown): v is string {
  return typeof v === "string" && v.length > 0;
}

function norm(tag: string): string {
  return tag.toLowerCase();
}

/**
 * A tag followed by its progressively shortened prefixes, lowercased:
 * `"ja-JP-u-ca"` → `["ja-jp-u-ca", "ja-jp-u", "ja-jp", "ja"]`.
 */
// docs/specs/plugins/i18n.md §1.2 rule 1
export function shortenedPrefixes(tag: string): string[] {
  const out: string[] = [];
  let t = norm(tag);
  for (;;) {
    out.push(t);
    const cut = t.lastIndexOf("-");
    if (cut <= 0) return out;
    t = t.slice(0, cut);
  }
}

/**
 * Creates the dictionary engine. `defaultLocale` is `PluginContext.locale` for the plugin's own
 * `setup()`, `"en"` for the hostless `createDictionary()` (§1.5) — the only difference between the
 * two call sites; everything else, including the `state` store, is identical and fully functional
 * in both forms (§1.5's store-ization of the hostless form).
 */
export function createDictionaryEngine(
  config: I18nConfig | undefined,
  defaultLocale: string,
): I18nService {
  // docs/specs/plugins/i18n.md §1.2, config table — unusable values fall back silently.
  const cfgLocale = config?.locale;
  let active = usableTag(cfgLocale) ? cfgLocale : defaultLocale;
  const cfgFallbacks = config?.fallbacks;
  let fallbacks: string[] = Array.isArray(cfgFallbacks) ? cfgFallbacks.filter(usableTag) : ["en"];

  /** normalized tag → (key → text); insertion order is first-seen registration order. */
  const tables = new Map<string, Map<string, string>>();
  /** normalized tag → the tag as most recently supplied (last contributing merge wins), for `locales`. */
  const displayTags = new Map<string, string>();

  /** Merges usable entries into `locale`'s table; returns whether anything actually changed. */
  const merge = (locale: unknown, entries: unknown): boolean => {
    if (!usableTag(locale)) return false;
    if (typeof entries !== "object" || entries === null || Array.isArray(entries)) return false;
    const key = norm(locale);
    let table = tables.get(key);
    let changed = false;
    for (const [k, v] of Object.entries(entries as Record<string, unknown>)) {
      if (typeof v !== "string") continue; // per-entry drop, §1.1
      if (table === undefined) {
        table = new Map();
        tables.set(key, table);
      }
      table.set(k, v);
      changed = true;
    }
    // §1.1 — a re-registration under a differently cased/spelled tag of the same locale updates
    // the display tag: the last merge that actually contributed entries wins.
    if (changed) displayTags.set(key, locale);
    return changed;
  };

  // Initial `config.translations` are applied through the same `merge` path before the store's
  // initial snapshot is taken (§ Config `translations` row), so no publish is needed for them.
  if (typeof config?.translations === "object" && config.translations !== null) {
    for (const [tag, entries] of Object.entries(config.translations)) merge(tag, entries);
  }

  const order = (): string[] => {
    const seen = new Set<string>();
    const out: string[] = [];
    const push = (tag: string): void => {
      for (const p of shortenedPrefixes(tag)) {
        if (seen.has(p)) continue;
        seen.add(p);
        out.push(p);
      }
    };
    push(active);
    for (const f of fallbacks) push(f);
    if (!seen.has("en")) {
      seen.add("en");
      out.push("en");
    }
    return out;
  };

  const lookup = (key: string): string | undefined => {
    if (typeof key !== "string") return undefined;
    for (const tag of order()) {
      const hit = tables.get(tag)?.get(key);
      if (hit !== undefined) return hit;
    }
    return undefined;
  };

  const snapshot = (): I18nState => ({
    locale: active,
    fallbacks: [...fallbacks],
    resolutionOrder: order(),
    locales: [...displayTags.values()],
  });

  // docs/specs/plugins/i18n.md §1.3 — the `state` store replaces `i18n/changed`. `createStore` is
  // context-free, so this works identically for both the plugin's provided service and the
  // hostless `createDictionary()`.
  const state = createStore<I18nState>(snapshot());
  const publish = (): void => state.set(snapshot());

  return {
    state,
    setLocale(locale): void {
      if (!usableTag(locale) || locale === active) return;
      active = locale;
      publish();
    },
    setFallbacks(chain): void {
      if (!Array.isArray(chain)) return;
      fallbacks = chain.filter(usableTag);
      // §1.3 — stores perform no equality gating; every usable (array) call publishes, even one
      // that leaves the effective chain unchanged.
      publish();
    },
    add(locale, entries): void {
      if (merge(locale, entries)) publish();
    },
    remove(locale): void {
      if (!usableTag(locale)) return;
      const key = norm(locale);
      if (!tables.delete(key)) return;
      displayTags.delete(key);
      publish();
    },
    t: lookup,
    has(key, locale?): boolean {
      if (typeof key !== "string") return false;
      if (locale !== undefined) {
        return usableTag(locale) ? tables.get(norm(locale))?.has(key) === true : false;
      }
      return lookup(key) !== undefined;
    },
    catalog<T extends object>(prefix: string, defaults: T): T {
      // docs/specs/plugins/i18n.md §1.4
      if (typeof prefix !== "string") return defaults;
      if (typeof defaults !== "object" || defaults === null) return defaults;
      const out = { ...defaults } as Record<string, unknown>;
      for (const [member, value] of Object.entries(defaults)) {
        if (typeof value !== "string") continue; // never override a function builder
        const hit = lookup(`${prefix}.${member}`);
        if (hit !== undefined) out[member] = hit;
      }
      return out as T;
    },
  };
}
