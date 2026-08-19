// docs/specs/plugins/export.md
/**
 * `@stargantt/plugin-export` — plugin id `stargantt.export`.
 *
 * Six former plugins (export-image, export-print, import-export, msproject-io, excel-io,
 * viewer-embed) merged into one Layer-8 facade: `stargantt.export` → `ExportService`. Everything
 * is pull-driven and on-demand — no layer contribution, no per-frame work, nothing resident in the
 * render pipeline. It defines one extension point (`export/auxiliarySurfaces`) and contributes to
 * none.
 *
 * `setup()` is wiring only: each former plugin's decisions live in an `internal/` area that can be
 * exercised without booting a host — the `capture` and `print` areas, plus the remaining four
 * (`formats`, `msproject`, `excel`, `embed`), each wired through its own `wire.ts` seam.
 */
import { collect, definePlugin } from "@stargantt/core";
import type { Plugin, PluginContext } from "@stargantt/core";
// Type-only: they load the sibling packages' `declare module "@stargantt/core"` augmentations, so
// every service key and extension point below is checked against the real key spaces. Erased at
// emit — no runtime dependency is added.
import type { TaskId } from "@stargantt/plugin-data-store";
import type {} from "@stargantt/plugin-view";
import type {} from "@stargantt/plugin-tree-grid";
import type { CriticalPathService } from "@stargantt/plugin-scheduling";
import { resolveConfig } from "./config";
import type { ExportConfig } from "./config";
import { resolveMessages } from "./internal/messages";
import { DISPOSED_MESSAGE } from "./internal/wiring";
import type { ExportWiring } from "./internal/wiring";
import { wireEmbed } from "./internal/embed/wire";
import { wireExcel } from "./internal/excel/wire";
import { wireFormats } from "./internal/formats/wire";
import { wireMsProject } from "./internal/msproject/wire";
import {
  captureLayers,
  captureLayersSVG,
  captureSurface,
  layout,
  surfaceSVG,
} from "./internal/capture/capture";
import type { CaptureDeps } from "./internal/capture/capture";
import {
  canvasToBlob,
  context2d,
  effectiveRatio,
  layerCanvases,
  offscreen,
  svgDocument,
  svgImage,
} from "./internal/capture/compose";
import { planRange, taskExtent } from "./internal/capture/range";
import type { RangePlan } from "./internal/capture/range";
import { resolveOptions } from "./internal/print/layout";
import { createPrintPreview } from "./internal/print/preview";
import type { PrintPreview } from "./internal/print/preview";
import { encodePdf, prepare, renderPages } from "./internal/print/render";
import type { PrintEnv, PrintTask } from "./internal/print/render";
import type {
  AuxiliarySurfaceContribution,
  ExportRange,
  ExportService,
  ImageCaptureConfig,
  PrintOptions,
  RasterOptions,
} from "./types";

export type {
  AuxiliarySurfaceContribution,
  BaselineInit,
  CsvExportOptions,
  CsvImportOptions,
  CsvMapping,
  ExportRange,
  ExportService,
  ExportTile,
  ICalExportOptions,
  ImageCaptureConfig,
  ImportApplyCause,
  ImportApplyResult,
  ImportChange,
  ImportDocument,
  ImportIssue,
  ImportOptions,
  ImportResult,
  JsonImportOptions,
  MsProjectApplyResult,
  MsProjectBaseline,
  MsProjectDocument,
  MsProjectExportOptions,
  MsProjectImportOptions,
  MsProjectImportResult,
  MsProjectIssue,
  PrintColumnId,
  PrintLegendEntry,
  PrintOptions,
  PrintPageInfo,
  PrintText,
  RasterOptions,
  ReadOnlyCause,
  SnapshotOptions,
  SnapshotSource,
  TaskCsvField,
  XlsxExportOptions,
} from "./types";
export type { ExportConfig } from "./config";
export type { ExportMessages } from "./internal/messages";

const PLUGIN_ID = "stargantt.export";

/**
 * §1.1 — JPEG cannot represent transparency, so an unconfigured background is painted opaque white
 * rather than letting the encoder flatten transparent pixels to black.
 */
const JPEG_DEFAULT_BACKGROUND = "#fff";

/* ------------------------------------------------------------------ *
 * Per-call option resolution for the image nest (§1, option resolution)
 * ------------------------------------------------------------------ */

/** The image nest's fields after the call's per-key override and per-key validation. */
interface ResolvedImageOptions {
  background: string | undefined;
  pixelRatio: number | undefined;
  range: ExportRange | undefined;
}

function usableRange(value: unknown): ExportRange | undefined {
  if (value === "viewport" || value === "full") return value;
  if (value === null || typeof value !== "object") return undefined;
  const r = value as { start?: unknown; end?: unknown };
  // A non-finite bound is NOT dropped here: §1.1 makes a degenerate explicit span a caller error
  // that must reject by name, which only happens if the object reaches the range planner intact.
  return typeof r.start === "number" && typeof r.end === "number"
    ? { start: r.start, end: r.end }
    : undefined;
}

/**
 * Per-key shallow override of the `image` nest by the call's options (§1).
 *
 * Each key is validated independently and an unusable value falls back to the default — which, for
 * every field here, is "omitted", i.e. the §1.1 environment-derived behavior.
 */
function resolveImageOptions(
  nest: ImageCaptureConfig,
  call: ImageCaptureConfig | undefined,
): ResolvedImageOptions {
  const merged: ImageCaptureConfig = {
    ...nest,
    ...(call !== null && typeof call === "object" ? call : {}),
  };
  return {
    background: typeof merged.background === "string" ? merged.background : undefined,
    pixelRatio:
      typeof merged.pixelRatio === "number" &&
      Number.isFinite(merged.pixelRatio) &&
      merged.pixelRatio > 0
        ? merged.pixelRatio
        : undefined,
    range: usableRange(merged.range),
  };
}

/* ------------------------------------------------------------------ *
 * Plugin
 * ------------------------------------------------------------------ */

function setup(ctx: PluginContext, config: ExportConfig | undefined): void {
  const resolved = resolveConfig(config);
  const reportError = (where: string, error: unknown): void => {
    ctx.emit("core/pluginError", { pluginId: PLUGIN_ID, error: { where, cause: error } });
  };
  const messages = resolveMessages(resolved.messages, (key, error) =>
    reportError(`messages.${key}`, error),
  );

  const data = ctx.use("stargantt.data");
  const view = ctx.use("stargantt.view");
  const timeline = ctx.use("stargantt.timeline");
  const theme = ctx.use("stargantt.theme");

  // §4 — the point is `collect`: every non-layer surface joins the export through its own
  // contribution, and the capture pass reads the composed list at export time, so contributions
  // registered after this plugin's setup are still picked up.
  const surfaces = ctx.defineExtensionPoint(
    "export/auxiliarySurfaces",
    collect<AuxiliarySurfaceContribution>(),
  );

  // The only resource the capture path holds is its own liveness: offscreen canvases are per-call
  // and unreferenced once the promise settles, and nothing is appended to `ctx.root`. Ownership
  // still goes through `ctx.own()` so a disposed instance cannot keep serving exports.
  let disposed = false;
  ctx.own({
    dispose: () => {
      disposed = true;
      closePrintPreview();
    },
  });

  /* --- shared reads ----------------------------------------------------- */

  /** The task extent `range: "full"` and the print range fall back to, read through the store. */
  function extent(): { start: number; end: number } | undefined {
    return taskExtent(data.query().byId.values());
  }

  /**
   * Total height of all rows, for §1.1's all-rows coverage.
   *
   * `RowsService.totalHeight()` is its only published source and tree-grid is an optional
   * dependency, so the lookup is soft on purpose: without a reachable rows service the plan keeps
   * the viewport's row window rather than guessing a height. The `typeof … !== "function"` guard
   * stays because a third-party stand-in may not honour the declared shape.
   */
  function contentHeight(): number | undefined {
    const rows = ctx.useOptional("stargantt.rows");
    if (rows === undefined || typeof rows.totalHeight !== "function") return undefined;
    let total: number;
    try {
      total = rows.totalHeight();
    } catch {
      return undefined;
    }
    return Number.isFinite(total) && total > 0 ? total : undefined;
  }

  /**
   * The per-task criticality query behind the print emphasis mode (§1.3).
   *
   * Typed against `@stargantt/plugin-scheduling`'s real `CriticalPathService` (a type-only import,
   * erased at emit — `@stargantt/plugin-scheduling` is a devDependency only, per `optional:
   * ["stargantt.tree-grid", "stargantt.scheduling"]` above). `criticalityOf(id)`'s `undefined`
   * return means "not classified" (§1.3).
   */
  function criticality(): ((id: unknown) => boolean) | undefined {
    const service: CriticalPathService | undefined = ctx.useOptional("stargantt.critical-path");
    if (service === undefined) return undefined;
    return (id) => {
      try {
        return service.criticalityOf(id as TaskId) !== undefined;
      } catch (error) {
        reportError("critical-path criticalityOf", error);
        return true;
      }
    };
  }

  /* --- image capture (§1.1) --------------------------------------------- */

  function begin(options: ResolvedImageOptions): {
    plan: RangePlan;
    lay: ReturnType<typeof layout>;
    deps: CaptureDeps;
  } {
    if (disposed) throw new Error(DISPOSED_MESSAGE);
    const viewport = view.viewport.get();
    // §1.1 — the ratio the chart is currently drawn at is recovered from the view plugin's own
    // layer canvases; they are read for their size only, never composited.
    const ratio = effectiveRatio(layerCanvases(ctx.root), options.pixelRatio);
    const plan = planRange(options.range, {
      viewport,
      scale: timeline,
      extent: extent(),
      contentHeight: contentHeight(),
      // The degenerate-span judgement happens at the export's resolution.
      pixelRatio: ratio,
    });
    // §1.1 — a degenerate explicit `{ start, end }` (non-finite bounds, or a span under one
    // exported pixel) is a caller error, not a fallback: reject instead of silently exporting the
    // viewport. Every other fallback reason stays a silent environment degradation.
    if (plan.fallbackReason === "degenerate") {
      const range = options.range as { start: number; end: number };
      throw new Error(
        `${PLUGIN_ID}: range { start: ${range.start}, end: ${range.end} } does not ` +
          "describe an exportable time span",
      );
    }
    const lay = layout(plan, plan.height, surfaces.get() ?? []);
    const deps: CaptureDeps = {
      doc: ctx.root.ownerDocument,
      renderTo: (g, vp) => view.renderTo(g, vp),
      ratio,
      aborted: () => disposed,
    };
    return { plan, lay, deps };
  }

  /**
   * The shared raster pipeline behind both `toPng` encoders: composite the layers and the
   * auxiliary surfaces into one offscreen canvas, then encode it.
   */
  async function raster(options: RasterOptions | undefined): Promise<Blob> {
    const jpeg = options?.format === "jpeg";
    const image = resolveImageOptions(resolved.image, options);
    const { plan, lay, deps } = begin(image);
    // Every exported pixel comes from `renderTo` into offscreen tiles; nothing on screen scrolls
    // or repaints, so the export is synchronous up to the image encoding itself.
    const layers = captureLayers(deps, plan);

    const out = offscreen(deps.doc, lay.width, lay.height, deps.ratio);
    const g = context2d(out);
    // §1.1 — the color is passed to the canvas unchanged; the plugin parses and validates nothing,
    // so an unparsable color simply paints nothing.
    const background = image.background ?? (jpeg ? JPEG_DEFAULT_BACKGROUND : undefined);
    if (background !== undefined) {
      g.fillStyle = background;
      g.fillRect(0, 0, out.width, out.height);
    }
    g.drawImage(layers, 0, lay.layersTop * deps.ratio, layers.width, layers.height);
    // §4 — the auxiliary compose pass, at the drawing layers' resolution ratio.
    for (const band of lay.bands) {
      const c = captureSurface(deps, plan, band);
      g.drawImage(c, 0, band.y * deps.ratio, c.width, c.height);
    }
    // §1.1 — a quality outside the encoder's meaningful [0, 1] range (or not a finite number) is
    // ignored, leaving the encoder at its own default. PNG ignores it entirely.
    const quality = options?.quality;
    const q =
      jpeg && typeof quality === "number" && Number.isFinite(quality) && quality >= 0 && quality <= 1
        ? quality
        : undefined;
    return await canvasToBlob(out, jpeg ? "image/jpeg" : "image/png", q);
  }

  async function toSvg(options?: ImageCaptureConfig): Promise<string> {
    // §1.1 — an SVG is resolution-independent, so `pixelRatio` is not forwarded here; the
    // rasterized fallbacks composite at the ratio recovered from the layer canvases.
    const image = resolveImageOptions(resolved.image, options);
    const { plan, lay, deps } = begin({ ...image, pixelRatio: undefined });

    // The layers are driven through `renderTo` with the recording proxy, so official layers emit
    // true vector elements; vectorization is still decided per layer, and a layer that reaches
    // outside the proxy's subset is replayed into a raster image on its own.
    const body = captureLayersSVG(deps, plan, lay.layersTop);

    // §4 — auxiliary surfaces map to SVG elements through their own `drawTileSVG`, and are
    // rasterized into an embedded image only when they do not offer one.
    for (const band of lay.bands) {
      const markup = surfaceSVG(plan, band, deps.ratio);
      if (markup !== undefined) {
        body.push(markup);
        continue;
      }
      const c = captureSurface(deps, plan, band);
      body.push(svgImage(0, band.y, lay.width, band.height, c.toDataURL("image/png")));
    }

    return svgDocument(lay.width, lay.height, body.join(""), image.background);
  }

  /* --- print (§1.2, §1.3) ------------------------------------------------ */

  /** Snapshots the services into the hostless print pipeline's adapter. */
  function makeEnv(): PrintEnv {
    const rows = ctx.useOptional("stargantt.rows");
    const critical = criticality();
    // Queried once per export instead of once per cell/task: a stable point-in-time snapshot the
    // whole layout/render pass reuses, so concurrent mutations cannot make different cells of the
    // same export see different data states.
    const query = data.query();
    const env: PrintEnv = {
      doc: ctx.root.ownerDocument,
      locale: ctx.locale,
      now: () => Date.now(),
      renderTo: (g, viewport) => view.renderTo(g, viewport),
      currentViewport: () => view.viewport.get(),
      taskExtent: () => taskExtent(query.byId.values()),
      taskById: (id) => query.byId.get(id as never) as PrintTask | undefined,
      // §1.2 — the t↔x mapping is always available (timeline is co-provided by the hard
      // `view` dependency), so the "no timeline-scale" degradation branch is unreachable.
      tToX: (t) => timeline.tToX(t),
      boundaries: (unit, from, to) => timeline.unitBoundaries(unit, from, to),
      fault: reportError,
    };
    if (rows !== undefined) env.rows = rows;
    if (critical !== undefined) env.criticality = critical;
    return env;
  }

  /**
   * Runs `fn` with the chart's color scheme pinned to `"light"` (§1.3), so the exported chart slice
   * renders with the theme's light values instead of compositing a dark-scheme chart onto the
   * print/PDF page's white chrome and legend. The prior pin — a pinned scheme or `"auto"` — is
   * restored immediately afterwards. Only `toPdf` and `printPreview` wrap in this: `pageCount`
   * renders nothing and therefore pins nothing.
   */
  function withLightScheme<T>(fn: () => T): T {
    const previous = theme.colorScheme();
    if (previous === "light") return fn();
    theme.setColorScheme("light");
    try {
      return fn();
    } finally {
      theme.setColorScheme(previous);
    }
  }

  let preview: PrintPreview | undefined;

  function closePrintPreview(): void {
    preview?.dispose();
    preview = undefined;
  }

  function openPrintPreview(options?: PrintOptions): boolean {
    const env = makeEnv();
    const rendered = withLightScheme(() =>
      renderPages(env, resolveOptions(resolved.print, options), messages),
    );
    if (rendered === undefined) return false;
    closePrintPreview();
    preview = createPrintPreview({
      host: view.chartPaneElement(),
      canvases: rendered.canvases,
      pageWidth: rendered.plan.pageWidth,
      messages,
      print: () => env.doc.defaultView?.print?.(),
      close: closePrintPreview,
      fault: reportError,
    });
    return true;
  }

  /* --- the facade -------------------------------------------------------- */

  const wiring: ExportWiring = {
    ctx,
    config: resolved,
    messages,
    data,
    view,
    timeline,
    theme,
    reportError,
    disposed: () => disposed,
  };

  const service: ExportService = {
    toPng: (options) => raster(options),
    toSvg,

    toPdf(options?: PrintOptions): Promise<Blob> {
      const rendered = withLightScheme(() =>
        renderPages(makeEnv(), resolveOptions(resolved.print, options), messages),
      );
      if (rendered === undefined) {
        return Promise.reject(new Error(`${PLUGIN_ID}: cannot obtain a 2D canvas context`));
      }
      const blob = encodePdf(rendered);
      return blob === undefined
        ? Promise.reject(new Error(`${PLUGIN_ID}: page image encoding failed`))
        : Promise.resolve(blob);
    },

    pageCount(options?: PrintOptions): number {
      // Planning only — `prepare()` renders nothing, so no light-scheme pin is taken (§1.3).
      return prepare(makeEnv(), resolveOptions(resolved.print, options), messages).plan.slices
        .length;
    },

    printPreview(options?: PrintOptions | false): boolean {
      // §1 — `printPreview(false)` folds the standalone close call into the one member; the
      // return value is "is a preview open after this call".
      if (options === false) {
        closePrintPreview();
        return false;
      }
      return openPrintPreview(options);
    },

    ...wireFormats(wiring),
    ...wireMsProject(wiring),
    ...wireExcel(wiring),
    ...wireEmbed(wiring),
  };

  ctx.provide("stargantt.export", service);
}

/**
 * Creates the export plugin: image capture (PNG / JPEG / SVG), paginated printing and PDF output,
 * CSV / JSON / iCal interchange, MS Project MSPDI, Excel workbooks, snapshots and read-only
 * viewing. Everything is on-demand — with no service call and an all-default config the plugin
 * paints nothing and changes nothing visible.
 */
export function exportPlugin(config?: ExportConfig): Plugin<void> {
  const options = config === null || typeof config !== "object" ? undefined : config;
  return definePlugin<void>({
    meta: {
      id: PLUGIN_ID,
      // §10 — both hard dependencies are strictly lower layers: the store (L1) behind every
      // serializer and extent, and the view (L2), which co-provides the timeline and theme
      // services the capture and print paths need.
      dependsOn: ["stargantt.data-store", "stargantt.view"],
      // Soft: the rows service refines image row coverage and the print row span; the scheduling
      // plugin's criticality query drives the print emphasis mode; without either the export
      // degrades silently (§1.1, §1.3).
      optional: ["stargantt.tree-grid", "stargantt.scheduling", "stargantt.tracking"],
    },
    setup: (ctx) => setup(ctx, options),
  });
}
