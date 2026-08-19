/**
 * Installs the fake DOM's globals — animation frames, `matchMedia`, `ResizeObserver`,
 * `MutationObserver` and `getComputedStyle` — onto `globalThis`, and hands back a harness for
 * driving and inspecting them.
 */
import type { FakeContext2D } from "./dom-canvas";
import { FakeDocument } from "./dom-document";
import type { ObserverRecord } from "./dom-document";
import { FakeElement } from "./dom-element";

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
  /** A detached root element sized to `width` × `height`, to pass as the chart's `element` option. */
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
 * Casts
 * ------------------------------------------------------------------ */

/** Casts a fake element to the DOM type the core/plugin signatures expect. */
export function asElement(el: FakeElement): HTMLElement {
  return el as unknown as HTMLElement;
}
/** Casts a recording context to the type a canvas-drawing contribution expects. */
export function asContext(g: FakeContext2D): CanvasRenderingContext2D {
  return g as unknown as CanvasRenderingContext2D;
}
