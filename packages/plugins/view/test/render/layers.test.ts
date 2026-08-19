/**
 * Hostless unit tests for the layer composite: z ordering, the memoized order, the guarded draw
 * loop and the dirty-claim repaint. Plain recording contexts stand in for canvases.
 */
import { describe, expect, it, vi } from "vitest";
import {
  createLayerOrder,
  drawLayers,
  normalizeViewport,
  orderLayers,
  paintLayers,
} from "../../src/internal/render/layers";
import type { CanvasLayer, LayerContribution, Viewport } from "../../src/internal/render/index";
import { FakeContext2D } from "../_utils/index";

const vp: Viewport = { scrollTop: 0, scrollLeft: 0, width: 800, height: 600 };

const layer = (
  id: string,
  zIndex: number,
  draw: LayerContribution["draw"] = () => {},
): LayerContribution => ({ id, zIndex, draw });

const context = (): CanvasRenderingContext2D =>
  new FakeContext2D() as unknown as CanvasRenderingContext2D;

describe("orderLayers", () => {
  it("sorts by zIndex and keeps contribution order on a tie", () => {
    const a = layer("a", 55);
    const b = layer("b", 10);
    const c = layer("c", 55);
    expect(orderLayers([a, b, c]).map((l) => l.id)).toEqual(["b", "a", "c"]);
  });

  it("does not mutate the input array", () => {
    const input = [layer("a", 90), layer("b", 5)];
    orderLayers(input);
    expect(input.map((l) => l.id)).toEqual(["a", "b"]);
  });
});

describe("createLayerOrder", () => {
  it("re-sorts only when the contribution list is a different reference", () => {
    let list: LayerContribution[] = [layer("a", 90), layer("b", 5)];
    const get = vi.fn(() => list);
    const ordered = createLayerOrder(get);

    const first = ordered();
    expect(first.map((l) => l.id)).toEqual(["b", "a"]);
    expect(ordered()).toBe(first);

    list = [...list, layer("c", 1)];
    const second = ordered();
    expect(second).not.toBe(first);
    expect(second.map((l) => l.id)).toEqual(["c", "b", "a"]);
  });

  it("treats a missing result as no contributions", () => {
    expect(createLayerOrder(() => undefined)()).toEqual([]);
  });
});

describe("drawLayers", () => {
  it("draws only the contributions the zIndex bands map onto the named layer", () => {
    const drawn: string[] = [];
    const list = orderLayers([
      layer("bg", 10, () => drawn.push("bg")),
      layer("main", 55, () => drawn.push("main")),
      layer("over", 110, () => drawn.push("over")),
    ]);
    drawLayers(context(), vp, list, "main", () => {});
    expect(drawn).toEqual(["main"]);
  });

  it("draws every contribution in z order when no layer is named (renderTo)", () => {
    const drawn: string[] = [];
    const list = orderLayers([
      layer("over", 110, () => drawn.push("over")),
      layer("bg", 10, () => drawn.push("bg")),
    ]);
    drawLayers(context(), vp, list, null, () => {});
    expect(drawn).toEqual(["bg", "over"]);
  });

  it("brackets each draw with save/restore and reports a throw without aborting the pass", () => {
    const g = new FakeContext2D();
    const faults: unknown[] = [];
    const drawn: string[] = [];
    drawLayers(
      g as unknown as CanvasRenderingContext2D,
      vp,
      orderLayers([
        layer("bad", 20, () => {
          throw new Error("draw failed");
        }),
        layer("good", 30, () => drawn.push("good")),
      ]),
      "background",
      (error) => faults.push(error),
    );
    expect(drawn).toEqual(["good"]);
    expect((faults[0] as Error).message).toBe("draw failed");
    // Balanced: the throwing contribution's context state was restored.
    expect(g.depth).toBe(0);
    expect(g.opNames()).toEqual(["save", "restore", "save", "restore"]);
  });

  it("hands every contribution the same viewport it was given", () => {
    const seen: Readonly<Viewport>[] = [];
    drawLayers(context(), vp, [layer("a", 55, (_g, v) => seen.push(v))], null, () => {});
    expect(seen).toEqual([vp]);
  });
});

describe("paintLayers", () => {
  const contexts = (): Record<CanvasLayer, FakeContext2D> => ({
    background: new FakeContext2D(),
    main: new FakeContext2D(),
    overlay: new FakeContext2D(),
  });

  it("clears and repaints only the layers whose dirty flag it claims", () => {
    const g = contexts();
    const dirty: Record<CanvasLayer, boolean> = {
      background: false,
      main: true,
      overlay: false,
    };
    const drawn: string[] = [];
    paintLayers(
      g as unknown as Record<CanvasLayer, CanvasRenderingContext2D>,
      vp,
      orderLayers([
        layer("bg", 10, () => drawn.push("bg")),
        layer("main", 55, () => drawn.push("main")),
      ]),
      (name) => {
        const was = dirty[name];
        dirty[name] = false;
        return was;
      },
      () => {},
    );

    expect(drawn).toEqual(["main"]);
    expect(g.background.calls("clearRect")).toEqual([]);
    expect(g.main.calls("clearRect").map((o) => o.args)).toEqual([[0, 0, 800, 600]]);
  });

  it("paints back to front, and serves a later layer dirtied from inside an earlier draw", () => {
    const g = contexts();
    const dirty: Record<CanvasLayer, boolean> = { background: true, main: false, overlay: false };
    const painted: CanvasLayer[] = [];
    paintLayers(
      g as unknown as Record<CanvasLayer, CanvasRenderingContext2D>,
      vp,
      orderLayers([
        layer("bg", 10, () => {
          painted.push("background");
          dirty.overlay = true;
        }),
        layer("over", 110, () => painted.push("overlay")),
      ]),
      (name) => {
        const was = dirty[name];
        dirty[name] = false;
        return was;
      },
      () => {},
    );
    expect(painted).toEqual(["background", "overlay"]);
  });
});

describe("normalizeViewport", () => {
  it("copies the caller's viewport so a later mutation cannot reach a draw", () => {
    const caller: Viewport = { scrollTop: 5, scrollLeft: 6, width: 7, height: 8 };
    const snapshot = normalizeViewport(caller);
    caller.scrollTop = 999;
    expect(snapshot).toEqual({ scrollTop: 5, scrollLeft: 6, width: 7, height: 8 });
  });

  it("replaces members that are not usable numbers with 0", () => {
    const bad = {
      scrollTop: Number.NaN,
      scrollLeft: "3",
      width: undefined,
      height: 10,
    } as unknown as Viewport;
    expect(normalizeViewport(bad)).toEqual({
      scrollTop: 0,
      scrollLeft: 0,
      width: 0,
      height: 10,
    });
    expect(normalizeViewport(undefined)).toEqual({
      scrollTop: 0,
      scrollLeft: 0,
      width: 0,
      height: 0,
    });
  });
});
