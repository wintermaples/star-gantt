/**
 * The CSS token reference: the page's promise, tested.
 *
 * That promise is unusually strong — "if a name is not on this page, the library does not have it"
 * — and it is the only thing a reader restyling a chart can act on, because a token they cannot
 * find is indistinguishable from one that does not exist. So the checks here run in both
 * directions: the committed snapshot must match what a fresh extraction produces, every `--sg-*`
 * the library's own sources use must appear in it, and every group of it must carry the sentence
 * that says what those tokens paint.
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { buildTokens, documentedNames, scanSourceTokens, serialize } from "../tools/extract-tokens";
import { TOKENS, tokensOf, valueIn } from "../src/generated/tokens";
import { TOKENS_PAGE, expectedRoutes, routes } from "../src/content/registry";
import { segmentsOf } from "../src/lib/inline";
import INDEX from "../src/generated/search-index.json";
import DOC from "../src/content/tokens";

const HERE = dirname(fileURLToPath(import.meta.url));
const DOCS_ROOT = join(HERE, "..");

describe("tokens.json", () => {
  it("matches what the extractor produces from the current sources", () => {
    const onDisk = readFileSync(join(DOCS_ROOT, "src/generated/tokens.json"), "utf8");
    const fresh = serialize(buildTokens());
    expect(
      onDisk === fresh
        ? "up to date"
        : "stale — run `node tools/extract-tokens.ts` and review the diff before committing",
    ).toBe("up to date");
  });

  it("found the registry rather than parsing an empty table", () => {
    // Every assertion below is over this list; a parse that silently matched nothing would make
    // all of them vacuously true.
    expect(TOKENS.tokens.length).toBeGreaterThan(100);
    expect(TOKENS.groups.length).toBeGreaterThan(5);
  });

  it("gives every token a light value and a kind", () => {
    const broken = TOKENS.tokens
      .filter((token) => token.light.trim() === "" || token.kind === undefined)
      .map((token) => token.name);
    expect(broken).toEqual([]);
  });

  it("resolves both schemes for every token", () => {
    // A token with no dark value is identical in both schemes, not missing one — asking for dark
    // has to answer with the shared value rather than with nothing.
    const empty = TOKENS.tokens.filter((token) => valueIn(token, "dark").trim() === "").map((t) => t.name);
    expect(empty).toEqual([]);
  });

  it("lists each token exactly once, in exactly one group", () => {
    const names = TOKENS.tokens.map((token) => token.name);
    expect(names.length).toBe(new Set(names).size);
    const grouped = TOKENS.groups.flatMap((group) => group.tokens);
    expect(grouped.length).toBe(new Set(grouped).size);
    expect([...grouped].sort()).toEqual([...names].sort());
  });

  it("resolves every group's tokens", () => {
    const unresolved = TOKENS.groups
      .filter((group) => tokensOf(group).length !== group.tokens.length)
      .map((group) => group.id);
    expect(unresolved).toEqual([]);
  });

  it("carries no ruling or section reference into the reader's prose", () => {
    // The contract writes its parentheticals for a reader of the contract. A-nn and §n.n mean
    // nothing to someone restyling a chart, and the extractor strips them (docs-policy.md D-18).
    const leaked = TOKENS.tokens.filter((token) => /\bA-\d+\b|§/.test(token.note)).map((token) => token.name);
    expect(leaked).toEqual([]);
  });

  it("leaves no unpaired code mark in an extracted note", () => {
    const unpaired = TOKENS.tokens
      .filter((token) => (token.note.match(/`/g) ?? []).length % 2 !== 0)
      .map((token) => token.name);
    expect(unpaired).toEqual([]);
  });
});

/* ------------------------------------------------------------------ *
 * The guarantee: nothing the library uses is missing from the page.
 * ------------------------------------------------------------------ */

describe("coverage of the library's own sources", () => {
  const scanned = scanSourceTokens();

  it("scanned a real corpus", () => {
    expect(scanned.size).toBeGreaterThan(100);
  });

  it("documents every --sg-* the library uses", () => {
    const known = documentedNames(TOKENS);
    const missing = [...scanned]
      .filter(([name]) => !known.has(name))
      .map(([name, files]) => `${name} — used in ${files[0] ?? "?"}`);
    expect(missing, "run `node tools/extract-tokens.ts`; a genuinely new token needs a registry row").toEqual([]);
  });

  it("invents no token the library does not use", () => {
    // The other direction: a row for a name nothing reads is a page telling a reader to set
    // something that has no effect, which is exactly what the retired list exists to warn about.
    const documented = [...TOKENS.tokens, ...TOKENS.derived, ...TOKENS.published].map((token) => token.name);
    const phantom = documented.filter((name) => !scanned.has(name));
    expect(phantom).toEqual([]);
  });

  it("keeps the retired names out of the live list", () => {
    const live = new Set(TOKENS.tokens.map((token) => token.name));
    expect(TOKENS.retired.filter((token) => live.has(token.name)).map((t) => t.name)).toEqual([]);
    expect(TOKENS.retired.filter((token) => token.advice.trim().length < 10)).toEqual([]);
  });
});

/* ------------------------------------------------------------------ *
 * The written half.
 * ------------------------------------------------------------------ */

/** Every string on the token page an author wrote by hand. */
function authoredStrings(): string[] {
  return [
    DOC.lede,
    ...DOC.sections.flatMap((section) => [section.heading, ...section.paragraphs]),
    ...DOC.groups.flatMap((group) => [group.title, group.prose]),
    ...Object.values(DOC.appendix),
  ];
}

describe("the token page's prose", () => {
  it("explains every group, and no group that does not exist", () => {
    const generated = TOKENS.groups.map((group) => group.id).sort();
    const written = DOC.groups.map((group) => group.id).sort();
    expect(written, "a new group needs a title and a sentence in src/content/tokens.ts").toEqual(generated);
  });

  it("gives every group a title and a real explanation", () => {
    for (const group of DOC.groups) {
      expect(group.title.trim().length, `${group.id} title`).toBeGreaterThan(2);
      expect(group.prose.trim().length, `${group.id} prose`).toBeGreaterThan(80);
      expect(group.title, `${group.id} title`).not.toContain("`");
    }
  });

  it("writes the guidance a generator could not", () => {
    expect(DOC.sections.length).toBeGreaterThanOrEqual(4);
    for (const section of DOC.sections) {
      expect(section.heading.trim()).not.toBe("");
      expect(section.paragraphs.length).toBeGreaterThanOrEqual(2);
      for (const paragraph of section.paragraphs) expect(paragraph.trim().length).toBeGreaterThan(80);
    }
  });

  it("says what each of the three closing lists is", () => {
    for (const [name, text] of Object.entries(DOC.appendix)) {
      expect(text.trim().length, `${name} appendix`).toBeGreaterThan(80);
    }
  });

  it("leaves no unpaired code mark in any authored string", () => {
    const unpaired = authoredStrings().filter((text) => (text.match(/`/g) ?? []).length % 2 !== 0);
    expect(unpaired).toEqual([]);
  });

  it("carries no markdown the renderer does not implement", () => {
    // The same rule the rest of the corpus is held to: the mark is the only markup, so a
    // `**bold**` written out of habit reaches the page with its asterisks showing.
    const leaked = authoredStrings().filter((text) => /\*\*[^*]+\*\*|\[[^\]]+\]\([^)]+\)/.test(text));
    expect(leaked).toEqual([]);
  });

  it("renders its marks as code spans rather than as backticks", () => {
    // The one thing `RichText` does; a paragraph whose marks do not split is a paragraph that
    // prints its own markup.
    const marked = DOC.groups.find((group) => group.prose.includes("`"));
    expect(marked).toBeDefined();
    expect(segmentsOf(marked!.prose).some((segment) => segment.code)).toBe(true);
  });

  it("labels the page the same way the sidebar does", () => {
    expect(TOKENS_PAGE.title).toBe(DOC.title);
  });
});

/* ------------------------------------------------------------------ *
 * Reachability.
 * ------------------------------------------------------------------ */

describe("the token page's route", () => {
  it("is a route the site serves", () => {
    expect(expectedRoutes()).toContain(routes.tokens());
  });

  it("is where every token's search hit lands", () => {
    const hits = INDEX.entries.filter((entry) => entry.kind === "token");
    expect(hits.length).toBe(TOKENS.tokens.length);
    const wrong = hits.filter((entry) => entry.path !== `${routes.tokens()}?t=${entry.title}`);
    expect(wrong.map((entry) => entry.path)).toEqual([]);
  });

  it("indexes every token by name", () => {
    const indexed = new Set(INDEX.entries.filter((entry) => entry.kind === "token").map((entry) => entry.title));
    const missing = TOKENS.tokens.filter((token) => !indexed.has(token.name)).map((token) => token.name);
    expect(missing).toEqual([]);
  });
});
