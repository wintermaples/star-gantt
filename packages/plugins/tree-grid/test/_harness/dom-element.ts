/**
 * The recording fake-element double the rest of this harness builds on.
 *
 * Nothing here touches a real DOM engine: what these tests assert is *which* DOM calls a plugin
 * makes, which a recording double answers directly and a real DOM engine only indirectly. Every
 * double is instrumented — listeners, attributes, pointer captures and focus are all recorded —
 * so a test can assert both the effect and the absence of leaks.
 *
 * Real DOM semantics are the standard this follows wherever there is a choice:
 *
 * - `find` / `findAll` / `querySelector` match a *token subset* of an element's class list, the
 *   way a CSS selector does, rather than comparing the whole `className` string — so a search for
 *   `.sg-grid-row` keeps matching a row after code adds `--selected` to it.
 * - `focus()` sets `ownerDocument.activeElement` **and** the element's own `focused` flag.
 * - `contains()` walks the parent chain and reports `true` for the element itself.
 */
import type { FakeDocument } from "./dom-document";

/** Any listener shape: the doubles never invent an event, they hand back what a test fires. */
export type Handler = (e: never) => void;

/** The settable layout box of a fake element, in CSS pixels. */
export interface Rect {
  left: number;
  top: number;
  width: number;
  height: number;
}

/** What `getBoundingClientRect()` reports: `Rect` plus the derived far edges. */
export interface ClientRect extends Rect {
  right: number;
  bottom: number;
}

/* ------------------------------------------------------------------ *
 * Selectors
 * ------------------------------------------------------------------ */

interface ParsedSelector {
  tag: string | undefined;
  classes: string[];
  id: string | undefined;
  attrs: { name: string; value: string | undefined }[];
}

const SIMPLE_SELECTOR = /^(\*|[a-zA-Z][\w-]*)?((?:[.#][\w-]+|\[[\w-]+(?:="[^"]*")?\])*)$/;
const SELECTOR_PART = /[.#][\w-]+|\[[\w-]+(?:="[^"]*")?\]/g;

/**
 * Parses one compound simple selector — an optional tag name followed by any number of `.class`,
 * `#id` and `[attr]` / `[attr="value"]` parts.
 *
 * Combinators (descendant, `>`, `,`) are deliberately unsupported: a test that needs one is
 * asserting on a structure the fake tree does not model, and a thrown error is better than a
 * silently empty result.
 */
function parseSelector(selector: string): ParsedSelector {
  const head = SIMPLE_SELECTOR.exec(selector.trim());
  if (head === null) throw new Error(`unsupported selector: ${selector}`);
  const tag = head[1];
  // CSS type selectors are ASCII-case-insensitive for HTML elements; normalized here so a
  // lowercase `"canvas"` selector (how every caller spells one) matches the uppercase `tagName` a
  // real HTML document — and this fake — reports.
  const out: ParsedSelector = {
    tag: tag === undefined || tag === "*" ? undefined : tag.toUpperCase(),
    classes: [],
    id: undefined,
    attrs: [],
  };
  for (const part of (head[2] ?? "").match(SELECTOR_PART) ?? []) {
    if (part.startsWith(".")) out.classes.push(part.slice(1));
    else if (part.startsWith("#")) out.id = part.slice(1);
    else {
      const eq = part.indexOf("=");
      if (eq < 0) out.attrs.push({ name: part.slice(1, -1), value: undefined });
      else out.attrs.push({ name: part.slice(1, eq), value: part.slice(eq + 2, -2) });
    }
  }
  return out;
}

/** Splits a class attribute into its tokens, the way the real `classList` does. */
function tokens(value: string): string[] {
  return value.split(/\s+/).filter((t) => t !== "");
}

/* ------------------------------------------------------------------ *
 * Elements
 * ------------------------------------------------------------------ */

export class FakeElement {
  /**
   * The element's class list as a string.
   *
   * It is the `class` **attribute**, as in the real DOM: `setAttribute("class", …)`,
   * `getAttribute("class")`, `className` and `classList` are four views of one value, and any of
   * them changing notifies the `MutationObserver` doubles watching this element.
   */
  get className(): string {
    return this.attributes.get("class") ?? "";
  }
  set className(value: string) {
    this.setAttribute("class", value);
  }
  /** `classList` double backed by `className`, mirroring the live-DOM invariant the code relies on. */
  readonly classList = {
    contains: (name: string): boolean => tokens(this.className).includes(name),
    add: (...names: string[]): void => {
      for (const name of names) {
        if (this.classList.contains(name)) continue;
        this.className = this.className === "" ? name : `${this.className} ${name}`;
      }
    },
    remove: (...names: string[]): void => {
      this.className = tokens(this.className)
        .filter((n) => !names.includes(n))
        .join(" ");
    },
    toggle: (name: string, force?: boolean): boolean => {
      const on = force ?? !this.classList.contains(name);
      if (on) this.classList.add(name);
      else this.classList.remove(name);
      return on;
    },
  };

  style: Record<string, string> = {};
  children: FakeElement[] = [];
  parentNode: FakeElement | null = null;
  text = "";
  readonly attributes = new Map<string, string>();
  readonly handlers = new Map<string, Set<Handler>>();
  tabIndex = -1;

  /** The element's layout box. Set it to place the element; `getBoundingClientRect` reads it. */
  rect: Rect = { left: 0, top: 0, width: 0, height: 0 };
  /** Native scroll offsets (the grid mirrors its body's scroll onto its header). */
  scrollLeft = 0;
  scrollTop = 0;
  /** Computed `overflow-x` / `overflow-y`, as the harness's `getComputedStyle` reports them. */
  overflowX = "visible";
  overflowY = "visible";
  /** Pointer ids currently captured by this element, in capture order. */
  readonly captured: number[] = [];
  /** Whether this element currently holds the focus; `focus()` / `blur()` maintain it. */
  focused = false;

  #offsetWidth = 0;
  #offsetHeight = 0;
  /**
   * The `style.left` in force the moment `offsetWidth` was last read.
   *
   * A real `offsetWidth` read reflects live layout, so this is how a test asserts that code
   * measures an element *before* positioning it rather than after.
   */
  leftAtLastMeasure: string | undefined;

  constructor(
    readonly tagName: string,
    readonly ownerDocument: FakeDocument,
  ) {}

  get offsetWidth(): number {
    this.leftAtLastMeasure = this.style["left"];
    return this.#offsetWidth;
  }
  set offsetWidth(value: number) {
    this.#offsetWidth = value;
  }
  get offsetHeight(): number {
    return this.#offsetHeight;
  }
  set offsetHeight(value: number) {
    this.#offsetHeight = value;
  }

  get firstChild(): FakeElement | null {
    return this.children[0] ?? null;
  }
  get lastChild(): FakeElement | null {
    return this.children[this.children.length - 1] ?? null;
  }
  get nextSibling(): FakeElement | null {
    const siblings = this.parentNode?.children;
    if (siblings === undefined) return null;
    const i = siblings.indexOf(this);
    return i < 0 ? null : (siblings[i + 1] ?? null);
  }
  get previousSibling(): FakeElement | null {
    const siblings = this.parentNode?.children;
    if (siblings === undefined) return null;
    const i = siblings.indexOf(this);
    return i <= 0 ? null : (siblings[i - 1] ?? null);
  }
  /** Mirrors `Element.parentElement`, which a clip walk climbs. */
  get parentElement(): FakeElement | null {
    return this.parentNode;
  }

  get textContent(): string {
    return this.text + this.children.map((c) => c.textContent).join("");
  }
  /** Setting `textContent` drops every child, as in the real DOM. */
  set textContent(value: string) {
    for (const child of this.children) child.parentNode = null;
    this.children = [];
    this.text = value;
  }

  setAttribute(name: string, value: string): void {
    this.attributes.set(name, String(value));
    this.ownerDocument.notifyAttributeChange(this, name);
  }
  getAttribute(name: string): string | null {
    return this.attributes.get(name) ?? null;
  }
  hasAttribute(name: string): boolean {
    return this.attributes.has(name);
  }
  removeAttribute(name: string): void {
    this.attributes.delete(name);
    this.ownerDocument.notifyAttributeChange(this, name);
  }

  appendChild<T extends FakeElement>(child: T): T {
    child.parentNode?.removeChild(child);
    child.parentNode = this;
    this.children.push(child);
    return child;
  }
  insertBefore<T extends FakeElement>(child: T, ref: FakeElement | null | undefined): T {
    // A real DOM throws `NotFoundError` when the reference node is not a child of this element;
    // appending instead would let a plugin that passes the wrong reference look correct here and
    // fail in a browser. A nullish reference appends, exactly as the DOM specifies.
    const i = ref === null || ref === undefined ? -1 : this.children.indexOf(ref);
    if (ref !== null && ref !== undefined && i < 0) {
      throw new Error(
        "NotFoundError: the node before which the new node is to be inserted is not a child of this node",
      );
    }
    child.parentNode?.removeChild(child);
    child.parentNode = this;
    // Removing `child` above can shift the reference's index, so it is resolved again here.
    const at = ref === null || ref === undefined ? -1 : this.children.indexOf(ref);
    if (at < 0) this.children.push(child);
    else this.children.splice(at, 0, child);
    return child;
  }
  removeChild<T extends FakeElement>(child: T): T {
    const i = this.children.indexOf(child);
    if (i >= 0) {
      this.children.splice(i, 1);
      child.parentNode = null;
    }
    return child;
  }
  remove(): void {
    this.parentNode?.removeChild(this);
  }

  /** `Node.contains`: `true` for this element itself and for any descendant. */
  contains(node: unknown): boolean {
    for (let cur = node as FakeElement | null; cur !== null && cur !== undefined; cur = cur.parentNode) {
      if (cur === this) return true;
    }
    return false;
  }

  /**
   * Synthesizes a click, as `HTMLElement.click()` does: the `click` listeners registered on this
   * element run, and the call is counted in `clicks` for code that only synthesizes the gesture
   * and registers no listener at all.
   */
  click(): void {
    this.clicks += 1;
    this.fire("click", { type: "click", target: this });
  }
  /** How many times `click()` has been called on this element. */
  clicks = 0;

  focus(): void {
    this.focused = true;
    const previous = this.ownerDocument.activeElement;
    if (previous !== null && previous !== this) previous.focused = false;
    this.ownerDocument.activeElement = this;
  }
  blur(): void {
    this.focused = false;
    // Real DOM reports document.body (not null) when nothing holds the focus.
    if (this.ownerDocument.activeElement === this) {
      this.ownerDocument.activeElement = this.ownerDocument.body;
    }
  }

  // The third argument is accepted (real `addEventListener`'s options) and otherwise ignored: this
  // fake has no capture/bubble phases, only a flat per-type handler set.
  addEventListener(type: string, fn: Handler, _options?: boolean | AddEventListenerOptions): void {
    let set = this.handlers.get(type);
    if (set === undefined) {
      set = new Set();
      this.handlers.set(type, set);
    }
    set.add(fn);
  }
  removeEventListener(type: string, fn: Handler, _options?: boolean | AddEventListenerOptions): void {
    this.handlers.get(type)?.delete(fn);
  }

  getBoundingClientRect(): ClientRect {
    const { left, top, width, height } = this.rect;
    return { left, top, right: left + width, bottom: top + height, width, height };
  }

  setPointerCapture(id: number): void {
    if (!this.captured.includes(id)) this.captured.push(id);
  }
  releasePointerCapture(id: number): void {
    const i = this.captured.indexOf(id);
    if (i >= 0) this.captured.splice(i, 1);
  }
  hasPointerCapture(id: number): boolean {
    return this.captured.includes(id);
  }

  /** Whether this element matches one compound simple selector — see `parseSelector`. */
  matches(selector: string): boolean {
    return this.matchesParsed(parseSelector(selector));
  }
  querySelector(selector: string): FakeElement | null {
    return this.querySelectorAll(selector)[0] ?? null;
  }
  querySelectorAll(selector: string): FakeElement[] {
    const parsed = parseSelector(selector);
    const out: FakeElement[] = [];
    const walk = (el: FakeElement): void => {
      for (const child of el.children) {
        if (child.matchesParsed(parsed)) out.push(child);
        walk(child);
      }
    };
    walk(this);
    return out;
  }

  /* --- test helpers --- */

  /**
   * Invokes every listener registered for `type` with `event`, exactly as a dispatch would.
   *
   * `event` defaults to `{ type }`, the minimum a real dispatch delivers, so a test firing an event
   * whose payload the code never reads can omit it.
   */
  fire(type: string, event: unknown = { type }): void {
    for (const fn of [...(this.handlers.get(type) ?? [])]) {
      (fn as (e: unknown) => void)(event);
    }
  }
  /** Live listeners for one type, or for every type when `type` is omitted. */
  listenerCount(type?: string): number {
    if (type !== undefined) return this.handlers.get(type)?.size ?? 0;
    let n = 0;
    for (const set of this.handlers.values()) n += set.size;
    return n;
  }
  /** Live listeners on this element and every descendant — the leak check after `dispose()`. */
  deepListenerCount(): number {
    let n = this.listenerCount();
    for (const child of this.children) n += child.deepListenerCount();
    return n;
  }
  /**
   * Depth-first search for the first descendant carrying every class in `query`.
   *
   * `query` is a space-separated class list, matched as a *subset* of the element's own classes, so
   * a search for `"sg-grid-row"` still finds a row the code has since marked `--selected`. Pass a
   * multi-class query (`"sg-grid-row sg-grid-row--selected"`) to require all of them.
   */
  find(query: string): FakeElement | undefined {
    const wanted = tokens(query);
    for (const child of this.children) {
      if (wanted.every((w) => child.classList.contains(w))) return child;
      const hit = child.find(query);
      if (hit !== undefined) return hit;
    }
    return undefined;
  }
  /** Every descendant matching `find`'s class-subset rule, in document order. */
  findAll(query: string, out: FakeElement[] = []): FakeElement[] {
    const wanted = tokens(query);
    for (const child of this.children) {
      if (wanted.every((w) => child.classList.contains(w))) out.push(child);
      child.findAll(query, out);
    }
    return out;
  }

  private matchesParsed(p: ParsedSelector): boolean {
    // Compared case-insensitively: `parseSelector` already normalizes the selector's own tag to
    // uppercase, and this side is normalized too so a double built by `new FakeElement("span", …)`
    // — bypassing `createElement`'s uppercasing — still matches a `"span"` type selector.
    if (p.tag !== undefined && this.tagName.toUpperCase() !== p.tag) return false;
    if (p.id !== undefined && this.getAttribute("id") !== p.id) return false;
    for (const c of p.classes) if (!this.classList.contains(c)) return false;
    for (const a of p.attrs) {
      if (!this.attributes.has(a.name)) return false;
      if (a.value !== undefined && this.attributes.get(a.name) !== a.value) return false;
    }
    return true;
  }
}

/** An `<input>` stand-in: the value plus the focus flag `FakeElement` already maintains. */
export class FakeInput extends FakeElement {
  value = "";
  selectionStart: number | null = null;
  selectionEnd: number | null = null;
  select(): void {
    this.selectionStart = 0;
    this.selectionEnd = this.value.length;
  }
}
