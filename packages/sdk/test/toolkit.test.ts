/**
 * `@stargantt/sdk` behavior (docs/specs/sdk.md, Module: sdk/dom / sdk/time): the shared `listen` /
 * `isoDay` / `MS_DAY` / `parsePx` helpers.
 */
import type { Disposable, PluginContext } from "@stargantt/core";
import { describe, expect, it } from "vitest";
import { MS_DAY, isoDay, listen, parsePx } from "../src/index";

interface Recorded {
  type: string;
  handler: EventListener;
  options: AddEventListenerOptions | undefined;
}

/** An `EventTarget` double recording every add/remove pair, plus a `ctx` exposing only `own`. */
function target(): {
  el: EventTarget;
  added: Recorded[];
  removed: Recorded[];
  fire(type: string, event: unknown): void;
} {
  const added: Recorded[] = [];
  const removed: Recorded[] = [];
  const el = {
    addEventListener(type: string, handler: EventListener, options?: AddEventListenerOptions) {
      added.push({ type, handler, options });
    },
    removeEventListener(type: string, handler: EventListener, options?: AddEventListenerOptions) {
      removed.push({ type, handler, options });
    },
  } as unknown as EventTarget;
  return {
    el,
    added,
    removed,
    fire(type, event): void {
      for (const a of added) if (a.type === type) a.handler(event as Event);
    },
  };
}

function fakeCtx(owned: Disposable[]): PluginContext {
  return { own: (d: Disposable) => void owned.push(d) } as unknown as PluginContext;
}

describe("listen", () => {
  it("attaches the listener immediately", () => {
    const t = target();
    let hits = 0;
    listen(fakeCtx([]), t.el, "pointerdown", () => void (hits += 1));
    expect(t.added).toHaveLength(1);
    expect(t.added[0]?.type).toBe("pointerdown");
    t.fire("pointerdown", {});
    expect(hits).toBe(1);
  });

  it("hands the removal to ctx.own() rather than removing it eagerly", () => {
    const t = target();
    const owned: Disposable[] = [];
    listen(fakeCtx(owned), t.el, "click", () => {});
    expect(owned).toHaveLength(1);
    expect(t.removed).toHaveLength(0);
    owned[0]?.dispose();
    expect(t.removed).toHaveLength(1);
    expect(t.removed[0]?.handler).toBe(t.added[0]?.handler);
  });

  it("passes the same options object to add and to remove, so a capture listener is removable", () => {
    const t = target();
    const owned: Disposable[] = [];
    const options: AddEventListenerOptions = { capture: true, passive: false };
    listen(fakeCtx(owned), t.el, "focusin", () => {}, options);
    owned[0]?.dispose();
    expect(t.added[0]?.options).toBe(options);
    expect(t.removed[0]?.options).toBe(options);
  });

  it("registers the handler verbatim, so the event reaches it untouched", () => {
    const t = target();
    const seen: unknown[] = [];
    listen(fakeCtx([]), t.el, "keydown", (e) => void seen.push(e));
    const event = { key: "Escape" };
    t.fire("keydown", event);
    expect(seen).toEqual([event]);
  });
});

describe("isoDay / MS_DAY", () => {
  it("MS_DAY is one day in milliseconds", () => {
    expect(MS_DAY).toBe(24 * 60 * 60 * 1000);
  });

  it("formats an instant as a UTC calendar day", () => {
    expect(isoDay(Date.UTC(2024, 0, 31))).toBe("2024-01-31");
  });

  it("takes the UTC day, not a local one, for an instant late in the day", () => {
    expect(isoDay(Date.UTC(2024, 0, 31, 23, 59, 59, 999))).toBe("2024-01-31");
    expect(isoDay(Date.UTC(2024, 0, 31) + MS_DAY)).toBe("2024-02-01");
  });

  it("formats the epoch itself", () => {
    expect(isoDay(0)).toBe("1970-01-01");
  });

  it("returns undefined for a non-finite instant instead of throwing", () => {
    expect(isoDay(Number.NaN)).toBeUndefined();
    expect(isoDay(Number.POSITIVE_INFINITY)).toBeUndefined();
    expect(isoDay(undefined as unknown as number)).toBeUndefined();
  });

  it("returns undefined for a finite instant outside the representable Date range", () => {
    expect(isoDay(8.64e15 + 1)).toBeUndefined();
  });
});

describe("parsePx", () => {
  it("parses a px length", () => {
    expect(parsePx("44px", 10)).toBe(44);
  });

  it("parses a bare number and a fractional length", () => {
    expect(parsePx("44", 10)).toBe(44);
    expect(parsePx("0.5px", 10)).toBe(0.5);
  });

  it("tolerates surrounding whitespace, as getPropertyValue can return it", () => {
    expect(parsePx("  24px ", 10)).toBe(24);
  });

  it("falls back for an undeclared (empty) token", () => {
    expect(parsePx("", 10)).toBe(10);
  });

  it("falls back for a non-numeric token", () => {
    expect(parsePx("auto", 10)).toBe(10);
    expect(parsePx("var(--x)", 10)).toBe(10);
  });

  it("falls back for a non-positive length — a zero-width column is not a usable value", () => {
    expect(parsePx("0px", 10)).toBe(10);
    expect(parsePx("-4px", 10)).toBe(10);
  });

  it("falls back for a non-finite token", () => {
    expect(parsePx("Infinity", 10)).toBe(10);
  });
});
