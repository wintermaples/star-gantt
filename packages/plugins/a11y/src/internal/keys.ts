// docs/specs/plugins/a11y.md § Extension points — "Chord syntax".
/**
 * Key-string parsing and matching for the `keys/bindings` extension point.
 *
 * A binding names its chord as `Modifier+Modifier+KEY`, e.g. `"Ctrl+Z"`, `"Ctrl+Shift+Z"`,
 * `"ArrowDown"`, `"+"`. Parsing is order-insensitive and case-insensitive, so `"shift+ctrl+z"`
 * and `"Ctrl+Shift+Z"` are the same chord. The recognized modifiers are Ctrl (alias Control), Alt,
 * Shift and Meta, the last being what macOS chords such as Command+Z are written with
 * (`@stargantt/plugin-undo-redo` binds `"Meta+Z"` by default).
 */

/** The pieces of a parsed key string. */
export interface Chord {
  ctrl: boolean;
  alt: boolean;
  meta: boolean;
  /** `undefined` = the shift state is not compared (see {@link parseChord}). */
  shift: boolean | undefined;
  /** Normalized key name: single characters upper-cased, longer names kept verbatim. */
  key: string;
}

/** The parts of a keyboard event this module compares against a chord. */
export interface KeyStroke {
  key: string;
  ctrlKey: boolean;
  altKey: boolean;
  shiftKey: boolean;
  metaKey: boolean;
}

// The space bar's `KeyboardEvent.key` is the single character `" "`, not a name, so a binding
// written as `"Ctrl+Space"` (the readable spelling this plugin's own default binding uses) would
// otherwise never match it. `" "` is canonicalized to the literal `"Space"` on both sides of the
// comparison; every other single-character key still just upper-cases.
function normalizeKey(key: string): string {
  if (key === " ") return "Space";
  return key.length === 1 ? key.toUpperCase() : key;
}

/** Whether the key is one whose character already encodes the shift state (`+`, `-`, `/`, …). */
function isPunctuation(key: string): boolean {
  return key.length === 1 && !/[A-Z0-9]/.test(key);
}

/**
 * Parses a key string such as `"Ctrl+Shift+Z"`.
 *
 * Returns `undefined` when the string names an unknown modifier or carries no key at all; such a
 * binding simply never matches.
 */
export function parseChord(spec: string): Chord | undefined {
  let key: string;
  let mods: string[];
  if (spec.endsWith("+")) {
    // The key itself is "+", so the final separator belongs to it.
    key = "+";
    mods = spec.slice(0, -1).split("+");
  } else {
    const parts = spec.split("+");
    key = parts.pop() ?? "";
    mods = parts;
  }
  if (key === "") return undefined;

  const chord: Chord = {
    ctrl: false,
    alt: false,
    meta: false,
    shift: false,
    key: normalizeKey(key),
  };
  let shiftNamed = false;
  for (const raw of mods) {
    const mod = raw.trim().toLowerCase();
    if (mod === "") continue;
    if (mod === "ctrl" || mod === "control") chord.ctrl = true;
    else if (mod === "alt") chord.alt = true;
    else if (mod === "meta") chord.meta = true;
    else if (mod === "shift") {
      chord.shift = true;
      shiftNamed = true;
    } else return undefined;
  }
  // A punctuation key such as "+" is produced *by* pressing shift on many layouts, so requiring
  // shift to be up would make the binding unreachable. Its shift state is therefore ignored unless
  // the binding names Shift explicitly.
  if (!shiftNamed && isPunctuation(chord.key)) chord.shift = undefined;
  return chord;
}

/** Whether a keystroke is the one the chord names. */
export function matches(chord: Chord, stroke: KeyStroke): boolean {
  if (normalizeKey(stroke.key) !== chord.key) return false;
  if (chord.ctrl !== stroke.ctrlKey) return false;
  if (chord.alt !== stroke.altKey) return false;
  if (chord.meta !== stroke.metaKey) return false;
  if (chord.shift !== undefined && chord.shift !== stroke.shiftKey) return false;
  return true;
}

/**
 * The chord's canonical form — the identity two contributions must share for the last-wins rule to
 * treat them as claiming the same chord, whatever spelling and modifier order each was written in.
 */
export function canonicalChord(chord: Chord): string {
  return [
    chord.ctrl ? "ctrl" : "",
    chord.alt ? "alt" : "",
    chord.shift === true ? "shift" : "",
    chord.meta ? "meta" : "",
    chord.key,
  ].join("+");
}

/** Parses key strings once and remembers the result, including the "unparseable" answer. */
export function chordCache(): (spec: string) => Chord | undefined {
  const seen = new Map<string, Chord | undefined>();
  return (spec) => {
    if (seen.has(spec)) return seen.get(spec);
    const chord = parseChord(spec);
    seen.set(spec, chord);
    return chord;
  };
}
