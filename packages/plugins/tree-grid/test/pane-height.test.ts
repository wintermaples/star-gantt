/**
 * Repaint on a pane height change: the grid observes its own pane element and repaints when the
 * pane's rendered height changes without a scroll or a data change — the gap a bottom-pane divider
 * drag (or a vertical host resize) falls into. A width-only resize must not repaint, the repaint
 * must ride the frame clock, and the scroll clamp must re-run so a grown pane cannot strand
 * `scrollTop` past the new maximum.
 *
 * docs/specs/plugins/tree-grid.md § Scroll synchronization, § Internal modules
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { boot, flatTasks } from "./_boot";
import type { Booted } from "./_boot";

let booted: Booted | undefined;

afterEach(() => {
  // Dispose before the global stubs come off: the fallback's own disposal calls
  // `globalThis.removeEventListener`, which some tests below stub in.
  booted?.gantt.dispose();
  booted?.dom.restore();
  booted = undefined;
  vi.unstubAllGlobals();
});

/** The fake DOM reports 400×300 for every element, and the default row height is 28. */
const VIEWPORT_H = 300;

/**
 * Simulates the layout effect of a pane-height change: the pane element and the body flexing
 * inside it move together (the fake DOM has no layout engine to do it for us).
 */
function setPaneHeight(b: Booted, height: number): void {
  b.pane.rect = { ...b.pane.rect, height };
  b.body.rect = { ...b.body.rect, height };
}

describe("repaint on a pane height change", () => {
  it("observes the mounted pane element itself", () => {
    booted = boot();
    expect(booted.dom.resizeObserverTargets()).toContain(booted.pane);
  });

  it("repaints and materialises the newly visible rows when the pane grows taller", () => {
    booted = boot();
    booted.data.load(flatTasks(1000));
    booted.dom.flushFrames();
    expect(booted.visibleRows().length).toBe(Math.ceil(VIEWPORT_H / 28));

    setPaneHeight(booted, 600);
    booted.dom.triggerResizeObservers();
    booted.dom.flushFrames();
    const rows = booted.visibleRows();
    expect(rows.length).toBe(Math.ceil(600 / 28));
    expect(rows[rows.length - 1]?.getAttribute("data-row-index")).toBe("21");
  });

  it("hides the rows a shorter pane no longer shows", () => {
    booted = boot();
    booted.data.load(flatTasks(1000));
    booted.dom.flushFrames();

    setPaneHeight(booted, 150);
    booted.dom.triggerResizeObservers();
    booted.dom.flushFrames();
    expect(booted.visibleRows().length).toBe(Math.ceil(150 / 28));
  });

  it("does not repaint for a width-only resize", () => {
    booted = boot();
    booted.data.load(flatTasks(50));
    booted.dom.flushFrames();
    expect(booted.dom.pendingFrames()).toBe(0);

    booted.pane.rect = { ...booted.pane.rect, width: 700 };
    booted.dom.triggerResizeObservers();
    expect(booted.dom.pendingFrames()).toBe(0);
  });

  it("ignores a notification that changed nothing (the observer's initial delivery)", () => {
    booted = boot();
    booted.data.load(flatTasks(50));
    booted.dom.flushFrames();

    booted.dom.triggerResizeObservers();
    expect(booted.dom.pendingFrames()).toBe(0);
  });

  it("coalesces a burst of height notifications into one repaint frame", () => {
    booted = boot();
    booted.data.load(flatTasks(50));
    booted.dom.flushFrames();

    // A divider drag delivers one notification per layout pass; several inside one frame must
    // still cost a single repaint.
    setPaneHeight(booted, 400);
    booted.dom.triggerResizeObservers();
    setPaneHeight(booted, 420);
    booted.dom.triggerResizeObservers();
    expect(booted.dom.flushFrames()).toBe(1);
  });

  it("re-clamps a `scrollTop` the grown pane pushed past the new maximum", () => {
    booted = boot();
    booted.data.load(flatTasks(12)); // 336px of content against a 300px viewport: max offset 36
    booted.dom.flushFrames();
    booted.pane.fire("wheel", { deltaY: 100_000, preventDefault: () => {} });
    booted.dom.flushFrames();
    expect(booted.visibleRows()[0]?.getAttribute("data-row-index")).toBe("1");

    // The content now fits entirely, so the only honest offset is 0 — the same clamp a scroll
    // runs — and every row is materialised from the top, with no stranded partial window.
    setPaneHeight(booted, 500);
    booted.dom.triggerResizeObservers();
    booted.dom.flushFrames();
    const rows = booted.visibleRows();
    expect(rows[0]?.getAttribute("data-row-index")).toBe("0");
    expect(rows[0]?.style["transform"]).toBe("translateY(0px)");
    expect(rows.length).toBe(12);
  });

  it("disconnects the observer on dispose", () => {
    booted = boot();
    const { dom, pane } = booted;
    booted.gantt.dispose();
    expect(dom.resizeObserverTargets()).not.toContain(pane);
    booted = { ...booted, gantt: { ...booted.gantt, dispose: () => {} } };
  });
});

describe("without `ResizeObserver` (the window-resize fallback)", () => {
  /** Stubs the window listener pair the fallback registers with, returning the live set. */
  function stubWindowListeners(): Set<() => void> {
    const listeners = new Set<() => void>();
    vi.stubGlobal("addEventListener", (type: string, fn: () => void): void => {
      if (type === "resize") listeners.add(fn);
    });
    vi.stubGlobal("removeEventListener", (type: string, fn: () => void): void => {
      if (type === "resize") listeners.delete(fn);
    });
    return listeners;
  }

  it("repaints on a window resize instead", () => {
    const listeners = stubWindowListeners();
    booted = boot([], { noResizeObserver: true });
    booted.data.load(flatTasks(1000));
    booted.dom.flushFrames();
    expect(booted.visibleRows().length).toBe(Math.ceil(VIEWPORT_H / 28));

    setPaneHeight(booted, 600);
    for (const fn of [...listeners]) fn();
    booted.dom.flushFrames();
    expect(booted.visibleRows().length).toBe(Math.ceil(600 / 28));
  });

  it("still ignores a resize that left the height alone", () => {
    const listeners = stubWindowListeners();
    booted = boot([], { noResizeObserver: true });
    booted.data.load(flatTasks(50));
    booted.dom.flushFrames();

    booted.pane.rect = { ...booted.pane.rect, width: 700 };
    for (const fn of [...listeners]) fn();
    expect(booted.dom.pendingFrames()).toBe(0);
  });

  it("removes the window listener on dispose", () => {
    const listeners = stubWindowListeners();
    booted = boot([], { noResizeObserver: true });
    expect(listeners.size).toBe(1);

    booted.gantt.dispose();
    expect(listeners.size).toBe(0);
    booted = { ...booted, gantt: { ...booted.gantt, dispose: () => {} } };
  });

  it("boots and paints when neither API exists (the bare test DOM)", () => {
    // Node's `globalThis` carries no `addEventListener`; make that explicit so the test still
    // pins the inert branch if the runtime ever grows one.
    vi.stubGlobal("addEventListener", undefined);
    vi.stubGlobal("removeEventListener", undefined);
    booted = boot([], { noResizeObserver: true });
    booted.data.load(flatTasks(3));
    booted.dom.flushFrames();
    expect(booted.visibleRows().length).toBe(3);
  });
});
