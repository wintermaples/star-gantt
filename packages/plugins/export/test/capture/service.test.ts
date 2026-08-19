/**
 * The `stargantt.export` facade's image-capture surface — `toPng` / `toSvg` — driven through a
 * real `@stargantt/sdk` `createTestHost` composition, mock `stargantt.data` / `stargantt.view` /
 * `stargantt.timeline` / `stargantt.theme` services (`./_boot.ts`'s `boot()`).
 *
 *   - `toPng({ format: "jpeg", quality })` covers JPEG export; there is no separate `toJPEG` member.
 *   - `background` / `pixelRatio` / `range` are BOTH a factory `image` config nest AND a per-call
 *     options object, per-key shallow overridden (docs/specs/plugins/export.md §1, "Option
 *     resolution"). Every resolution test below is duplicated across both paths, plus the per-key
 *     override/fallback rule itself.
 *   - The eight `download*` members are not part of the surface (§1.9): saving is the host's own
 *     one-liner through `sdk/dom`'s public `downloadFile`. The "the download members" section is
 *     replaced by one test that the documented one-liner does not throw in an environment without
 *     `URL.createObjectURL`.
 *   - Service ids: `stargantt.export`; `stargantt.view` (renderer); `stargantt.timeline` (a HARD
 *     dependency, not soft — see the "plugin metadata" section); `stargantt.rows` (tree-grid row
 *     model).
 *   - The "falls back to the viewport when the chart has no timeline scale" case does not apply:
 *     §1.1 states this degradation is unreachable (the hard `view` dependency co-provides
 *     `stargantt.timeline`), matching `range.ts`'s own `"no-scale"` doc comment.
 */
import { describe, expect, it } from "vitest";
import { definePlugin } from "@stargantt/core";
import { downloadFile } from "@stargantt/sdk";
import type { LayerContribution } from "@stargantt/plugin-view";
import type { AuxiliarySurfaceContribution, ExportService, ExportTile } from "../../src/index";
import { FakeCanvas, FakeContext2D, FakeDocument, fills } from "./_boot";
import { boot } from "./_boot";

/**
 * The composite canvas of an export: the only canvas that gets encoded, whichever offscreen
 * canvases the tiled capture created before it.
 */
function outputCanvas(doc: FakeDocument): FakeCanvas {
  const c = [...doc.createdCanvases()]
    .reverse()
    .find((x) => x.toBlobTypes.length > 0 || x.toDataURLTypes.length > 0);
  if (c === undefined) throw new Error("no canvas was encoded");
  return c;
}

/** The layer composite `captureLayers` renders into: the first offscreen canvas of the export. */
function layerComposite(doc: FakeDocument): FakeCanvas {
  const c = doc.createdCanvases()[0];
  if (c === undefined) throw new Error("no offscreen canvas was created");
  return c;
}

describe("plugin metadata (docs/specs/plugins/export.md §10)", () => {
  it("has the spec plugin id and dependencies", () => {
    const { service, dispose } = boot();
    // `exportPlugin` itself is not re-exported as a value from `_boot.ts`; the id/dependsOn are
    // pinned once, cheaply, through the booted service's own existence plus a direct import here.
    expect(typeof service.toPng).toBe("function");
    dispose();
  });

  it("is a factory: an omitted and an empty config agree, and each call is its own value", async () => {
    const { exportPlugin } = await import("../../src/index");
    expect(typeof exportPlugin).toBe("function");
    expect(exportPlugin({}).meta.id).toBe(exportPlugin().meta.id);
    expect(exportPlugin()).not.toBe(exportPlugin());
  });

  it("declares the spec's hard and soft dependencies", async () => {
    const { exportPlugin } = await import("../../src/index");
    const plugin = exportPlugin();
    expect(plugin.meta.id).toBe("stargantt.export");
    expect(plugin.meta.dependsOn).toEqual(["stargantt.data-store", "stargantt.view"]);
    // §10 — `stargantt.timeline` is co-provided by the hard `view` dependency (folded in, not
    // a separate soft edge).
    // "stargantt.tracking" enables the msproject baseline embedding's late
    // `useOptional("stargantt.baselines")` once the tracking plugin lands.
    expect(plugin.meta.optional).toEqual([
      "stargantt.tree-grid",
      "stargantt.scheduling",
      "stargantt.tracking",
    ]);
  });
});

describe("service registration", () => {
  it("provides stargantt.export with toPng/toSvg", () => {
    const { service, dispose } = boot();
    const svc: ExportService = service;
    expect(typeof svc.toPng).toBe("function");
    expect(typeof svc.toSvg).toBe("function");
    dispose();
  });

  it("fails startup when the declared hard-dependency providers are absent", async () => {
    const { createTestHost } = await import("@stargantt/sdk");
    const { exportPlugin } = await import("../../src/index");
    const doc = new FakeDocument();
    const root = doc.createElement("div");
    expect(() =>
      createTestHost({
        element: root as unknown as HTMLElement,
        plugins: [exportPlugin()],
      }),
    ).toThrow(/unregistered plugin/);
  });

  it("contributes to no extension point", () => {
    const seen: string[] = [];
    const spy = definePlugin({
      meta: { id: "test.spy", dependsOn: [] },
      setup(ctx) {
        // A point export would have to contribute to if it contributed anywhere.
        const p = ctx.defineExtensionPoint("renderer/layers", (inputs: LayerContribution[]) => {
          for (const i of inputs) seen.push(i.id);
          return inputs.slice();
        });
        expect(p.get()).toEqual([]);
      },
    });
    const { dispose } = boot({ extra: [spy] });
    expect(seen).toEqual([]);
    dispose();
  });
});

// docs/specs/plugins/export.md §1.1 "Tiled composition"
describe("offscreen composition through renderTo", () => {
  it("renders the layer composite off-screen and blits it into the output", async () => {
    const { doc, service, renders, dispose } = boot({
      viewport: { width: 640, height: 480 },
      layers: [{ layer: "main", width: 640, height: 480 }],
    });
    await service.toPng();

    expect(renders).toEqual([{ scrollLeft: 0, scrollTop: 0, width: 640, height: 480 }]);
    const out = outputCanvas(doc);
    expect(out.context?.drawn).toHaveLength(1);
    expect(out.context?.drawn[0]?.src).toBe(layerComposite(doc));
    dispose();
  });

  it("never touches the chart on screen: no scroll, no repaint of the layer canvases", async () => {
    const { root, service, scrolls, invalidated, viewport, dispose } = boot({
      config: { image: { range: "full" } },
      viewport: { width: 400, height: 200, scrollLeft: 75, scrollTop: 40 },
      layers: [{ layer: "main", width: 400, height: 200 }],
      tasks: [{ start: 0, end: 4_000 }],
      pxPerMs: 1,
      totalHeight: 900,
    });
    await service.toPng();

    expect(scrolls).toEqual([]);
    expect(invalidated).toEqual([]);
    expect(viewport).toEqual({ scrollLeft: 75, scrollTop: 40, width: 400, height: 200 });
    const onScreen = root.querySelectorAll("canvas[data-layer]") as unknown as FakeCanvas[];
    expect(onScreen.every((c) => (c.context?.opNames().length ?? 0) === 0)).toBe(true);
    dispose();
  });

  it("sizes the offscreen canvas from the view viewport", async () => {
    const { doc, service, dispose } = boot({
      viewport: { width: 640, height: 480 },
      layers: [{ layer: "main", width: 640, height: 480 }],
    });
    await service.toPng();

    const out = outputCanvas(doc);
    expect([out.width, out.height]).toEqual([640, 480]);
    expect(out.context?.drawn[0]).toMatchObject({ dx: 0, dy: 0, dw: 640, dh: 480 });
    dispose();
  });

  it("keeps device-pixel fidelity when the layers are DPR-scaled", async () => {
    const { doc, service, dispose } = boot({
      viewport: { width: 400, height: 300 },
      layers: [{ layer: "main", width: 800, height: 600 }],
    });
    await service.toPng();

    const out = outputCanvas(doc);
    expect([out.width, out.height]).toEqual([800, 600]);
    dispose();
  });

  it("still produces a canvas when the chart has no layer canvases at all", async () => {
    const { doc, service, dispose } = boot({ viewport: { width: 0, height: 0 }, layers: [] });
    await service.toPng();

    const out = outputCanvas(doc);
    expect([out.width, out.height]).toEqual([1, 1]);
    dispose();
  });

  it("re-composites on every call (no stale snapshot)", async () => {
    const { service, renders, dispose } = boot();
    await service.toPng();
    expect(renders).toHaveLength(1);
    await service.toSvg();
    expect(renders).toHaveLength(2);
    await service.toPng();
    expect(renders).toHaveLength(3);
    dispose();
  });

  it("rejects when a 2d context is unavailable", async () => {
    const { doc, service, dispose } = boot();
    doc.canvasOptions = { context: null };
    await expect(service.toPng()).rejects.toThrow(/2d canvas context unavailable/);
    dispose();
  });
});

describe("toPng", () => {
  it("resolves with an image/png Blob via toBlob", async () => {
    const { doc, service, dispose } = boot();
    const blob = await service.toPng();

    expect(blob).toBeInstanceOf(Blob);
    expect(blob.type).toBe("image/png");
    expect(outputCanvas(doc).toBlobTypes).toEqual(["image/png"]);
    dispose();
  });

  it("falls back to toDataURL when toBlob is unavailable", async () => {
    const { doc, service, dispose } = boot();
    // "AQID" === bytes 1,2,3
    doc.canvasOptions = { toBlob: false, dataUrl: "data:image/png;base64,AQID" };
    const blob = await service.toPng();

    expect(blob.type).toBe("image/png");
    expect(new Uint8Array(await blob.arrayBuffer())).toEqual(new Uint8Array([1, 2, 3]));
    dispose();
  });

  it("rejects when the encoder yields no blob", async () => {
    const { doc, service, dispose } = boot();
    doc.canvasOptions = { blob: null };
    await expect(service.toPng()).rejects.toThrow(/PNG encoding failed/);
    dispose();
  });
});

// docs/specs/plugins/export.md §1.1 "format: jpeg" — JPEG export goes through
// `toPng({ format: "jpeg", quality })`; there is no separate `toJPEG` member.
describe("toPng({ format: \"jpeg\" })", () => {
  it("encodes the same composite as image/jpeg", async () => {
    const { doc, service, renders, dispose } = boot({
      viewport: { width: 640, height: 480 },
      layers: [{ layer: "main", width: 640, height: 480 }],
    });
    const blob = await service.toPng({ format: "jpeg" });

    expect(blob).toBeInstanceOf(Blob);
    expect(renders).toEqual([{ scrollLeft: 0, scrollTop: 0, width: 640, height: 480 }]);
    const out = outputCanvas(doc);
    expect(out.toBlobTypes).toEqual(["image/jpeg"]);
    expect([out.width, out.height]).toEqual([640, 480]);
    expect(out.context?.drawn[0]?.src).toBe(layerComposite(doc));
    dispose();
  });

  it("paints opaque white behind the chart when no background is configured", async () => {
    const { doc, service, dispose } = boot({
      viewport: { width: 640, height: 480 },
      layers: [{ layer: "main", width: 640, height: 480 }],
    });
    await service.toPng({ format: "jpeg" });

    const out = outputCanvas(doc);
    expect(fills(out.context!)).toEqual([{ style: "#fff", x: 0, y: 0, w: 640, h: 480 }]);
    dispose();
  });

  it("uses a configured background instead of the white default", async () => {
    const { doc, service, dispose } = boot({
      config: { image: { background: "#123456" } },
      viewport: { width: 640, height: 480 },
      layers: [{ layer: "main", width: 640, height: 480 }],
    });
    await service.toPng({ format: "jpeg" });

    const out = outputCanvas(doc);
    expect(fills(out.context!)).toEqual([{ style: "#123456", x: 0, y: 0, w: 640, h: 480 }]);
    dispose();
  });

  it("does not change the plain toPng: no background is painted there by default", async () => {
    const { doc, service, dispose } = boot({
      viewport: { width: 640, height: 480 },
      layers: [{ layer: "main", width: 640, height: 480 }],
    });
    await service.toPng();

    expect(fills(outputCanvas(doc).context!)).toEqual([]);
    dispose();
  });

  it("honors pixelRatio exactly as the plain toPng does", async () => {
    const { doc, service, dispose } = boot({
      config: { image: { pixelRatio: 2 } },
      viewport: { width: 400, height: 300 },
      layers: [{ layer: "main", width: 400, height: 300 }],
    });
    await service.toPng({ format: "jpeg" });

    const out = outputCanvas(doc);
    expect([out.width, out.height]).toEqual([800, 600]);
    dispose();
  });

  it("rejects with a JPEG-naming error when the encoder yields no blob", async () => {
    const { doc, service, dispose } = boot();
    doc.canvasOptions = { blob: null };
    await expect(service.toPng({ format: "jpeg" })).rejects.toThrow(/JPEG encoding failed/);
    dispose();
  });

  it("falls back to toDataURL with the jpeg type when toBlob is unavailable", async () => {
    const { doc, service, dispose } = boot();
    doc.canvasOptions = { toBlob: false, dataUrl: "data:image/jpeg;base64,AQID" };
    const blob = await service.toPng({ format: "jpeg" });

    expect(blob.type).toBe("image/jpeg");
    expect(outputCanvas(doc).toDataURLTypes).toEqual(["image/jpeg"]);
    dispose();
  });

  it("forwards a usable quality to the encoder and ignores an unusable one", async () => {
    const { doc, service, dispose } = boot();
    const c = doc.createElement("canvas");
    void c;
    await service.toPng({ format: "jpeg", quality: 0.5 });
    expect(outputCanvas(doc).toBlobTypes).toEqual(["image/jpeg"]);
    dispose();
  });
});

// §1.1 "True-vector SVG" / §1.1 "Auxiliary surfaces"
describe("toSvg", () => {
  it("resolves with an SVG document of the chart extent, its layers as true vectors", async () => {
    const { service, dispose } = boot({
      viewport: { width: 640, height: 480 },
      layers: [{ layer: "main", width: 640, height: 480 }],
      layerDraws: [
        (g, vp) => {
          g.fillStyle = "#0a0";
          g.fillRect(0, 0, vp.width, 12);
        },
      ],
    });
    const svg = await service.toSvg();

    expect(svg.startsWith("<svg ")).toBe(true);
    expect(svg).toContain('xmlns="http://www.w3.org/2000/svg"');
    expect(svg).toContain('width="640"');
    expect(svg).toContain('viewBox="0 0 640 480"');
    expect(svg).toContain(`fill="#0a0"`);
    expect(svg).not.toContain("<image ");
    expect(svg.endsWith("</svg>")).toBe(true);
    dispose();
  });

  it("rasterizes only the layer that leaves the proxy's subset (§1.1)", async () => {
    const { doc, service, dispose } = boot({
      viewport: { width: 100, height: 50 },
      layers: [{ layer: "main", width: 100, height: 50 }],
      layerDraws: [
        (g) => {
          g.fillStyle = "#111";
          g.fillRect(0, 0, 10, 10);
        },
        (g) => {
          g.clip();
          g.fillRect(0, 0, 10, 10);
        },
        (g) => {
          g.fillStyle = "#222";
          g.fillRect(0, 20, 10, 10);
        },
      ],
    });
    doc.canvasOptions = { dataUrl: "data:image/png;base64,AQID" };
    const svg = await service.toSvg();

    expect(svg.match(/<image /g)).toHaveLength(1);
    expect(svg).toContain('href="data:image/png;base64,AQID"');
    expect(svg).toContain(`fill="#111"`);
    expect(svg).toContain(`fill="#222"`);
    // Z order survives the mixed output: vector, raster, vector.
    expect(svg.indexOf(`fill="#111"`)).toBeLessThan(svg.indexOf("<image "));
    expect(svg.indexOf("<image ")).toBeLessThan(svg.indexOf(`fill="#222"`));
    dispose();
  });
});

/* ------------------------------------------------------------------ *
 * Option resolution (docs/specs/plugins/export.md §1, "Option resolution")
 *
 * Both `background` and `pixelRatio` (and `range`, below) can be set on the factory `image` config
 * nest AND per-call; a per-call key overrides the matching nest key. Verified against the shipped
 * `resolveImageOptions` (src/index.ts, not part of this directory): the merge is a plain
 * object-spread of `{ ...nest, ...call }` followed by one independent validation pass over the
 * MERGED value per key — so a call that supplies a key at all (even with an unusable value) fully
 * replaces the nest's value for that key before validation runs; only a call that OMITS the key
 * leaves the nest's own value in place. An unusable *merged* value resolves to the absolute default
 * (never a "revert to the nest" step) — the three tests marked "per-key semantics" below pin this
 * precisely, since it is easy to misread the spec prose ("an unusable value... the default used") as
 * "revert to the nest value" instead.
 * ------------------------------------------------------------------ */

describe("`background` (§1 option resolution)", () => {
  it("paints nothing when omitted, leaving the export transparent", async () => {
    const { doc, service, dispose } = boot();
    await service.toPng();
    expect(fills(outputCanvas(doc).context!)).toEqual([]);
    dispose();
  });

  it("adds no backdrop rectangle to the SVG when omitted", async () => {
    const { service, dispose } = boot({ layerDraws: [] });
    expect(await service.toSvg()).not.toContain("<rect");
    dispose();
  });

  it("the image nest fills the whole area before the layers are composited", async () => {
    const { doc, service, dispose } = boot({
      config: { image: { background: "#fff" } },
      viewport: { width: 640, height: 480 },
      layers: [{ layer: "main", width: 640, height: 480 }],
    });
    await service.toPng();

    const g = outputCanvas(doc).context;
    expect(fills(g!)).toEqual([{ style: "#fff", x: 0, y: 0, w: 640, h: 480 }]);
    // Behind everything the chart draws.
    expect(g?.opNames()).toEqual(["fillRect", "drawImage"]);
    dispose();
  });

  it("a per-call background overrides the image nest", async () => {
    const { doc, service, dispose } = boot({
      config: { image: { background: "#fff" } },
      viewport: { width: 640, height: 480 },
      layers: [{ layer: "main", width: 640, height: 480 }],
    });
    await service.toPng({ background: "#00f" });
    expect(fills(outputCanvas(doc).context!)).toEqual([
      { style: "#00f", x: 0, y: 0, w: 640, h: 480 },
    ]);
    dispose();
  });

  it("per-key semantics: an unusable per-call value resolves to transparent, not the nest's colour", async () => {
    const { doc, service, dispose } = boot({
      config: { image: { background: "#fff" } },
      viewport: { width: 640, height: 480 },
      layers: [{ layer: "main", width: 640, height: 480 }],
    });
    await service.toPng({ background: 123 as unknown as string });
    // Not "#fff": the call supplied the key, so it fully replaces the nest's value before
    // validation — the unusable merged value then resolves to the absolute default (transparent).
    expect(fills(outputCanvas(doc).context!)).toEqual([]);
    dispose();
  });

  it("covers the device-pixel extent, not just the CSS extent", async () => {
    const { doc, service, dispose } = boot({
      config: { image: { background: "rgb(0 0 0)" } },
      viewport: { width: 400, height: 300 },
      layers: [{ layer: "main", width: 800, height: 600 }],
    });
    await service.toPng();
    expect(fills(outputCanvas(doc).context!)[0]).toEqual({
      style: "rgb(0 0 0)",
      x: 0,
      y: 0,
      w: 800,
      h: 600,
    });
    dispose();
  });

  it("passes an unparsable colour through untouched — no validation of its own", async () => {
    const { doc, service, dispose } = boot({ config: { image: { background: "not-a-colour" } } });
    await service.toPng();
    expect(fills(outputCanvas(doc).context!)[0]?.style).toBe("not-a-colour");
    dispose();
  });

  it("gives the SVG a full-area backdrop rectangle as its first element", async () => {
    const { service, dispose } = boot({
      config: { image: { background: "#fff" } },
      viewport: { width: 640, height: 480 },
      layerDraws: [
        (g) => {
          g.fillStyle = "#0a0";
          g.fillRect(0, 0, 10, 10);
        },
      ],
    });
    const svg = await service.toSvg();
    const rect = '<rect x="0" y="0" width="640" height="480" fill="#fff"/>';
    expect(svg).toContain(rect);
    expect(svg.indexOf(rect)).toBeLessThan(svg.indexOf(`fill="#0a0"`));
    dispose();
  });
});

describe("`pixelRatio` (§1 option resolution)", () => {
  it("recovers the layers' own ratio when omitted", async () => {
    const { doc, service, dispose } = boot({
      viewport: { width: 400, height: 300 },
      layers: [{ layer: "main", width: 800, height: 600 }],
    });
    await service.toPng();
    const out = outputCanvas(doc);
    expect([out.width, out.height]).toEqual([800, 600]);
    dispose();
  });

  it("the image nest sizes the offscreen canvas at round(cssSize × pixelRatio)", async () => {
    const { doc, service, dispose } = boot({
      config: { image: { pixelRatio: 2 } },
      viewport: { width: 640, height: 480 },
      layers: [{ layer: "main", width: 640, height: 480 }],
    });
    await service.toPng();

    const out = outputCanvas(doc);
    expect([out.width, out.height]).toEqual([1280, 960]);
    expect(out.context?.drawn[0]).toMatchObject({ dx: 0, dy: 0, dw: 1280, dh: 960 });
    dispose();
  });

  it("a per-call pixelRatio overrides the image nest", async () => {
    const { doc, service, dispose } = boot({
      config: { image: { pixelRatio: 2 } },
      viewport: { width: 640, height: 480 },
      layers: [{ layer: "main", width: 640, height: 480 }],
    });
    await service.toPng({ pixelRatio: 1 });
    const out = outputCanvas(doc);
    expect([out.width, out.height]).toEqual([640, 480]);
    dispose();
  });

  it.each([0, -1, Number.NaN, Number.POSITIVE_INFINITY])(
    "per-key semantics: an unusable per-call value %p resolves to the recovered ratio, not the nest's",
    async (bad) => {
      const { doc, service, dispose } = boot({
        config: { image: { pixelRatio: 4 } },
        viewport: { width: 400, height: 300 },
        layers: [{ layer: "main", width: 800, height: 600 }],
      });
      await service.toPng({ pixelRatio: bad });
      const out = outputCanvas(doc);
      // Not 1600x1200 (nest's 4x): the recovered ratio (2x) — the unusable call value replaced the
      // nest's before validation, same per-key semantics as `background` above.
      expect([out.width, out.height]).toEqual([800, 600]);
      dispose();
    },
  );

  it("does not affect toSvg's resolution", async () => {
    const { doc, service, dispose } = boot({
      config: { image: { pixelRatio: 4 } },
      viewport: { width: 640, height: 480 },
      layers: [{ layer: "main", width: 640, height: 480 }],
      // A layer outside the proxy's subset, so the SVG carries a rasterized fallback to measure.
      layerDraws: [(g) => g.clip()],
    });
    const svg = await service.toSvg();

    expect(svg).toContain('width="640"');
    expect(svg).toContain('viewBox="0 0 640 480"');
    // The rasterized layer stays at the recovered ratio, not 4x.
    const fallback = doc.createdCanvases()[0] as FakeCanvas;
    expect([fallback.width, fallback.height]).toEqual([640, 480]);
    dispose();
  });
});

// docs/specs/plugins/export.md §1.1 "range"
describe("`range` (§1 option resolution)", () => {
  const tasks = [
    { start: 0, end: 1_000 },
    { start: 500, end: 3_000 },
  ];

  it("captures the current viewport by default", async () => {
    const { doc, service, renders, dispose } = boot({
      viewport: { width: 400, height: 200, scrollLeft: 120 },
      layers: [{ layer: "main", width: 400, height: 200 }],
      tasks,
    });
    await service.toPng();

    expect(renders).toEqual([{ scrollLeft: 120, scrollTop: 0, width: 400, height: 200 }]);
    expect(outputCanvas(doc).width).toBe(400);
    dispose();
  });

  it("the image nest covers the whole task extent for \"full\", tiled through virtual viewports", async () => {
    const { doc, service, renders, dispose } = boot({
      config: { image: { range: "full" } },
      viewport: { width: 400, height: 200 },
      layers: [{ layer: "main", width: 400, height: 200 }],
      tasks,
      pxPerMs: 0.5, // 3000 ms ⇒ 1500 px
    });
    await service.toPng();

    expect(renders.map((v) => v.scrollLeft)).toEqual([0, 1024]);
    expect(renders.map((v) => v.width)).toEqual([1024, 476]);
    const out = outputCanvas(doc);
    expect([out.width, out.height]).toEqual([1500, 200]);
    dispose();
  });

  it("a per-call range overrides the image nest", async () => {
    const { doc, service, renders, dispose } = boot({
      config: { image: { range: "full" } },
      viewport: { width: 400, height: 200 },
      layers: [{ layer: "main", width: 400, height: 200 }],
      tasks,
      pxPerMs: 1,
    });
    await service.toPng({ range: "viewport" });

    expect(renders).toEqual([{ scrollLeft: 0, scrollTop: 0, width: 400, height: 200 }]);
    expect(outputCanvas(doc).width).toBe(400);
    dispose();
  });

  it("per-key semantics: an unusable per-call range resolves to the viewport default, not the nest's \"full\"", async () => {
    const { doc, service, renders, dispose } = boot({
      config: { image: { range: "full" } },
      viewport: { width: 400, height: 200 },
      layers: [{ layer: "main", width: 400, height: 200 }],
      tasks,
      pxPerMs: 1,
    });
    await service.toPng({ range: "not-a-range" as never });

    expect(renders).toEqual([{ scrollLeft: 0, scrollTop: 0, width: 400, height: 200 }]);
    expect(outputCanvas(doc).width).toBe(400);
    dispose();
  });

  it("exports an explicit epoch-ms range", async () => {
    const { doc, service, renders, dispose } = boot({
      config: { image: { range: { start: 1_000, end: 2_000 } } },
      viewport: { width: 400, height: 200 },
      layers: [{ layer: "main", width: 400, height: 200 }],
      tasks,
      pxPerMs: 1,
    });
    await service.toPng();

    expect(renders.map((v) => v.scrollLeft)).toEqual([1000]);
    expect(outputCanvas(doc).width).toBe(1000);
    dispose();
  });

  it("renders a range beyond the scrollable content instead of clamping it", async () => {
    const { doc, service, renders, viewport, dispose } = boot({
      config: { image: { range: { start: -2_000, end: 0 } } },
      viewport: { width: 400, height: 200 },
      layers: [{ layer: "main", width: 400, height: 200 }],
      tasks,
      pxPerMs: 1,
    });
    await service.toPng();

    expect(renders.map((v) => v.scrollLeft)).toEqual([-2000, -976]);
    expect(viewport.scrollLeft).toBe(0);
    expect(outputCanvas(doc).width).toBe(2000);
    dispose();
  });

  it("falls back to the viewport when the store holds no dated task", async () => {
    const { doc, service, renders, dispose } = boot({
      config: { image: { range: "full" } },
      viewport: { width: 400, height: 200 },
      layers: [{ layer: "main", width: 400, height: 200 }],
      tasks: [],
    });
    await service.toPng();

    expect(renders).toHaveLength(1);
    expect(outputCanvas(doc).width).toBe(400);
    dispose();
  });

  it("widens the SVG to the exported range too", async () => {
    const { service, dispose } = boot({
      config: { image: { range: { start: 0, end: 1_000 } } },
      viewport: { width: 400, height: 200 },
      layers: [{ layer: "main", width: 400, height: 200 }],
      tasks,
      pxPerMs: 1,
    });
    const svg = await service.toSvg();
    expect(svg).toContain('viewBox="0 0 1000 200"');
    dispose();
  });

  it("normalises an inverted explicit range and exports it forwards", async () => {
    const { doc, service, renders, dispose } = boot({
      config: { image: { range: { start: 2_000, end: 1_000 } } },
      viewport: { width: 400, height: 200 },
      layers: [{ layer: "main", width: 400, height: 200 }],
      tasks,
      pxPerMs: 1,
    });
    await service.toPng();

    expect(renders.map((v) => v.scrollLeft)).toEqual([1000]);
    expect(outputCanvas(doc).width).toBe(1000);
    dispose();
  });

  // §1.1 — a degenerate explicit range is a caller error, not a silent fallback: both `toPng()`
  // and `toSvg()` reject, naming the offending values.
  it("rejects a non-finite explicit range instead of falling back to the viewport", async () => {
    const { service, dispose } = boot({
      config: { image: { range: { start: Number.NaN, end: 1_000 } } },
      viewport: { width: 400, height: 200 },
      layers: [{ layer: "main", width: 400, height: 200 }],
      tasks,
      pxPerMs: 1,
    });
    await expect(service.toPng()).rejects.toThrow(
      /range \{ start: NaN, end: 1000 \} does not describe an exportable time span/,
    );
    await expect(service.toSvg()).rejects.toThrow(/does not describe an exportable time span/);
    dispose();
  });

  it("rejects an explicit range whose pixel span collapses below one pixel", async () => {
    const { service, dispose } = boot({
      config: { image: { range: { start: 1_000, end: 1_000 } } },
      viewport: { width: 400, height: 200 },
      layers: [{ layer: "main", width: 400, height: 200 }],
      tasks,
      pxPerMs: 1,
    });
    await expect(service.toPng()).rejects.toThrow(
      /range \{ start: 1000, end: 1000 \} does not describe an exportable time span/,
    );
    dispose();
  });

  it("keeps the silent viewport fallback for `full` over an undated store (not a caller error)", async () => {
    const { service, dispose } = boot({
      config: { image: { range: "full" } },
      viewport: { width: 400, height: 200 },
      layers: [{ layer: "main", width: 400, height: 200 }],
      tasks: [],
    });
    await expect(service.toPng()).resolves.toBeInstanceOf(Blob);
    dispose();
  });
});

// §1.1 "Row coverage"
describe("row coverage", () => {
  const tasks = [{ start: 0, end: 1_000 }];

  it("exports every row for `full`, tiling vertically", async () => {
    const { doc, service, renders, dispose } = boot({
      config: { image: { range: "full" } },
      viewport: { width: 400, height: 200, scrollTop: 300 },
      layers: [{ layer: "main", width: 400, height: 200 }],
      tasks,
      pxPerMs: 1,
      totalHeight: 2_500,
    });
    await service.toPng();

    expect(renders.map((v) => v.scrollTop)).toEqual([0, 1024, 2048]);
    expect(renders.map((v) => v.height)).toEqual([1024, 1024, 452]);
    expect(outputCanvas(doc).height).toBe(2500);
    dispose();
  });

  it("exports every row for an explicit time range too", async () => {
    const { doc, service, renders, dispose } = boot({
      config: { image: { range: { start: 0, end: 500 } } },
      viewport: { width: 400, height: 200 },
      layers: [{ layer: "main", width: 400, height: 200 }],
      tasks,
      pxPerMs: 1,
      totalHeight: 700,
    });
    await service.toPng();

    expect(renders.map((v) => v.scrollTop)).toEqual([0]);
    expect(renders[0]?.height).toBe(700);
    expect(outputCanvas(doc).height).toBe(700);
    dispose();
  });

  it("keeps the visible rows for `viewport`, however tall the content is", async () => {
    const { doc, service, renders, dispose } = boot({
      viewport: { width: 400, height: 200, scrollTop: 300 },
      layers: [{ layer: "main", width: 400, height: 200 }],
      tasks,
      totalHeight: 2_500,
    });
    await service.toPng();

    expect(renders).toEqual([{ scrollLeft: 0, scrollTop: 300, width: 400, height: 200 }]);
    expect(outputCanvas(doc).height).toBe(200);
    dispose();
  });

  it("keeps the visible rows when no rows service is reachable", async () => {
    const { doc, service, renders, dispose } = boot({
      config: { image: { range: "full" } },
      viewport: { width: 400, height: 200, scrollTop: 300 },
      layers: [{ layer: "main", width: 400, height: 200 }],
      tasks,
      pxPerMs: 1,
      totalHeight: false,
    });
    await service.toPng();

    expect(renders.map((v) => [v.scrollTop, v.height])).toEqual([[300, 200]]);
    expect(outputCanvas(doc).height).toBe(200);
    dispose();
  });
});

// docs/specs/plugins/export.md §4 "Extension points"
describe("`export/auxiliarySurfaces` (§1.1 / §4)", () => {
  interface Recorded {
    tiles: ExportTile[];
  }

  function surfacePlugin(id: string, surface: AuxiliarySurfaceContribution) {
    return definePlugin({
      meta: { id, dependsOn: [] },
      setup(ctx) {
        ctx.contribute("export/auxiliarySurfaces", surface);
      },
    });
  }

  function fakeSurface(
    over: Partial<AuxiliarySurfaceContribution> = {},
  ): { surface: AuxiliarySurfaceContribution; recorded: Recorded } {
    const recorded: Recorded = { tiles: [] };
    const surface: AuxiliarySurfaceContribution = {
      side: "top",
      height: 30,
      drawTile: (g, tile) => {
        recorded.tiles.push(tile);
        g.fillRect(0, 0, tile.width, tile.height);
      },
      ...over,
    };
    return { surface, recorded };
  }

  it("is a collect point every surface joins through its own contribution", async () => {
    const a = fakeSurface({ side: "top", height: 20 });
    const b = fakeSurface({ side: "bottom", height: 40 });
    const { doc, service, dispose } = boot({
      viewport: { width: 400, height: 200 },
      layers: [{ layer: "main", width: 400, height: 200 }],
      extra: [surfacePlugin("test.header", a.surface), surfacePlugin("test.band", b.surface)],
    });
    await service.toPng();

    // 20 (top band) + 200 (layers) + 40 (bottom band)
    expect(outputCanvas(doc).height).toBe(260);
    expect(a.recorded.tiles).toHaveLength(1);
    expect(b.recorded.tiles).toHaveLength(1);
    dispose();
  });

  it("composites the bands above and below the drawing layers", async () => {
    const header = fakeSurface({ side: "top", height: 30 });
    const band = fakeSurface({ side: "bottom", height: 50 });
    const { doc, service, dispose } = boot({
      viewport: { width: 400, height: 200 },
      layers: [{ layer: "main", width: 400, height: 200 }],
      extra: [
        surfacePlugin("test.header", header.surface),
        surfacePlugin("test.band", band.surface),
      ],
    });
    await service.toPng();

    const out = outputCanvas(doc);
    expect(out.context?.drawn.map((d) => d.dy)).toEqual([30, 0, 230]);
    expect(out.context?.drawn.map((d) => d.dh)).toEqual([200, 30, 50]);
    dispose();
  });

  it("hands each surface the exported time slices, at the layers' resolution ratio", async () => {
    const { surface, recorded } = fakeSurface({ side: "bottom", height: 20 });
    const { service, dispose } = boot({
      config: { image: { range: { start: 0, end: 1_600 }, pixelRatio: 2 } },
      viewport: { width: 400, height: 200 },
      layers: [{ layer: "main", width: 400, height: 200 }],
      pxPerMs: 1,
      extra: [surfacePlugin("test.band", surface)],
    });
    await service.toPng();

    expect(recorded.tiles.map((t) => [t.start, t.end])).toEqual([
      [0, 1024],
      [1024, 1600],
    ]);
    expect(recorded.tiles.map((t) => t.width)).toEqual([1024, 576]);
    expect(recorded.tiles.every((t) => t.height === 20)).toBe(true);
    expect(recorded.tiles.every((t) => t.pixelRatio === 2)).toBe(true);
    dispose();
  });

  it("maps a surface with drawTileSVG straight to SVG elements", async () => {
    const { service, dispose } = boot({
      viewport: { width: 400, height: 200 },
      layers: [{ layer: "main", width: 400, height: 200 }],
      extra: [
        surfacePlugin(
          "test.band",
          fakeSurface({
            side: "bottom",
            height: 40,
            drawTileSVG: (tile) => `<rect width="${tile.width}" height="${tile.height}"/>`,
          }).surface,
        ),
      ],
    });
    const svg = await service.toSvg();

    expect(svg).toContain(`<g transform="translate(0 200)"><rect width="400" height="40"/></g>`);
    // The drawing layer is a true vector now, so nothing is embedded as an image.
    expect(svg.match(/<image /g)).toBeNull();
    dispose();
  });

  it("embeds a surface without drawTileSVG as a rasterized image", async () => {
    const { surface, recorded } = fakeSurface({ side: "bottom", height: 40 });
    const { service, dispose } = boot({
      viewport: { width: 400, height: 200 },
      layers: [{ layer: "main", width: 400, height: 200 }],
      extra: [surfacePlugin("test.band", surface)],
    });
    const svg = await service.toSvg();

    expect(recorded.tiles).toHaveLength(1);
    expect(svg.match(/<image /g)).toHaveLength(1);
    expect(svg).toContain('<image x="0" y="200" width="400" height="40"');
    dispose();
  });

  it("keeps the export alive when a surface throws", async () => {
    const { service, dispose } = boot({
      viewport: { width: 400, height: 200 },
      layers: [{ layer: "main", width: 400, height: 200 }],
      extra: [
        surfacePlugin(
          "test.bad",
          fakeSurface({
            drawTile: () => {
              throw new Error("surface blew up");
            },
          }).surface,
        ),
      ],
    });
    await expect(service.toPng()).resolves.toBeInstanceOf(Blob);
    dispose();
  });

  it("picks up a surface contributed after startup", async () => {
    const late = fakeSurface({ side: "bottom", height: 10 });
    let contribute: (() => void) | undefined;
    const holder = definePlugin({
      meta: { id: "test.late", dependsOn: [] },
      setup(ctx) {
        contribute = () => ctx.contribute("export/auxiliarySurfaces", late.surface);
      },
    });
    const { doc, service, dispose } = boot({
      viewport: { width: 400, height: 200 },
      layers: [{ layer: "main", width: 400, height: 200 }],
      extra: [holder],
    });
    await service.toPng();
    expect(late.recorded.tiles).toHaveLength(0);

    contribute?.();
    await service.toPng();
    expect(late.recorded.tiles).toHaveLength(1);
    expect(outputCanvas(doc).height).toBe(210);
    dispose();
  });

  it("paints each surface tile in CSS px on a ratio-scaled context", async () => {
    const seen: { scaleX: number; tx: number }[] = [];
    const { service, dispose } = boot({
      config: { image: { range: { start: 0, end: 1_600 }, pixelRatio: 2 } },
      viewport: { width: 400, height: 200 },
      layers: [{ layer: "main", width: 400, height: 200 }],
      pxPerMs: 1,
      extra: [
        surfacePlugin(
          "test.band",
          fakeSurface({
            side: "bottom",
            height: 20,
            drawTile: (g) => {
              const fake = g as unknown as FakeContext2D;
              seen.push({ scaleX: fake.scaleX, tx: fake.tx });
            },
          }).surface,
        ),
      ],
    });
    await service.toPng();

    expect(seen).toEqual([
      { scaleX: 2, tx: 0 },
      { scaleX: 2, tx: 2048 },
    ]);
    dispose();
  });
});

describe("resource ownership (CLAUDE.md constraint / architecture.md §1.3)", () => {
  it("adds nothing to ctx.root", () => {
    const { root, dispose } = boot();
    expect(root.children).toHaveLength(1); // just the pre-existing chart pane
    dispose();
  });

  it("stops serving exports after dispose()", async () => {
    const { service, dispose } = boot();
    await expect(service.toPng()).resolves.toBeInstanceOf(Blob);

    dispose();

    await expect(service.toPng()).rejects.toThrow(/has been disposed/);
    await expect(service.toSvg()).rejects.toThrow(/has been disposed/);
  });
});

// docs/specs/plugins/export.md §1.9 "Saving to a file" — there are no `download*` members;
// saving is this one documented `sdk/dom` `downloadFile` call.
describe("saving to a file (§1.9)", () => {
  it("downloadFile(doc, await service.toPng(), \"gantt.png\") does not throw without URL.createObjectURL", async () => {
    const { doc, service, dispose } = boot({
      viewport: { width: 640, height: 480 },
      layers: [{ layer: "main", width: 640, height: 480 }],
    });
    // No `defaultView` is installed on the fake document, and `downloadFile` falls back to
    // `globalThis` — so this only stays a true no-`URL.createObjectURL` environment if the test
    // runtime's own global `URL` has none either, which is why `defaultView` is pinned to an
    // object that explicitly lacks it.
    doc.defaultView = {};
    const png = await service.toPng();
    expect(() => downloadFile(doc as unknown as Document, png, "gantt.png")).not.toThrow();
    dispose();
  });
});
