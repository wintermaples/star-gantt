/** Hostless unit tests for dirty-region accumulation and the clipped repaint (contract §6.4). */
import { describe, expect, it } from "vitest";
import { createDirtyRegions } from "../../src/internal/render/dirty";
import { orderLayers, paintLayers } from "../../src/internal/render/layers";
import { FakeContext2D } from "../_utils/index";
import type { CanvasLayer, Viewport } from "../../src/internal/render/index";

const vp: Viewport = { scrollTop: 0, scrollLeft: 0, width: 800, height: 600 };

describe("createDirtyRegions", () => {
  it("unions rects per layer and consumes them on take()", () => {
    const d = createDirtyRegions(true);
    d.add("main", { x: 10, y: 10, width: 20, height: 20 });
    d.add("main", { x: 50, y: 40, width: 10, height: 10 });
    expect(d.take("main")).toEqual({ x: 10, y: 10, width: 50, height: 40 });
    expect(d.take("main")).toBeNull(); // consumed: next repaint is full
  });

  it("keeps layers independent", () => {
    const d = createDirtyRegions(true);
    d.add("main", { x: 0, y: 0, width: 5, height: 5 });
    expect(d.take("background")).toBeNull();
    expect(d.take("main")).toEqual({ x: 0, y: 0, width: 5, height: 5 });
  });

  it("a rectless or unusable invalidation makes the layer fully dirty and stays full", () => {
    const d = createDirtyRegions(true);
    d.add("main", { x: 0, y: 0, width: 5, height: 5 });
    d.add("main"); // full invalidation wins
    d.add("main", { x: 1, y: 1, width: 2, height: 2 }); // cannot narrow it back
    expect(d.take("main")).toBeNull();

    d.add("overlay", { x: 0, y: 0, width: 0, height: 5 }); // zero-size: unusable = full
    expect(d.take("overlay")).toBeNull();
  });

  it("disabled, every answer is full repaint", () => {
    const d = createDirtyRegions(false);
    d.add("main", { x: 1, y: 1, width: 2, height: 2 });
    expect(d.take("main")).toBeNull();
  });
});

describe("paintLayers with a dirty region", () => {
  const contexts = (): Record<CanvasLayer, FakeContext2D> => ({
    background: new FakeContext2D(),
    main: new FakeContext2D(),
    overlay: new FakeContext2D(),
  });

  it("clips the clear and the draws to the region rect", () => {
    const ctxs = contexts();
    const list = orderLayers([{ id: "m", zIndex: 55, draw: () => {} }]);
    paintLayers(
      ctxs as unknown as Record<CanvasLayer, CanvasRenderingContext2D>,
      vp,
      list,
      () => true,
      () => {},
      (layer) => (layer === "main" ? { x: 10, y: 20, width: 30, height: 40 } : null),
    );
    const ops = ctxs.main.opNames();
    expect(ops.slice(0, 5)).toEqual(["save", "beginPath", "rect", "clip", "clearRect"]);
    const clear = ctxs.main.ops.find((o) => o.op === "clearRect");
    expect(clear?.args).toEqual([10, 20, 30, 40]);
    // The full-repaint layers still clear the whole viewport, unclipped.
    const bgClear = ctxs.background.ops.find((o) => o.op === "clearRect");
    expect(bgClear?.args).toEqual([0, 0, 800, 600]);
  });

  it("without a region callback the pass is byte-identical to the historical one", () => {
    const a = contexts();
    const b = contexts();
    const list = orderLayers([{ id: "m", zIndex: 55, draw: () => {} }]);
    paintLayers(
      a as unknown as Record<CanvasLayer, CanvasRenderingContext2D>,
      vp,
      list,
      () => true,
      () => {},
    );
    paintLayers(
      b as unknown as Record<CanvasLayer, CanvasRenderingContext2D>,
      vp,
      list,
      () => true,
      () => {},
      () => null,
    );
    expect(a.main.opNames()).toEqual(b.main.opNames());
  });
});
