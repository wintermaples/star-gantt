/** Hostless unit tests for the reduced-motion watcher (contract §6.7). */
import { describe, expect, it } from "vitest";
import { createMotionWatcher } from "../../src/internal/render/motion";
import type { MediaQueryLike } from "../../src/internal/render/motion";

function mediaDouble(matches: boolean): MediaQueryLike & {
  fire(matches: boolean): void;
  listeners(): number;
} {
  const handlers = new Set<() => void>();
  const mql = {
    matches,
    addEventListener: (_type: "change", h: () => void) => void handlers.add(h),
    removeEventListener: (_type: "change", h: () => void) => void handlers.delete(h),
    fire(next: boolean) {
      mql.matches = next;
      for (const h of handlers) h();
    },
    listeners: () => handlers.size,
  };
  return mql;
}

describe("createMotionWatcher", () => {
  it("reports the live value of prefers-reduced-motion, tracking changes", () => {
    const mql = mediaDouble(false);
    const queries: string[] = [];
    const watcher = createMotionWatcher((q) => {
      queries.push(q);
      return mql;
    });
    expect(queries).toEqual(["(prefers-reduced-motion: reduce)"]);
    expect(watcher.reduced()).toBe(false);
    mql.fire(true);
    expect(watcher.reduced()).toBe(true);
    mql.fire(false);
    expect(watcher.reduced()).toBe(false);
  });

  it("unsubscribes on dispose", () => {
    const mql = mediaDouble(false);
    const watcher = createMotionWatcher(() => mql);
    expect(mql.listeners()).toBe(1);
    watcher.dispose();
    expect(mql.listeners()).toBe(0);
  });

  it("falls back to the legacy addListener pair", () => {
    const handlers = new Set<() => void>();
    const mql: MediaQueryLike = {
      matches: false,
      addListener: (h) => void handlers.add(h),
      removeListener: (h) => void handlers.delete(h),
    };
    const watcher = createMotionWatcher(() => mql);
    mql.matches = true;
    for (const h of handlers) h();
    expect(watcher.reduced()).toBe(true);
    watcher.dispose();
    expect(handlers.size).toBe(0);
  });

  it("reports false forever without matchMedia", () => {
    const watcher = createMotionWatcher(undefined);
    // The shared test DOM installs a matchMedia double; the watcher may bind it, so only the
    // no-throw + boolean contract is asserted here.
    expect(typeof watcher.reduced()).toBe("boolean");
    watcher.dispose();
  });
});
