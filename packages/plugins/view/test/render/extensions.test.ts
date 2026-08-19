/**
 * Booted integration tests for the default-off renderer extensions: RTL direction, first-paint
 * timing, dirty-region invalidation, layout batching, progressive detail and prefetch — each
 * asserted through the real plugin over the shared fake DOM.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { boot, probe } from "./_boot";
import { wheelEvent } from "../_utils/index";
import type { ViewService, Viewport } from "../../src/internal/render/index";

function bootWithService(
  config?: Parameters<typeof boot>[2],
  options: Parameters<typeof boot>[1] = { width: 400, height: 300 },
): { booted: ReturnType<typeof boot>; service: ViewService } {
  let service: ViewService | undefined;
  const grab = probe((ctx) => {
    service = ctx.use("stargantt.view");
  });
  const booted = boot([grab], options, config);
  if (service === undefined) throw new Error("renderer service was not provided");
  return { booted, service };
}

afterEach(() => {
  vi.useRealTimers();
});

describe("§6.1 RTL layout switch", () => {
  it("default config leaves the pane's dir attribute unset and reports ltr", () => {
    const { booted, service } = bootWithService();
    expect(booted.pane.getAttribute("dir")).toBeNull();
    expect(service.direction()).toBe("ltr");
    booted.gantt.dispose();
    booted.dom.restore();
  });

  it("direction: 'rtl' marks the pane and is reported through the service", () => {
    const { booted, service } = bootWithService({ direction: "rtl" });
    expect(booted.pane.getAttribute("dir")).toBe("rtl");
    expect(service.direction()).toBe("rtl");
    booted.gantt.dispose();
    booted.dom.restore();
  });

  it("an unusable direction value is ignored", () => {
    const { booted, service } = bootWithService({
      direction: "up" as never,
    });
    expect(booted.pane.getAttribute("dir")).toBeNull();
    expect(service.direction()).toBe("ltr");
    booted.gantt.dispose();
    booted.dom.restore();
  });
});

describe("§6.2 first-paint timing", () => {
  it("is undefined before the first composite and a number afterwards", () => {
    const { booted, service } = bootWithService();
    expect(service.firstPaintMs()).toBeUndefined();
    booted.dom.flushFrames();
    const ms = service.firstPaintMs();
    expect(typeof ms).toBe("number");
    expect(ms).toBeGreaterThanOrEqual(0);
    booted.dom.flushFrames();
    expect(service.firstPaintMs()).toBe(ms); // latched: later frames do not move it
    booted.gantt.dispose();
    booted.dom.restore();
  });
});

describe("§6.4 dirty-region invalidation", () => {
  it("clips a rect-invalidated repaint when dirtyRegions is enabled", () => {
    const { booted, service } = bootWithService({ dirtyRegions: true });
    booted.dom.flushFrames(); // first (full) paint
    const g = booted.ctx("main");
    g.ops.length = 0;
    service.invalidate("main", { x: 10, y: 20, width: 30, height: 40 });
    booted.dom.flushFrames();
    const clear = g.ops.find((o) => o.op === "clearRect");
    expect(clear?.args).toEqual([10, 20, 30, 40]);
    expect(g.opNames()).toContain("clip");
    booted.gantt.dispose();
    booted.dom.restore();
  });

  it("ignores the rect and repaints fully when the option is off (default)", () => {
    const { booted, service } = bootWithService();
    booted.dom.flushFrames();
    const g = booted.ctx("main");
    g.ops.length = 0;
    service.invalidate("main", { x: 10, y: 20, width: 30, height: 40 });
    booted.dom.flushFrames();
    const clear = g.ops.find((o) => o.op === "clearRect");
    expect(clear?.args).toEqual([0, 0, 400, 300]);
    expect(g.opNames()).not.toContain("clip");
    booted.gantt.dispose();
    booted.dom.restore();
  });
});

describe("§6.8 layout read/write batching", () => {
  it("drains queued reads before queued writes in the next frame", () => {
    const { booted, service } = bootWithService();
    booted.dom.flushFrames();
    const order: string[] = [];
    service.batchWrite(() => order.push("write"));
    service.batchRead(() => order.push("read"));
    expect(order).toEqual([]); // nothing runs synchronously
    booted.dom.flushFrames();
    expect(order).toEqual(["read", "write"]);
    booted.gantt.dispose();
    booted.dom.restore();
  });
});

describe("§6.3 progressive detail", () => {
  it("marks scroll frames coarse and refines to fine after the quiet period", () => {
    vi.useFakeTimers();
    const seen: (string | undefined)[] = [];
    const spy = probe((ctx) => {
      ctx.contribute("renderer/layers", {
        id: "spy",
        zIndex: 55,
        draw: (_g, vp: Readonly<Viewport>) => seen.push(vp.detail),
      });
    });
    const booted = boot([spy], { width: 400, height: 300 }, { progressive: true });
    booted.dom.flushFrames(); // initial paint: no scroll yet, fine
    booted.pane.fire("wheel", wheelEvent({ deltaX: 0, deltaY: 40 }));
    booted.dom.flushFrames();
    expect(seen.at(-1)).toBe("coarse");
    vi.advanceTimersByTime(200); // quiet period elapses -> refine repaint queued
    booted.dom.flushFrames();
    expect(seen.at(-1)).toBe("fine");
    booted.gantt.dispose();
    booted.dom.restore();
  });

  it("default config never sets Viewport.detail", () => {
    const seen: unknown[] = [];
    const spy = probe((ctx) => {
      ctx.contribute("renderer/layers", {
        id: "spy",
        zIndex: 55,
        draw: (_g, vp: Readonly<Viewport>) => seen.push(vp.detail),
      });
    });
    const booted = boot([spy], { width: 400, height: 300 });
    booted.dom.flushFrames();
    booted.pane.fire("wheel", wheelEvent({ deltaX: 0, deltaY: 40 }));
    booted.dom.flushFrames();
    expect(seen.every((d) => d === undefined)).toBe(true);
    booted.gantt.dispose();
    booted.dom.restore();
  });
});

describe("§6.5 scroll prediction", () => {
  it("predicts ahead of consecutive scrolls when prefetch is enabled, and never by default", () => {
    vi.useFakeTimers(); // gives the two scroll samples distinct timestamps
    const { booted, service } = bootWithService({ prefetch: true });
    booted.dom.flushFrames();
    expect(service.predictedViewport()).toBeUndefined(); // at rest
    booted.pane.fire("wheel", wheelEvent({ deltaX: 0, deltaY: 40 }));
    vi.advanceTimersByTime(16);
    booted.pane.fire("wheel", wheelEvent({ deltaX: 0, deltaY: 40 }));
    const predicted = service.predictedViewport();
    expect(predicted).toBeDefined();
    expect(predicted!.scrollTop).toBeGreaterThanOrEqual(80);
    booted.gantt.dispose();
    booted.dom.restore();

    const off = bootWithService();
    off.booted.pane.fire("wheel", wheelEvent({ deltaX: 0, deltaY: 40 }));
    off.booted.pane.fire("wheel", wheelEvent({ deltaX: 0, deltaY: 40 }));
    expect(off.service.predictedViewport()).toBeUndefined();
    off.booted.gantt.dispose();
    off.booted.dom.restore();
  });
});

describe("§6.6 / §6.9 text helpers on the service", () => {
  it("textWidth measures once per string and bidiIsolate wraps mixed labels", () => {
    const { booted, service } = bootWithService();
    booted.dom.flushFrames();
    const g = booted.ctx("main") as unknown as CanvasRenderingContext2D;
    const w1 = service.textWidth(g, "Task A");
    const w2 = service.textWidth(g, "Task A");
    expect(w1).toBe(w2);
    expect(w1).toBeGreaterThan(0);
    expect(service.bidiIsolate("משימה A1", "rtl")).toBe("\u2067משימה A1\u2069");
    expect(service.bidiIsolate("plain", "rtl")).toBe("plain");
    expect(typeof service.reducedMotion()).toBe("boolean");
    booted.gantt.dispose();
    booted.dom.restore();
  });
});
