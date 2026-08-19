import { describe, expect, it } from "vitest";
import { planVectorization } from "../../src/internal/capture/vectorization";
import type { TileRecording } from "../../src/internal/capture/vectorization";
import { recordComposite } from "../../src/internal/capture/recorder";

// docs/specs/plugins/export.md §1.1 "True-vector SVG" — the SVG export's vector-versus-raster
// eligibility rule, decided per layer across every tile of the export.

/** A tile whose layers are described by their usability, in z order. */
function tile(loose: boolean, ...blocks: boolean[]): TileRecording {
  return { loose: { ok: loose }, blocks: blocks.map((ok) => ({ ok })) };
}

describe("planVectorization", () => {
  it("keeps every layer vector when all tiles stay inside the recorded subset", () => {
    expect(planVectorization([tile(true, true, true), tile(true, true, true)])).toEqual({
      rasterizeComposite: false,
      layers: ["vector", "vector"],
    });
  });

  it("rasterizes only the layer that left the subset", () => {
    const plan = planVectorization([tile(true, true, false, true)]);
    expect(plan.rasterizeComposite).toBe(false);
    expect(plan.layers).toEqual(["vector", "raster", "vector"]);
  });

  it("rasterizes a layer in every tile as soon as one tile fails for it", () => {
    // A layer must not be vector in one tile and raster in the next: one decision covers the export.
    const plan = planVectorization([tile(true, true, true), tile(true, false, true)]);
    expect(plan.layers).toEqual(["raster", "vector"]);
  });

  it("rasterizes the whole composite when any tile drew unusable output outside a block", () => {
    const plan = planVectorization([tile(true, true), tile(false, true)]);
    expect(plan).toEqual({ rasterizeComposite: true, layers: [] });
  });

  it("covers as many layers as the tile with the most blocks", () => {
    const plan = planVectorization([tile(true, true), tile(true, true, true, true)]);
    expect(plan.layers).toEqual(["vector", "vector", "vector"]);
  });

  it("does not force a raster replay for a layer a tile recorded no block for", () => {
    // A missing block is "this tile drew nothing there", which vector output expresses as nothing.
    const plan = planVectorization([tile(true), tile(true, true)]);
    expect(plan.layers).toEqual(["vector"]);
  });

  it("plans nothing at all for an export with no tile and for tiles with no layer", () => {
    expect(planVectorization([])).toEqual({ rasterizeComposite: false, layers: [] });
    expect(planVectorization([tile(true)])).toEqual({ rasterizeComposite: false, layers: [] });
  });

  it("reads real recordings: a clipping layer goes raster, its neighbours stay vector", () => {
    const recording = recordComposite(
      (g) => {
        for (const layer of [
          (c: CanvasRenderingContext2D) => c.fillRect(0, 0, 1, 1),
          (c: CanvasRenderingContext2D) => c.clip(),
          (c: CanvasRenderingContext2D) => c.fillRect(1, 1, 1, 1),
        ]) {
          g.save();
          layer(g);
          g.restore();
        }
      },
      10,
      10,
    );
    expect(planVectorization([recording]).layers).toEqual(["vector", "raster", "vector"]);
  });

  it("reads real recordings: output outside every block forces the whole composite to raster", () => {
    const recording = recordComposite((g) => g.clip(), 10, 10);
    expect(planVectorization([recording]).rasterizeComposite).toBe(true);
  });
});
