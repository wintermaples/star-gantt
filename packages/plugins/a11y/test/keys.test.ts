// docs/specs/plugins/a11y.md § Extension points — "Chord syntax".
import { describe, expect, it } from "vitest";
import { canonicalChord, chordCache, matches, parseChord } from "../src/internal/keys";
import type { KeyStroke } from "../src/internal/keys";

function stroke(key: string, mods: Partial<KeyStroke> = {}): KeyStroke {
  return {
    key,
    ctrlKey: mods.ctrlKey ?? false,
    altKey: mods.altKey ?? false,
    shiftKey: mods.shiftKey ?? false,
    metaKey: mods.metaKey ?? false,
  };
}

function hit(spec: string, s: KeyStroke): boolean {
  const chord = parseChord(spec);
  return chord !== undefined && matches(chord, s);
}

describe("parseChord", () => {
  it("reads a bare key", () => {
    expect(parseChord("ArrowDown")).toEqual({
      ctrl: false,
      alt: false,
      meta: false,
      shift: false,
      key: "ArrowDown",
    });
  });

  it("reads modifiers in any order and any case", () => {
    expect(parseChord("shift+CTRL+z")).toEqual(parseChord("Ctrl+Shift+Z"));
  });

  it("accepts `Control` as an alias of `Ctrl`", () => {
    expect(parseChord("Control+Z")).toEqual(parseChord("Ctrl+Z"));
  });

  it("treats a trailing + as the key itself", () => {
    const chord = parseChord("+");
    expect(chord?.key).toBe("+");
    expect(chord?.ctrl).toBe(false);
  });

  it("rejects an unknown modifier and an empty key", () => {
    expect(parseChord("Hyper+K")).toBeUndefined();
    expect(parseChord("")).toBeUndefined();
  });
});

describe("matches", () => {
  it("matches a single letter case-insensitively", () => {
    expect(hit("Ctrl+Z", stroke("z", { ctrlKey: true }))).toBe(true);
    expect(hit("Ctrl+Z", stroke("Z", { ctrlKey: true }))).toBe(true);
  });

  it("keeps Ctrl+Z and Ctrl+Shift+Z apart", () => {
    expect(hit("Ctrl+Z", stroke("Z", { ctrlKey: true, shiftKey: true }))).toBe(false);
    expect(hit("Ctrl+Shift+Z", stroke("Z", { ctrlKey: true, shiftKey: true }))).toBe(true);
  });

  it("ignores the shift state of a punctuation key", () => {
    expect(hit("+", stroke("+", { shiftKey: true }))).toBe(true);
    expect(hit("+", stroke("+"))).toBe(true);
    expect(hit("-", stroke("-"))).toBe(true);
  });

  it("honours an explicitly named Shift on a punctuation key", () => {
    expect(hit("Shift++", stroke("+"))).toBe(false);
    expect(hit("Shift++", stroke("+", { shiftKey: true }))).toBe(true);
  });

  it("requires every named modifier", () => {
    expect(hit("Ctrl+Z", stroke("z"))).toBe(false);
    expect(hit("ArrowDown", stroke("ArrowDown", { altKey: true }))).toBe(false);
    expect(hit("Meta+K", stroke("k", { metaKey: true }))).toBe(true);
  });

  // The space bar's `KeyboardEvent.key` is the single character `" "`, not a name, so
  // `"Ctrl+Space"` (this plugin's own default chord) must still match it.
  it("matches Ctrl+Space against the real space-bar key value", () => {
    expect(hit("Ctrl+Space", stroke(" ", { ctrlKey: true }))).toBe(true);
    expect(hit("Ctrl+Space", stroke(" "))).toBe(false); // ctrl not held
    expect(hit("Space", stroke(" "))).toBe(true);
  });
});

describe("canonicalChord", () => {
  it("gives two spellings of one chord the same identity", () => {
    const a = parseChord("shift+CTRL+z");
    const b = parseChord("Ctrl+Shift+Z");
    expect(a !== undefined && b !== undefined && canonicalChord(a) === canonicalChord(b)).toBe(true);
  });

  it("keeps different chords apart", () => {
    const ctrlZ = parseChord("Ctrl+Z");
    const metaZ = parseChord("Meta+Z");
    expect(ctrlZ !== undefined && metaZ !== undefined).toBe(true);
    expect(canonicalChord(ctrlZ!)).not.toBe(canonicalChord(metaZ!));
  });
});

describe("chordCache", () => {
  it("remembers both parsed and unparseable specs", () => {
    const cache = chordCache();
    expect(cache("Ctrl+Z")).toEqual(cache("Ctrl+Z"));
    expect(cache("Hyper+K")).toBeUndefined();
    expect(cache("Hyper+K")).toBeUndefined();
  });
});
