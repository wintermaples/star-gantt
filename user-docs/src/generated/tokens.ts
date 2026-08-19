import snapshot from "./tokens.json";

export type TokenKind = "color" | "length" | "number" | "font" | "text";

export interface TokenDoc {
  name: string;
  group: string;
  kind: TokenKind;
  light: string;
  dark: string | null;
  canvasRead: boolean;
  forcedColor: string | null;
  readers: string[];
  note: string;
}

export interface DerivedToken {
  name: string;
  value: string;
}

export interface PublishedToken {
  name: string;
}

export interface RetiredToken {
  name: string;
  advice: string;
}

export interface TokenGroup {
  id: string;
  kind: "base" | "plugin" | "family";
  tokens: string[];
}

export interface TokenSnapshot {
  schemaVersion: number;
  groups: TokenGroup[];
  tokens: TokenDoc[];
  derived: DerivedToken[];
  published: PublishedToken[];
  retired: RetiredToken[];
}

/**
 * Every CSS custom property the library declares, publishes or has retired, extracted from its
 * sources and its token registry by `tools/extract-tokens.ts`.
 *
 * Committed and verified twice over: the extractor refuses to write a snapshot that omits a token
 * the sources use, and `test/tokens.test.ts` re-runs it and fails on any difference. That pairing
 * is what lets the page state, as a fact rather than as a hope, that a name it does not list is a
 * name the library does not have.
 */
export const TOKENS = snapshot as TokenSnapshot;

const byName = new Map(TOKENS.tokens.map((token) => [token.name, token]));

export const tokenByName = (name: string): TokenDoc | undefined => byName.get(name);

/** One group's tokens, resolved, in the registry's own order. */
export function tokensOf(group: TokenGroup): TokenDoc[] {
  return group.tokens.map((name) => byName.get(name)).filter((token): token is TokenDoc => token !== undefined);
}

/** How many tokens a canvas painter reads — the size of the set a replacement palette must cover. */
export const CANVAS_READ_COUNT = TOKENS.tokens.filter((token) => token.canvasRead).length;

/**
 * A token's value in one scheme. A token with no dark value is deliberately identical in both, so
 * asking for either scheme gives the same answer rather than nothing.
 */
export function valueIn(token: TokenDoc, scheme: "light" | "dark"): string {
  return scheme === "dark" ? (token.dark ?? token.light) : token.light;
}

/** Whether a value is one CSS colour a swatch can paint, rather than a font stack or a length. */
export const isPaintable = (token: TokenDoc): boolean => token.kind === "color";
