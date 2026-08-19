// Hostless unit tests of the dictionary engine.
// docs/specs/plugins/i18n.md §1.1-§1.5
import { describe, expect, it } from "vitest";
import { shortenedPrefixes } from "../src/internal/dictionary";
import { createDictionary } from "../src/index";
import type { I18nState } from "../src/index";

describe("shortenedPrefixes", () => {
  it("drops one subtag at a time, lowercased", () => {
    expect(shortenedPrefixes("ja-JP-u-ca")).toEqual(["ja-jp-u-ca", "ja-jp-u", "ja-jp", "ja"]);
    expect(shortenedPrefixes("EN")).toEqual(["en"]);
  });
});

describe("lookup and fallback chain", () => {
  it("resolves through active locale, its prefixes, fallbacks, then en", () => {
    const d = createDictionary({
      locale: "ja-JP",
      fallbacks: ["fr"],
      translations: {
        ja: { greet: "こんにちは" },
        fr: { bye: "au revoir" },
        en: { greet: "hello", bye: "bye", only: "en only" },
      },
    });
    expect(d.state.get().resolutionOrder).toEqual(["ja-jp", "ja", "fr", "en"]);
    expect(d.t("greet")).toBe("こんにちは"); // ja prefix beats en
    expect(d.t("bye")).toBe("au revoir"); // fr fallback beats en
    expect(d.t("only")).toBe("en only"); // terminal en
    expect(d.t("missing")).toBeUndefined();
  });

  it("matches locale tags case-insensitively and keeps display tags as supplied", () => {
    const d = createDictionary({ locale: "JA-jp", translations: { "Ja-JP": { k: "v" } } });
    expect(d.t("k")).toBe("v");
    expect(d.state.get().locales).toEqual(["Ja-JP"]);
  });

  // i18n.md §1.1 — a same-locale re-registration merges its entries into the same table and
  // updates the display tag: the last registration that contributed entries wins.
  it("updates the display tag to the last-registered casing across re-registration", () => {
    const d = createDictionary({ locale: "Ja-JP", translations: { "Ja-JP": { a: "1" } } });
    d.add("JA-jp", { b: "2" });
    expect(d.state.get().locales).toEqual(["JA-jp"]);
    expect(d.t("a")).toBe("1");
    expect(d.t("b")).toBe("2");
  });

  it("does not update the display tag on a merge that contributes no entries", () => {
    const d = createDictionary({ translations: { "Ja-JP": { a: "1" } } });
    d.add("JA-jp", { b: 2 as unknown as string }); // per-entry drop leaves nothing to merge — no publish
    // `state.get()` returns the last PUBLISHED snapshot, not a live read of the internal map — the
    // contributing-nothing `add()` above published nothing, so without forcing a fresh publish here
    // this assertion would only ever see the snapshot from BEFORE that call and could not detect a
    // wrongly-updated display tag. `setLocale` is an unrelated, always-publishing mutator (it does
    // not touch `displayTags`), so it forces `snapshot()` to recompute `locales` from the CURRENT map.
    d.setLocale("fr");
    expect(d.state.get().locales).toEqual(["Ja-JP"]);
  });

  it("takes the empty string verbatim as a usable translation", () => {
    const d = createDictionary({ translations: { en: { silent: "" } } });
    expect(d.t("silent")).toBe("");
    expect(d.has("silent")).toBe(true);
  });

  it("honors an empty fallback array (active + terminal en only)", () => {
    const d = createDictionary({
      locale: "ja",
      fallbacks: [],
      translations: { fr: { k: "non" }, en: { k: "yes" } },
    });
    expect(d.state.get().resolutionOrder).toEqual(["ja", "en"]);
    expect(d.t("k")).toBe("yes");
  });

  it("setLocale / setFallbacks change resolution; unusable values are ignored", () => {
    const d = createDictionary({
      translations: { de: { k: "de" }, en: { k: "en" } },
    });
    expect(d.state.get().locale).toBe("en");
    expect(d.t("k")).toBe("en");
    d.setLocale("de");
    expect(d.t("k")).toBe("de");
    d.setLocale("");
    d.setLocale(42 as unknown as string);
    expect(d.state.get().locale).toBe("de");
    d.setFallbacks(["fr", 7 as unknown as string, "de"]);
    expect(d.state.get().fallbacks).toEqual(["fr", "de"]);
    d.setFallbacks("nope" as unknown as string[]);
    expect(d.state.get().fallbacks).toEqual(["fr", "de"]);
  });
});

describe("add / remove", () => {
  it("merges per key, last write wins, drops non-string values per entry", () => {
    const d = createDictionary();
    d.add("en", { a: "1", b: "2" });
    d.add("en", { b: "3", c: 4 as unknown as string });
    expect(d.t("a")).toBe("1");
    expect(d.t("b")).toBe("3");
    expect(d.t("c")).toBeUndefined();
  });

  it("ignores unusable locales and tables; remove drops a whole table", () => {
    const d = createDictionary();
    d.add("", { a: "x" });
    d.add("en", null as unknown as Record<string, string>);
    d.add("en", ["x"] as unknown as Record<string, string>);
    // Every add() above is unusable and publishes nothing, so `state.get()` would otherwise still
    // be the store's pre-add() initial snapshot — force a fresh publish first so this really reads
    // the current (post-add()) `displayTags` map, not a stale value that was already `[]` before
    // any of these calls ran.
    d.setLocale("xx");
    expect(d.state.get().locales).toEqual([]);
    d.add("en", { a: "x" });
    d.remove("unknown");
    expect(d.t("a")).toBe("x");
    d.remove("EN"); // case-insensitive
    expect(d.t("a")).toBeUndefined();
    expect(d.state.get().locales).toEqual([]);
  });
});

// docs/specs/plugins/i18n.md §1.2 — "has(key, locale?) answers for one specific locale table
// exactly (no chain) when `locale` is given, else whether t(key) would hit."
describe("has(key, locale?) — the per-locale-exact form (no chain)", () => {
  it("hits when the key is in the named table", () => {
    const d = createDictionary({ translations: { ja: { greet: "こんにちは" } } });
    expect(d.has("greet", "ja")).toBe(true);
  });

  it("matches the locale tag case-insensitively", () => {
    const d = createDictionary({ translations: { ja: { greet: "こんにちは" } } });
    expect(d.has("greet", "EN")).toBe(false); // control: wrong table, still exercises the branch
    expect(d.has("greet", "JA")).toBe(true);
  });

  it("is false for a locale that does not hold the key, even though the fallback chain would hit", () => {
    // "en" is always the terminal fallback, so t()/has() without a locale WOULD hit here — proving
    // the per-locale form really bypasses the chain rather than silently falling through to it.
    const d = createDictionary({ locale: "ja", translations: { en: { greet: "hello" } } });
    expect(d.t("greet")).toBe("hello"); // chain form: hits via the terminal "en" fallback
    expect(d.has("greet")).toBe(true); // chain form, no locale: same hit
    expect(d.has("greet", "ja")).toBe(false); // per-locale form: "ja"'s own table has nothing
  });

  it("is false for an unusable (empty) locale argument", () => {
    const d = createDictionary({ translations: { en: { greet: "hello" } } });
    expect(d.has("greet", "")).toBe(false);
  });
});

describe("catalog()", () => {
  const defaults = {
    title: "Details",
    empty: "No task",
    format: (n: number) => `${n}%`,
  };

  it("overrides string members that resolve under the prefix, skips builders", () => {
    const d = createDictionary({
      locale: "ja",
      translations: { ja: { "sidePanel.title": "詳細", "sidePanel.format": "not-a-fn" } },
    });
    const out = d.catalog("sidePanel", defaults);
    expect(out.title).toBe("詳細");
    expect(out.empty).toBe("No task"); // no translation → default kept
    expect(out.format).toBe(defaults.format); // function member never overridden
    expect(out).not.toBe(defaults);
    expect(defaults.title).toBe("Details"); // never mutated
  });

  // docs/specs/plugins/i18n.md §1.4 — "the result is a fresh object" — verified beyond the
  // per-field checks above: a mutation of the returned catalog must never reach `defaults`.
  it("returns a fresh object even when nothing was overridden", () => {
    const d = createDictionary();
    const out = d.catalog("nothing", defaults);
    expect(out).not.toBe(defaults);
    expect(out).toEqual(defaults);
    (out as { title: string }).title = "mutated";
    expect(defaults.title).toBe("Details");
  });

  it("returns defaults unchanged (same reference) for unusable arguments", () => {
    const d = createDictionary();
    expect(d.catalog(1 as unknown as string, defaults)).toBe(defaults);
    expect(d.catalog("p", null as unknown as object)).toBeNull();
  });
});

describe("the state store (§1.3, replaces i18n/changed)", () => {
  it("publishes on every effective mutator call, including a translations-only merge", () => {
    const d = createDictionary({ translations: { en: { k: "v" } } });
    const seen: I18nState[] = [];
    d.state.subscribe((next) => seen.push(next));

    d.setLocale("ja");
    d.setLocale(""); // unusable → no publish
    d.setLocale("ja"); // unchanged → no publish
    d.setFallbacks(["fr"]);
    d.add("ja", { k: "や" });
    d.add("", { k: "x" }); // unusable → no publish
    d.remove("unknown"); // no-op → no publish
    d.remove("ja");

    expect(seen).toHaveLength(4);
    expect(seen[0]!.locale).toBe("ja");
    expect(seen[1]!.fallbacks).toEqual(["fr"]);
    // seen[2] is the translations-only add: every I18nState field is diff-less against seen[1]
    // (still locale "ja", fallbacks ["fr"]) — the notification itself is the only observable
    // signal.
    expect(seen[2]!.locale).toBe("ja");
    expect(seen[2]!.fallbacks).toEqual(["fr"]);
    expect(seen[3]!.locales).toEqual(["en"]); // the remove() drops "ja", leaving the seeded "en"
  });

  // Positive control for the negative assertions above: a call that changes nothing on the
  // dictionary (not merely "no I18nState field differs") really does publish nothing at all —
  // proven by contrast with an otherwise-identical call that DOES merge something.
  it("a no-op add() publishes nothing; the otherwise-identical merging call does", () => {
    const d = createDictionary();
    let count = 0;
    d.state.subscribe(() => (count += 1));

    d.add("en", { a: 1 as unknown as string }); // every entry dropped: nothing merged
    expect(count).toBe(0);

    d.add("en", { a: "1" }); // positive control: an otherwise-identical, usable call
    expect(count).toBe(1);
  });

  it("createDictionary()'s store is fully functional, independent of any host", () => {
    const d = createDictionary();
    const seen: string[] = [];
    d.state.subscribe((next) => seen.push(next.locale));
    d.setLocale("fr");
    expect(seen).toEqual(["fr"]);
    expect(d.state.get().locale).toBe("fr");
  });

  it("get() reflects the committed value even when read from inside a subscriber", () => {
    const d = createDictionary();
    let seenInside: string | undefined;
    d.state.subscribe(() => {
      seenInside = d.state.get().locale;
    });
    d.setLocale("de");
    expect(seenInside).toBe("de");
  });
});
