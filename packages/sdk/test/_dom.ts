/**
 * A minimal DOM double for the `createDialog` tests.
 *
 * Written here rather than taken from `sdk/testing` (the plugin test harness):
 * `@stargantt/sdk` is the bottom of the dependency graph, and a test harness package would sit
 * above it. Nothing may sit below the SDK, so the SDK's own tests bring their own doubles. This
 * mirrors the hand-rolled `EventTarget` double `toolkit.test.ts` already uses.
 */

type Handler = (e: unknown) => void;

export interface Rect {
  left: number;
  top: number;
  width: number;
  height: number;
}

export class FakeElement {
  style: Record<string, string> = {};
  children: FakeElement[] = [];
  parentNode: FakeElement | null = null;
  className = "";
  focused = false;
  /** The layout box `getBoundingClientRect()` reports. Set it to place the element. */
  rect: Rect = { left: 0, top: 0, width: 0, height: 0 };
  readonly attributes = new Map<string, string>();
  readonly handlers = new Map<string, Set<Handler>>();
  readonly captured: number[] = [];
  /** Set on the element `fakeHost` builds — the anchor `isConnected` walks up towards. */
  isDocRoot = false;

  #text = "";

  constructor(
    readonly tagName: string,
    readonly ownerDocument: FakeDocument,
  ) {}

  /**
   * Mirrors `Node.isConnected`: true while a walk up `parentNode` reaches the host `fakeHost` built,
   * false once `remove()` has detached the chain from it. `dialog.ts`'s dispose-time focus restore
   * reads this to decide whether the opener is still a legal focus target.
   */
  get isConnected(): boolean {
    for (let cur: FakeElement | null = this; cur !== null; cur = cur.parentNode) {
      if (cur.isDocRoot) return true;
    }
    return false;
  }

  /** Aggregates descendants like the real DOM, so a title inside a wrapper still reads out. */
  get textContent(): string {
    if (this.children.length === 0) return this.#text;
    return this.children.map((c) => c.textContent).join("");
  }
  set textContent(value: string) {
    this.#text = value;
    for (const child of this.children) child.parentNode = null;
    this.children.length = 0;
  }

  appendChild<T extends FakeElement>(child: T): T {
    child.parentNode?.removeChild(child);
    child.parentNode = this;
    this.children.push(child);
    return child;
  }

  removeChild(child: FakeElement): FakeElement {
    const i = this.children.indexOf(child);
    if (i >= 0) this.children.splice(i, 1);
    child.parentNode = null;
    return child;
  }

  remove(): void {
    this.parentNode?.removeChild(this);
  }

  /** Mirrors `Node.contains`: true when `other` is this element or a descendant of it. */
  contains(other: unknown): boolean {
    let cur = other as FakeElement | null;
    while (cur !== null) {
      if (cur === this) return true;
      cur = cur.parentNode;
    }
    return false;
  }

  setAttribute(name: string, value: string): void {
    this.attributes.set(name, value);
  }
  getAttribute(name: string): string | null {
    return this.attributes.get(name) ?? null;
  }

  focus(): void {
    this.focused = true;
    const previous = this.ownerDocument.activeElement;
    if (previous !== null && previous !== this) previous.focused = false;
    this.ownerDocument.activeElement = this;
  }

  getBoundingClientRect(): Rect & { right: number; bottom: number } {
    return {
      ...this.rect,
      right: this.rect.left + this.rect.width,
      bottom: this.rect.top + this.rect.height,
    };
  }

  setPointerCapture(id: number): void {
    if (!this.captured.includes(id)) this.captured.push(id);
  }
  releasePointerCapture(id: number): void {
    const i = this.captured.indexOf(id);
    if (i >= 0) this.captured.splice(i, 1);
  }

  addEventListener(type: string, fn: Handler): void {
    let set = this.handlers.get(type);
    if (set === undefined) {
      set = new Set();
      this.handlers.set(type, set);
    }
    set.add(fn);
  }
  removeEventListener(type: string, fn: Handler): void {
    this.handlers.get(type)?.delete(fn);
  }

  /** Invokes every listener registered for `type`, as a dispatch would. */
  fire(type: string, event: unknown = { type }): void {
    for (const fn of [...(this.handlers.get(type) ?? [])]) fn(event);
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
}

export class FakeDocument {
  activeElement: FakeElement | null = null;
  readonly handlers = new Map<string, Set<Handler>>();

  createElement(tag: string): FakeElement {
    // Real `Document.createElement` always uppercases the tag name in an HTML document; several
    // dialog.ts checks compare `tagName` against uppercase constants without normalizing.
    return new FakeElement(tag.toUpperCase(), this);
  }

  addEventListener(type: string, fn: Handler): void {
    let set = this.handlers.get(type);
    if (set === undefined) {
      set = new Set();
      this.handlers.set(type, set);
    }
    set.add(fn);
  }
  removeEventListener(type: string, fn: Handler): void {
    this.handlers.get(type)?.delete(fn);
  }
  fire(type: string, event: unknown = { type }): void {
    for (const fn of [...(this.handlers.get(type) ?? [])]) fn(event);
  }
  listenerCount(type?: string): number {
    if (type !== undefined) return this.handlers.get(type)?.size ?? 0;
    let n = 0;
    for (const set of this.handlers.values()) n += set.size;
    return n;
  }
}

/** A host element of the given size, in a fresh document. */
export function fakeHost(width: number, height: number): FakeElement {
  const doc = new FakeDocument();
  const host = doc.createElement("div");
  host.rect = { left: 0, top: 0, width, height };
  host.isDocRoot = true;
  return host;
}

/** A recording `PointerEvent` double: `preventDefault` / `stopPropagation` are observable. */
export interface PointerDouble {
  type: string;
  clientX: number;
  clientY: number;
  pointerId: number;
  shiftKey: boolean;
  target: unknown;
  defaultPrevented: boolean;
  propagationStopped: boolean;
  preventDefault(): void;
  stopPropagation(): void;
}

export function pointerEvent(
  clientX: number,
  clientY: number,
  init: { pointerId?: number; type?: string; target?: unknown } = {},
): PointerDouble {
  const e: PointerDouble = {
    type: init.type ?? "pointermove",
    clientX,
    clientY,
    pointerId: init.pointerId ?? 1,
    shiftKey: false,
    target: init.target,
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

export const asElement = (el: FakeElement): HTMLElement => el as unknown as HTMLElement;
