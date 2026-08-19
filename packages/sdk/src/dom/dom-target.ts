// Event-target interrogation helpers (docs/specs/sdk.md, Module: sdk/dom), written against
// structural shapes so they run under any DOM (or DOM double).

/** The node shape the ancestor walks read; every real DOM element satisfies it. */
type Walkable = {
  tagName?: unknown;
  isContentEditable?: unknown;
  disabled?: unknown;
  getAttribute?: (name: string) => string | null;
  parentNode?: unknown;
};

/**
 * Whether a keyboard event's target is — or sits inside — an element that owns keystrokes for
 * text or value entry: an `input`, `textarea` or `select`, or anywhere inside a `contenteditable`
 * region (whose descendants, a `<span>` inside it say, are text too).
 *
 * A *disabled* `input`/`textarea`/`select` does not own keystrokes — it cannot receive them at
 * all — so it does not count as editable; a shortcut aimed at a disabled field must still reach
 * the shortcut handler rather than being swallowed on its behalf.
 *
 * This is the superset of the narrower per-purpose guards a keyboard handler might otherwise write
 * by hand — walking ancestors, and also recognizing `select` — so a shortcut handler consults this
 * before claiming a key and typing always wins.
 *
 * The walk follows `parentNode` only, so it stops at a shadow root's boundary rather than
 * crossing into the host document — an editable ancestor that lives outside a shadow tree the
 * target is inside is not seen.
 */
export function isEditableTarget(target: unknown): boolean {
  let node = target as Walkable | null;
  while (node != null) {
    const tag = typeof node.tagName === "string" ? node.tagName.toUpperCase() : undefined;
    if ((tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") && node.disabled !== true) {
      return true;
    }
    if (node.isContentEditable === true) return true;
    if (typeof node.getAttribute === "function") {
      const ce = node.getAttribute("contenteditable");
      if (ce !== null && ce !== "false") return true;
    }
    node = (node.parentNode as Walkable | null) ?? null;
  }
  return false;
}

/**
 * Walks from an event target up the `parentNode` chain, returning the first element `pred`
 * accepts, or `null` when none does. When `root` is given, the walk stops *before* it — `root`
 * itself is never tested — so a delegated listener on a container never matches the container.
 *
 * The chain followed is `parentNode`, not the flattened composed tree, so the walk stops at a
 * shadow root's boundary: an ancestor outside the shadow tree the start node is inside is never
 * reached, even when `root` sits further up the light DOM.
 *
 * @example
 * ```ts
 * const cell = findUp(e.target, (el) => el.getAttribute("data-cell") !== null, ctx.root);
 * ```
 */
export function findUp(
  start: unknown,
  pred: (el: HTMLElement) => boolean,
  root?: unknown,
): HTMLElement | null {
  let node = start as HTMLElement | null;
  while (node !== null && node !== root) {
    if (pred(node)) return node;
    node = (node.parentNode as HTMLElement | null) ?? null;
  }
  return null;
}

/** Remembers and restores where the DOM focus sat — see {@link focusRestorer}. */
export interface FocusRestorer {
  /** Records the document's current `activeElement` as the place to return the focus to. */
  save(): void;
  /**
   * Moves the focus back to the saved element (when it still accepts `focus()`), then forgets it;
   * a `restore` with nothing saved does nothing.
   */
  restore(): void;
}

/**
 * The save/restore pair a modal surface (dialog, help overlay, summary table) wraps around taking
 * the focus: `save()` before focusing the surface, `restore()` when it closes, so the keyboard
 * user lands back where they were.
 */
export function focusRestorer(doc: { activeElement: unknown }): FocusRestorer {
  let restoreTo: unknown = null;
  return {
    save: () => {
      restoreTo = doc.activeElement;
    },
    restore: () => {
      const target = restoreTo as { focus?: () => void } | null;
      restoreTo = null;
      if (target !== null && typeof target?.focus === "function") target.focus();
    },
  };
}
