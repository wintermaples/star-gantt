/**
 * A minimal fake DOM for the zoom toolbar's own tests.
 *
 * `internal/zoom/toolbar.ts` assigns `calc(var(--sg-safe-*, 0px) + 12px)` to the physical offset
 * properties (`top`/`right`/`bottom`/`left`) — valid CSS any real browser accepts, but happy-dom's
 * `CSSStyleDeclaration` rejects `var()` on those four specific longhand properties and silently
 * drops the whole declaration (verified directly against the installed happy-dom build; `max-width`
 * with the identical `var()` pattern round-trips fine, so the gap is narrow and property-specific).
 * That is a test-environment limitation, not a defect in the toolbar or in what a real browser does
 * with it (per the gantt-ui-ux skill: "a fake-DOM ... proves arithmetic, not layout" — final visual
 * verification belongs in E2E). `createToolbar`/`wireZoom` only ever read/write `.style` as a plain
 * object (via `@stargantt/sdk`'s `styled()`, which just does `el.style[prop] = value`), so a fake
 * element whose `.style` is an unchecked plain object sidesteps the gap entirely and lets the
 * position-decision *logic* — which two of the four sides get written — stay under test.
 */

export interface FakeElement {
  tagName: string;
  className: string;
  readonly style: Record<string, string>;
  readonly children: FakeElement[];
  parentNode: FakeElement | null;
  readonly ownerDocument: FakeDocument;
  textContent: string;
  tabIndex: number;
  disabled: boolean;
  type: string;
  value: string;
  min: string;
  max: string;
  step: string;
  readonly attrs: Map<string, string>;
  readonly listeners: Map<string, Set<(e: unknown) => void>>;
  setAttribute(name: string, value: string): void;
  removeAttribute(name: string): void;
  getAttribute(name: string): string | null;
  addEventListener(type: string, fn: (e: unknown) => void): void;
  appendChild(child: FakeElement): FakeElement;
  remove(): void;
  focus(): void;
  click(): void;
  /** Fires a synthetic event to every listener registered for `type` (test-only convenience). */
  fire(type: string, detail?: unknown): void;
  /** The first descendant (self included) carrying `cls` in its class list, depth-first. */
  query(cls: string): FakeElement | null;
}

export interface FakeDocument {
  activeElement: FakeElement | null;
  createElement(tag: string): FakeElement;
}

function makeElement(doc: FakeDocument, tag: string): FakeElement {
  const el: FakeElement = {
    tagName: tag.toUpperCase(),
    className: "",
    style: {},
    children: [],
    parentNode: null,
    ownerDocument: doc,
    textContent: "",
    tabIndex: 0,
    disabled: false,
    type: "",
    value: "",
    min: "",
    max: "",
    step: "",
    attrs: new Map(),
    listeners: new Map(),
    setAttribute(name, value) {
      el.attrs.set(name, value);
    },
    removeAttribute(name) {
      el.attrs.delete(name);
    },
    getAttribute(name) {
      return el.attrs.has(name) ? (el.attrs.get(name) as string) : null;
    },
    addEventListener(type, fn) {
      let set = el.listeners.get(type);
      if (set === undefined) el.listeners.set(type, (set = new Set()));
      set.add(fn);
    },
    appendChild(child) {
      child.parentNode = el;
      el.children.push(child);
      return child;
    },
    remove() {
      if (el.parentNode !== null) {
        const idx = el.parentNode.children.indexOf(el);
        if (idx >= 0) el.parentNode.children.splice(idx, 1);
      }
      el.parentNode = null;
    },
    focus() {
      doc.activeElement = el;
    },
    click() {
      el.fire("click");
    },
    fire(type, detail) {
      for (const fn of el.listeners.get(type) ?? []) fn(detail ?? { type });
    },
    query(cls) {
      if (el.className.split(/\s+/).includes(cls)) return el;
      for (const child of el.children) {
        const found = child.query(cls);
        if (found !== null) return found;
      }
      return null;
    },
  };
  return el;
}

/** A fresh fake `Document`, structurally enough for `createToolbar`/`wireZoom`. */
export function fakeDocument(): FakeDocument {
  const doc: FakeDocument = {
    activeElement: null,
    createElement: (tag) => makeElement(doc, tag),
  };
  return doc;
}
