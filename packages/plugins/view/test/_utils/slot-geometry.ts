/**
 * Resolved corner-slot geometry, for tests that must pin *where an overlay lands* rather than what
 * it declares.
 *
 * The shared fake DOM (`./dom`) has no CSS engine, so `calc(var(--sg-safe-right, 0px) + 12px)` is
 * only a string there and an assertion on that string proves nothing. These helpers do what a
 * browser would: read the four `--sg-safe-*` lengths the **real** renderer publishes on the chart
 * pane in the same composition, resolve the declaration — `calc()`, `min()`, `max()`, `var()` with
 * its fallback, and `%` of a caller-supplied pane box — against them, and hand back pixel offsets a
 * test can compare with the safe area itself. Real layout — the pane's clamped width at the
 * viewport floor, text measurement, wrapping — is verified in E2E against `examples/*.html`; what is
 * proven here is the arithmetic every one of those layouts starts from.
 *
 * Shared by every plugin that anchors an overlay to the renderer's published safe area
 * (conditional-format, perf-tools, zoom-controls, load-chart, resource-utilization, calendars): the
 * resolver and the fake-DOM `setProperty` shim were independently reimplemented in each package's
 * `test/` directory before this module replaced them.
 */
import type { DomHarness, FakeElement } from "./dom";

/** The pane box a slot's percentages resolve against. */
export interface PaneBox {
  width: number;
  height: number;
}

/** The four sides of the safe area, in CSS px from the pane's border box. */
export interface SafeArea {
  top: number;
  right: number;
  bottom: number;
  left: number;
}

/** Where a slot child sits: the offset of each anchored side, plus the caps it declares. */
export interface SlotBox {
  top?: number;
  right?: number;
  bottom?: number;
  left?: number;
  maxWidth?: number;
  maxHeight?: number;
}

/** One overlay's resolved slot: the offsets it is placed at and the box it may grow to. */
export interface SlotGeometry {
  /** Distance from the pane's top edge to the overlay's top edge; `undefined` when not anchored. */
  top?: number | undefined;
  /** Distance from the overlay's bottom edge to the pane's bottom edge. */
  bottom?: number | undefined;
  /** Distance from the overlay's right edge to the pane's right edge. */
  right: number;
  /** The widest the overlay may become, resolved against the pane. */
  maxWidth: number;
  /** The tallest the overlay may become, resolved against the pane. */
  maxHeight: number;
  /** Where the overlay's left edge sits at its widest, measured from the pane's left edge. */
  leftAtMaxWidth: number;
  /** Where its far edge sits at its tallest, from the pane's top (top slot) or bottom (bottom). */
  farEdgeAtMaxHeight: number;
}

/** Documents currently patched by {@link publishInlineCustomProperties}, mapped to the `restore()`
 * that undoes their patch — so a second call on the same harness returns the same live restorer
 * instead of wrapping `createElement` a second time (and instead of handing back a no-op that
 * silently drops the caller's ability to undo the original patch). */
const patchedDocuments = new WeakMap<object, () => void>();

/**
 * Teaches the fake DOM's style records `setProperty`, which they do not have, so the renderer's
 * safe-area writer actually publishes `--sg-safe-*` onto the chart pane. Must run before
 * `Gantt.create()`: the renderer creates its pane, and publishes for the first time, inside its own
 * `setup()`.
 *
 * Idempotent — calling it twice on the same harness patches `createElement` once, not twice — and
 * returns a `restore()` that undoes the patch, for a test that wants to prove behaviour with and
 * without the shim in the same run.
 */
export function publishInlineCustomProperties(dom: DomHarness): () => void {
  const doc = dom.document;
  const existing = patchedDocuments.get(doc);
  if (existing !== undefined) return existing;

  const create = doc.createElement.bind(doc);
  const patched = (tag: string): FakeElement => {
    const element = create(tag);
    const style = element.style as unknown as Record<string, unknown>;
    style["setProperty"] = (name: string, value: string): void => {
      (element.style as Record<string, string>)[name] = value;
    };
    return element;
  };
  doc.createElement = patched;

  let restored = false;
  const restore = (): void => {
    if (restored) return;
    restored = true;
    // Only undo the patch if `createElement` is still the wrapper this call installed — a later
    // patch (or a manual reassignment) may have replaced it since, and clobbering that would
    // silently drop whatever came after.
    if (doc.createElement === patched) doc.createElement = create;
    patchedDocuments.delete(doc);
  };
  patchedDocuments.set(doc, restore);
  return restore;
}

function camelCase(property: string): string {
  return property.replace(/-([a-z])/g, (_match, letter: string) => letter.toUpperCase());
}

/**
 * An element's inline declarations, keyed the way `element.style.<property>` is.
 *
 * A browser parses a `cssText` assignment into the same declarations as individual property
 * writes; the fake DOM's style record does not, so both spellings are read here — which is why a
 * plugin writing its panel as one `cssText` string is measured exactly like one writing properties
 * one at a time.
 */
export function declaredStyle(element: FakeElement): Record<string, string> {
  const style = element.style as Record<string, string | undefined>;
  const out: Record<string, string> = {};
  const cssText = style["cssText"];
  if (typeof cssText === "string") {
    for (const declaration of cssText.split(";")) {
      const colon = declaration.indexOf(":");
      if (colon < 0) continue;
      const property = declaration.slice(0, colon).trim();
      const value = declaration.slice(colon + 1).trim();
      if (property === "" || value === "") continue;
      // A custom property's name is not camelCased — `--sg-safe-top` is not a hyphenated word, and
      // `camelCase` would mangle it into `-SgSafeTop`. Every other declaration is written the way
      // `element.style.<property>` reads it, exactly as a browser normalizes it off `cssText`.
      out[property.startsWith("--") ? property : camelCase(property)] = value;
    }
  }
  for (const [property, value] of Object.entries(style)) {
    if (property === "cssText" || property.startsWith("--")) continue;
    if (typeof value === "string" && value !== "") out[property] = value;
  }
  return out;
}

/** The safe area the renderer published on `pane`; throws when a side was never published. */
export function safeArea(pane: FakeElement): SafeArea {
  const style = pane.style as Record<string, string | undefined>;
  const side = (name: string): number => {
    const value = style[`--sg-safe-${name}`];
    if (value === undefined) throw new Error(`the pane published no --sg-safe-${name}`);
    return resolveCssPx(value, pane, 0);
  };
  return { top: side("top"), right: side("right"), bottom: side("bottom"), left: side("left") };
}

/**
 * Folds one CSS length declaration to px the way a browser would for an absolutely positioned
 * child of `pane`: `var(--sg-safe-*, fallback)` reads the lengths the renderer actually published
 * on the pane, falling back when it published none (or published an empty string), percentages
 * resolve against `basis`, and `calc()` / `min()` / `max()` collapse to a number over `+`, `-`,
 * `*` and `/`. The fake DOM has no layout engine, so this is the arithmetic a browser would run
 * over the same two inputs — what a test needs to say where an overlay lands rather than which
 * string it carries.
 */
export function resolveCssPx(decl: string, pane: FakeElement, basis: number): number {
  const vars = pane.style as Record<string, string | undefined>;
  const src = decl.replace(
    /var\(\s*(--[\w-]+)\s*(?:,\s*([^()]*?)\s*)?\)/g,
    (_match, name: string, fallback?: string) => {
      const value = vars[name];
      return value === undefined || value === "" ? (fallback ?? "") : value;
    },
  );
  let i = 0;
  const ws = (): void => {
    while (i < src.length && /\s/.test(src[i] as string)) i++;
  };
  const sum = (): number => {
    let value = product();
    for (;;) {
      ws();
      if (src[i] === "+") {
        i++;
        value += product();
      } else if (src[i] === "-") {
        i++;
        value -= product();
      } else return value;
    }
  };
  const product = (): number => {
    let value = atom();
    for (;;) {
      ws();
      if (src[i] === "*") {
        i++;
        value *= atom();
      } else if (src[i] === "/") {
        i++;
        value /= atom();
      } else return value;
    }
  };
  const atom = (): number => {
    ws();
    for (const fn of ["calc(", "min(", "max("] as const) {
      if (!src.startsWith(fn, i)) continue;
      i += fn.length;
      const args = [sum()];
      for (ws(); src[i] === ","; ws()) {
        i++;
        args.push(sum());
      }
      i++; // ")"
      const first = args[0] as number;
      return fn === "calc(" ? first : fn === "min(" ? Math.min(...args) : Math.max(...args);
    }
    const literal = /^[+-]?[\d.]+(px|%)?/.exec(src.slice(i));
    if (literal === null) throw new Error(`unresolvable CSS length "${decl}" at "${src.slice(i)}"`);
    i += literal[0].length;
    const n = Number.parseFloat(literal[0]);
    return literal[1] === "%" ? (n / 100) * basis : n;
  };
  const value = sum();
  ws();
  if (i !== src.length) throw new Error(`unresolvable CSS length "${decl}"`);
  return value;
}

/**
 * The resolved geometry of a slot child of `pane`: every anchored side and cap it declares, in CSS
 * px, against the pane box a percentage resolves against. Every field is optional — unlike
 * {@link slotGeometry}, nothing is assumed about which sides the caller's overlay anchors.
 */
export function slotBox(element: FakeElement, pane: FakeElement, box: PaneBox): SlotBox {
  const style = declaredStyle(element);
  const out: SlotBox = {};
  const read = (property: string, basis: number): number | undefined => {
    const declared = style[property];
    return declared === undefined || declared === "" ? undefined : resolveCssPx(declared, pane, basis);
  };
  const assign = (key: keyof SlotBox, value: number | undefined): void => {
    if (value !== undefined) out[key] = value;
  };
  assign("top", read("top", box.height));
  assign("right", read("right", box.width));
  assign("bottom", read("bottom", box.height));
  assign("left", read("left", box.width));
  assign("maxWidth", read("maxWidth", box.width));
  assign("maxHeight", read("maxHeight", box.height));
  return out;
}

/**
 * Resolves an overlay's inline slot declarations against the pane box it is positioned in. Throws
 * when the element declares no `right` / `max-width` / `max-height` — the three every corner-slot
 * overlay is expected to carry — and derives `leftAtMaxWidth` / `farEdgeAtMaxHeight` on top, which
 * {@link slotBox}'s callers do not need.
 *
 * Built on {@link slotBox} (itself built on {@link declaredStyle}) rather than reading `el.style`
 * directly: an overlay written as one `cssText` assignment used to resolve here as if it had
 * declared nothing at all, throwing "no right / max-width / max-height slot" for a panel that in
 * fact declared all three — `slotBox` is what already reads both spellings.
 */
export function slotGeometry(el: FakeElement, pane: FakeElement, box: PaneBox): SlotGeometry {
  const resolved = slotBox(el, pane, box);
  const { right, maxWidth, maxHeight, top, bottom } = resolved;
  if (right === undefined || maxWidth === undefined || maxHeight === undefined) {
    throw new Error("the overlay declares no right / max-width / max-height slot");
  }
  return {
    top,
    bottom,
    right,
    maxWidth,
    maxHeight,
    leftAtMaxWidth: box.width - right - maxWidth,
    farEdgeAtMaxHeight: (top ?? bottom ?? 0) + maxHeight,
  };
}
