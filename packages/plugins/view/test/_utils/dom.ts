/**
 * The shared fake-DOM + fake-canvas harness.
 *
 * happy-dom is deliberately not used for plugin unit tests: what these tests assert is *which* DOM
 * calls a plugin makes and *what* it paints, which a recording double answers directly and a real
 * DOM engine only indirectly. Every double here is instrumented — listeners, attributes, pointer
 * captures, animation frames, observers and 2d-context calls are all recorded — so a test can
 * assert both the effect and the absence of leaks.
 *
 * Where the per-package forks this package replaces disagreed, **real DOM semantics win**:
 *
 * - `find` / `findAll` / `querySelector` match a *token subset* of an element's class list, the way
 *   a CSS selector does, rather than comparing the whole `className` string. A fork that compared
 *   whole strings stopped finding `.sg-grid-row` the moment the code added `--selected` to it.
 * - `focus()` sets `ownerDocument.activeElement` **and** the element's own `focused` flag; the
 *   forks did one or the other.
 * - `contains()` walks the parent chain and reports `true` for the element itself.
 */

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
 * Canvas
 * ------------------------------------------------------------------ */

/** One recorded 2d-context call: the method, its numeric arguments and the state in effect. */
export interface Op {
  op: string;
  args: number[];
  fill: string;
  stroke: string;
  lineWidth: number;
  globalAlpha: number;
  /** The dash pattern in effect; empty for a solid line. */
  dash: number[];
}

/** One recorded `fillText` / `strokeText` call, with the text state in effect. */
export interface TextOp {
  text: string;
  x: number;
  y: number;
  fill: string;
  stroke: string;
  font: string;
  align: string;
  baseline: string;
}

/** One recorded straight line — a `moveTo` followed by a `lineTo` — with the stroke in effect. */
export interface Line {
  x1: number;
  y1: number;
  x2: number;
  y2: number;
  stroke: string;
}

/** One recorded `drawImage` call, with the destination box normalized across argument forms. */
export interface DrawnImage {
  src: unknown;
  args: number[];
  dx: number;
  dy: number;
  dw: number;
  dh: number;
}

/** A recording `CanvasGradient`: it collects its stops instead of rasterizing anything. */
export class FakeGradient {
  /** The `[x0, y0, x1, y1]` the gradient was created with. */
  readonly line: readonly [number, number, number, number];
  /** Every `addColorStop(offset, color)`, in call order. */
  readonly stops: { offset: number; color: string }[] = [];

  constructor(line: readonly [number, number, number, number]) {
    this.line = line;
  }

  addColorStop(offset: number, color: string): void {
    this.stops.push({ offset, color });
  }

  /** A stable textual form, so a recorded op's `fill` distinguishes a gradient from a colour. */
  toString(): string {
    return `linear-gradient(${this.stops.map((s) => `${String(s.offset)} ${s.color}`).join(", ")})`;
  }
}

/**
 * A recording 2d context: nothing is rasterized, every call is logged with the style state that
 * was in force, and the current transform is tracked through `setTransform` / `scale` /
 * `translate` and the `save()` / `restore()` stack.
 */
export class FakeContext2D {
  fillStyle = "";
  strokeStyle = "";
  font = "";
  textAlign = "";
  textBaseline = "";
  lineWidth = 1;
  lineCap = "";
  lineJoin = "";
  globalAlpha = 1;
  imageSmoothingEnabled = true;

  /** `[a, b, c, d, e, f]`, as `setTransform` takes them. */
  transform: [number, number, number, number, number, number] = [1, 0, 0, 1, 0, 0];

  readonly ops: Op[] = [];
  /** Every text call, in order — `Op.args` carries only numbers, so the string lives here. */
  readonly texts: TextOp[] = [];
  /** Every `drawImage` call, in order. */
  readonly drawn: DrawnImage[] = [];

  /** Current `save()` nesting depth, and the deepest it ever reached. */
  depth = 0;
  maxDepth = 0;

  private dash: number[] = [];
  private stack: {
    transform: [number, number, number, number, number, number];
    fillStyle: string;
    strokeStyle: string;
    font: string;
    textAlign: string;
    textBaseline: string;
    lineWidth: number;
    globalAlpha: number;
    dash: number[];
  }[] = [];

  /** Every gradient handed out by `createLinearGradient`, in creation order. */
  readonly gradients: FakeGradient[] = [];

  /**
   * A recording gradient. A real 2D context accepts one as `fillStyle`; painters that build one
   * (task-bars' bar bevel) are exercised through this rather than skipped, and its
   * `toString()` is what a recorded op's `fill` shows.
   */
  createLinearGradient(x0: number, y0: number, x1: number, y1: number): FakeGradient {
    const gradient = new FakeGradient([x0, y0, x1, y1]);
    this.gradients.push(gradient);
    return gradient;
  }

  /** Horizontal scale factor of the current transform. */
  get scaleX(): number {
    return this.transform[0];
  }
  /** Vertical scale factor of the current transform. */
  get scaleY(): number {
    return this.transform[3];
  }
  /** Horizontal translation of the current transform, in device px. */
  get tx(): number {
    return this.transform[4];
  }
  /** Vertical translation of the current transform, in device px. */
  get ty(): number {
    return this.transform[5];
  }

  private record(op: string, ...args: number[]): void {
    this.ops.push({
      op,
      args,
      // `String(...)` because a gradient is a legal `fillStyle`: the recorded op keeps a stable
      // textual form of whichever kind was in force, so assertions read the same either way.
      fill: String(this.fillStyle),
      stroke: String(this.strokeStyle),
      lineWidth: this.lineWidth,
      globalAlpha: this.globalAlpha,
      dash: [...this.dash],
    });
  }

  setTransform(a: number, b: number, c: number, d: number, e: number, f: number): void {
    this.transform = [a, b, c, d, e, f];
    this.record("setTransform", a, b, c, d, e, f);
  }
  resetTransform(): void {
    this.transform = [1, 0, 0, 1, 0, 0];
    this.record("resetTransform");
  }
  scale(x: number, y: number): void {
    const [a, b, c, d, e, f] = this.transform;
    this.transform = [a * x, b * x, c * y, d * y, e, f];
    this.record("scale", x, y);
  }
  translate(x: number, y: number): void {
    const [a, b, c, d, e, f] = this.transform;
    this.transform = [a, b, c, d, e + a * x + c * y, f + b * x + d * y];
    this.record("translate", x, y);
  }

  setLineDash(segments: number[]): void {
    this.dash = [...segments];
    this.record("setLineDash", ...segments);
  }
  getLineDash(): number[] {
    return [...this.dash];
  }

  clearRect(x: number, y: number, w: number, h: number): void {
    this.record("clearRect", x, y, w, h);
  }
  fillRect(x: number, y: number, w: number, h: number): void {
    this.record("fillRect", x, y, w, h);
  }
  strokeRect(x: number, y: number, w: number, h: number): void {
    this.record("strokeRect", x, y, w, h);
  }
  beginPath(): void {
    this.record("beginPath");
  }
  closePath(): void {
    this.record("closePath");
  }
  moveTo(x: number, y: number): void {
    this.record("moveTo", x, y);
  }
  lineTo(x: number, y: number): void {
    this.record("lineTo", x, y);
  }
  arc(x: number, y: number, r: number, from: number, to: number): void {
    this.record("arc", x, y, r, from, to);
  }
  arcTo(x1: number, y1: number, x2: number, y2: number, r: number): void {
    this.record("arcTo", x1, y1, x2, y2, r);
  }
  rect(x: number, y: number, w: number, h: number): void {
    this.record("rect", x, y, w, h);
  }
  fill(): void {
    this.record("fill");
  }
  stroke(): void {
    this.record("stroke");
  }
  clip(): void {
    this.record("clip");
  }

  fillText(text: string, x: number, y: number): void {
    this.texts.push(this.textOp(text, x, y));
    this.record("fillText", x, y);
  }
  strokeText(text: string, x: number, y: number): void {
    this.texts.push(this.textOp(text, x, y));
    this.record("strokeText", x, y);
  }
  /**
   * The advance width `measureText` gives every character, in CSS px.
   *
   * Raise it to make labels "too wide" for their slot without touching the text itself, which is
   * how a fit-based thinning or label-drop path is exercised deterministically.
   */
  charWidth = 6;

  /** A deterministic `charWidth` CSS px per character — enough for fit/thinning assertions. */
  measureText(text: string): { width: number } {
    return { width: text.length * this.charWidth };
  }

  drawImage(src: unknown, ...args: number[]): void {
    const short = args.length <= 4;
    this.drawn.push({
      src,
      args,
      dx: (short ? args[0] : args[4]) ?? 0,
      dy: (short ? args[1] : args[5]) ?? 0,
      dw: (short ? args[2] : args[6]) ?? 0,
      dh: (short ? args[3] : args[7]) ?? 0,
    });
    this.record("drawImage", ...args);
  }

  /**
   * A deterministic pixel readback: this fake never rasterizes its draw calls, so it cannot
   * reconstruct what was actually painted. It returns an opaque-white buffer of exactly the
   * requested `(w, h)` — stable across calls, correctly sized, RGBA order — which is enough for
   * tests that only need real pixel dimensions and a byte layout to round-trip through an
   * encoder (e.g. a lossless PDF/PNG page-image codec). A test that needs pixel *content* to
   * reflect specific draw calls should assert against `ops`/`drawn` instead of `getImageData`.
   */
  getImageData(_x: number, _y: number, w: number, h: number): ImageData {
    return {
      data: new Uint8ClampedArray(w * h * 4).fill(255),
      width: w,
      height: h,
      colorSpace: "srgb",
    } as ImageData;
  }

  save(): void {
    this.stack.push({
      transform: [...this.transform] as [number, number, number, number, number, number],
      fillStyle: this.fillStyle,
      strokeStyle: this.strokeStyle,
      font: this.font,
      textAlign: this.textAlign,
      textBaseline: this.textBaseline,
      lineWidth: this.lineWidth,
      globalAlpha: this.globalAlpha,
      dash: [...this.dash],
    });
    this.depth += 1;
    if (this.depth > this.maxDepth) this.maxDepth = this.depth;
    this.record("save");
  }
  restore(): void {
    const s = this.stack.pop();
    if (s !== undefined) {
      this.transform = s.transform;
      this.fillStyle = s.fillStyle;
      this.strokeStyle = s.strokeStyle;
      this.font = s.font;
      this.textAlign = s.textAlign;
      this.textBaseline = s.textBaseline;
      this.lineWidth = s.lineWidth;
      this.globalAlpha = s.globalAlpha;
      this.dash = s.dash;
      this.depth -= 1;
    }
    this.record("restore");
  }

  /* --- test helpers --- */

  /** Every recorded call of one method, in order. */
  calls(op: string): Op[] {
    return this.ops.filter((o) => o.op === op);
  }
  /** How many times one method was called. */
  count(op: string): number {
    return this.calls(op).length;
  }
  /** The numeric arguments of every recorded call of one method, in order. */
  argsOf(op: string): number[][] {
    return this.calls(op).map((o) => o.args);
  }
  /**
   * Every `moveTo`+`lineTo` pair recorded, as lines.
   *
   * A path is a chain: each `lineTo` starts where the previous `moveTo` or `lineTo` ended, so the
   * segments of a multi-point path are all reported, not only the first.
   */
  lines(): Line[] {
    const out: Line[] = [];
    let cursor: [number, number] | null = null;
    for (const o of this.ops) {
      if (o.op === "beginPath") {
        // A fresh path has no current point: a real context treats its first `lineTo` as a
        // `moveTo`, so no segment may be fabricated from the previous subpath's endpoint.
        cursor = null;
      } else if (o.op === "moveTo") {
        cursor = [o.args[0] ?? 0, o.args[1] ?? 0];
      } else if (o.op === "lineTo") {
        if (cursor === null) continue;
        const to: [number, number] = [o.args[0] ?? 0, o.args[1] ?? 0];
        out.push({ x1: cursor[0], y1: cursor[1], x2: to[0], y2: to[1], stroke: o.stroke });
        cursor = to;
      }
    }
    return out;
  }
  /** The x coordinates of the vertical lines recorded, in draw order, optionally by stroke colour. */
  verticalXs(stroke?: string): number[] {
    return this.lines()
      .filter((l) => l.x1 === l.x2 && (stroke === undefined || l.stroke === stroke))
      .map((l) => l.x1);
  }
  /** The recorded method names, in order — for asserting *ordering* (background before bars). */
  opNames(): string[] {
    return this.ops.map((o) => o.op);
  }
  /** Clears the logs but keeps the live state (transform, styles, save depth). */
  reset(): void {
    this.ops.length = 0;
    this.texts.length = 0;
    this.drawn.length = 0;
    this.maxDepth = this.depth;
  }

  private textOp(text: string, x: number, y: number): TextOp {
    return {
      text,
      x,
      y,
      fill: this.fillStyle,
      stroke: this.strokeStyle,
      font: this.font,
      align: this.textAlign,
      baseline: this.textBaseline,
    };
  }
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
  /** Native scroll offsets (the grid mirrors its body's onto its header). */
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
   * measures an element *before* positioning it (as a tooltip does) rather than after.
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
   * (an `<a download>` save, for one) and registers no listener at all.
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

/** Knobs for the canvases a `FakeDocument` hands out. */
export interface CanvasOptions {
  /** `false` removes `toBlob`, exercising the `toDataURL` fallback path. */
  toBlob?: boolean;
  /** `null` makes `toBlob` report an encoding failure. */
  blob?: Blob | null;
  dataUrl?: string;
  /** `null` makes `getContext("2d")` fail. */
  context?: FakeContext2D | null;
}

export class FakeCanvas extends FakeElement {
  width = 0;
  height = 0;
  context: FakeContext2D | null = new FakeContext2D();
  dataUrl = "data:image/png;base64,AAAA";
  blob: Blob | null = new Blob([new Uint8Array([1, 2, 3])], { type: "image/png" });
  /** The `type` argument of every `toDataURL` / `toBlob` call, in order. */
  readonly toDataURLTypes: (string | undefined)[] = [];
  readonly toBlobTypes: (string | undefined)[] = [];
  toBlob: ((cb: (b: Blob | null) => void, type?: string) => void) | undefined;

  constructor(tagName: string, ownerDocument: FakeDocument) {
    super(tagName, ownerDocument);
    this.toBlob = (cb, type): void => {
      this.toBlobTypes.push(type);
      // Asynchronous, like the real thing.
      queueMicrotask(() => cb(this.blob));
    };
  }

  getContext(id: string): FakeContext2D | null {
    return id === "2d" ? this.context : null;
  }
  toDataURL(type?: string): string {
    this.toDataURLTypes.push(type);
    return this.dataUrl;
  }
}

/* ------------------------------------------------------------------ *
 * Document
 * ------------------------------------------------------------------ */

/** A `MutationObserver` double's registration, as the harness records it. */
export interface ObserverRecord {
  target: unknown;
  /** The `attributeFilter` the observer was registered with, if any. */
  filter: string[] | undefined;
  callback: () => void;
  connected: boolean;
}

/** Stand-in for `window`: what a viewport-clamping or clip-walking plugin reads off it. */
export interface FakeView {
  innerWidth: number;
  innerHeight: number;
  getComputedStyle(el: FakeElement): { overflowX: string; overflowY: string };
}

/** Builds a window stand-in whose computed styles report each element's own overflow. */
export function fakeView(innerWidth: number, innerHeight: number): FakeView {
  return {
    innerWidth,
    innerHeight,
    getComputedStyle: (el) => ({ overflowX: el.overflowX, overflowY: el.overflowY }),
  };
}

export class FakeDocument {
  /** Layout stand-in: every created element starts out reporting this box. */
  defaultRect: Rect = { left: 0, top: 0, width: 0, height: 0 };
  /** Applied to every canvas produced by `createElement("canvas")`. */
  canvasOptions: CanvasOptions = {};
  /** `undefined` by default, matching a headless environment with no window. */
  defaultView: FakeView | undefined;
  /** Defaults to `body` (set in the constructor), matching real DOM's idle focus target. */
  activeElement: FakeElement | null = null;

  /** Every element `createElement` produced, in order. */
  readonly created: FakeElement[] = [];
  readonly handlers = new Map<string, Set<Handler>>();
  /** Live `MutationObserver` doubles; `installDom` populates this. */
  readonly observers: ObserverRecord[] = [];

  // Stand-ins for `document.body` / `document.documentElement`, the two targets a keystroke lands
  // on when nothing on the page holds the focus (keyboard-a11y.md §3).
  readonly documentElement: FakeElement;
  readonly body: FakeElement;

  constructor() {
    this.documentElement = new FakeElement("HTML", this);
    this.body = new FakeElement("BODY", this);
    this.documentElement.appendChild(this.body);
    // Real DOM: activeElement is body whenever nothing on the page holds the focus.
    this.activeElement = this.body;
  }

  createElement(tag: string): FakeElement {
    // Dispatch on the raw, lowercase tag name — `canvas`/`input` are how a caller spells them —
    // but the element itself reports its `tagName` uppercased, as a real HTML document does.
    const el =
      tag === "canvas"
        ? this.createCanvas()
        : tag === "input"
          ? new FakeInput(tag.toUpperCase(), this)
          : new FakeElement(tag.toUpperCase(), this);
    el.rect = { ...this.defaultRect };
    this.created.push(el);
    return el;
  }

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
  /** Invokes every document-level listener for `type`. */
  fire(type: string, event: unknown = { type }): void {
    for (const fn of [...(this.handlers.get(type) ?? [])]) {
      (fn as (e: unknown) => void)(event);
    }
  }
  /** Live document-level listeners for one type, or for every type when `type` is omitted. */
  listenerCount(type?: string): number {
    if (type !== undefined) return this.handlers.get(type)?.size ?? 0;
    let n = 0;
    for (const set of this.handlers.values()) n += set.size;
    return n;
  }

  /** Every canvas this document created, in order. */
  createdCanvases(): FakeCanvas[] {
    return this.created.filter((el): el is FakeCanvas => el instanceof FakeCanvas);
  }

  /**
   * Notifies the `MutationObserver` doubles watching `el` of an attribute change, honouring each
   * observer's `attributeFilter`. `setAttribute` / `removeAttribute` call this for you.
   */
  notifyAttributeChange(el: FakeElement, name: string): void {
    for (const o of [...this.observers]) {
      if (!o.connected || o.target !== el) continue;
      if (o.filter !== undefined && !o.filter.includes(name)) continue;
      o.callback();
    }
  }

  private createCanvas(): FakeCanvas {
    const c = new FakeCanvas("CANVAS", this);
    const o = this.canvasOptions;
    if (o.toBlob === false) c.toBlob = undefined;
    if (o.blob !== undefined) c.blob = o.blob;
    if (o.dataUrl !== undefined) c.dataUrl = o.dataUrl;
    if (o.context !== undefined) c.context = o.context;
    return c;
  }
}

/* ------------------------------------------------------------------ *
 * Global installation
 * ------------------------------------------------------------------ */

/** A `matchMedia` double. Which listener pair it exposes depends on `DomOptions.legacyMediaQuery`. */
export interface MediaQueryDouble {
  media: string;
  matches: boolean;
  listeners: Set<() => void>;
  addEventListener?(type: string, fn: () => void): void;
  removeEventListener?(type: string, fn: () => void): void;
  /** Legacy pre-`EventTarget` surface (older Safari). */
  addListener?(fn: () => void): void;
  removeListener?(fn: () => void): void;
}

export interface DomOptions {
  /** Default element width; also the root's. */
  width?: number;
  /** Default element height; also the root's. */
  height?: number;
  /** Default element `left`, for testing client-x → local-x conversions. */
  left?: number;
  /** Default element `top`. */
  top?: number;
  /** `devicePixelRatio`. */
  dpr?: number;
  /** `false` removes `requestAnimationFrame` entirely, exercising a timer fallback. */
  raf?: boolean;
  /** `true` gives the `matchMedia` doubles only the legacy `addListener` / `removeListener` pair. */
  legacyMediaQuery?: boolean;
  /**
   * CSS custom properties (and any other property) `getComputedStyle().getPropertyValue()` reports.
   * Absent names read as `""` — the no-stylesheet path every plugin must tolerate. Mutate
   * `harness.tokens` between reads to simulate a restyle.
   */
  tokens?: Record<string, string>;
  /** Omit `globalThis.getComputedStyle`. */
  noComputedStyle?: boolean;
  /** Omit `globalThis.matchMedia`. */
  noMatchMedia?: boolean;
  /** Omit `globalThis.MutationObserver`. */
  noMutationObserver?: boolean;
  /** Omit `globalThis.ResizeObserver`. */
  noResizeObserver?: boolean;
}

export interface DomHarness {
  document: FakeDocument;
  /** A detached root element sized to `width` × `height`, to pass as `GanttOptions.element`. */
  root: FakeElement;
  /** The live token map `getComputedStyle` reads; mutate it to simulate a restyle. */
  tokens: Record<string, string>;
  /** How many times `getComputedStyle` was called — proves a bulk read is cached. */
  computedStyleCalls(): number;
  /**
   * Every property name passed to `getComputedStyle().getPropertyValue()`, in call order and
   * including repeats — so a test can assert that a token is *not* read at all on a code path that
   * should never consult it.
   */
  propertyReads(): string[];

  /** Runs every currently queued rAF callback exactly once; returns how many ran. */
  flushFrames(): number;
  /** Runs frames repeatedly until the queue stays empty (for a chain of re-scheduling frames). */
  flushAllFrames(limit?: number): number;
  pendingFrames(): number;
  /** How many queued frames were cancelled — a cancel-on-dispose assertion. */
  cancelledFrames(): number;

  setDpr(dpr: number): void;
  /** Fires `change` on every live `matchMedia` double (simulates a DPR / color-scheme change). */
  fireMediaChange(): void;
  mediaQueries(): readonly MediaQueryDouble[];
  /** `matchMedia` doubles that still have a `change` listener attached. */
  liveMediaListeners(): number;

  resizeObserverCount(): number;
  /** Every element under observation, flattened across all live `ResizeObserver`s. */
  resizeObserverTargets(): FakeElement[];
  /** The observed elements of each live `ResizeObserver`, one array per observer. */
  resizeObserverGroups(): FakeElement[][];
  triggerResizeObservers(): void;

  /** Every `MutationObserver` registration, connected or not. */
  mutationObservers(): readonly ObserverRecord[];
  /** `MutationObserver` + `ResizeObserver` doubles that have not been disconnected. */
  liveObservers(): number;

  restore(): void;
}

type MutableGlobal = Record<string, unknown>;

const PATCHED = [
  "requestAnimationFrame",
  "cancelAnimationFrame",
  "devicePixelRatio",
  "matchMedia",
  "ResizeObserver",
  "MutationObserver",
  "getComputedStyle",
] as const;

/**
 * Installs the doubles onto `globalThis` and returns the harness.
 *
 * Always call `restore()` (an `afterEach` is the usual home) — it puts back exactly what was there
 * before, deleting the globals that did not exist rather than leaving `undefined` behind.
 */
export function installDom(options: DomOptions = {}): DomHarness {
  const g = globalThis as unknown as MutableGlobal;
  const saved: Record<string, unknown> = {};
  const present = new Set<string>();
  for (const key of PATCHED) {
    saved[key] = g[key];
    if (key in g) present.add(key);
  }

  const document = new FakeDocument();
  document.defaultRect = {
    left: options.left ?? 0,
    top: options.top ?? 0,
    width: options.width ?? 800,
    height: options.height ?? 600,
  };
  const root = new FakeElement("div", document);
  root.rect = { ...document.defaultRect };

  const tokens: Record<string, string> = { ...(options.tokens ?? {}) };
  let computedStyleCalls = 0;
  const propertyReads: string[] = [];

  /* --- animation frames --- */
  let nextId = 1;
  const queue = new Map<number, () => void>();
  let cancelled = 0;
  if (options.raf === false) {
    delete g["requestAnimationFrame"];
    delete g["cancelAnimationFrame"];
  } else {
    g["requestAnimationFrame"] = (cb: () => void): number => {
      const id = nextId++;
      queue.set(id, cb);
      return id;
    };
    g["cancelAnimationFrame"] = (id: number): void => {
      if (queue.delete(id)) cancelled += 1;
    };
  }
  g["devicePixelRatio"] = options.dpr ?? 1;

  /* --- matchMedia --- */
  const queries: MediaQueryDouble[] = [];
  if (options.noMatchMedia) delete g["matchMedia"];
  else {
    g["matchMedia"] = (media: string): MediaQueryDouble => {
      const listeners = new Set<() => void>();
      const mql: MediaQueryDouble = options.legacyMediaQuery
        ? {
            media,
            matches: true,
            listeners,
            addListener: (fn) => void listeners.add(fn),
            removeListener: (fn) => void listeners.delete(fn),
          }
        : {
            media,
            matches: true,
            listeners,
            addEventListener: (type, fn) => {
              if (type === "change") listeners.add(fn);
            },
            removeEventListener: (type, fn) => {
              if (type === "change") listeners.delete(fn);
            },
          };
      queries.push(mql);
      return mql;
    };
  }

  /* --- observers --- */
  const resizeObservers: { cb: () => void; connected: boolean; targets: FakeElement[] }[] = [];
  if (options.noResizeObserver) delete g["ResizeObserver"];
  else {
    g["ResizeObserver"] = class {
      private readonly entry: { cb: () => void; connected: boolean; targets: FakeElement[] };
      constructor(cb: () => void) {
        this.entry = { cb, connected: true, targets: [] };
        resizeObservers.push(this.entry);
      }
      observe(target: FakeElement): void {
        this.entry.targets.push(target);
      }
      unobserve(target: FakeElement): void {
        const i = this.entry.targets.indexOf(target);
        if (i >= 0) this.entry.targets.splice(i, 1);
      }
      disconnect(): void {
        this.entry.connected = false;
      }
    };
  }

  if (options.noMutationObserver) delete g["MutationObserver"];
  else {
    g["MutationObserver"] = class {
      #rec: ObserverRecord | null = null;
      constructor(private readonly cb: () => void) {}
      observe(target: unknown, init?: { attributeFilter?: string[] }): void {
        this.#rec = {
          target,
          filter: init?.attributeFilter,
          callback: () => this.cb(),
          connected: true,
        };
        document.observers.push(this.#rec);
      }
      takeRecords(): unknown[] {
        return [];
      }
      disconnect(): void {
        if (this.#rec !== null) this.#rec.connected = false;
      }
    };
  }

  /* --- getComputedStyle --- */
  if (options.noComputedStyle) delete g["getComputedStyle"];
  else {
    g["getComputedStyle"] = (
      el?: FakeElement,
    ): { getPropertyValue(name: string): string; overflowX: string; overflowY: string } => {
      computedStyleCalls += 1;
      return {
        getPropertyValue: (name: string): string => {
          propertyReads.push(name);
          return tokens[name] ?? "";
        },
        overflowX: el?.overflowX ?? "visible",
        overflowY: el?.overflowY ?? "visible",
      };
    };
  }

  const runFrames = (): number => {
    const batch = [...queue.values()];
    queue.clear();
    for (const cb of batch) cb();
    return batch.length;
  };

  return {
    document,
    root,
    tokens,
    computedStyleCalls: () => computedStyleCalls,
    propertyReads: () => [...propertyReads],

    flushFrames: runFrames,
    flushAllFrames(limit = 20): number {
      let total = 0;
      for (let i = 0; i < limit && queue.size > 0; i += 1) total += runFrames();
      return total;
    },
    pendingFrames: () => queue.size,
    cancelledFrames: () => cancelled,

    setDpr(dpr: number): void {
      g["devicePixelRatio"] = dpr;
    },
    fireMediaChange(): void {
      for (const mql of [...queries]) for (const fn of [...mql.listeners]) fn();
    },
    mediaQueries: () => queries,
    liveMediaListeners: () => queries.reduce((n, q) => n + q.listeners.size, 0),

    resizeObserverCount: () => resizeObservers.filter((o) => o.connected).length,
    resizeObserverTargets: () =>
      resizeObservers.filter((o) => o.connected).flatMap((o) => o.targets),
    resizeObserverGroups: () =>
      resizeObservers.filter((o) => o.connected).map((o) => [...o.targets]),
    triggerResizeObservers(): void {
      for (const o of resizeObservers) if (o.connected) o.cb();
    },

    mutationObservers: () => document.observers,
    liveObservers: () =>
      resizeObservers.filter((o) => o.connected).length +
      document.observers.filter((o) => o.connected).length,

    restore(): void {
      for (const key of PATCHED) {
        if (present.has(key)) g[key] = saved[key];
        else delete g[key];
      }
    },
  };
}

/* ------------------------------------------------------------------ *
 * Casts and event doubles
 * ------------------------------------------------------------------ */

/** Casts a fake element to the DOM type the core/plugin signatures expect. */
export function asElement(el: FakeElement): HTMLElement {
  return el as unknown as HTMLElement;
}
export function asCanvas(el: FakeElement): HTMLCanvasElement {
  return el as unknown as HTMLCanvasElement;
}
export function asDocument(doc: FakeDocument): Document {
  return doc as unknown as Document;
}
/** Casts a recording context to the type `LayerContribution.draw` expects. */
export function asContext(g: FakeContext2D): CanvasRenderingContext2D {
  return g as unknown as CanvasRenderingContext2D;
}

/** The `PointerEvent` fields a gesture test varies. */
export interface PointerInit {
  pointerId?: number;
  buttons?: number;
  altKey?: boolean;
  ctrlKey?: boolean;
  metaKey?: boolean;
  shiftKey?: boolean;
  /** The raw event type; `drag-edit` tells a cancelled capture from a release by it. */
  type?: string;
  /** The element the press landed on; the renderer routes overlay presses by it. */
  target?: unknown;
}

/** The pointer a test uses unless it names another. */
export const DEFAULT_POINTER_ID = 1;

/** A recording event double: `preventDefault` / `stopPropagation` are observable, not ignored. */
export interface EventDouble {
  defaultPrevented: boolean;
  propagationStopped: boolean;
  preventDefault(): void;
  stopPropagation(): void;
}

export interface PointerDouble extends EventDouble {
  type: string;
  clientX: number;
  clientY: number;
  pointerId: number;
  buttons: number;
  altKey: boolean;
  ctrlKey: boolean;
  metaKey: boolean;
  shiftKey: boolean;
  target: unknown;
}

function eventBase(): EventDouble {
  const e: EventDouble = {
    defaultPrevented: false,
    propagationStopped: false,
    preventDefault(): void {
      e.defaultPrevented = true;
    },
    stopPropagation(): void {
      e.propagationStopped = true;
    },
  };
  return e;
}

/**
 * A `PointerEvent` double at `(clientX, clientY)`.
 *
 * Defaults to `pointermove` with the primary button held (`buttons: 1`) and pointer
 * `DEFAULT_POINTER_ID`; name a `type` for a down/up/cancel. Cast with `asPointerEvent` where a
 * `PointerEvent` is required.
 */
export function pointerEvent(
  clientX: number,
  clientY: number,
  init: PointerInit = {},
): PointerDouble {
  return Object.assign(eventBase(), {
    type: init.type ?? "pointermove",
    clientX,
    clientY,
    pointerId: init.pointerId ?? DEFAULT_POINTER_ID,
    buttons: init.buttons ?? 1,
    altKey: init.altKey ?? false,
    ctrlKey: init.ctrlKey ?? false,
    metaKey: init.metaKey ?? false,
    shiftKey: init.shiftKey ?? false,
    target: init.target,
  });
}

export function asPointerEvent(e: PointerDouble): PointerEvent {
  return e as unknown as PointerEvent;
}

export interface WheelDouble extends EventDouble {
  type: string;
  deltaX: number;
  deltaY: number;
  clientX: number;
  clientY: number;
  ctrlKey: boolean;
  shiftKey: boolean;
}

/**
 * A `WheelEvent` double: pinch-zoom is `ctrlKey: true`, per the platform convention.
 *
 * `shiftKey` models the horizontal-scroll modifier as browsers actually dispatch it — the notch
 * stays on `deltaY` and the listener is left to swap the axes.
 */
export function wheelEvent(
  init: {
    deltaX?: number;
    deltaY?: number;
    clientX?: number;
    clientY?: number;
    ctrlKey?: boolean;
    shiftKey?: boolean;
  } = {},
): WheelDouble {
  return Object.assign(eventBase(), {
    type: "wheel",
    deltaX: init.deltaX ?? 0,
    deltaY: init.deltaY ?? 0,
    clientX: init.clientX ?? 0,
    clientY: init.clientY ?? 0,
    ctrlKey: init.ctrlKey ?? false,
    shiftKey: init.shiftKey ?? false,
  });
}

export interface KeyDouble extends EventDouble {
  type: string;
  key: string;
  altKey: boolean;
  ctrlKey: boolean;
  metaKey: boolean;
  shiftKey: boolean;
  target: unknown;
}

/** A `KeyboardEvent` double. */
export function keyEvent(
  key: string,
  init: {
    type?: string;
    altKey?: boolean;
    ctrlKey?: boolean;
    metaKey?: boolean;
    shiftKey?: boolean;
    target?: unknown;
  } = {},
): KeyDouble {
  return Object.assign(eventBase(), {
    type: init.type ?? "keydown",
    key,
    altKey: init.altKey ?? false,
    ctrlKey: init.ctrlKey ?? false,
    metaKey: init.metaKey ?? false,
    shiftKey: init.shiftKey ?? false,
    target: init.target,
  });
}

export function asKeyboardEvent(e: KeyDouble): KeyboardEvent {
  return e as unknown as KeyboardEvent;
}
