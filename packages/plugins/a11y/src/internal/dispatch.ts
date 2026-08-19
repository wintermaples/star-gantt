// docs/specs/plugins/a11y.md § Extension points — "Dispatch rules".
/**
 * Key routing for the `keys/bindings` extension point: which keystrokes belong to this chart, which
 * of them a binding may see at all, and which binding wins one that gets through.
 *
 * The decisions are plain functions over a keystroke and the current binding list, so they are
 * unit-testable without a composed chart; `mountKeyDispatcher` is the only part that touches the
 * document, and it is pure wiring around them.
 */
import type { PluginContext } from "@stargantt/core";
import { isEditableTarget, listen } from "@stargantt/sdk";
import type { KeyBinding } from "../types";
import type { Chord, KeyStroke } from "./keys";
import { matches } from "./keys";

// docs/specs/plugins/a11y.md § Extension points — the input guard suppresses every binding,
// built-in and contributed alike, while the focus sits on a text-entry element. The SDK helper is
// the shared form of the walk: the element itself and every ancestor are checked, since a
// `contenteditable` region's descendants (a `<span>` inside it, say) are text too.
/** Whether `target` is, or sits inside, an element that owns keystrokes for text entry. */
export const isTextEntry = isEditableTarget;

// docs/specs/plugins/a11y.md § Extension points — the input guard's second half: no binding runs
// while the focus sits on a grid header cell (`role="columnheader"`) or anywhere inside the grid
// header container, so the header's own key handling (the sort cycle, Alt+Arrow resize) is the only
// thing Enter / Space do there.
/** Whether `target` is, or sits inside, a grid header cell or the grid header container. */
export function isInGridHeader(target: unknown): boolean {
  type Walkable = {
    className?: unknown;
    getAttribute?: (name: string) => string | null;
    parentNode?: unknown;
  };
  let node = target as Walkable | null;
  while (node != null) {
    if (typeof node.getAttribute === "function" && node.getAttribute("role") === "columnheader") {
      return true;
    }
    if (typeof node.className === "string" && node.className.indexOf("sg-grid-header") >= 0) {
      return true;
    }
    node = (node.parentNode as Walkable | null | undefined) ?? null;
  }
  return false;
}

/** The element tree this module needs from `ctx.root` — the real `HTMLElement` satisfies it. */
export interface ScopeRoot {
  contains?: unknown;
  ownerDocument: { body: unknown; documentElement: unknown };
}

/** Tracks whether the last pointer interaction on the page happened inside this chart. */
export interface KeyScope {
  /** Records a pointerdown: the claim is held while it landed inside the chart, dropped otherwise. */
  notePointerDown(target: unknown): void;
  /** Records a focusin: focus moving outside the chart drops the claim. */
  noteFocusIn(target: unknown): void;
  /** Whether a keydown on `target` belongs to this chart. */
  inScope(target: unknown): boolean;
  /** Whether `target` is `root` itself or one of its descendants. */
  isInside(target: unknown): boolean;
}

// A keyboard chord such as `Ctrl+Z` needs to reach the dispatcher after a **pointer** edit (a bar
// drag, a rubber-band selection) too, but a pointer gesture never moves the DOM focus, so the very
// next keystroke would otherwise land on `<body>`, outside `ctx.root`. The claim below is the
// chart's "the last pointer interaction happened here": set whenever a pointerdown lands inside the
// root, cleared the moment a pointerdown lands outside it or the DOM focus moves outside it. It
// never moves the DOM focus itself — only which keydowns this instance treats as its own.
/** The pointer-claim state machine for one chart root. */
export function createKeyScope(root: ScopeRoot): KeyScope {
  let pointerClaim = false;

  const isInside = (target: unknown): boolean => {
    if (target === null || target === undefined) return false;
    if (typeof root.contains !== "function") return false;
    return (root.contains as (node: unknown) => boolean)(target);
  };

  /** Whether `target` is where a keystroke lands when nothing on the page holds the focus. */
  const isNothingFocused = (target: unknown): boolean => {
    if (target === null) return true;
    const doc = root.ownerDocument;
    return target === doc.body || target === doc.documentElement;
  };

  return {
    isInside,
    notePointerDown: (target) => {
      pointerClaim = isInside(target);
    },
    noteFocusIn: (target) => {
      // Tabbing (or clicking a focusable element) to somewhere outside the chart is a visible way
      // of leaving it, independent of any pointer claim.
      if (!isInside(target)) pointerClaim = false;
    },
    // A keydown is in scope when it targets the chart itself or when nothing is focused and this
    // chart holds the pointer claim. Every other target — a page button, a page input, a second
    // chart instance — is out of scope and never dispatched.
    inScope: (target) => isInside(target) || (pointerClaim && isNothingFocused(target)),
  };
}

export interface StrokeRouting {
  /** The composed `keys/bindings` list, oldest contribution first. */
  bindings(): readonly KeyBinding[] | undefined;
  /** Parses a binding's key string, cached. */
  chordOf(spec: string): Chord | undefined;
  /** Reports a throwing `when` / `run` as `core/pluginError`. */
  fault(error: unknown): void;
  /** Called the moment a binding claims the stroke, before its `run()`. */
  onClaim(): void;
}

/**
 * Runs the first binding, newest contribution first, whose chord matches `stroke` and whose `when`
 * allows it. Returns whether a binding claimed the stroke.
 */
export function runStroke(stroke: KeyStroke, routing: StrokeRouting): boolean {
  const list = routing.bindings();
  if (list === undefined) return false;
  // Last wins: scan from the most recent contribution backwards.
  for (let i = list.length - 1; i >= 0; i -= 1) {
    const binding = list[i];
    if (binding === undefined) continue;
    const chord = routing.chordOf(binding.key);
    if (chord === undefined || !matches(chord, stroke)) continue;
    // `when` is evaluated after the chord already matches. Absent means always active; `false`, or
    // a throw (guarded like any other function-shaped contribution), skips this binding and the
    // scan continues, so an earlier contribution claiming the same chord still gets a chance.
    if (binding.when !== undefined) {
      let active: boolean;
      try {
        active = binding.when();
      } catch (error) {
        routing.fault(error);
        active = false;
      }
      if (!active) continue;
    }
    routing.onClaim();
    try {
      binding.run();
    } catch (error) {
      routing.fault(error);
    }
    return true;
  }
  return false;
}

// docs/specs/plugins/a11y.md § Shortcut-help dialog — the three answers an open modal can give per
// keystroke. `"claim"` prevents the default and stops (the key was the dialog's, or a plain key
// swallowed so no chart shortcut runs behind the modal); `"pass"` stops without preventing
// (modifier chords and native scroll keys stay the browser's — WCAG 1.4.4 — while chart bindings
// still never run); `"inactive"` means no modal is open, so normal dispatch proceeds.
/** What an open modal decides about one in-scope keystroke. */
export type ModalVerdict = "claim" | "pass" | "inactive";

export interface KeyDispatcherDeps extends Omit<StrokeRouting, "onClaim"> {
  /** Called when a binding claims a keystroke, before its `run()` (it disarms the edit announce). */
  onClaim(): void;
  /** Called for every pointerdown on the page, wherever it landed. */
  onPointerDown(): void;
  /** When present, gets each in-scope keystroke first; any verdict but `"inactive"` ends dispatch. */
  modalStroke?: ((stroke: KeyStroke) => ModalVerdict) | undefined;
}

/**
 * Registers the document-level keydown dispatcher plus the pointer/focus listeners that decide which
 * keystrokes this chart owns, and hands every listener to `ctx.own()`.
 */
export function mountKeyDispatcher(ctx: PluginContext, deps: KeyDispatcherDeps): void {
  const scope = createKeyScope(ctx.root as unknown as ScopeRoot);

  function handle(e: KeyboardEvent): void {
    // A stroke another handler already claimed (the context menu's roving arrows / Escape
    // preventDefault on their way up) is not re-dispatched into the chart bindings; without this
    // the menu moved its own focus and the grid bindings immediately moved it back to the mirror.
    if (e.defaultPrevented) return;
    if (!scope.inScope(e.target)) return;
    // An open modal (the shortcut-help dialog) is consulted before any binding. While it is open no
    // binding runs; whether the browser keeps the key's default action is the modal's call.
    if (deps.modalStroke !== undefined) {
      const verdict = deps.modalStroke(e);
      if (verdict === "claim") {
        e.preventDefault();
        return;
      }
      if (verdict === "pass") return;
    }
    // The input guard: no binding runs at all while the focus is on a text-entry element,
    // independently of `when`.
    if (isTextEntry(e.target)) return;
    // The guard's header half: the grid header owns its keys, so the global "Enter edits the
    // focused row" never fires from a header cell.
    if (isInGridHeader(e.target)) return;
    runStroke(e, {
      bindings: deps.bindings,
      chordOf: deps.chordOf,
      fault: deps.fault,
      onClaim: () => {
        e.preventDefault();
        deps.onClaim();
      },
    });
  }

  // The dispatcher listens on the **document**, not `ctx.root`, so the scope check above is what
  // limits it to this chart; a single document listener also means exactly one dispatcher ever sees
  // a given keystroke; two chart instances on one page each register their own and each scopes
  // itself independently.
  // `listen` hands the removal to `ctx.own()` itself, so no listener here is registered twice.
  const doc = ctx.root.ownerDocument;
  listen(ctx, doc, "keydown", handle);

  // Both listeners run in the capture phase, ahead of the view's own pointer capture and any
  // `stopPropagation` a contributed binding's `run()` might later perform downstream, so the claim
  // is never missed.
  listen(
    ctx,
    doc,
    "pointerdown",
    (e) => {
      scope.notePointerDown((e as unknown as { target: unknown }).target);
      deps.onPointerDown();
    },
    { capture: true },
  );
  listen(
    ctx,
    doc,
    "focusin",
    (e) => {
      scope.noteFocusIn((e as unknown as { target: unknown }).target);
    },
    { capture: true },
  );
}
