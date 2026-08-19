/**
 * Scoring for the site's search box.
 *
 * No search library: the index is a few hundred entries of short strings, so ranking them is a loop
 * over substring tests, and a dependency would buy tokenisation and stemming that identifiers do
 * not benefit from. What identifiers *do* need is the thing a generic tokeniser gets wrong —
 * `rowHeight` has to be findable by typing `row height` — so titles are split on camel-case and on
 * the `.` and `/` that separate a service key from its namespace, and each part is matched in its
 * own right.
 *
 * Every term must match somewhere (AND, not OR): with 111 option names in the index, an OR search
 * for two words returns everything that has either, which is no answer at all.
 */

/** Which kind of thing a hit is. Mirrors `tools/build-content-index.ts`. */
export type SearchKind =
  | "guide"
  | "core"
  | "plugin"
  | "option"
  | "service"
  | "event"
  | "command"
  | "point"
  | "recipe"
  | "token";

export interface SearchEntry {
  kind: SearchKind;
  title: string;
  context: string;
  path: string;
  text: string;
  keywords?: string;
}

export interface SearchHit {
  entry: SearchEntry;
  score: number;
}

/**
 * How a kind breaks a tie. A reader who types a word that is both a guide title and an option name
 * is more often looking for the guide, and an exact identifier match already outscores everything
 * here by a wide margin — this only decides between hits that matched the same way.
 */
const KIND_WEIGHT: Record<SearchKind, number> = {
  guide: 8,
  core: 7,
  plugin: 6,
  option: 5,
  service: 4,
  command: 3,
  event: 3,
  point: 2,
  recipe: 1,
  token: 4,
};

/** Human-facing label for a kind, used by the result list. */
export const KIND_LABEL: Record<SearchKind, string> = {
  guide: "guide",
  core: "core",
  plugin: "plugin",
  option: "option",
  service: "service",
  event: "event",
  command: "command",
  point: "point",
  recipe: "recipe",
  token: "token",
};

/**
 * The searchable words of a title: the whole thing, plus its camel-case and separator-delimited
 * parts. `rowHeight` yields `rowheight`, `row`, `height`; `view/rowToggle` adds `view`, `rowtoggle`,
 * `row`, `toggle`.
 */
function wordsOf(title: string): string[] {
  const flat = title.toLowerCase();
  const parts = title
    .split(/[^A-Za-z0-9]+/)
    .flatMap((part) => part.split(/(?<=[a-z0-9])(?=[A-Z])/))
    .map((part) => part.toLowerCase())
    .filter((part) => part.length > 0);
  return [flat, ...parts];
}

interface Prepared {
  entry: SearchEntry;
  title: string;
  words: string[];
  haystack: string;
}

/** Pre-lowercases the index once, so a keystroke costs comparisons rather than allocations. */
export function prepare(entries: readonly SearchEntry[]): readonly Prepared[] {
  return entries.map((entry) => ({
    entry,
    title: entry.title.toLowerCase(),
    words: wordsOf(entry.title),
    haystack: `${entry.context} ${entry.text} ${entry.keywords ?? ""}`.toLowerCase(),
  }));
}

/** How well one term matches one entry. `0` means it does not, which drops the entry entirely. */
function scoreTerm(prepared: Prepared, term: string): number {
  const { title, words, haystack } = prepared;
  if (title === term) return 120;
  if (words.includes(term)) return 90;
  if (title.startsWith(term)) return 70;
  if (words.some((word) => word.startsWith(term))) return 50;
  if (title.includes(term)) return 35;
  if (haystack.includes(term)) return 12;
  return 0;
}

/** Splits a query into terms. Punctuation is kept: `view/rowToggle` is one term a reader may type. */
export function termsOf(query: string): string[] {
  return query
    .toLowerCase()
    .split(/\s+/)
    .map((term) => term.trim())
    .filter((term) => term.length > 0);
}

/**
 * The ranked hits for a query, best first, at most `limit`.
 *
 * An empty query returns nothing rather than everything: a list of 479 entries is not a useful
 * answer to "the reader has focused the box and typed nothing".
 */
export function search(
  prepared: readonly Prepared[],
  query: string,
  limit = 12,
): readonly SearchHit[] {
  const terms = termsOf(query);
  if (terms.length === 0) return [];

  const hits: SearchHit[] = [];
  for (const candidate of prepared) {
    let total = 0;
    for (const term of terms) {
      const score = scoreTerm(candidate, term);
      if (score === 0) {
        total = 0;
        break;
      }
      total += score;
    }
    if (total > 0) hits.push({ entry: candidate.entry, score: total });
  }

  hits.sort(
    (a, b) =>
      b.score - a.score ||
      KIND_WEIGHT[b.entry.kind] - KIND_WEIGHT[a.entry.kind] ||
      a.entry.title.length - b.entry.title.length ||
      a.entry.title.localeCompare(b.entry.title),
  );
  return hits.slice(0, limit);
}
