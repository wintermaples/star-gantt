/**
 * Public shapes of `@stargantt/plugin-i18n`, kept in one place so the internal modules can share
 * them without importing the plugin entry — and so the package's single `declare module
 * "@stargantt/core"` site (architecture.md ch. 1.4) lives here.
 */
// docs/specs/plugins/i18n.md §1
import type { Store } from "@stargantt/core";

/** One locale's translation table: flat dot-separated keys mapped to translated strings. */
export type TranslationEntries = Readonly<Record<string, string>>;

// docs/specs/plugins/i18n.md §1 — the observable dictionary snapshot; replaces the earlier
// implementation's `i18n/changed` event (§1.3).
/** The observable dictionary state, published on every change §1.3 defines as observable. */
export interface I18nState {
  /** The active locale (BCP-47). */
  readonly locale: string;
  /** The configured fallback chain, in order. */
  readonly fallbacks: readonly string[];
  /** The computed lookup order (lowercased, deduplicated, "en"-terminated). */
  readonly resolutionOrder: readonly string[];
  /** The registered locale tags, first-seen order, most-recent display casing. */
  readonly locales: readonly string[];
}

/**
 * The multilingual dictionary service: per-locale translation tables, an active locale with a
 * fallback chain, key lookup, and a message-catalog builder for other plugins' `messages` configs.
 */
export interface I18nService {
  /** Set on every observable dictionary change (§1.3): an effective mutator call. */
  readonly state: Store<Readonly<I18nState>>;
  /**
   * Changes the active locale. An unusable value (non-string or empty) is silently ignored, as is
   * a value equal to the current active locale — neither publishes a new `state`.
   */
  setLocale(locale: string): void;
  /**
   * Replaces the fallback chain. A non-array is ignored; non-string entries are dropped while
   * usable entries are kept. An empty array is honored. Any usable (array) call publishes,
   * regardless of whether the resulting chain differs from the previous one.
   */
  setFallbacks(chain: readonly string[]): void;
  /**
   * Merges entries into the named locale's table, key by key (last write wins). Unusable input —
   * a non-string/empty locale, a non-object table, or a non-string entry key/value — is silently
   * dropped, per entry. Publishes only when at least one entry was actually merged.
   */
  add(locale: string, entries: TranslationEntries): void;
  /** Removes a whole locale table. An unknown locale is ignored (no publish). */
  remove(locale: string): void;
  /**
   * Resolves a key through the fallback chain and returns the first translation found, or
   * `undefined` when no table in the chain holds the key (the caller keeps its own default).
   */
  t(key: string): string | undefined;
  /**
   * Whether `key` resolves: against one specific locale table exactly when `locale` is given,
   * else through the whole fallback chain.
   */
  has(key: string, locale?: string): boolean;
  /**
   * Builds a message-catalog object for another plugin's `messages` config: a copy of `defaults`
   * where every string-valued member `m` for which `t(prefix + "." + m)` resolves is replaced by
   * the translation. Function-valued members (builders) are never overridden. Unusable arguments
   * return `defaults` unchanged (same reference); `defaults` is never mutated.
   */
  catalog<T extends object>(prefix: string, defaults: T): T;
}

/** Options of the {@link i18n} factory and of `createDictionary`. Every field is optional. */
export interface I18nConfig {
  /**
   * The active locale, as a BCP-47 tag such as `"en"` or `"ja-JP"`. Defaults to the chart's
   * locale (`"en"` for the hostless dictionary). An unusable value is silently ignored.
   */
  locale?: string;
  /**
   * Fallback locales consulted, in order, after the active locale when a key is missing.
   * `"en"` is always appended as the terminal fallback. Default `["en"]`.
   */
  fallbacks?: readonly string[];
  /** Initial dictionaries, keyed by locale tag. Default: none. */
  translations?: Readonly<Record<string, TranslationEntries>>;
}

declare module "@stargantt/core" {
  interface Services {
    /** The multilingual dictionary: locale tables, fallback chain, lookup, catalog builder. */
    "stargantt.i18n": I18nService;
  }
}
