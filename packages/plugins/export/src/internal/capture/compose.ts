// docs/specs/plugins/export.md §9 — the published surface is only the plugin's service value, its
// public types and its `declare module` augmentation; this module is not part of it.
/**
 * Internal offscreen-composition helpers for the image-capture area of `stargantt.export`.
 *
 * Not part of the package's published surface — these helpers exist so the composition can be
 * unit-tested without booting a full chart.
 */

import { escapeAttr } from "./xml";

// docs/specs/plugins/view.md §1 / §3 — the render module's `data-layer` values.
/**
 * The renderer's three `data-layer` values, back to front. Any other canvas keeps DOM order
 * after these.
 */
export const LAYER_ORDER: readonly string[] = ["background", "main", "overlay"];

/**
 * Collects the renderer's layer canvases from below `root`, back to front.
 *
 * Ordering is by the `data-layer` attribute; unknown values sort last in DOM order, matching the
 * order the renderer composites them in.
 */
export function layerCanvases(root: HTMLElement): HTMLCanvasElement[] {
  // These canvases are read for their **size only** — the pixel ratio the chart is currently drawn
  // at (§1.1). Their bitmaps are never composited: every exported pixel comes from
  // `ViewService.renderTo` instead (§1.1 "Tiled composition").
  const found = Array.from(
    root.querySelectorAll("canvas[data-layer]"),
  ) as unknown as HTMLCanvasElement[];
  const rank = (c: HTMLCanvasElement): number => {
    const i = LAYER_ORDER.indexOf(c.getAttribute("data-layer") ?? "");
    return i < 0 ? LAYER_ORDER.length : i;
  };
  return found
    .map((c, i) => ({ c, i }))
    .sort((a, b) => rank(a.c) - rank(b.c) || a.i - b.i)
    .map((x) => x.c);
}

/**
 * The device-pixel ratio the layer backing stores are drawn at, as recovered from their sizes.
 *
 * Each canvas's own on-screen CSS width — its `getBoundingClientRect().width`, falling back to
 * `clientWidth` — is what the ratio is derived against, not the chart's outer viewport width: a
 * layer canvas embedded in a pane narrower than the viewport (a sidebar, a split view) would
 * otherwise recover an inflated ratio. Falls back to `1` when no layer yields a usable number (no
 * canvas at all, a zero-width one, or a canvas with no measurable on-screen width).
 */
export function recoverRatio(canvases: readonly HTMLCanvasElement[]): number {
  let ratio = 0;
  for (const c of canvases) {
    const cssWidth = c.clientWidth || c.getBoundingClientRect().width;
    if (cssWidth > 0) ratio = Math.max(ratio, c.width / cssWidth);
  }
  return ratio > 0 && Number.isFinite(ratio) ? ratio : 1;
}

/**
 * The image-pixels-per-CSS-pixel ratio an export runs at.
 *
 * §1.1 — a configured ratio replaces the recovered one; an unusable value (not finite, or not > 0)
 * falls back to the recovered ratio.
 */
export function effectiveRatio(canvases: readonly HTMLCanvasElement[], wanted?: number): number {
  return wanted !== undefined && Number.isFinite(wanted) && wanted > 0
    ? wanted
    : recoverRatio(canvases);
}

/** An offscreen canvas of `cssWidth × cssHeight` at `ratio` device pixels per CSS pixel. */
export function offscreen(
  doc: Document,
  cssWidth: number,
  cssHeight: number,
  ratio: number,
): HTMLCanvasElement {
  const c = doc.createElement("canvas");
  c.width = Math.max(1, Math.round(cssWidth * ratio));
  c.height = Math.max(1, Math.round(cssHeight * ratio));
  return c;
}

/** The 2d context of `canvas`, or a thrown error when the host cannot supply one. */
export function context2d(canvas: HTMLCanvasElement): CanvasRenderingContext2D {
  const g = canvas.getContext("2d");
  if (g === null) throw new Error("stargantt.export: 2d canvas context unavailable");
  return g;
}

/** A raster MIME type the export can encode to. */
export type RasterType = "image/png" | "image/jpeg";

/**
 * `HTMLCanvasElement.toBlob` where available, otherwise a `toDataURL` round-trip.
 *
 * `type` selects the encoder (PNG by default); `quality` is forwarded to the encoder untouched
 * and is only meaningful for lossy types — the caller sanitises it.
 */
export function canvasToBlob(
  canvas: HTMLCanvasElement,
  type: RasterType = "image/png",
  quality?: number,
): Promise<Blob> {
  const label = type === "image/jpeg" ? "JPEG" : "PNG";
  if (typeof canvas.toBlob === "function") {
    return new Promise<Blob>((resolve, reject) => {
      canvas.toBlob(
        (blob) => {
          if (blob === null) {
            reject(new Error(`stargantt.export: ${label} encoding failed`));
          } else resolve(blob);
        },
        type,
        quality,
      );
    });
  }
  return Promise.resolve(dataUrlToBlob(canvas.toDataURL(type, quality)));
}

export function dataUrlToBlob(url: string): Blob {
  const comma = url.indexOf(",");
  if (comma < 0) throw new Error("stargantt.export: PNG encoding failed");
  const meta = url.slice(0, comma);
  const body = url.slice(comma + 1);
  const type = /^data:([^;,]*)/.exec(meta)?.[1] || "image/png";
  if (!meta.includes(";base64")) {
    // `canvasToBlob`'s `toDataURL` round-trip — this function's only caller — always encodes
    // base64; a non-base64 data URL is a state this function should never actually reach, so it
    // is rejected outright rather than silently decoded through a dead fallback path.
    throw new Error("stargantt.export: unsupported data URL encoding");
  }
  const bin = atob(body);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i += 1) bytes[i] = bin.charCodeAt(i);
  return new Blob([bytes], { type });
}

/** An `<image>` element carrying `href` over the given box. */
export function svgImage(
  x: number,
  y: number,
  width: number,
  height: number,
  href: string,
): string {
  const h = escapeAttr(href);
  return (
    `<image x="${x}" y="${y}" width="${width}" height="${height}"` +
    ` href="${h}" xlink:href="${h}"/>`
  );
}

/**
 * An SVG document of the exported extent wrapping the already-composed `body` elements.
 *
 * When a background colour is given, a full-area rectangle in that colour is the document's first
 * element, so it sits behind everything the chart draws.
 */
export function svgDocument(
  width: number,
  height: number,
  body: string,
  background?: string,
): string {
  // §1.1 — the backdrop rectangle is the SVG equivalent of the raster fill; the colour is emitted
  // as given (escaped only for XML safety).
  const backdrop =
    background === undefined
      ? ""
      : `<rect x="0" y="0" width="${width}" height="${height}" fill="${escapeAttr(background)}"/>`;
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink"` +
    ` width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">` +
    backdrop +
    body +
    `</svg>`
  );
}
