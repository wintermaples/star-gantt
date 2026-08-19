import { describe, expect, it } from "vitest";
import {
  LAYER_ORDER,
  canvasToBlob,
  context2d,
  dataUrlToBlob,
  effectiveRatio,
  layerCanvases,
  offscreen,
  recoverRatio,
  svgDocument,
  svgImage,
} from "../../src/internal/capture/compose";
import { FakeCanvas, FakeDocument, asCanvas, asDocument, asElement } from "./_boot";
import { makeRoot } from "./_boot";

describe("LAYER_ORDER", () => {
  it("is the back-to-front canvas order (docs/specs/plugins/view.md §1)", () => {
    expect(LAYER_ORDER).toEqual(["background", "main", "overlay"]);
  });
});

describe("layerCanvases", () => {
  it("returns an empty list when the root holds no layer canvases", () => {
    const doc = new FakeDocument();
    expect(layerCanvases(asElement(makeRoot(doc, [])))).toEqual([]);
  });

  it("ignores canvases without a data-layer attribute", () => {
    const doc = new FakeDocument();
    const root = makeRoot(doc, [{ layer: "main", width: 10, height: 10 }]);
    root.appendChild(new FakeCanvas("CANVAS", doc));
    const found = layerCanvases(asElement(root));
    expect(found).toHaveLength(1);
    expect(found[0]?.getAttribute("data-layer")).toBe("main");
  });

  it("orders the built-in layers back to front and keeps unknown ones last", () => {
    const doc = new FakeDocument();
    const root = makeRoot(doc, [
      { layer: "overlay", width: 10, height: 10 },
      { layer: "custom", width: 10, height: 10 },
      { layer: "background", width: 10, height: 10 },
      { layer: "main", width: 10, height: 10 },
    ]);
    expect(layerCanvases(asElement(root)).map((c) => c.getAttribute("data-layer"))).toEqual([
      "background",
      "main",
      "overlay",
      "custom",
    ]);
  });
});

// docs/specs/plugins/export.md §1.1
describe("recoverRatio / effectiveRatio", () => {
  function canvasOfWidth(doc: FakeDocument, backingWidth: number, cssWidth = 100): HTMLCanvasElement {
    const c = new FakeCanvas("CANVAS", doc);
    c.width = backingWidth;
    c.rect = { left: 0, top: 0, width: cssWidth, height: 0 };
    return asCanvas(c);
  }

  it("takes the largest layer ratio", () => {
    const doc = new FakeDocument();
    expect(recoverRatio([canvasOfWidth(doc, 100), canvasOfWidth(doc, 250)])).toBe(2.5);
  });

  it("falls back to 1 with no layers, or with a zero-width one", () => {
    const doc = new FakeDocument();
    expect(recoverRatio([])).toBe(1);
    expect(recoverRatio([canvasOfWidth(doc, 0)])).toBe(1);
  });

  it("falls back to 1 when the canvas has no measurable on-screen width", () => {
    const doc = new FakeDocument();
    expect(recoverRatio([canvasOfWidth(doc, 200, 0)])).toBe(1);
  });

  // A pane narrower than the viewport (a sidebar, a split view) must not inflate the ratio.
  it("derives the ratio from the canvas's own bounding-rect width, not a wider viewport", () => {
    const doc = new FakeDocument();
    // A 300px-wide backing store behind a 60px-wide on-screen pane (embedded in a narrow
    // sidebar), while some much wider viewport (e.g. 1000px) exists elsewhere: the ratio must
    // come out as 300/60 = 5, not 300/1000 = 0.3.
    const narrowPane = canvasOfWidth(doc, 300, 60);
    expect(recoverRatio([narrowPane])).toBe(5);
  });

  it("prefers a usable configured ratio and ignores an unusable one", () => {
    const doc = new FakeDocument();
    const layers = [canvasOfWidth(doc, 200)];
    expect(effectiveRatio(layers, 3)).toBe(3);
    expect(effectiveRatio(layers, 0)).toBe(2);
    expect(effectiveRatio(layers, Number.NaN)).toBe(2);
    expect(effectiveRatio(layers, undefined)).toBe(2);
  });
});

describe("offscreen / context2d", () => {
  it("sizes the bitmap in device px and never goes below 1x1", () => {
    const doc = new FakeDocument();
    expect([offscreen(asDocument(doc), 10.4, 0, 2).width, offscreen(asDocument(doc), 10.4, 0, 2).height]).toEqual(
      [21, 1],
    );
  });

  it("throws when the host yields no 2d context", () => {
    const doc = new FakeDocument();
    doc.canvasOptions = { context: null };
    expect(() => context2d(offscreen(asDocument(doc), 10, 10, 1))).toThrow(
      /2d canvas context unavailable/,
    );
  });
});

describe("canvasToBlob", () => {
  it("prefers toBlob and requests image/png", async () => {
    const doc = new FakeDocument();
    const c = doc.createElement("canvas") as FakeCanvas;
    const blob = await canvasToBlob(asCanvas(c));
    expect(blob.type).toBe("image/png");
    expect(c.toBlobTypes).toEqual(["image/png"]);
    expect(c.toDataURLTypes).toEqual([]);
  });

  it("rejects when toBlob hands back null", async () => {
    const doc = new FakeDocument();
    doc.canvasOptions = { blob: null };
    const c = doc.createElement("canvas") as FakeCanvas;
    await expect(canvasToBlob(asCanvas(c))).rejects.toThrow(/PNG encoding failed/);
  });

  it("falls back to toDataURL", async () => {
    const doc = new FakeDocument();
    doc.canvasOptions = { toBlob: false };
    const c = doc.createElement("canvas") as FakeCanvas;
    await canvasToBlob(asCanvas(c));
    expect(c.toDataURLTypes).toEqual(["image/png"]);
  });

  // docs/specs/plugins/export.md §1.1 "format: jpeg"
  it("forwards the jpeg type and quality to toBlob", async () => {
    const doc = new FakeDocument();
    const c = doc.createElement("canvas") as FakeCanvas;
    const seen: unknown[][] = [];
    c.toBlob = (cb, ...rest): void => {
      seen.push(rest);
      cb(new Blob([new Uint8Array([1])], { type: "image/jpeg" }));
    };
    const blob = await canvasToBlob(asCanvas(c), "image/jpeg", 0.5);
    expect(blob.type).toBe("image/jpeg");
    expect(seen).toEqual([["image/jpeg", 0.5]]);
  });

  it("names JPEG in the encoding-failure rejection", async () => {
    const doc = new FakeDocument();
    doc.canvasOptions = { blob: null };
    const c = doc.createElement("canvas") as FakeCanvas;
    await expect(canvasToBlob(asCanvas(c), "image/jpeg")).rejects.toThrow(/JPEG encoding failed/);
  });
});

describe("dataUrlToBlob", () => {
  it("decodes base64 payloads", async () => {
    const blob = dataUrlToBlob("data:image/png;base64,AQID");
    expect(blob.type).toBe("image/png");
    expect(new Uint8Array(await blob.arrayBuffer())).toEqual(new Uint8Array([1, 2, 3]));
  });

  it("rejects a non-base64 (e.g. percent-encoded) data URL instead of silently decoding it", () => {
    expect(() => dataUrlToBlob("data:image/svg+xml,%3Csvg%2F%3E")).toThrow(
      /unsupported data URL encoding/,
    );
  });

  it("defaults the media type", () => {
    expect(dataUrlToBlob("data:;base64,AQID").type).toBe("image/png");
  });

  it("throws on a malformed data URL", () => {
    expect(() => dataUrlToBlob("not-a-data-url")).toThrow(/PNG encoding failed/);
  });
});

describe("svgImage / svgDocument", () => {
  it("emits both href and xlink:href for a bitmap", () => {
    const svg = svgDocument(4, 2, svgImage(0, 0, 4, 2, "data:image/png;base64,AQID"));
    expect(svg).toContain('href="data:image/png;base64,AQID"');
    expect(svg).toContain('xlink:href="data:image/png;base64,AQID"');
    expect(svg).toContain('viewBox="0 0 4 2"');
  });

  it("escapes XML-significant characters in the href", () => {
    expect(svgImage(0, 0, 1, 1, 'a&b<c>d"e')).toContain('href="a&amp;b&lt;c&gt;d&quot;e"');
  });

  it("emits no backdrop rectangle without a background", () => {
    expect(svgDocument(10, 5, "<g/>")).not.toContain("<rect");
  });

  it("emits the backdrop rectangle before the body", () => {
    const svg = svgDocument(10, 5, svgImage(0, 0, 10, 5, "u"), "#fff");
    expect(svg).toContain('<rect x="0" y="0" width="10" height="5" fill="#fff"/>');
    expect(svg.indexOf("<rect")).toBeLessThan(svg.indexOf("<image"));
  });

  it("escapes a background value that would break the attribute", () => {
    expect(svgDocument(10, 5, "", 'a"b')).toContain('fill="a&quot;b"');
  });
});
