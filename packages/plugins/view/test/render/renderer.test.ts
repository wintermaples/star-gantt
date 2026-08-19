/**
 * Contract §3.2 (`@stargantt/plugin-renderer`) end-to-end through the real core:
 * service surface, extension points, rAF paint loop, DPR, virtual scroll, hit testing,
 * pointer re-emission, fault barrier and disposal.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { view } from "../../src/index";
import type {
  CanvasLayer,
  ContentExtentContribution,
  DomOverlayContribution,
  HitResult,
  InsetContribution,
  InsetRect,
  LayerContribution,
  Viewport,
} from "../../src/internal/render/index";
import { boot, ctxOf, probe } from "./_boot";
import type { Booted } from "./_boot";
import { DEFAULT_POINTER_ID, pointerEvent, wheelEvent } from "../_utils/index";
import type { FakeElement } from "../_utils/index";

let booted: Booted | null = null;

function start(...args: Parameters<typeof boot>): Booted {
  booted = boot(...args);
  return booted;
}

afterEach(() => {
  booted?.dom.restore();
  booted = null;
  vi.useRealTimers();
});

/** A `renderer/layers` contribution that records the context it was handed. */
function layerSpy(
  id: string,
  zIndex: number,
  sink: { g: unknown; vp: Readonly<Viewport> }[],
): LayerContribution {
  return {
    id,
    zIndex,
    draw(g, vp) {
      sink.push({ g, vp });
    },
  };
}

describe("plugin identity and service (docs/specs/plugins/view.md)", () => {
  it("is `stargantt.view` and depends on the data store", () => {
    expect(view().meta.id).toBe("stargantt.view");
    expect(view().meta.dependsOn).toEqual(["stargantt.data-store"]);
  });

  // docs/specs/plugins/view.md — every official plugin is a factory taking a typed, optional config
  it("is a factory, not a plain plugin const, and takes an optional empty config", () => {
    expect(typeof view).toBe("function");
    expect(typeof view().setup).toBe("function");
    const a = view();
    const b = view({});
    expect(a).not.toBe(b);
    expect(a.meta.id).toBe(b.meta.id);
  });

  it("provides `stargantt.view` with invalidate + the viewport store", () => {
    const { gantt } = start();
    const service = gantt.service("stargantt.view");
    expect(typeof service.invalidate).toBe("function");
    expect(typeof service.viewport.get).toBe("function");
    expect(typeof service.viewport.subscribe).toBe("function");
  });

  it("reports the pane size and a zeroed scroll origin as the viewport", () => {
    const { gantt } = start([], { width: 640, height: 480 });
    expect(gantt.service("stargantt.view").viewport.get()).toEqual({
      scrollTop: 0,
      scrollLeft: 0,
      width: 640,
      height: 480,
    });
  });

  // `renderer/insets` is an ordered strip model: per-side stacking by `order` (ties by
  // registration), the side reserves the sum, and every contribution is told the rect it was
  // assigned.
  describe("`renderer/insets` (reduce: ordered strip, per-side sum)", () => {
    const strip = (
      side: "top" | "bottom",
      order: number,
      size: number,
      placed?: (rect: Readonly<InsetRect>) => void,
    ): InsetContribution =>
      placed === undefined ? { side, order, size } : { side, order, size, placed };

    it("reserves the top band: canvases move down and the viewport height shrinks", () => {
      const { dom, gantt, canvas } = start(
        [probe((ctx) => ctx.contribute("renderer/insets", strip("top", 0, 44)))],
        { width: 640, height: 480 },
      );
      dom.flushFrames();
      expect(gantt.service("stargantt.view").viewport.get().height).toBe(436);
      expect(canvas("main").style["top"]).toBe("44px");
    });

    it("reserves the bottom band: only the viewport height shrinks, the origin stays", () => {
      const { dom, gantt, canvas } = start(
        [probe((ctx) => ctx.contribute("renderer/insets", strip("bottom", 0, 60)))],
        { width: 640, height: 480 },
      );
      dom.flushFrames();
      expect(gantt.service("stargantt.view").viewport.get().height).toBe(420);
      expect(canvas("main").style["top"]).toBe("0px");
    });

    it("reserves the SUM of a side's strips, not their maximum", () => {
      const { dom, gantt, canvas } = start(
        [
          probe((ctx) => {
            ctx.contribute("renderer/insets", strip("top", 0, 44));
            ctx.contribute("renderer/insets", strip("top", 1, 20));
            ctx.contribute("renderer/insets", strip("bottom", 0, 10));
            ctx.contribute("renderer/insets", strip("bottom", 1, 30));
          }),
        ],
        { width: 640, height: 480 },
      );
      dom.flushFrames();
      // top = 44 + 20, bottom = 10 + 30 → 480 - 64 - 40.
      expect(gantt.service("stargantt.view").viewport.get().height).toBe(376);
      expect(canvas("main").style["top"]).toBe("64px");
    });

    it("stacks a side by ascending order, outermost first, and hands each strip its rect", () => {
      const rects: Record<string, InsetRect> = {};
      const at = (id: string) => (rect: Readonly<InsetRect>) => {
        rects[id] = { ...rect };
      };
      const { dom } = start(
        [
          probe((ctx) => {
            ctx.contribute("renderer/insets", strip("top", 10, 20, at("top-outer-later")));
            ctx.contribute("renderer/insets", strip("top", 1, 30, at("top-outer")));
            ctx.contribute("renderer/insets", strip("bottom", 1, 15, at("bottom-outer")));
            ctx.contribute("renderer/insets", strip("bottom", 5, 25, at("bottom-inner")));
          }),
        ],
        { width: 640, height: 480 },
      );
      dom.flushFrames();

      // Top: order 1 hugs the body's top edge, order 10 stacks beneath it.
      expect(rects["top-outer"]).toEqual({ x: 0, y: 0, width: 640, height: 30 });
      expect(rects["top-outer-later"]).toEqual({ x: 0, y: 30, width: 640, height: 20 });
      // Bottom: order 1 hugs the body's bottom edge, order 5 stacks above it.
      expect(rects["bottom-outer"]).toEqual({ x: 0, y: 465, width: 640, height: 15 });
      expect(rects["bottom-inner"]).toEqual({ x: 0, y: 440, width: 640, height: 25 });
    });

    it("breaks an order tie by registration order", () => {
      const seen: [string, number][] = [];
      const record =
        (id: string) =>
        (rect: Readonly<InsetRect>): void => {
          seen.push([id, rect.y]);
        };
      const { dom } = start(
        [
          probe((ctx) => ctx.contribute("renderer/insets", strip("top", 0, 10, record("a"))), "t.a"),
          probe((ctx) => ctx.contribute("renderer/insets", strip("top", 0, 10, record("b"))), "t.b"),
        ],
        { width: 640, height: 480 },
      );
      dom.flushFrames();
      expect(seen).toEqual([
        ["a", 0],
        ["b", 10],
      ]);
    });

    it("places every strip before the first paint pass", () => {
      const calls: number[] = [];
      const sink: { g: unknown; vp: Readonly<Viewport> }[] = [];
      const { dom } = start([
        probe((ctx) => {
          ctx.contribute("renderer/layers", layerSpy("bars", 55, sink));
          ctx.contribute(
            "renderer/insets",
            strip("top", 0, 20, () => calls.push(sink.length)),
          );
        }),
      ]);
      dom.flushFrames();
      // The single call happened while nothing had been painted yet.
      expect(calls).toEqual([0]);
      expect(sink).toHaveLength(1);
    });

    it("re-places a strip when a resize moves it, and not otherwise", () => {
      const rects: InsetRect[] = [];
      const booted = start(
        [
          probe((ctx) =>
            ctx.contribute(
              "renderer/insets",
              strip("bottom", 0, 20, (r) => rects.push({ ...r })),
            ),
          ),
        ],
        { width: 640, height: 480 },
      );
      booted.dom.flushFrames();
      expect(rects).toEqual([{ x: 0, y: 460, width: 640, height: 20 }]);

      // A resize observer notification that does not change the box must not re-fire `placed`.
      booted.dom.triggerResizeObservers();
      expect(rects).toHaveLength(1);

      booted.pane.rect = { left: 0, top: 0, width: 500, height: 300 };
      booted.dom.triggerResizeObservers();
      expect(rects).toEqual([
        { x: 0, y: 460, width: 640, height: 20 },
        { x: 0, y: 280, width: 500, height: 20 },
      ]);
    });

    // A strip whose size follows the data needs a pull: the renderer re-reads `renderer/insets`
    // on resize and DPR change, never on a transaction, so the contributor asks for the re-read
    // once its own geometry moved.
    describe("`refreshInsets()`", () => {
      /** A bottom strip whose size is read from `box.size` at every reduction. */
      const growing = (
        box: { size: number },
        placed?: (rect: Readonly<InsetRect>) => void,
      ): InsetContribution => ({
        side: "bottom",
        order: 0,
        get size() {
          return box.size;
        },
        ...(placed === undefined ? {} : { placed }),
      });

      it("re-reads the strips and re-lays out the surfaces after a size change", () => {
        const box = { size: 20 };
        const { dom, gantt } = start([probe((ctx) => ctx.contribute("renderer/insets", growing(box)))], {
          width: 640,
          height: 480,
        });
        dom.flushFrames();
        const service = gantt.service("stargantt.view");
        expect(service.viewport.get().height).toBe(460);

        box.size = 80;
        service.refreshInsets();
        expect(service.viewport.get().height).toBe(400);
      });

      it("re-places the strip at its new rect", () => {
        const box = { size: 20 };
        const rects: InsetRect[] = [];
        const { dom, gantt } = start(
          [
            probe((ctx) =>
              ctx.contribute(
                "renderer/insets",
                growing(box, (r) => rects.push({ ...r })),
              ),
            ),
          ],
          { width: 640, height: 480 },
        );
        dom.flushFrames();
        expect(rects).toEqual([{ x: 0, y: 460, width: 640, height: 20 }]);

        box.size = 50;
        gantt.service("stargantt.view").refreshInsets();
        expect(rects).toEqual([
          { x: 0, y: 460, width: 640, height: 20 },
          { x: 0, y: 430, width: 640, height: 50 },
        ]);
      });

      it("changes nothing when the reserved bands are unchanged", () => {
        const box = { size: 20 };
        const rects: InsetRect[] = [];
        const { dom, gantt } = start(
          [
            probe((ctx) =>
              ctx.contribute(
                "renderer/insets",
                growing(box, (r) => rects.push({ ...r })),
              ),
            ),
          ],
          { width: 640, height: 480 },
        );
        dom.flushFrames();
        const service = gantt.service("stargantt.view");
        const before = service.viewport.get().height;

        service.refreshInsets();
        expect(service.viewport.get().height).toBe(before);
        expect(rects).toHaveLength(1);
      });
    });

    it("isolates a throwing `placed` and still places the remaining strips", () => {
      const faults: { pluginId: string; error: unknown }[] = [];
      const placed: string[] = [];
      // Placement happens on `lifecycle/ready`, before `Gantt.create()` returns, so the fault sink
      // has to be subscribed from inside a plugin's setup.
      const booted = start([
        probe((ctx) => {
          ctx.on("core/pluginError", (e) => faults.push(e));
          ctx.contribute(
            "renderer/insets",
            strip("top", 0, 10, () => {
              throw new Error("placed failed");
            }),
          );
          ctx.contribute(
            "renderer/insets",
            strip("top", 1, 10, () => placed.push("ok")),
          );
        }),
      ]);
      booted.dom.flushFrames();

      expect(placed).toEqual(["ok"]);
      expect(faults).toHaveLength(1);
      expect((faults[0]?.error as Error).message).toBe("placed failed");
      expect(faults[0]?.pluginId).toBe("stargantt.view");
    });

    it("treats a negative or non-finite size as reserving nothing", () => {
      const { dom, gantt } = start(
        [
          probe((ctx) => {
            ctx.contribute("renderer/insets", strip("top", 0, -5));
            ctx.contribute("renderer/insets", strip("bottom", 0, Number.NaN));
          }),
        ],
        { width: 640, height: 480 },
      );
      dom.flushFrames();
      expect(gantt.service("stargantt.view").viewport.get().height).toBe(480);
    });

    it("skips a contribution that is not a usable strip", () => {
      const { dom, gantt } = start(
        [
          probe((ctx) => {
            const bad = [null, 42, { size: 50 }, { side: "left", size: 50, order: 0 }];
            for (const value of bad as unknown as InsetContribution[]) {
              ctx.contribute("renderer/insets", value);
            }
            ctx.contribute("renderer/insets", strip("top", 0, 30));
          }),
        ],
        { width: 640, height: 480 },
      );
      dom.flushFrames();
      expect(gantt.service("stargantt.view").viewport.get().height).toBe(450);
    });
  });

  // The store publishes a snapshot, not the module's live viewport object. `get()` keeps returning
  // that same object until the next `set` replaces it — the core's store contract, which callers
  // must treat as immutable — so what this pins is the separation: writing through a cast cannot
  // reach the module's own state, and a scroll publishes a *new* object rather than mutating the
  // one a caller is holding.
  it("publishes a viewport snapshot, never the live internal object", () => {
    const { dom, gantt, pane } = start([], { width: 640, height: 480 });
    const service = gantt.service("stargantt.view");
    dom.flushFrames();

    const held = service.viewport.get();

    // a consumer cast must not be able to corrupt the module's state
    (held as Viewport).scrollTop = 999;
    pane.fire("wheel", wheelEvent({ deltaX: 0, deltaY: 120 }));

    // the scroll started from 0, not from the 999 written into the held object
    expect(service.viewport.get().scrollTop).toBe(120);
    // and the held reference did not change under the caller
    expect(held.scrollTop).toBe(999);
    expect(service.viewport.get()).not.toBe(held);
  });
});

describe("§3.1 DOM host", () => {
  it("attaches the chart pane under the plugin root", () => {
    const { dom, pane } = start();
    expect(dom.root.children).toHaveLength(1);
    expect(pane.className).toBe("sg-pane sg-pane--chart");
    expect(pane.find("sg-dom-overlay")).toBeDefined();
  });

  // The sanctioned way to obtain the pane, replacing the `.sg-pane--chart` class-string lookup
  // consumers used to run.
  it("hands out the chart pane element through the service", () => {
    const { gantt, pane, dom } = start();
    const service = gantt.service("stargantt.view");
    const found = service.chartPaneElement();
    expect(found).toBe(pane as unknown as HTMLElement);
    // The pane the accessor returns is the element the canvases live in, under the plugin root.
    expect(dom.root.children).toContain(pane);
  });

  it("keeps returning the same pane element across frames and resizes", () => {
    const { gantt, dom, pane } = start([], { width: 400, height: 300 });
    const service = gantt.service("stargantt.view");
    const first = service.chartPaneElement();
    dom.flushFrames();
    expect(service.chartPaneElement()).toBe(first);
    pane.rect = { left: 0, top: 0, width: 900, height: 500 };
    dom.triggerResizeObservers();
    dom.flushFrames();
    expect(service.chartPaneElement()).toBe(first);
  });

  it("sizes every canvas to the viewport only, never to content extent", () => {
    const { canvas } = start([], { width: 800, height: 600, dpr: 1 });
    for (const layer of ["background", "main", "overlay"] as const) {
      expect(canvas(layer).width).toBe(800);
      expect(canvas(layer).height).toBe(600);
    }
  });
});

describe("§3.2-4 devicePixelRatio", () => {
  it("allocates the backing store at cssSize * dpr", () => {
    const { canvas } = start([], { width: 800, height: 600, dpr: 2 });
    const main = canvas("main");
    expect(main.width).toBe(1600);
    expect(main.height).toBe(1200);
    expect(main.style.width).toBe("800px");
    expect(ctxOf(main).calls("scale").at(-1)?.args).toEqual([2, 2]);
  });

  it("watches the current ratio through matchMedia and re-sizes on change", () => {
    const { dom, canvas } = start([], { width: 400, height: 300, dpr: 1 });
    expect(dom.mediaQueries()[0]?.media).toBe("(resolution: 1dppx)");

    dom.setDpr(3);
    dom.fireMediaChange();

    expect(canvas("main").width).toBe(1200);
    expect(canvas("main").height).toBe(900);
    // the watcher re-arms itself for the new ratio
    expect(dom.mediaQueries().at(-1)?.media).toBe("(resolution: 3dppx)");
    expect(dom.mediaQueries()[0]?.listeners.size).toBe(0);
  });

  it("falls back to the legacy addListener pair when the MediaQueryList has no addEventListener", () => {
    const { dom, canvas } = start([], {
      width: 400,
      height: 300,
      dpr: 1,
      legacyMediaQuery: true,
    });
    expect(dom.mediaQueries()[0]?.listeners.size).toBe(1);

    dom.setDpr(2);
    dom.fireMediaChange();

    expect(canvas("main").width).toBe(800);
    expect(dom.mediaQueries().at(-1)?.media).toBe("(resolution: 2dppx)");
    expect(dom.mediaQueries()[0]?.listeners.size).toBe(0);
  });

  it("re-measures on ResizeObserver notifications", () => {
    const { dom, canvas, pane } = start([], { width: 400, height: 300, dpr: 1 });
    expect(dom.resizeObserverCount()).toBe(1);

    pane.rect = { left: 0, top: 0, width: 900, height: 100 };
    dom.triggerResizeObservers();

    expect(canvas("background").width).toBe(900);
    expect(canvas("background").height).toBe(100);
  });
});

describe("§3.2 rAF paint loop", () => {
  it("does not paint synchronously — one pass per animation frame", () => {
    const sink: { g: unknown; vp: Readonly<Viewport> }[] = [];
    const { dom } = start([
      probe((ctx) => {
        ctx.contribute("renderer/layers", layerSpy("bars", 55, sink));
      }),
    ]);

    expect(sink).toHaveLength(0);
    expect(dom.pendingFrames()).toBe(1);
    dom.flushFrames();
    expect(sink).toHaveLength(1);
  });

  it("coalesces many invalidate() calls into a single frame", () => {
    const sink: { g: unknown; vp: Readonly<Viewport> }[] = [];
    const { dom, gantt } = start([
      probe((ctx) => {
        ctx.contribute("renderer/layers", layerSpy("bars", 55, sink));
      }),
    ]);
    dom.flushFrames();
    sink.length = 0;

    const service = gantt.service("stargantt.view");
    service.invalidate("main");
    service.invalidate("main");
    service.invalidate("main");
    expect(dom.pendingFrames()).toBe(1);
    expect(dom.flushFrames()).toBe(1);
    expect(sink).toHaveLength(1);
  });

  it("paints synchronously on a resize, since the resize cleared the canvases", () => {
    const sink: { g: unknown; vp: Readonly<Viewport> }[] = [];
    const { dom, pane } = start(
      [
        probe((ctx) => {
          ctx.contribute("renderer/layers", layerSpy("bars", 55, sink));
        }),
      ],
      { width: 400, height: 300, dpr: 1 },
    );
    dom.flushFrames();
    sink.length = 0;

    pane.rect = { left: 0, top: 0, width: 900, height: 500 };
    dom.triggerResizeObservers();

    // No flushFrames(): the pass has to have happened already, or the frame the browser is about to
    // composite shows the cleared (transparent) backing stores.
    expect(sink).toHaveLength(1);
    expect(sink[0]?.vp.width).toBe(900);

    // And the frame the resize's own invalidation had scheduled is gone with it: the pass covers it,
    // so nothing runs the whole pipeline (overlay sync, hover, scrollbars, prefetch) a second time.
    expect(dom.pendingFrames()).toBe(0);
    expect(dom.flushFrames()).toBe(0);
    expect(sink).toHaveLength(1);
  });

  it("paints nothing extra when a resize leaves the metrics unchanged", () => {
    const sink: { g: unknown; vp: Readonly<Viewport> }[] = [];
    const { dom } = start(
      [
        probe((ctx) => {
          ctx.contribute("renderer/layers", layerSpy("bars", 55, sink));
        }),
      ],
      { width: 400, height: 300, dpr: 1 },
    );
    dom.flushFrames();
    sink.length = 0;

    dom.triggerResizeObservers();

    expect(sink).toHaveLength(0);
    expect(dom.pendingFrames()).toBe(0);
  });

  it("paints synchronously on a resize without requestAnimationFrame too", () => {
    vi.useFakeTimers();
    try {
      const sink: { g: unknown; vp: Readonly<Viewport> }[] = [];
      const { dom, pane } = start(
        [
          probe((ctx) => {
            ctx.contribute("renderer/layers", layerSpy("bars", 55, sink));
          }),
        ],
        { width: 400, height: 300, dpr: 1, raf: false },
      );
      vi.advanceTimersByTime(16);
      sink.length = 0;

      pane.rect = { left: 0, top: 0, width: 900, height: 500 };
      dom.triggerResizeObservers();

      expect(sink).toHaveLength(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("repaints only the invalidated layer", () => {
    const sink: { g: unknown; vp: Readonly<Viewport> }[] = [];
    const { dom, gantt, layerNameOf } = start([
      probe((ctx) => {
        ctx.contribute("renderer/layers", layerSpy("grid", 10, sink));
        ctx.contribute("renderer/layers", layerSpy("bars", 55, sink));
        ctx.contribute("renderer/layers", layerSpy("ghost", 500, sink));
      }),
    ]);
    dom.flushFrames();
    expect(sink.map((c) => layerNameOf(c.g))).toEqual(["background", "main", "overlay"]);

    sink.length = 0;
    gantt.service("stargantt.view").invalidate("overlay");
    dom.flushFrames();
    expect(sink.map((c) => layerNameOf(c.g))).toEqual(["overlay"]);
  });

  it("routes contributions onto a canvas by zIndex and draws in zIndex order", () => {
    const sink: { g: unknown; vp: Readonly<Viewport> }[] = [];
    const order: string[] = [];
    const { dom, layerNameOf } = start([
      probe((ctx) => {
        ctx.contribute("renderer/layers", {
          id: "late",
          zIndex: 90,
          draw: (g, vp) => {
            order.push("late");
            sink.push({ g, vp });
          },
        });
        ctx.contribute("renderer/layers", {
          id: "early",
          zIndex: 60,
          draw: (g, vp) => {
            order.push("early");
            sink.push({ g, vp });
          },
        });
      }),
    ]);
    dom.flushFrames();

    expect(order).toEqual(["early", "late"]);
    expect(sink.map((c) => layerNameOf(c.g))).toEqual(["main", "main"]);
  });

  it("clears each repainted layer over the viewport rect and hands `draw` the viewport", () => {
    const sink: { g: unknown; vp: Readonly<Viewport> }[] = [];
    const { dom, canvas } = start(
      [
        probe((ctx) => {
          ctx.contribute("renderer/layers", layerSpy("bars", 55, sink));
        }),
      ],
      { width: 320, height: 240 },
    );
    dom.flushFrames();

    expect(ctxOf(canvas("main")).calls("clearRect").at(-1)?.args).toEqual([0, 0, 320, 240]);
    expect(sink[0]?.vp).toEqual({ scrollTop: 0, scrollLeft: 0, width: 320, height: 240 });
  });

  it("isolates a throwing layer contribution and keeps painting the rest", () => {
    const drawn: string[] = [];
    const faults: { pluginId: string; error: unknown }[] = [];
    const { dom, canvas, gantt } = start([
      probe((ctx) => {
        ctx.contribute("renderer/layers", {
          id: "boom",
          zIndex: 51,
          draw: () => {
            throw new Error("draw failed");
          },
        });
        ctx.contribute("renderer/layers", {
          id: "ok",
          zIndex: 52,
          draw: () => {
            drawn.push("ok");
          },
        });
      }),
    ]);
    gantt.on("core/pluginError", (e) => faults.push(e));
    dom.flushFrames();

    expect(drawn).toEqual(["ok"]);
    expect(faults).toHaveLength(1);
    expect((faults[0]?.error as Error).message).toBe("draw failed");
    // save/restore stays balanced across the throw
    expect(ctxOf(canvas("main")).depth).toBe(0);
  });

  it("still batches a pass on a timer when requestAnimationFrame is unavailable", () => {
    vi.useFakeTimers();
    const sink: { g: unknown; vp: Readonly<Viewport> }[] = [];
    const { gantt } = start(
      [
        probe((ctx) => {
          ctx.contribute("renderer/layers", layerSpy("bars", 55, sink));
        }),
      ],
      { raf: false },
    );

    expect(sink).toHaveLength(0);
    vi.advanceTimersByTime(16);
    expect(sink).toHaveLength(1);

    sink.length = 0;
    const service = gantt.service("stargantt.view");
    service.invalidate("main");
    service.invalidate("main");
    vi.advanceTimersByTime(16);
    expect(sink).toHaveLength(1);

    // and the pending timer is released on dispose
    sink.length = 0;
    service.invalidate("main");
    gantt.dispose();
    vi.advanceTimersByTime(64);
    expect(sink).toHaveLength(0);
  });

  it("first-paints on lifecycle/ready (§1.5-5)", () => {
    const sink: { g: unknown; vp: Readonly<Viewport> }[] = [];
    const seen: number[] = [];
    const { dom } = start([
      probe((ctx) => {
        ctx.contribute("renderer/layers", layerSpy("bars", 55, sink));
        ctx.on("lifecycle/ready", () => seen.push(sink.length));
      }),
    ]);
    // the frame is queued by ready, not painted inside it
    expect(seen).toEqual([0]);
    dom.flushFrames();
    expect(sink).toHaveLength(1);
  });
});

describe("§3.3 fully custom virtual scroll (no native scrollHeight)", () => {
  it("owns the wheel gesture and updates the viewport numbers", () => {
    const scrolls: { scrollTop: number; scrollLeft: number }[] = [];
    const { dom, gantt, pane } = start();
    gantt.on("view/scrolled", (e) => scrolls.push(e));
    dom.flushFrames();

    const e = wheelEvent({ deltaX: 20, deltaY: 120 });
    pane.fire("wheel", e);

    expect(e.defaultPrevented).toBe(true);
    expect(gantt.service("stargantt.view").viewport.get()).toMatchObject({
      scrollTop: 120,
      scrollLeft: 20,
    });
    expect(scrolls).toEqual([{ scrollTop: 120, scrollLeft: 20 }]);
  });

  it("clamps at the scroll origin and stays silent when nothing moves", () => {
    const scrolls: unknown[] = [];
    const { dom, gantt, pane } = start();
    gantt.on("view/scrolled", (e) => scrolls.push(e));
    dom.flushFrames();

    pane.fire("wheel", wheelEvent({ deltaX: 0, deltaY: -500 }));
    expect(gantt.service("stargantt.view").viewport.get().scrollTop).toBe(0);
    expect(scrolls).toHaveLength(0);
    expect(dom.pendingFrames()).toBe(0);
  });

  it("repaints via the frame loop after a scroll, without resizing any canvas", () => {
    const sink: { g: unknown; vp: Readonly<Viewport> }[] = [];
    const { dom, gantt, pane, canvas } = start(
      [
        probe((ctx) => {
          ctx.contribute("renderer/layers", layerSpy("bars", 55, sink));
        }),
      ],
      { width: 800, height: 600 },
    );
    dom.flushFrames();
    sink.length = 0;

    pane.fire("wheel", wheelEvent({ deltaX: 0, deltaY: 900_000 }));
    expect(dom.pendingFrames()).toBe(1);
    dom.flushFrames();

    expect(sink).toHaveLength(1);
    expect(sink[0]?.vp.scrollTop).toBe(900_000);
    expect(canvas("main").height).toBe(600);
    expect(gantt.service("stargantt.view").viewport.get().height).toBe(600);
  });
});

describe("§3.4 hit testing (`renderer/hitTest`, first)", () => {
  const bar = (id: string): HitResult => ({ kind: "bar", id, cursor: "grab" });

  it("takes the first contribution that returns a result and lets others decline", () => {
    const events: { hit: HitResult; x: number; y: number }[] = [];
    const { dom, gantt, pane } = start([
      probe((ctx) => {
        ctx.contribute("renderer/hitTest", () => undefined);
        ctx.contribute("renderer/hitTest", (x) => (x > 10 ? bar("second") : undefined));
        ctx.contribute("renderer/hitTest", () => bar("third"));
      }),
    ]);
    gantt.on("pointer/barDown", (e) => events.push({ hit: e.hit, x: e.x, y: e.y }));
    dom.flushFrames();

    pane.fire("pointerdown", pointerEvent(50, 5));
    pane.fire("pointerdown", pointerEvent(2, 5));

    expect(events.map((e) => e.hit.id)).toEqual(["second", "third"]);
  });

  it("guards a throwing hit tester and lets the next one answer", () => {
    const faults: { pluginId: string; error: unknown }[] = [];
    const events: HitResult[] = [];
    const { dom, gantt, pane } = start([
      probe((ctx) => {
        ctx.contribute("renderer/hitTest", () => {
          throw new Error("hit failed");
        });
        ctx.contribute("renderer/hitTest", () => bar("survivor"));
      }),
    ]);
    gantt.on("core/pluginError", (e) => faults.push(e));
    gantt.on("pointer/barDown", (e) => events.push(e.hit));
    dom.flushFrames();

    pane.fire("pointerdown", pointerEvent(5, 5));

    expect(events.map((h) => h.id)).toEqual(["survivor"]);
    expect(faults).toHaveLength(1);
    expect(faults[0]?.pluginId).toBe("stargantt.view");
  });

  it("emits pointer/barDown in pane-local coordinates only when something is hit", () => {
    const events: { x: number; y: number; event: unknown }[] = [];
    const { dom, gantt, pane } = start([
      probe((ctx) => {
        ctx.contribute("renderer/hitTest", (x, y) => (y > 100 ? bar("b1") : undefined));
      }),
    ]);
    pane.rect = { left: 30, top: 40, width: 800, height: 600 };
    gantt.on("pointer/barDown", (e) => events.push({ x: e.x, y: e.y, event: e.event }));
    dom.flushFrames();

    pane.fire("pointerdown", pointerEvent(130, 50)); // local y = 10 -> no hit
    expect(events).toHaveLength(0);

    const raw = pointerEvent(130, 240); // local (100, 200)
    pane.fire("pointerdown", raw);
    expect(events).toEqual([{ x: 100, y: 200, event: raw }]);
  });

  it("applies the hit result's cursor to the chart pane on the frame after pointermove", () => {
    const { dom, pane } = start([
      probe((ctx) => {
        ctx.contribute("renderer/hitTest", (x) =>
          x < 100 ? { kind: "handle", id: 7, cursor: "ew-resize" } : undefined,
        );
      }),
    ]);
    dom.flushFrames();

    pane.fire("pointermove", pointerEvent(10, 10));
    dom.flushFrames();
    expect(pane.style["cursor"]).toBe("ew-resize");

    pane.fire("pointermove", pointerEvent(500, 10));
    dom.flushFrames();
    expect(pane.style["cursor"]).toBe("");
  });

  it("resolves a hover through the timer fallback when there is no rAF", () => {
    vi.useFakeTimers();
    const { pane } = start(
      [
        probe((ctx) => {
          ctx.contribute("renderer/hitTest", () => ({ kind: "bar", id: 1, cursor: "grab" }));
        }),
      ],
      { raf: false },
    );
    vi.advanceTimersByTime(16);

    pane.fire("pointermove", pointerEvent(10, 10));
    expect(pane.style["cursor"]).toBeUndefined();

    vi.advanceTimersByTime(16);
    expect(pane.style["cursor"]).toBe("grab");
  });

  it("returns nothing when no plugin contributes a hit tester", () => {
    const events: unknown[] = [];
    const { dom, gantt, pane } = start();
    gantt.on("pointer/barDown", (e) => events.push(e));
    dom.flushFrames();

    pane.fire("pointerdown", pointerEvent(10, 10));
    expect(events).toHaveLength(0);
  });
});

describe("hover is resolved once per frame, not once per pointer event", () => {
  const handleUnder100 = (x: number): HitResult | undefined =>
    x < 100 ? { kind: "handle", id: 7, cursor: "ew-resize" } : undefined;

  /** Boots with a hit tester that records every position it is asked about. */
  function startTracking(): { booted: Booted; seen: [number, number][] } {
    const seen: [number, number][] = [];
    const booted = start([
      probe((ctx) => {
        ctx.contribute("renderer/hitTest", (x, y) => {
          seen.push([x, y]);
          return handleUnder100(x);
        });
      }),
    ]);
    booted.dom.flushFrames();
    seen.length = 0;
    return { booted, seen };
  }

  it("collapses a burst of pointermove events into one hit test at the latest position", () => {
    const { booted, seen } = startTracking();
    const { dom, pane } = booted;

    for (let i = 0; i < 20; i += 1) pane.fire("pointermove", pointerEvent(10 + i, 30));
    expect(seen).toEqual([]); // nothing is resolved inside the event itself

    dom.flushFrames();
    expect(seen).toEqual([[29, 30]]); // only the last position of the burst
    expect(pane.style["cursor"]).toBe("ew-resize");
  });

  it("measures the pane's box once per frame rather than once per event", () => {
    const { booted } = startTracking();
    const { dom, pane } = booted;
    const rect = vi.spyOn(pane, "getBoundingClientRect");

    for (let i = 0; i < 20; i += 1) pane.fire("pointermove", pointerEvent(10 + i, 30));
    dom.flushFrames();

    expect(rect).toHaveBeenCalledTimes(1);
  });

  it("writes the pane cursor only when the resolved value actually changes", () => {
    const { booted } = startTracking();
    const { dom, pane } = booted;

    let writes = 0;
    let value: string | undefined;
    Object.defineProperty(pane.style, "cursor", {
      configurable: true,
      get: () => value,
      set: (v: string) => {
        value = v;
        writes += 1;
      },
    });

    pane.fire("pointermove", pointerEvent(10, 30));
    dom.flushFrames();
    expect(writes).toBe(1);
    expect(value).toBe("ew-resize");

    // Still over the same handle on the next two frames: same cursor, so no further writes.
    pane.fire("pointermove", pointerEvent(20, 30));
    dom.flushFrames();
    pane.fire("pointermove", pointerEvent(30, 30));
    dom.flushFrames();
    expect(writes).toBe(1);

    pane.fire("pointermove", pointerEvent(500, 30));
    dom.flushFrames();
    expect(writes).toBe(2);
    expect(value).toBe("");
  });

  it("rides the paint frame instead of queueing one of its own", () => {
    const { booted } = startTracking();
    const { dom, gantt, pane } = booted;
    expect(dom.pendingFrames()).toBe(0);

    gantt.service("stargantt.view").invalidate("main");
    expect(dom.pendingFrames()).toBe(1);

    pane.fire("pointermove", pointerEvent(10, 30));
    expect(dom.pendingFrames()).toBe(1);
  });

  it("still resolves a hover when no layer is dirty", () => {
    const { booted, seen } = startTracking();
    const { dom, pane, canvas } = booted;
    const cleared = ctxOf(canvas("main")).count("clearRect");

    pane.fire("pointermove", pointerEvent(10, 30));
    expect(dom.pendingFrames()).toBe(1);
    dom.flushFrames();

    expect(seen).toEqual([[10, 30]]);
    // Hovering must not repaint: the frame ran only to resolve the cursor.
    expect(ctxOf(canvas("main")).count("clearRect")).toBe(cleared);
  });

  it("keeps pointerdown synchronous so pointer/barDown is unaffected", () => {
    const events: HitResult[] = [];
    const { booted } = startTracking();
    const { gantt, pane } = booted;
    gantt.on("pointer/barDown", (e) => events.push(e.hit));

    pane.fire("pointerdown", pointerEvent(10, 30));

    expect(events.map((h) => h.id)).toEqual([7]); // no frame flush needed
  });

  it("drops a hover queued before dispose", () => {
    const { booted, seen } = startTracking();
    const { dom, gantt, pane } = booted;

    pane.fire("pointermove", pointerEvent(10, 30));
    gantt.dispose();
    dom.flushFrames();

    expect(seen).toEqual([]);
  });
});

// The full `pointer/*` family, delivered synchronously during a gesture.
describe("§3 pointer gestures", () => {
  const grab = (id: string): HitResult => ({ kind: "bar", id, cursor: "grab" });

  interface Log {
    type: string;
    x: number;
    y: number;
    hitId?: string | number;
    event?: unknown;
  }

  /** Boots with a hit tester that claims `x < 100` and records the whole pointer family. */
  function startPointer(): { booted: Booted; log: Log[] } {
    const log: Log[] = [];
    const booted = start([
      probe((ctx) => {
        ctx.contribute("renderer/hitTest", (x) => (x < 100 ? grab("b1") : undefined));
      }),
    ]);
    const push = (type: string) => (e: { hit?: HitResult; x: number; y: number; event?: unknown }) =>
      log.push(
        e.hit === undefined
          ? { type, x: e.x, y: e.y, event: e.event }
          : { type, x: e.x, y: e.y, hitId: e.hit.id, event: e.event },
      );
    booted.gantt.on("pointer/barDown", push("down"));
    booted.gantt.on("pointer/barMove", push("move"));
    booted.gantt.on("pointer/barUp", push("up"));
    booted.gantt.on("pointer/background", push("background"));
    booted.gantt.on("pointer/barHover", push("hover"));
    booted.dom.flushFrames();
    log.length = 0;
    return { booted, log };
  }

  it("delivers move and up synchronously, with the initiating hit frozen", () => {
    const { booted, log } = startPointer();
    const { pane } = booted;

    pane.fire("pointerdown", pointerEvent(10, 10));
    pane.fire("pointermove", pointerEvent(40, 20));
    // Past x = 100 the tester would decline, but a gesture never re-hit-tests.
    pane.fire("pointermove", pointerEvent(500, 30));
    pane.fire("pointerup", pointerEvent(500, 30));

    // No frame was flushed: every one of these arrived inside the raw handler.
    expect(log.map((e) => [e.type, e.x, e.hitId])).toEqual([
      ["down", 10, "b1"],
      ["move", 40, "b1"],
      ["move", 500, "b1"],
      ["up", 500, "b1"],
    ]);
  });

  it("carries the raw event on move and up so modifier state is exact", () => {
    const { booted, log } = startPointer();
    const { pane } = booted;

    pane.fire("pointerdown", pointerEvent(10, 10));
    const moved = pointerEvent(20, 10, { altKey: true });
    pane.fire("pointermove", moved);
    const released = pointerEvent(20, 10);
    pane.fire("pointerup", released);

    expect(log[1]?.event).toBe(moved);
    expect((log[1]?.event as PointerEvent).altKey).toBe(true);
    expect(log[2]?.event).toBe(released);
  });

  it("captures the pointer for the gesture and releases it on up", () => {
    const { booted } = startPointer();
    const { pane } = booted;

    pane.fire("pointerdown", pointerEvent(10, 10, { pointerId: 7 }));
    expect(pane.captured).toEqual([7]);

    pane.fire("pointerup", pointerEvent(10, 10, { pointerId: 7 }));
    expect(pane.captured).toEqual([]);
  });

  it("starts a hit-less gesture from empty space, with no `hit` on move or up", () => {
    const { booted, log } = startPointer();
    const { pane } = booted;

    pane.fire("pointerdown", pointerEvent(500, 10));
    pane.fire("pointermove", pointerEvent(520, 40));
    pane.fire("pointerup", pointerEvent(530, 50));

    expect(log.map((e) => e.type)).toEqual(["background", "move", "up"]);
    for (const entry of log) expect(entry.hitId).toBeUndefined();
    expect(log.map((e) => e.x)).toEqual([500, 520, 530]);
  });

  it("ends the gesture on pointercancel with exactly one `pointer/barUp`", () => {
    const { booted, log } = startPointer();
    const { pane } = booted;

    pane.fire("pointerdown", pointerEvent(10, 10));
    pane.fire("pointercancel", pointerEvent(10, 10));
    // The release that never comes, and a stray second cancel, add nothing.
    pane.fire("pointercancel", pointerEvent(10, 10));
    pane.fire("pointerup", pointerEvent(10, 10));

    expect(log.filter((e) => e.type === "up")).toHaveLength(1);
    expect(pane.captured).toEqual([]);
  });

  it("emits no move or up once the gesture has ended", () => {
    const { booted, log } = startPointer();
    const { pane } = booted;

    pane.fire("pointerdown", pointerEvent(10, 10));
    pane.fire("pointerup", pointerEvent(10, 10));
    log.length = 0;
    pane.fire("pointermove", pointerEvent(20, 10));

    expect(log.filter((e) => e.type === "move")).toEqual([]);
  });

  it("ignores a second pointer pressed during a gesture", () => {
    const { booted, log } = startPointer();
    const { pane } = booted;

    pane.fire("pointerdown", pointerEvent(10, 10, { pointerId: 1 }));
    pane.fire("pointerdown", pointerEvent(20, 10, { pointerId: 2 }));
    pane.fire("pointermove", pointerEvent(30, 10, { pointerId: 2 }));
    pane.fire("pointerup", pointerEvent(30, 10, { pointerId: 2 }));

    expect(log.map((e) => e.type)).toEqual(["down", "move"]);
    expect(pane.captured).toEqual([1]);
  });

  it("suppresses hover resolution while a gesture is active", () => {
    const seen: [number, number][] = [];
    const booted = start([
      probe((ctx) => {
        ctx.contribute("renderer/hitTest", (x, y) => {
          seen.push([x, y]);
          return x < 100 ? grab("b1") : undefined;
        });
      }),
    ]);
    booted.dom.flushFrames();
    const hovers: unknown[] = [];
    booted.gantt.on("pointer/barHover", (e) => hovers.push(e));

    booted.pane.fire("pointerdown", pointerEvent(10, 10));
    seen.length = 0;
    booted.pane.fire("pointermove", pointerEvent(20, 10));
    booted.dom.flushFrames();

    expect(seen).toEqual([]); // no hit test was run for hover
    expect(hovers).toEqual([]);
  });

  it("emits `pointer/barHover` once per frame, only when the resolved target changes", () => {
    const { booted, log } = startPointer();
    const { dom, pane } = booted;

    // Onto the bar: one hover with the hit.
    pane.fire("pointermove", pointerEvent(10, 10));
    dom.flushFrames();
    // Still the same bar over two more frames: no further event.
    pane.fire("pointermove", pointerEvent(20, 10));
    dom.flushFrames();
    pane.fire("pointermove", pointerEvent(30, 15));
    dom.flushFrames();
    // Off every shape: one hover with no hit.
    pane.fire("pointermove", pointerEvent(500, 15));
    dom.flushFrames();

    expect(log.map((e) => [e.type, e.x, e.hitId])).toEqual([
      ["hover", 10, "b1"],
      ["hover", 500, undefined],
    ]);
    // The hover event carries no raw event.
    expect(log[0]?.event).toBeUndefined();
  });

  it("collapses a burst of moves into a single hover for the frame's last position", () => {
    const { booted, log } = startPointer();
    const { dom, pane } = booted;

    for (let i = 0; i < 10; i += 1) pane.fire("pointermove", pointerEvent(10 + i, 30));
    expect(log).toEqual([]);
    dom.flushFrames();

    expect(log.map((e) => [e.type, e.x])).toEqual([["hover", 19]]);
  });

  it("releases the pointer listeners on dispose", () => {
    const { booted } = startPointer();
    booted.gantt.dispose();
    for (const type of ["pointerdown", "pointermove", "pointerup", "pointercancel"]) {
      expect(booted.pane.listenerCount(type)).toBe(0);
    }
  });
});

describe("programmatic scroll and wheel speed", () => {
  it("scrollTo moves both axes instantly and emits view/scrolled once", () => {
    const scrolls: { scrollTop: number; scrollLeft: number }[] = [];
    const { dom, gantt } = start();
    gantt.on("view/scrolled", (e) => scrolls.push(e));
    dom.flushFrames();

    gantt.service("stargantt.view").scrollTo({ scrollLeft: 120, scrollTop: 40 });

    expect(gantt.service("stargantt.view").viewport.get()).toMatchObject({
      scrollLeft: 120,
      scrollTop: 40,
    });
    expect(scrolls).toEqual([{ scrollTop: 40, scrollLeft: 120 }]);
    expect(dom.pendingFrames()).toBe(1);
  });

  it("leaves an omitted axis untouched", () => {
    const { dom, gantt } = start();
    dom.flushFrames();
    const service = gantt.service("stargantt.view");

    service.scrollTo({ scrollLeft: 50, scrollTop: 60 });
    service.scrollTo({ scrollTop: 10 });

    expect(service.viewport.get()).toMatchObject({ scrollLeft: 50, scrollTop: 10 });
  });

  it("clamps to the scroll origin exactly like a wheel scroll, and stays silent when nothing moves", () => {
    const scrolls: unknown[] = [];
    const { dom, gantt } = start();
    gantt.on("view/scrolled", (e) => scrolls.push(e));
    dom.flushFrames();
    const service = gantt.service("stargantt.view");

    service.scrollTo({ scrollTop: -500, scrollLeft: -1 });
    expect(service.viewport.get()).toMatchObject({ scrollTop: 0, scrollLeft: 0 });
    expect(scrolls).toHaveLength(0);
    expect(dom.pendingFrames()).toBe(0);

    // A non-finite target is ignored rather than corrupting the viewport.
    service.scrollTo({ scrollTop: Number.NaN });
    expect(service.viewport.get().scrollTop).toBe(0);
    expect(scrolls).toHaveLength(0);
  });

  it("repaints after a programmatic scroll", () => {
    const sink: { g: unknown; vp: Readonly<Viewport> }[] = [];
    const { dom, gantt } = start([
      probe((ctx) => {
        ctx.contribute("renderer/layers", layerSpy("bars", 55, sink));
      }),
    ]);
    dom.flushFrames();
    sink.length = 0;

    gantt.service("stargantt.view").scrollTo({ scrollTop: 300 });
    dom.flushFrames();

    expect(sink).toHaveLength(1);
    expect(sink[0]?.vp.scrollTop).toBe(300);
  });

  it("multiplies wheel deltas by wheelSpeedFactor before clamping", () => {
    const { dom, gantt, pane } = start([], {}, { wheelSpeedFactor: 3 });
    dom.flushFrames();

    pane.fire("wheel", wheelEvent({ deltaX: 10, deltaY: 20 }));
    expect(gantt.service("stargantt.view").viewport.get()).toMatchObject({
      scrollLeft: 30,
      scrollTop: 60,
    });

    // Scrolling back up is clamped at the origin, not multiplied past it into a negative offset.
    pane.fire("wheel", wheelEvent({ deltaX: 0, deltaY: -100 }));
    expect(gantt.service("stargantt.view").viewport.get().scrollTop).toBe(0);
  });

  it("defaults the factor to 1", () => {
    const { dom, gantt, pane } = start();
    dom.flushFrames();
    pane.fire("wheel", wheelEvent({ deltaX: 0, deltaY: 120 }));
    expect(gantt.service("stargantt.view").viewport.get().scrollTop).toBe(120);
  });

  // Line/page deltaMode units resolve to CSS px before the swap and the speed factor.
  it("normalizes a line-mode wheel to ~16px per line unit", () => {
    const { dom, gantt, pane } = start();
    dom.flushFrames();
    pane.fire("wheel", { ...wheelEvent({ deltaX: 0, deltaY: 1 }), deltaMode: 1 });
    expect(gantt.service("stargantt.view").viewport.get().scrollTop).toBe(16);
  });

  it("exposes the resolved factor through the service", () => {
    const { dom, gantt } = start([], {}, { wheelSpeedFactor: 2 });
    dom.flushFrames();
    expect(gantt.service("stargantt.view").wheelSpeedFactor()).toBe(2);
    booted?.dom.restore();
    const plain = start();
    plain.dom.flushFrames();
    expect(plain.gantt.service("stargantt.view").wheelSpeedFactor()).toBe(1);
  });

  it("ignores a non-positive or non-finite factor", () => {
    for (const factor of [-2, 0, Number.NaN]) {
      booted?.dom.restore();
      const { dom, gantt, pane } = start([], {}, { wheelSpeedFactor: factor });
      dom.flushFrames();
      pane.fire("wheel", wheelEvent({ deltaX: 0, deltaY: 120 }));
      expect(gantt.service("stargantt.view").viewport.get().scrollTop).toBe(120);
    }
  });
});

describe("Shift+wheel scrolls horizontally", () => {
  it("applies a Shift+wheel notch to the horizontal axis, leaving the vertical one alone", () => {
    const { dom, gantt, pane } = start();
    dom.flushFrames();

    // How every engine dispatches it: the notch stays on deltaY, and the modifier says what it means.
    pane.fire("wheel", wheelEvent({ deltaX: 0, deltaY: 120, shiftKey: true }));

    expect(gantt.service("stargantt.view").viewport.get()).toMatchObject({
      scrollLeft: 120,
      scrollTop: 0,
    });
  });

  it("leaves an event that already reports a horizontal component alone", () => {
    const { dom, gantt, pane } = start();
    dom.flushFrames();

    // A trackpad, a tilt wheel, or an engine that swaps the axes before dispatch: swapping again
    // would send the vertical component sideways too.
    pane.fire("wheel", wheelEvent({ deltaX: 30, deltaY: 40, shiftKey: true }));

    expect(gantt.service("stargantt.view").viewport.get()).toMatchObject({
      scrollLeft: 30,
      scrollTop: 40,
    });
  });

  it("multiplies the swapped delta by wheelSpeedFactor, like any other", () => {
    const { dom, gantt, pane } = start([], {}, { wheelSpeedFactor: 3 });
    dom.flushFrames();

    pane.fire("wheel", wheelEvent({ deltaX: 0, deltaY: 20, shiftKey: true }));

    expect(gantt.service("stargantt.view").viewport.get().scrollLeft).toBe(60);
  });

  it("clamps a Shift+wheel back past the origin like any other horizontal scroll", () => {
    const { dom, gantt, pane } = start();
    dom.flushFrames();
    pane.fire("wheel", wheelEvent({ deltaX: 0, deltaY: 100, shiftKey: true }));

    pane.fire("wheel", wheelEvent({ deltaX: 0, deltaY: -500, shiftKey: true }));

    expect(gantt.service("stargantt.view").viewport.get().scrollLeft).toBe(0);
  });
});

describe("scrollable range and content extent — renderer/contentExtent", () => {
  const extent = (
    measure: () => { width?: number; height?: number },
    id = "ext",
  ): ContentExtentContribution => ({ id, measure });

  it("stays clamped at the origin when the content already fits the viewport", () => {
    const scrolls: unknown[] = [];
    const { dom, gantt, pane } = start(
      [probe((ctx) => ctx.contribute("renderer/contentExtent", extent(() => ({ height: 200 }))))],
      { width: 640, height: 400 },
    );
    gantt.on("view/scrolled", (e) => scrolls.push(e));
    dom.flushFrames();

    pane.fire("wheel", wheelEvent({ deltaX: 0, deltaY: 900 }));
    expect(gantt.service("stargantt.view").viewport.get().scrollTop).toBe(0);
    expect(scrolls).toEqual([]);
  });

  it("clamps wheel and scrollTo to extent - viewport once the content overflows", () => {
    const { dom, gantt, pane } = start(
      [probe((ctx) => ctx.contribute("renderer/contentExtent", extent(() => ({ height: 1000 }))))],
      { width: 640, height: 400 },
    );
    dom.flushFrames();

    pane.fire("wheel", wheelEvent({ deltaX: 0, deltaY: 900 }));
    expect(gantt.service("stargantt.view").viewport.get().scrollTop).toBe(600);

    gantt.service("stargantt.view").scrollTo({ scrollTop: 10_000 });
    expect(gantt.service("stargantt.view").viewport.get().scrollTop).toBe(600);
  });

  it("clamps the horizontal axis independently of the vertical one", () => {
    const { dom, gantt, pane } = start(
      [probe((ctx) => ctx.contribute("renderer/contentExtent", extent(() => ({ width: 900 }))))],
      { width: 640, height: 400 },
    );
    dom.flushFrames();

    pane.fire("wheel", wheelEvent({ deltaX: 5000, deltaY: 0 }));
    expect(gantt.service("stargantt.view").viewport.get().scrollLeft).toBe(260);
  });

  it("stays unbounded on an axis nothing contributes to", () => {
    const { dom, gantt, pane } = start(
      [probe((ctx) => ctx.contribute("renderer/contentExtent", extent(() => ({ height: 1000 }))))],
      { width: 640, height: 400 },
    );
    dom.flushFrames();

    pane.fire("wheel", wheelEvent({ deltaX: 50_000, deltaY: 0 }));
    expect(gantt.service("stargantt.view").viewport.get().scrollLeft).toBe(50_000);
  });

  it("reduces multiple contributions per axis by their maximum, not their sum", () => {
    const { dom, gantt, pane } = start(
      [
        probe((ctx) => {
          ctx.contribute("renderer/contentExtent", extent(() => ({ height: 500 }), "a"));
          ctx.contribute("renderer/contentExtent", extent(() => ({ height: 1000 }), "b"));
        }),
      ],
      { width: 640, height: 400 },
    );
    dom.flushFrames();

    pane.fire("wheel", wheelEvent({ deltaX: 0, deltaY: 5000 }));
    expect(gantt.service("stargantt.view").viewport.get().scrollTop).toBe(600);
  });

  it("isolates a throwing measure() and treats that axis as unbounded for the clamp", () => {
    const faults: { pluginId: string; error: unknown }[] = [];
    const { dom, gantt, pane } = start(
      [
        probe((ctx) => {
          ctx.on("core/pluginError", (e) => faults.push(e));
          ctx.contribute(
            "renderer/contentExtent",
            extent(() => {
              throw new Error("measure failed");
            }),
          );
        }),
      ],
      { width: 640, height: 400 },
    );
    dom.flushFrames();

    pane.fire("wheel", wheelEvent({ deltaX: 0, deltaY: 900 }));
    expect(gantt.service("stargantt.view").viewport.get().scrollTop).toBe(900);
    // Every call to the throwing `measure` (the wheel's own clamp, and the re-clamp / scrollbar
    // update the following paint pass runs) is individually isolated and reported.
    expect(faults.length).toBeGreaterThan(0);
    for (const f of faults) {
      expect((f.error as Error).message).toBe("measure failed");
      expect(f.pluginId).toBe("stargantt.view");
    }
  });

  it("re-clamps a scroll position the extent has shrunk past, and announces the correction once", () => {
    let height = 1000;
    const scrolls: { scrollTop: number; scrollLeft: number }[] = [];
    const { dom, gantt, pane } = start(
      [probe((ctx) => ctx.contribute("renderer/contentExtent", extent(() => ({ height }))))],
      { width: 640, height: 400 },
    );
    dom.flushFrames();

    pane.fire("wheel", wheelEvent({ deltaX: 0, deltaY: 900 }));
    expect(gantt.service("stargantt.view").viewport.get().scrollTop).toBe(600);

    gantt.on("view/scrolled", (e) => scrolls.push(e));
    height = 500;
    gantt.service("stargantt.view").invalidate("main");
    dom.flushFrames();

    expect(gantt.service("stargantt.view").viewport.get().scrollTop).toBe(100);
    expect(scrolls).toEqual([{ scrollTop: 100, scrollLeft: 0 }]);
  });

  it("re-clamps on a viewport resize that shrinks the scrollable range", () => {
    const { dom, gantt, pane } = start(
      [probe((ctx) => ctx.contribute("renderer/contentExtent", extent(() => ({ height: 1000 }))))],
      { width: 640, height: 400 },
    );
    dom.flushFrames();

    pane.fire("wheel", wheelEvent({ deltaX: 0, deltaY: 900 }));
    expect(gantt.service("stargantt.view").viewport.get().scrollTop).toBe(600);

    booted!.pane.rect = { left: 0, top: 0, width: 640, height: 800 };
    dom.triggerResizeObservers();

    expect(gantt.service("stargantt.view").viewport.get().scrollTop).toBe(200);
  });

  it("does not subscribe to its own view/scrolled event (pane sync stays one-way)", () => {
    const { dom, gantt } = start([
      probe((ctx) => ctx.emit("view/scrolled", { scrollTop: 999, scrollLeft: 999 })),
    ]);
    dom.flushFrames();

    expect(gantt.service("stargantt.view").viewport.get()).toMatchObject({
      scrollTop: 0,
      scrollLeft: 0,
    });
  });
});

describe("synthetic scrollbars — RenderConfig.scrollbar", () => {
  const extent = (height: number): ContentExtentContribution => ({
    id: "rows",
    measure: () => ({ height }),
  });

  /** A `renderer/contentExtent` contribution for the horizontal axis. */
  const widthExtent = (width: number): ContentExtentContribution => ({
    id: "bars",
    measure: () => ({ width }),
  });

  /** The bar for `axis`, or `undefined` when the renderer created none. */
  function bar(booted: Booted, axis: "vertical" | "horizontal"): FakeElement | undefined {
    return booted.pane.children.find((c) =>
      c.className.split(" ").includes(`sg-scrollbar--${axis}`),
    );
  }

  /** The vertical bar — the one the scrollbar rules were written for. */
  function track(booted: Booted): FakeElement | undefined {
    return bar(booted, "vertical");
  }

  /** The thumb of `axis`'s bar. */
  function thumb(booted: Booted, axis: "vertical" | "horizontal"): FakeElement {
    const el = bar(booted, axis)?.children[0];
    if (el === undefined) throw new Error(`no ${axis} scrollbar thumb`);
    return el;
  }

  it("is created by default, appended after the DOM overlay", () => {
    const booted = start([], { width: 640, height: 400 });
    const el = track(booted);
    expect(el).toBeDefined();
    expect(el?.children[0]?.className).toBe("sg-scrollbar__thumb");
  });

  // One bar per axis, both under the same switch.
  it("creates a horizontal bar beside the vertical one", () => {
    const booted = start([], { width: 640, height: 400 });
    expect(bar(booted, "horizontal")).toBeDefined();
    expect(bar(booted, "horizontal")?.children[0]?.className).toBe("sg-scrollbar__thumb");
  });

  it("is never created when scrollbar: false", () => {
    const booted = start([], { width: 640, height: 400 }, { scrollbar: false });
    expect(track(booted)).toBeUndefined();
    expect(bar(booted, "horizontal")).toBeUndefined();
  });

  it("stays hidden when nothing contributes a vertical extent", () => {
    const booted = start([], { width: 640, height: 400 });
    booted.dom.flushFrames();
    expect(track(booted)?.style["display"]).toBe("none");
  });

  it("stays hidden while the content fits the viewport", () => {
    const booted = start(
      [probe((ctx) => ctx.contribute("renderer/contentExtent", extent(200)))],
      { width: 640, height: 400 },
    );
    booted.dom.flushFrames();
    expect(track(booted)?.style["display"]).toBe("none");
  });

  it("shows and sizes the track/thumb from the resolved extent once content overflows", () => {
    const booted = start(
      [probe((ctx) => ctx.contribute("renderer/contentExtent", extent(1000)))],
      { width: 640, height: 400 },
    );
    booted.dom.flushFrames();

    const el = track(booted);
    expect(el?.style["display"]).toBe("block");
    expect(el?.style["height"]).toBe("400px");
    // thumbHeight = trackH * vp.height / contentH = 400 * 400 / 1000
    expect(el?.children[0]?.style["height"]).toBe("160px");
    expect(el?.children[0]?.style["top"]).toBe("0px");
  });

  it("positions the thumb proportionally to the scroll position", () => {
    const booted = start(
      [probe((ctx) => ctx.contribute("renderer/contentExtent", extent(1000)))],
      { width: 640, height: 400 },
    );
    booted.dom.flushFrames();

    booted.pane.fire("wheel", wheelEvent({ deltaX: 0, deltaY: 300 }));
    booted.dom.flushFrames();

    // maxTop = 1000 - 400 = 600; thumbH = 160; thumbTop = (400 - 160) * 300 / 600 = 120
    expect(track(booted)?.children[0]?.style["top"]).toBe("120px");
  });

  it("respects a built-in minimum thumb height at large extents", () => {
    const booted = start(
      [probe((ctx) => ctx.contribute("renderer/contentExtent", extent(1_000_000)))],
      { width: 640, height: 400 },
    );
    booted.dom.flushFrames();

    const height = Number.parseFloat(track(booted)?.children[0]?.style["height"] ?? "0");
    expect(height).toBeGreaterThanOrEqual(24);
    expect(height).toBeLessThan(400);
  });

  it("carries the active class while a scroll is in progress and drops it after the linger", () => {
    vi.useFakeTimers();
    const booted = start(
      [probe((ctx) => ctx.contribute("renderer/contentExtent", extent(1000)))],
      { width: 640, height: 400 },
    );
    booted.dom.flushFrames();

    booted.pane.fire("wheel", wheelEvent({ deltaX: 0, deltaY: 100 }));
    booted.dom.flushFrames();
    expect(track(booted)?.className).toBe(
      "sg-scrollbar sg-scrollbar--vertical sg-scrollbar--active",
    );

    vi.advanceTimersByTime(300);
    expect(track(booted)?.className).toBe("sg-scrollbar sg-scrollbar--vertical");
  });

  it("removes the track on dispose", () => {
    const booted = start([], { width: 640, height: 400 });
    booted.dom.flushFrames();
    expect(track(booted)).toBeDefined();
    expect(bar(booted, "horizontal")).toBeDefined();

    booted.gantt.dispose();
    expect(track(booted)).toBeUndefined();
    expect(bar(booted, "horizontal")).toBeUndefined();
  });

  // The horizontal bar follows the vertical rules per axis: shown only while the horizontal
  // extent exceeds `Viewport.width`, sized from it.
  describe("horizontal bar", () => {
    it("stays hidden while the content fits the viewport width", () => {
      const booted = start(
        [probe((ctx) => ctx.contribute("renderer/contentExtent", widthExtent(400)))],
        { width: 640, height: 400 },
      );
      booted.dom.flushFrames();
      expect(bar(booted, "horizontal")?.style["display"]).toBe("none");
    });

    it("shows and sizes the track/thumb from the resolved horizontal extent", () => {
      const booted = start(
        [probe((ctx) => ctx.contribute("renderer/contentExtent", widthExtent(1280)))],
        { width: 640, height: 400 },
      );
      booted.dom.flushFrames();

      const el = bar(booted, "horizontal");
      expect(el?.style["display"]).toBe("block");
      expect(el?.style["width"]).toBe("640px");
      // thumbW = trackW * vp.width / contentW = 640 * 640 / 1280
      expect(el?.children[0]?.style["width"]).toBe("320px");
      expect(el?.children[0]?.style["left"]).toBe("0px");
    });

    it("positions the thumb proportionally to the horizontal scroll position", () => {
      const booted = start(
        [probe((ctx) => ctx.contribute("renderer/contentExtent", widthExtent(1280)))],
        { width: 640, height: 400 },
      );
      booted.dom.flushFrames();

      booted.pane.fire("wheel", wheelEvent({ deltaX: 320, deltaY: 0 }));
      booted.dom.flushFrames();

      // maxLeft = 1280 - 640 = 640; thumbW = 320; thumbLeft = (640 - 320) * 320 / 640 = 160
      expect(bar(booted, "horizontal")?.children[0]?.style["left"]).toBe("160px");
    });

    it("clears the bottom band before hugging the body's bottom edge", () => {
      const booted = start(
        [
          probe((ctx) => {
            ctx.contribute("renderer/contentExtent", widthExtent(1280));
            ctx.contribute("renderer/insets", { side: "bottom", order: 0, size: 60 });
          }),
        ],
        { width: 640, height: 400 },
      );
      booted.dom.flushFrames();
      expect(bar(booted, "horizontal")?.style["bottom"]).toBe("62px");
    });
  });

  // The thumb is a drag target, and the drag maps back through the exact inverse of the
  // thumb-offset formula.
  describe("thumb dragging", () => {
    /** Boots a chart whose content overflows on both axes. */
    function overflowing(): Booted {
      const booted = start(
        [
          probe((ctx) => {
            ctx.contribute("renderer/contentExtent", extent(1000));
            ctx.contribute("renderer/contentExtent", widthExtent(1280));
          }),
        ],
        { width: 640, height: 400 },
      );
      booted.dom.flushFrames();
      return booted;
    }

    it("scrolls vertically as the thumb is dragged", () => {
      const booted = overflowing();
      const el = thumb(booted, "vertical");

      // trackH = 400, thumbH = 160, maxTop = 600 → span = 240.
      el.fire("pointerdown", pointerEvent(600, 50));
      booted.dom.document.fire("pointermove", pointerEvent(600, 170));

      // (170 - 50) * 600 / 240 = 300
      expect(booted.gantt.service("stargantt.view").viewport.get().scrollTop).toBe(300);
      expect(booted.gantt.service("stargantt.view").viewport.get().scrollLeft).toBe(0);
    });

    it("scrolls horizontally as the horizontal thumb is dragged", () => {
      const booted = overflowing();
      const el = thumb(booted, "horizontal");

      // trackW = 640, thumbW = 320, maxLeft = 640 → span = 320.
      el.fire("pointerdown", pointerEvent(10, 396));
      booted.dom.document.fire("pointermove", pointerEvent(110, 396));

      // (110 - 10) * 640 / 320 = 200
      expect(booted.gantt.service("stargantt.view").viewport.get().scrollLeft).toBe(200);
      expect(booted.gantt.service("stargantt.view").viewport.get().scrollTop).toBe(0);
    });

    it("emits view/scrolled for the drag, through the ordinary scroll path", () => {
      const seen: { scrollTop: number; scrollLeft: number }[] = [];
      const booted = start(
        [
          probe((ctx) => {
            ctx.contribute("renderer/contentExtent", extent(1000));
            ctx.on("view/scrolled", (p) => seen.push(p));
          }),
        ],
        { width: 640, height: 400 },
      );
      booted.dom.flushFrames();

      const el = thumb(booted, "vertical");
      el.fire("pointerdown", pointerEvent(600, 0));
      booted.dom.document.fire("pointermove", pointerEvent(600, 40));

      expect(seen).toEqual([{ scrollTop: 100, scrollLeft: 0 }]);
    });

    it("clamps a drag past the end to the scrollable maximum", () => {
      const booted = overflowing();
      const el = thumb(booted, "vertical");

      el.fire("pointerdown", pointerEvent(600, 0));
      booted.dom.document.fire("pointermove", pointerEvent(600, 5_000));

      expect(booted.gantt.service("stargantt.view").viewport.get().scrollTop).toBe(600);
    });

    it("keeps the grab offset, so the thumb does not jump to the pointer", () => {
      const booted = overflowing();
      const el = thumb(booted, "vertical");

      // Grabbed 100px down the thumb; a move of 0 must not scroll at all.
      el.fire("pointerdown", pointerEvent(600, 100));
      booted.dom.document.fire("pointermove", pointerEvent(600, 100));

      expect(booted.gantt.service("stargantt.view").viewport.get().scrollTop).toBe(0);
    });

    it("consumes the press so the pane's gesture never starts", () => {
      const booted = overflowing();
      const press = pointerEvent(600, 50);
      thumb(booted, "vertical").fire("pointerdown", press);

      expect((press as unknown as { propagationStopped: boolean }).propagationStopped).toBe(true);
      expect((press as unknown as { defaultPrevented: boolean }).defaultPrevented).toBe(true);
    });

    it("captures the pointer on the thumb and releases it on pointerup", () => {
      const booted = overflowing();
      const el = thumb(booted, "vertical");

      el.fire("pointerdown", pointerEvent(600, 50, { pointerId: 7 }));
      expect(el.captured).toEqual([7]);

      booted.dom.document.fire("pointerup", pointerEvent(600, 50, { pointerId: 7 }));
      expect(el.captured).toEqual([]);
    });

    it("stops scrolling once the drag has ended", () => {
      const booted = overflowing();
      const el = thumb(booted, "vertical");

      el.fire("pointerdown", pointerEvent(600, 50));
      booted.dom.document.fire("pointermove", pointerEvent(600, 170));
      booted.dom.document.fire("pointerup", pointerEvent(600, 170));
      booted.dom.document.fire("pointermove", pointerEvent(600, 300));

      expect(booted.gantt.service("stargantt.view").viewport.get().scrollTop).toBe(300);
    });

    it("ends the drag on pointercancel exactly as on pointerup", () => {
      const booted = overflowing();
      const el = thumb(booted, "vertical");

      el.fire("pointerdown", pointerEvent(600, 50, { pointerId: 3 }));
      booted.dom.document.fire("pointercancel", pointerEvent(600, 50, { pointerId: 3 }));
      booted.dom.document.fire("pointermove", pointerEvent(600, 300, { pointerId: 3 }));

      expect(el.captured).toEqual([]);
      expect(booted.gantt.service("stargantt.view").viewport.get().scrollTop).toBe(0);
    });

    it("holds the active style for the whole drag, even while pinned at an end", () => {
      vi.useFakeTimers();
      const booted = overflowing();
      const el = thumb(booted, "vertical");

      el.fire("pointerdown", pointerEvent(600, 5_000));
      booted.dom.document.fire("pointermove", pointerEvent(600, 5_000));
      vi.advanceTimersByTime(1_000);
      booted.dom.flushFrames();
      expect(track(booted)?.className).toContain("sg-scrollbar--active");

      booted.dom.document.fire("pointerup", pointerEvent(600, 5_000));
      vi.advanceTimersByTime(300);
      booted.dom.flushFrames();
      expect(track(booted)?.className).not.toContain("sg-scrollbar--active");
    });

    it("does nothing on a hidden bar, which has no geometry to map through", () => {
      const booted = start([], { width: 640, height: 400 });
      booted.dom.flushFrames();
      const el = thumb(booted, "vertical");

      el.fire("pointerdown", pointerEvent(600, 50));
      el.fire("pointermove", pointerEvent(600, 300));

      expect(booted.gantt.service("stargantt.view").viewport.get().scrollTop).toBe(0);
      expect(el.captured).toEqual([]);
    });

    it("removes its listeners on dispose", () => {
      const booted = overflowing();
      const el = thumb(booted, "vertical");
      expect(el.listenerCount("pointerdown")).toBe(1);

      booted.gantt.dispose();
      for (const type of ["pointerdown", "pointermove", "pointerup", "pointercancel"]) {
        expect(el.listenerCount(type)).toBe(0);
      }
    });
  });
});

describe("§4 DOM overlays — renderer/domOverlays", () => {
  /** The clip host, or `undefined` when the renderer created none. */
  function host(booted: Booted): FakeElement | undefined {
    return booted.pane.find("sg-dom-overlays");
  }

  /** A contribution that records the wrapper it was mounted into. */
  function overlaySpy(id: string, sink: FakeElement[]): DomOverlayContribution {
    return {
      id,
      mount(wrapper) {
        sink.push(wrapper as unknown as FakeElement);
      },
    };
  }

  // §4.4 — the default `preset-standard` composition contributes nothing, and the rendered DOM must
  // stay byte-for-byte what it was before the point existed (screenshot baselines depend on it).
  it("creates no clip host and no wrapper when nothing contributes", () => {
    const booted = start();
    booted.dom.flushFrames();

    expect(host(booted)).toBeUndefined();
    const overlay = booted.pane.find("sg-dom-overlay");
    expect(overlay?.children).toHaveLength(0);
  });

  it("creates the clip host inside .sg-dom-overlay with one wrapper per contribution", () => {
    const mounted: FakeElement[] = [];
    const booted = start([
      probe((ctx) => {
        ctx.contribute("renderer/domOverlays", overlaySpy("acme.badge", mounted));
      }),
    ]);
    booted.dom.flushFrames();

    const clip = host(booted);
    expect(clip).toBeDefined();
    expect(clip?.parentNode?.className).toBe("sg-dom-overlay");
    expect(clip?.children).toHaveLength(1);

    const wrapper = clip?.children[0];
    expect(wrapper?.className).toBe("sg-dom-overlay-item");
    expect(wrapper?.getAttribute("data-overlay-id")).toBe("acme.badge");
    // §4.4 — mounted exactly once, into the wrapper the renderer built and attached.
    expect(mounted).toHaveLength(1);
    expect(mounted[0]).toBe(wrapper);
  });

  it("sizes the clip host to the viewport rectangle so the inset bands are clipped away (§4.2-3)", () => {
    const booted = start(
      [
        probe((ctx) => {
          ctx.contribute("renderer/insets", { side: "top", order: 0, size: 40 });
          ctx.contribute("renderer/insets", { side: "bottom", order: 0, size: 10 });
          ctx.contribute("renderer/domOverlays", { id: "a", mount: () => {} });
        }),
      ],
      { width: 800, height: 600 },
    );
    booted.dom.flushFrames();

    const clip = host(booted);
    // The enclosing `.sg-dom-overlay` already starts below the top band; the host covers only the
    // remaining 600 - 40 - 10 px, so nothing mounted inside it can paint over either band.
    expect(clip?.style["width"]).toBe("800px");
    expect(clip?.style["height"]).toBe("550px");
  });

  it("re-sizes the clip host when the pane resizes", () => {
    const booted = start(
      [probe((ctx) => ctx.contribute("renderer/domOverlays", { id: "a", mount: () => {} }))],
      { width: 800, height: 600 },
    );
    booted.dom.flushFrames();
    expect(host(booted)?.style["height"]).toBe("600px");

    booted.pane.rect = { left: 0, top: 0, width: 500, height: 300 };
    booted.dom.triggerResizeObservers();

    expect(host(booted)?.style["width"]).toBe("500px");
    expect(host(booted)?.style["height"]).toBe("300px");
  });

  // §4.5 — content coordinates stay pinned under scroll; the renderer, not the contribution,
  // subtracts the scroll offsets.
  it("translates every wrapper by the negated scroll offsets, in the paint pass", () => {
    const mounted: FakeElement[] = [];
    const booted = start([
      probe((ctx) => {
        ctx.contribute("renderer/domOverlays", overlaySpy("a", mounted));
        ctx.contribute("renderer/domOverlays", overlaySpy("b", mounted));
      }),
    ]);
    booted.dom.flushFrames();

    // Aligned before `mount` ever sees the wrapper.
    expect(mounted[0]?.style["transform"]).toBe("translate(0px, 0px)");

    booted.pane.fire("wheel", wheelEvent({ deltaX: 30, deltaY: 120 }));
    // The offset is applied by the same once-per-rAF pass that composites the canvases, so it is
    // not visible until that pass runs.
    booted.dom.flushFrames();

    for (const wrapper of mounted) {
      expect(wrapper.style["transform"]).toBe("translate(-30px, -120px)");
    }
  });

  it("mounts and appends in collect order, so DOM order is deterministic", () => {
    const order: string[] = [];
    const record = (id: string): DomOverlayContribution => ({
      id,
      mount: () => order.push(id),
    });
    const booted = start([
      probe((ctx) => {
        ctx.contribute("renderer/domOverlays", record("first"));
        ctx.contribute("renderer/domOverlays", record("second"));
      }, "test.a"),
      probe((ctx) => ctx.contribute("renderer/domOverlays", record("third")), "test.b"),
    ]);
    booted.dom.flushFrames();

    expect(order).toEqual(["first", "second", "third"]);
    expect(host(booted)?.children.map((c) => c.getAttribute("data-overlay-id"))).toEqual([
      "first",
      "second",
      "third",
    ]);
  });

  it("does not deduplicate ids: every contribution gets a wrapper", () => {
    const booted = start([
      probe((ctx) => {
        ctx.contribute("renderer/domOverlays", { id: "dup", mount: () => {} });
        ctx.contribute("renderer/domOverlays", { id: "dup", mount: () => {} });
      }),
    ]);
    booted.dom.flushFrames();

    expect(host(booted)?.children.map((c) => c.getAttribute("data-overlay-id"))).toEqual([
      "dup",
      "dup",
    ]);
  });

  it("calls mount exactly once, however many frames run", () => {
    const mount = vi.fn();
    const booted = start([
      probe((ctx) => ctx.contribute("renderer/domOverlays", { id: "a", mount })),
    ]);
    booted.dom.flushFrames();
    booted.gantt.service("stargantt.view").invalidate("main");
    booted.dom.flushFrames();

    expect(mount).toHaveBeenCalledTimes(1);
    expect(host(booted)?.children).toHaveLength(1);
  });

  it("isolates a throwing mount and still mounts the rest", () => {
    const faults: { pluginId: string; error: unknown }[] = [];
    const mounted: string[] = [];
    const booted = start([
      probe((ctx) => {
        ctx.contribute("renderer/domOverlays", {
          id: "bad",
          mount: () => {
            throw new Error("mount failed");
          },
        });
        ctx.contribute("renderer/domOverlays", {
          id: "ok",
          mount: () => mounted.push("ok"),
        });
      }),
    ]);
    booted.gantt.on("core/pluginError", (e) => faults.push(e));
    booted.dom.flushFrames();

    expect(mounted).toEqual(["ok"]);
    expect(faults).toHaveLength(1);
    expect((faults[0]?.error as Error).message).toBe("mount failed");
    // The barrier reports the invoking plugin: a contribution is a bare value with no observable id.
    expect(faults[0]?.pluginId).toBe("stargantt.view");
    // The faulting wrapper is left in place, in whatever state `mount` got it to.
    expect(host(booted)?.children.map((c) => c.getAttribute("data-overlay-id"))).toEqual([
      "bad",
      "ok",
    ]);
  });

  it("skips a value that is not a usable contribution, without a wrapper or an error", () => {
    const faults: unknown[] = [];
    const booted = start([
      probe((ctx) => {
        const bad = [null, 42, { id: "no-mount" }] as unknown as DomOverlayContribution[];
        for (const value of bad) ctx.contribute("renderer/domOverlays", value);
        ctx.contribute("renderer/domOverlays", { id: "good", mount: () => {} });
      }),
    ]);
    booted.gantt.on("core/pluginError", (e) => faults.push(e));
    booted.dom.flushFrames();

    expect(faults).toEqual([]);
    expect(host(booted)?.children.map((c) => c.getAttribute("data-overlay-id"))).toEqual(["good"]);
  });

  it("removes the clip host and every wrapper on dispose (§4.2-4)", () => {
    const mounted: FakeElement[] = [];
    const booted = start([
      probe((ctx) => {
        ctx.contribute("renderer/domOverlays", {
          id: "a",
          mount(wrapper) {
            const child = wrapper.ownerDocument.createElement("div");
            wrapper.appendChild(child);
            mounted.push(wrapper as unknown as FakeElement);
          },
        });
      }),
    ]);
    booted.dom.flushFrames();
    const clip = host(booted);
    expect(clip?.children).toHaveLength(1);

    booted.gantt.dispose();

    // Detached from the tree together with everything the contribution mounted inside it.
    expect(booted.pane.find("sg-dom-overlays")).toBeUndefined();
    expect(clip?.parentNode).toBeNull();
    expect(mounted[0]?.parentNode).toBeNull();
  });
});

describe("§3 overlay children are exempt from the gesture machine", () => {
  /** Boots with a hit tester that answers everywhere, so any chart press would emit `barDown`. */
  function bootWithHits(): { booted: Booted; seen: string[] } {
    const seen: string[] = [];
    const booted = start([
      probe((ctx) => {
        ctx.contribute("renderer/hitTest", () => ({ kind: "bar", id: "t1", cursor: "move" }));
        ctx.contribute("renderer/domOverlays", {
          id: "acme.panel",
          mount(wrapper) {
            const button = wrapper.ownerDocument.createElement("button");
            wrapper.appendChild(button);
          },
        });
      }),
    ]);
    for (const type of ["pointer/barDown", "pointer/background", "pointer/barUp"] as const) {
      booted.gantt.on(type, () => seen.push(type));
    }
    booted.dom.flushFrames();
    return { booted, seen };
  }

  /** The `<button>` the overlay contribution mounted inside its wrapper. */
  function overlayButton(booted: Booted): FakeElement {
    const found = booted.pane.find("sg-dom-overlays")?.children[0]?.children[0];
    if (found === undefined) throw new Error("overlay button was not mounted");
    return found;
  }

  it("a press inside a DOM-overlay wrapper emits nothing and captures no pointer", () => {
    const { booted, seen } = bootWithHits();

    booted.pane.fire(
      "pointerdown",
      pointerEvent(20, 20, { type: "pointerdown", target: overlayButton(booted) }),
    );

    expect(seen).toEqual([]);
    expect(booted.pane.captured).toEqual([]);
    // The release the overlay's own click depends on is likewise not turned into a `pointer/barUp`.
    booted.pane.fire("pointerup", pointerEvent(20, 20, { type: "pointerup" }));
    expect(seen).toEqual([]);
  });

  it("a press on a corner widget mounted straight into the chart pane is exempt too", () => {
    const { booted, seen } = bootWithHits();
    // What zoom-controls / filter-search / schedule-diagnostics do: append to `chartPaneElement()`.
    const pane = booted.gantt.service("stargantt.view").chartPaneElement();
    const widget = pane.ownerDocument.createElement("div");
    pane.appendChild(widget);
    const button = pane.ownerDocument.createElement("button");
    widget.appendChild(button);

    booted.pane.fire(
      "pointerdown",
      pointerEvent(20, 20, { type: "pointerdown", target: button }),
    );

    expect(seen).toEqual([]);
    expect(booted.pane.captured).toEqual([]);
  });

  it("a press on a layer canvas still starts the gesture and captures the pointer", () => {
    const { booted, seen } = bootWithHits();

    booted.pane.fire(
      "pointerdown",
      pointerEvent(20, 20, { type: "pointerdown", target: booted.canvas("main") }),
    );

    expect(seen).toEqual(["pointer/barDown"]);
    expect(booted.pane.captured).toEqual([DEFAULT_POINTER_ID]);

    booted.pane.fire("pointerup", pointerEvent(20, 20, { type: "pointerup" }));
    expect(seen).toEqual(["pointer/barDown", "pointer/barUp"]);
    expect(booted.pane.captured).toEqual([]);
  });
});

describe("`ViewService.renderTo` — the off-screen composite", () => {
  /** A stand-in for an offscreen 2d context: records the members the renderer touches. */
  class RecordingContext {
    readonly ops: string[] = [];
    depth = 0;
    save(): void {
      this.depth += 1;
      this.ops.push("save");
    }
    restore(): void {
      this.depth -= 1;
      this.ops.push("restore");
    }
  }

  /** The same, but a Proxy that fails loudly on any member the composite is not allowed to use. */
  function strictContext(): { context: CanvasRenderingContext2D; touched: string[] } {
    const inner = new RecordingContext();
    const touched: string[] = [];
    const context = new Proxy(inner, {
      get(base, key) {
        const name = String(key);
        touched.push(name);
        const value = (base as unknown as Record<string, unknown>)[name];
        if (value === undefined) {
          throw new Error(`renderTo touched an unimplemented context member: ${name}`);
        }
        return typeof value === "function" ? value.bind(base) : value;
      },
    }) as unknown as CanvasRenderingContext2D;
    return { context, touched };
  }

  /** Contributions across all three canvases, recording the target and viewport they were given. */
  function threeLayers(
    order: string[],
    sink: { g: unknown; vp: Readonly<Viewport> }[],
  ): LayerContribution[] {
    const spy = (id: string, zIndex: number): LayerContribution => ({
      id,
      zIndex,
      draw: (g, vp) => {
        order.push(id);
        sink.push({ g, vp });
      },
    });
    // Contributed out of z order on purpose: the pass must sort, not follow registration.
    return [spy("ghost", 500), spy("grid", 10), spy("bars", 55)];
  }

  it("draws every contribution into the one supplied context in z order", () => {
    const order: string[] = [];
    const sink: { g: unknown; vp: Readonly<Viewport> }[] = [];
    const { dom, gantt } = start([
      probe((ctx) => {
        for (const c of threeLayers(order, sink)) ctx.contribute("renderer/layers", c);
      }),
    ]);
    dom.flushFrames();
    order.length = 0;
    sink.length = 0;

    const target = new RecordingContext();
    gantt.service("stargantt.view").renderTo(target as unknown as CanvasRenderingContext2D, {
      scrollTop: 0,
      scrollLeft: 0,
      width: 100,
      height: 50,
    });

    // Background, main and overlay contributions all land on the single target, back to front.
    expect(order).toEqual(["grid", "bars", "ghost"]);
    expect(sink.every((c) => c.g === target)).toBe(true);
    // Every draw is bracketed exactly like the on-screen pass.
    expect(target.ops).toEqual(["save", "restore", "save", "restore", "save", "restore"]);
    expect(target.depth).toBe(0);
  });

  it("hands `draw` the caller's virtual viewport, unclamped and independent of the live scroll", () => {
    const sink: { g: unknown; vp: Readonly<Viewport> }[] = [];
    const { dom, gantt } = start(
      [
        probe((ctx) => {
          ctx.contribute("renderer/layers", layerSpy("bars", 55, sink));
        }),
      ],
      { width: 320, height: 240 },
    );
    dom.flushFrames();
    const service = gantt.service("stargantt.view");
    service.scrollTo({ scrollLeft: 10, scrollTop: 20 });
    dom.flushFrames();
    sink.length = 0;

    const requested: Viewport = {
      scrollTop: 9_000,
      scrollLeft: 12_345,
      width: 1_024,
      height: 768,
    };
    service.renderTo(new RecordingContext() as unknown as CanvasRenderingContext2D, requested);

    expect(sink).toHaveLength(1);
    expect(sink[0]?.vp).toEqual(requested);
    // A snapshot, not the caller's object: mutating it afterwards cannot reach a past `draw`, and
    // the on-screen viewport is untouched by the request.
    expect(sink[0]?.vp).not.toBe(requested);
    expect(service.viewport.get()).toEqual({
      scrollTop: 20,
      scrollLeft: 10,
      width: 320,
      height: 240,
    });
  });

  it("touches no on-screen canvas, scroll state, hover state or frame", () => {
    const sink: { g: unknown; vp: Readonly<Viewport> }[] = [];
    const scrolls: unknown[] = [];
    const hovers: unknown[] = [];
    const { dom, gantt, canvas, pane } = start([
      probe((ctx) => {
        ctx.contribute("renderer/layers", layerSpy("bars", 55, sink));
        ctx.contribute("renderer/hitTest", () => ({ kind: "bar", id: "a", cursor: "move" }));
      }),
    ]);
    dom.flushFrames();
    gantt.on("view/scrolled", (e) => scrolls.push(e));
    gantt.on("pointer/barHover", (e) => hovers.push(e));
    sink.length = 0;
    const before = {
      background: ctxOf(canvas("background")).ops.length,
      main: ctxOf(canvas("main")).ops.length,
      overlay: ctxOf(canvas("overlay")).ops.length,
      cursor: pane.style["cursor"],
    };

    gantt.service("stargantt.view").renderTo(
      new RecordingContext() as unknown as CanvasRenderingContext2D,
      { scrollTop: 0, scrollLeft: 0, width: 320, height: 240 },
    );

    // Exactly one `draw`, on the caller's surface — nothing on screen was drawn into or scheduled.
    expect(sink).toHaveLength(1);
    expect(ctxOf(canvas("background")).ops).toHaveLength(before.background);
    expect(ctxOf(canvas("main")).ops).toHaveLength(before.main);
    expect(ctxOf(canvas("overlay")).ops).toHaveLength(before.overlay);
    expect(dom.pendingFrames()).toBe(0);
    expect(scrolls).toHaveLength(0);
    expect(hovers).toHaveLength(0);
    expect(pane.style["cursor"]).toBe(before.cursor);

    // The next on-screen frame is still driven only by the dirty flags `renderTo` never set.
    gantt.service("stargantt.view").invalidate("main");
    expect(dom.flushFrames()).toBe(1);
    expect(sink).toHaveLength(2);
  });

  it("isolates a throwing `draw` exactly like the on-screen composite", () => {
    const drawn: string[] = [];
    const faults: { pluginId: string; error: unknown }[] = [];
    const { dom, gantt } = start([
      probe((ctx) => {
        ctx.contribute("renderer/layers", {
          id: "boom",
          zIndex: 10,
          draw: () => {
            throw new Error("export draw failed");
          },
        });
        ctx.contribute("renderer/layers", {
          id: "ok",
          zIndex: 55,
          draw: () => void drawn.push("ok"),
        });
      }),
    ]);
    gantt.on("core/pluginError", (e) => faults.push(e));
    dom.flushFrames();
    drawn.length = 0;
    faults.length = 0;

    const target = new RecordingContext();
    gantt.service("stargantt.view").renderTo(target as unknown as CanvasRenderingContext2D, {
      scrollTop: 0,
      scrollLeft: 0,
      width: 10,
      height: 10,
    });

    expect(drawn).toEqual(["ok"]);
    expect(faults).toHaveLength(1);
    expect((faults[0]?.error as Error).message).toBe("export draw failed");
    // The barrier reports the invoking plugin, and save/restore stays balanced across a throw.
    expect(faults[0]?.pluginId).toBe("stargantt.view");
    expect(target.depth).toBe(0);
  });

  it("works against a minimal context that implements only what the composite calls", () => {
    const drawn: string[] = [];
    const { dom, gantt } = start([
      probe((ctx) => {
        ctx.contribute("renderer/layers", {
          id: "vector",
          zIndex: 55,
          draw: () => void drawn.push("vector"),
        });
      }),
    ]);
    dom.flushFrames();
    drawn.length = 0;

    // A recording proxy implements a subset of Canvas2D; the renderer must not reach for
    // members outside it — the Proxy throws on any other access.
    const { context, touched } = strictContext();
    expect(() =>
      gantt
        .service("stargantt.view")
        .renderTo(context, { scrollTop: 0, scrollLeft: 0, width: 8, height: 8 }),
    ).not.toThrow();

    expect(drawn).toEqual(["vector"]);
    expect([...new Set(touched)].sort()).toEqual(["restore", "save"]);
  });

  it("normalizes a viewport whose members are not usable numbers", () => {
    const sink: { g: unknown; vp: Readonly<Viewport> }[] = [];
    const { dom, gantt } = start([
      probe((ctx) => {
        ctx.contribute("renderer/layers", layerSpy("bars", 55, sink));
      }),
    ]);
    dom.flushFrames();
    sink.length = 0;

    gantt.service("stargantt.view").renderTo(
      new RecordingContext() as unknown as CanvasRenderingContext2D,
      { scrollTop: Number.NaN, scrollLeft: 5, width: Number.POSITIVE_INFINITY, height: 40 },
    );

    expect(sink[0]?.vp).toEqual({ scrollTop: 0, scrollLeft: 5, width: 0, height: 40 });
  });
});

describe("resource ownership and disposal (CLAUDE.md constraint, §1.8)", () => {
  it("removes the pane, its listeners, the rAF frame and the observers", () => {
    const { dom, gantt, pane } = start();
    dom.flushFrames();
    gantt.service("stargantt.view").invalidate("main");
    expect(dom.pendingFrames()).toBe(1);

    gantt.dispose();

    expect(dom.root.children).toHaveLength(0);
    expect(pane.listenerCount("wheel")).toBe(0);
    expect(pane.listenerCount("pointerdown")).toBe(0);
    expect(pane.listenerCount("pointermove")).toBe(0);
    expect(pane.listenerCount("pointerup")).toBe(0);
    expect(pane.listenerCount("pointercancel")).toBe(0);
    expect(dom.pendingFrames()).toBe(0);
    expect(dom.cancelledFrames()).toBe(1);
    expect(dom.resizeObserverCount()).toBe(0);
    expect(dom.mediaQueries()[0]?.listeners.size).toBe(0);
  });
});

describe("§2 declaration merging is live end-to-end", () => {
  it("lets a dependent plugin `use()` the renderer key and contribute to both points", () => {
    const seen: CanvasLayer[] = [];
    const { dom } = start([
      probe((ctx) => {
        const service = ctx.use("stargantt.view");
        expect(service.viewport.get().width).toBe(800);
        ctx.contribute("renderer/hitTest", () => undefined);
        ctx.contribute("renderer/layers", {
          id: "probe",
          zIndex: 55,
          draw: () => {
            seen.push("main");
          },
        });
        service.invalidate("main");
      }),
    ]);
    dom.flushFrames();
    expect(seen).toEqual(["main"]);
  });

  it("throws for an undeclared dependency, proving no back-door access (§1.5-4)", () => {
    const spy = vi.fn();
    expect(() =>
      start([
        probe(
          (ctx) => {
            spy();
            ctx.use("stargantt.view");
          },
          "test.undeclared",
          [],
        ),
      ]),
    ).toThrow();
    expect(spy).toHaveBeenCalled();
  });
});
