/**
 * The fake `document` double: element creation, focus tracking and `MutationObserver`
 * notification for the elements it owns.
 */
import { FakeContext2D } from "./dom-canvas";
import { FakeElement, FakeInput } from "./dom-element";
import type { Handler, Rect } from "./dom-element";

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

export class FakeDocument {
  /** Layout stand-in: every created element starts out reporting this box. */
  defaultRect: Rect = { left: 0, top: 0, width: 0, height: 0 };
  /** Applied to every canvas produced by `createElement("canvas")`. */
  canvasOptions: CanvasOptions = {};
  /** Defaults to `body` (set in the constructor), matching real DOM's idle focus target. */
  activeElement: FakeElement | null = null;

  /** Every element `createElement` produced, in order. */
  readonly created: FakeElement[] = [];
  readonly handlers = new Map<string, Set<Handler>>();
  /** Live `MutationObserver` doubles; `installDom` populates this. */
  readonly observers: ObserverRecord[] = [];

  // Stand-ins for `document.body` / `document.documentElement`, the two targets a keystroke lands
  // on when nothing on the page holds the focus.
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
