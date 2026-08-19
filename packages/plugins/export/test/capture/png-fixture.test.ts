/**
 * A PNG byte-comparison against a reference fixture, with a documented substitution.
 *
 * A genuine byte-identical PNG fixture is not reproducible headlessly: the test harness
 * (`_boot.ts`'s `FakeCanvas`) is a *recording* fake canvas that never rasterizes — `toBlob` /
 * `toDataURL` hand back a fixed stand-in `Blob`/data URL rather than encoded pixels — and no PNG
 * byte sequence exists to compare against, headless or otherwise. Real canvas rasterization (a
 * `node-canvas` or real-browser encode) would also not be *byte-identical* across
 * platforms/versions, which is the disqualifying case.
 *
 * What this file asserts instead, and why it is load-bearing: the exact sequence of composition
 * operations `toPng()` performs — every offscreen canvas it allocates (role and CSS/device-pixel
 * size), every `fillRect` (the background) and `drawImage` (the layer composite, then each
 * auxiliary band) on the final output canvas with their destination boxes, and the encoder MIME
 * type plus the `quality` argument forwarded to `toBlob` — against a checked-in expectation
 * (`fixtures/png-composition.json`) hand-derived from §1.1's documented composition order (verbatim
 * from the `raster()` / `captureLayers()` / `captureSurface()` pipeline). A change to canvas
 * sizing, draw offsets, band ordering, or encoder argument forwarding breaks this test, which a
 * purely "does it resolve to *a* Blob" test would not catch.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { definePlugin } from "@stargantt/core";
import type { AuxiliarySurfaceContribution } from "../../src/index";
import { FakeCanvas, boot } from "./_boot";

interface Fixture {
  scenario: {
    viewport: { width: number; height: number };
    layer: { width: number; height: number };
    image: { background: string; pixelRatio: number; format: "jpeg"; quality: number };
    auxiliarySurfaces: readonly { side: "top" | "bottom"; height: number }[];
  };
  createdCanvases: readonly { role: string; width: number; height: number }[];
  outputCanvasOps: readonly (
    | { op: "fillRect"; args: [number, number, number, number]; fill: string }
    | { op: "drawImage"; dx: number; dy: number; dw: number; dh: number; src: string }
  )[];
  encoder: { type: string; quality: number };
}

const fixture = JSON.parse(
  readFileSync(fileURLToPath(new URL("./fixtures/png-composition.json", import.meta.url)), "utf-8"),
) as Fixture;

function auxSurface(side: "top" | "bottom", height: number): AuxiliarySurfaceContribution {
  return { side, height, drawTile: () => undefined };
}

describe("toPng composition trace (structural PNG-fixture substitute)", () => {
  it("matches the checked-in composition-operation expectation", async () => {
    const { scenario } = fixture;
    const surfaces = scenario.auxiliarySurfaces.map((s, i) =>
      definePlugin({
        meta: { id: `test.aux${i}`, dependsOn: [] },
        setup(ctx) {
          ctx.contribute("export/auxiliarySurfaces", auxSurface(s.side, s.height));
        },
      }),
    );

    const { doc, service, dispose } = boot({
      viewport: { width: scenario.viewport.width, height: scenario.viewport.height },
      layers: [{ layer: "main", width: scenario.layer.width, height: scenario.layer.height }],
      config: { image: { background: scenario.image.background, pixelRatio: scenario.image.pixelRatio } },
      extra: surfaces,
    });

    await service.toPng({ format: scenario.image.format, quality: scenario.image.quality });

    // --- every offscreen canvas the export allocated, in creation order ---
    const canvases = doc.createdCanvases();
    expect(canvases.map((c) => ({ width: c.width, height: c.height }))).toEqual(
      fixture.createdCanvases.map((c) => ({ width: c.width, height: c.height })),
    );

    // --- the top-level output canvas: the only one actually encoded ---
    const bySize = new Map<string, FakeCanvas>();
    fixture.createdCanvases.forEach((c, i) => bySize.set(c.role, canvases[i] as FakeCanvas));
    const out = bySize.get("top-level output canvas (raster()'s own offscreen canvas)")!;

    const fills = (out.context?.calls("fillRect") ?? []).map((o) => ({
      op: "fillRect" as const,
      args: [o.args[0] ?? 0, o.args[1] ?? 0, o.args[2] ?? 0, o.args[3] ?? 0] as [number, number, number, number],
      fill: o.fill,
    }));
    const draws = (out.context?.drawn ?? []).map((d) => ({
      op: "drawImage" as const,
      dx: d.dx,
      dy: d.dy,
      dw: d.dw,
      dh: d.dh,
    }));

    expect(fills).toEqual(
      fixture.outputCanvasOps
        .filter((o): o is Extract<Fixture["outputCanvasOps"][number], { op: "fillRect" }> => o.op === "fillRect")
        .map((o) => ({ op: "fillRect", args: o.args, fill: o.fill })),
    );
    expect(draws).toEqual(
      fixture.outputCanvasOps
        .filter((o): o is Extract<Fixture["outputCanvasOps"][number], { op: "drawImage" }> => o.op === "drawImage")
        .map((o) => ({ op: "drawImage", dx: o.dx, dy: o.dy, dw: o.dw, dh: o.dh })),
    );
    // Op order matters too: background first, then the layer composite, then the bands in
    // declared (top, then bottom) order.
    expect(out.context?.opNames()).toEqual(fixture.outputCanvasOps.map((o) => o.op));

    // --- the encoder call: MIME type and quality ---
    expect(out.toBlobTypes).toEqual([fixture.encoder.type]);
    expect(out.toBlobQualities).toEqual([fixture.encoder.quality]);

    dispose();
  });
});
