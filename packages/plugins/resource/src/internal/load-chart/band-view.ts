// docs/specs/plugins/resource.md §3.6 — the aggregate band's PAINT half and its strip DOM.
/**
 * The band is the `view/bottomPanes` contribution `stargantt.load-chart:total`, rendered inside the
 * `{ pane, gutter, body, trailing }` elements its `mount` receives: the plot fills the BODY column
 * (aligned with the chart pane, so the shared `tToX` mapping holds without any pane-box
 * measurement), the y-axis renders in the GUTTER column when that column has width — with an
 * in-plot fallback when it does not — and the TRAILING column stays empty. A width change reaches
 * the plugin by observing its own body element; no chart-pane lookup, no chart-pane observer.
 *
 * `paintBand` below is the ONE draw routine: the live strip and the `export/auxiliarySurfaces`
 * tile writers both go through it, over the same `projectHistogram` boxes, so screen and export
 * cannot drift apart. Overload is drawn as colour PLUS a diagonal hatch (WCAG 1.4.1).
 */
import type { BottomPaneElements } from "@stargantt/plugin-view";
// Type-only: the export plugin's auxiliary-surface contribution shape (a devDependency edge).
import type { AuxiliarySurfaceContribution, ExportTile } from "@stargantt/plugin-export";
import { AXIS_LABEL_HEIGHT, layoutAxisLabels } from "./axis";
import type { AxisLabelBox } from "./axis";
import type { BucketResult } from "./band";
import {
  AXIS_WIDTH,
  CAPACITY_LINE_THICKNESS,
  escapeAttr,
  formatTick,
  hatchPatternSVG,
  paintHatch,
  projectHistogram,
} from "./geometry";
import type { HistogramProjection } from "./geometry";

/** The band's own container class; the pane carries the band background across all three columns. */
export const BAND_CLASS = "sg-load-chart";
export const LOAD_PANE_CLASS = "sg-load-pane";

/** The default label font, used when the `--sg-header-font` token resolves to nothing. */
export const DEFAULT_LABEL_FONT = "11px system-ui, sans-serif";

/** Resolved band colours for one paint, read from the `--sg-load-*` tokens. */
export interface BandColors {
  fill: string;
  overFill: string;
  capacityLine: string;
  bg: string;
  axisText: string;
  gridline: string;
}

/**
 * Resolves the band's colours from the `--sg-load-*` tokens.
 *
 * A canvas has no CSS cascade to lean on, so both the live strip and the export read the tokens
 * through the theme's getter at draw time. Each fallback is a fixed color, for a composition whose
 * theme resolves the token to nothing at all.
 */
export function resolveBandColors(token: (name: string) => string): BandColors {
  return {
    fill: token("--sg-load-fill") || "#6f90c0",
    overFill: token("--sg-load-over-fill") || "#d9534f",
    capacityLine: token("--sg-load-capacity-line") || "#2b3240",
    bg: token("--sg-load-bg") || "#f7f8fa",
    axisText: token("--sg-muted-fg") || "#3c4350",
    gridline: token("--sg-load-gridline") || "rgba(60, 67, 80, 0.18)",
  };
}

export interface BandPaintOptions {
  /** The buckets to draw, already restricted to the range being drawn. */
  results: readonly BucketResult[];
  /** Width of the drawn box in CSS px. */
  width: number;
  /** Height of the drawn box in CSS px. */
  height: number;
  /** Maps an epoch-ms instant to an x offset local to the drawn box (0 at its left edge). */
  xOf(t: number): number;
  colors: BandColors;
  /** Whether the top value-label gutter is reserved — a band-wide rule, not a per-medium one. */
  valueLabels: boolean;
  /** Whether the y-axis gridlines are drawn into the plot. */
  gridlines: boolean;
  /** Whether the axis LABELS are drawn in-plot (the zero-width-gutter fallback). */
  axisInPlot: boolean;
  /** The peak of the whole span the scale must cover, when wider than `results` alone. */
  scaleMax?: number;
  /** Whether the values are working milliseconds (Σ mode) — decides the step magnitude. */
  durationScale?: boolean;
  /** Renders a value as label text. Omitted, the plain numeric form is used. */
  formatValue?: (value: number) => string;
  /** The font every label is drawn in. */
  font: string;
}

/** The one draw routine of the band — used by the live strip AND the export tile writer. */
export function paintBand(
  ctx: CanvasRenderingContext2D,
  o: BandPaintOptions,
): HistogramProjection {
  ctx.save();
  ctx.font = o.font;
  ctx.textBaseline = "top";

  const measure = (text: string): number => ctx.measureText(text).width;
  const projection = projectHistogram({
    results: o.results,
    width: o.width,
    height: o.height,
    xOf: o.xOf,
    valueLabels: o.valueLabels,
    nice: true,
    ...(o.scaleMax === undefined ? {} : { scaleMax: o.scaleMax }),
    ...(o.durationScale === true ? { durationScale: true } : {}),
    ...(o.formatValue === undefined ? {} : { formatValue: o.formatValue }),
    ...(o.valueLabels ? { measure } : {}),
  });

  ctx.fillStyle = o.colors.bg;
  ctx.fillRect(0, 0, o.width, o.height);

  // Gridlines sit UNDER the bars: they are ground, never figure (the figure/ground rule).
  if (o.gridlines && projection.ticks.length > 0 && projection.max > 0) {
    ctx.strokeStyle = o.colors.gridline;
    ctx.lineWidth = 1;
    ctx.beginPath();
    for (const tick of projection.ticks) {
      const y = Math.round(projection.yOf(tick)) + 0.5;
      ctx.moveTo(0, y);
      ctx.lineTo(o.width, y);
    }
    ctx.stroke();
  }

  for (const bar of projection.bars) {
    ctx.fillStyle = o.colors.fill;
    ctx.fillRect(bar.x, bar.top, bar.width, bar.height);
    if (bar.over !== undefined) {
      // The overload segment is the top portion of the bar's own box, painted over it — with a
      // diagonal hatch on top, so overload is never signalled by colour alone (WCAG 1.4.1).
      ctx.fillStyle = o.colors.overFill;
      ctx.fillRect(bar.x, bar.over.top, bar.width, bar.over.height);
      paintHatch(ctx, bar.x, bar.over.top, bar.width, bar.over.height, o.colors.bg);
    }
  }

  ctx.strokeStyle = o.colors.capacityLine;
  ctx.lineWidth = CAPACITY_LINE_THICKNESS;
  for (const segment of projection.capacity) {
    const y = Math.round(segment.y) + 0.5;
    ctx.beginPath();
    ctx.moveTo(segment.x, y);
    ctx.lineTo(segment.x + segment.width, y);
    ctx.stroke();
  }

  if (o.valueLabels) {
    ctx.fillStyle = o.colors.axisText;
    ctx.textAlign = "center";
    for (const bar of projection.bars) {
      const label = bar.label;
      if (label === undefined) continue;
      ctx.fillText(label.text, label.x + label.width / 2, label.top);
    }
    ctx.textAlign = "left";
  }

  if (o.axisInPlot) {
    ctx.textAlign = "right";
    for (const box of axisLabelBoxes(projection, o)) {
      const top = box.top ?? Math.max(0, o.height - AXIS_LABEL_HEIGHT);
      // The in-plot column draws OVER the bars, so each label needs a translucent backdrop — an
      // opaque full-column fill would erase the leftmost bucket, which is the defect this
      // 78%-alpha label backdrop exists to avoid.
      const textWidth = ctx.measureText(box.text).width;
      ctx.globalAlpha = 0.78;
      ctx.fillStyle = o.colors.bg;
      ctx.fillRect(AXIS_WIDTH - 6 - textWidth, top, textWidth + 4, AXIS_LABEL_HEIGHT);
      ctx.globalAlpha = 1;
      ctx.fillStyle = o.colors.axisText;
      ctx.fillText(box.text, AXIS_WIDTH - 4, top);
    }
    ctx.textAlign = "left";
  }

  ctx.restore();
  return projection;
}

/** The surviving axis labels of a projection, under the caller's own value formatting. */
export function axisLabelBoxes(
  projection: HistogramProjection,
  o: Pick<BandPaintOptions, "height" | "formatValue" | "durationScale">,
): AxisLabelBox[] {
  if (projection.ticks.length === 0 || projection.max <= 0) return [];
  const format = o.durationScale === true ? o.formatValue : undefined;
  return layoutAxisLabels({
    ticks: projection.ticks,
    yOf: (value) => projection.yOf(value),
    height: o.height,
    ...(format === undefined ? {} : { format }),
  });
}

/** The SVG counterpart of {@link paintBand} — the vector form one export tile emits. */
export function bandTileSVG(o: BandPaintOptions, measure: (text: string) => number): string {
  const projection = projectHistogram({
    results: o.results,
    width: o.width,
    height: o.height,
    xOf: o.xOf,
    valueLabels: o.valueLabels,
    nice: true,
    ...(o.scaleMax === undefined ? {} : { scaleMax: o.scaleMax }),
    ...(o.durationScale === true ? { durationScale: true } : {}),
    ...(o.formatValue === undefined ? {} : { formatValue: o.formatValue }),
    ...(o.valueLabels ? { measure } : {}),
  });

  const parts: string[] = [
    `<rect x="0" y="0" width="${String(o.width)}" height="${String(o.height)}" fill="${escapeAttr(o.colors.bg)}"/>`,
  ];

  const hatchId = `sg-load-over-hatch-${String(nextHatchId++)}`;
  let hatchEmitted = false;

  for (const bar of projection.bars) {
    parts.push(
      `<rect x="${String(bar.x)}" y="${String(bar.top)}" width="${String(bar.width)}" height="${String(bar.height)}" fill="${escapeAttr(o.colors.fill)}"/>`,
    );
    if (bar.over !== undefined) {
      if (!hatchEmitted) {
        hatchEmitted = true;
        parts.push(`<defs>${hatchPatternSVG(hatchId, o.colors.bg)}</defs>`);
      }
      // The coloured segment plus a diagonal hatch on top — overload never by colour alone.
      parts.push(
        `<rect x="${String(bar.x)}" y="${String(bar.over.top)}" width="${String(bar.width)}" height="${String(bar.over.height)}" fill="${escapeAttr(o.colors.overFill)}"/>`,
        `<rect x="${String(bar.x)}" y="${String(bar.over.top)}" width="${String(bar.width)}" height="${String(bar.over.height)}" fill="url(#${hatchId})"/>`,
      );
    }
  }

  for (const segment of projection.capacity) {
    parts.push(
      `<line x1="${String(segment.x)}" y1="${String(segment.y)}" x2="${String(segment.x + segment.width)}" y2="${String(segment.y)}" stroke="${escapeAttr(o.colors.capacityLine)}" stroke-width="${String(CAPACITY_LINE_THICKNESS)}"/>`,
    );
  }

  return `<g>${parts.join("")}</g>`;
}

/**
 * Monotonic suffix so each emitted tile's hatch `<pattern>` id is document-unique: an export
 * concatenates many tiles into one SVG, and duplicate ids are invalid markup.
 */
let nextHatchId = 1;

/* ------------------------------------------------------------------ *
 * The live strip
 * ------------------------------------------------------------------ */

/** The strip's measurable geometry in CSS px. */
export interface StripMeasure {
  width: number;
  gutterWidth: number;
}

/** Everything one repaint of the band's content needs, beyond what the view holds itself. */
export interface BandContent {
  /** The buckets to draw, already restricted to the visible time range. */
  results: readonly BucketResult[];
  /** The strip's body-column width, as `measure()` reported it. */
  width: number;
  /** The strip's current height — the view plugin owns it; the caller tracks it via `onResize`. */
  height: number;
  /** The gutter column's width, deciding the axis presentation. */
  gutterWidth: number;
  /** Content x of a time, local to the body column (`tToX(t) - scrollLeft`). */
  xOf(t: number): number;
  colors: BandColors;
  font: string;
  /** Whether these results are Σ-mode working milliseconds. */
  durationScale: boolean;
  /** Renders a working-time value as text — the catalog's `duration` member. */
  formatDuration: (ms: number) => string;
}

export interface BandViewDeps {
  axisLabels: boolean;
  valueLabels: boolean;
  /** Invoked when the strip's body column resizes — the repaint trigger. */
  onResize(): void;
}

/** The band's view: mounted once by the strip contribution's `mount`, disposed by `ctx.own`. */
export interface BandView {
  mount(elements: BottomPaneElements): void;
  /** The strip's current column widths, or `null` before `mount`. */
  measure(): StripMeasure | null;
  /** Rebuilds the band for `content`. A no-op before `mount`. */
  render(content: BandContent): void;
  /** Sets the band's accessible name, skipping the write when the wording has not changed. */
  describe(ariaLabel: string): void;
  /** Removes the band's own DOM and observers from the view-owned columns. `ctx.own()`-shaped. */
  dispose(): void;
}

/** Creates the band view. DOM exists only after the view plugin calls `mount`. */
export function createBandView(deps: BandViewDeps): BandView {
  let elements: BottomPaneElements | null = null;
  let container: HTMLElement | null = null;
  let canvas: HTMLCanvasElement | null = null;
  let observer: ResizeObserver | null = null;
  let lastAriaLabel = "";
  // Widths cached from the ResizeObserver's contentRect — no per-frame layout reads.
  let bodyWidth = Number.NaN;
  let gutterWidth = Number.NaN;
  /** The axis label elements currently in the gutter, reused across frames. */
  const axisNodes: HTMLElement[] = [];
  let axisHost: HTMLElement | null = null;

  function syncAxisGutter(gutter: HTMLElement, boxes: readonly AxisLabelBox[]): void {
    if (axisHost === null) {
      const host = gutter.ownerDocument.createElement("div");
      host.className = "sg-load-chart__axis";
      host.setAttribute("aria-hidden", "true");
      Object.assign(host.style, {
        position: "relative",
        width: "100%",
        height: "100%",
        overflow: "hidden",
        pointerEvents: "none",
      });
      gutter.appendChild(host);
      axisHost = host;
    }
    const host = axisHost;
    while (axisNodes.length < boxes.length) {
      const label = gutter.ownerDocument.createElement("div");
      label.className = "sg-load-chart__axis-label";
      Object.assign(label.style, {
        position: "absolute",
        right: "4px",
        textAlign: "right",
        whiteSpace: "nowrap",
        lineHeight: `${String(AXIS_LABEL_HEIGHT)}px`,
      });
      host.appendChild(label);
      axisNodes.push(label);
    }
    for (let i = 0; i < axisNodes.length; i += 1) {
      const node = axisNodes[i] as HTMLElement;
      const box = boxes[i];
      if (box === undefined) {
        node.style.display = "none";
        continue;
      }
      node.style.display = "block";
      node.style.top = `${String(box.top ?? 0)}px`;
      if (box.top === null) {
        node.style.top = "";
        node.style.bottom = "0";
      } else {
        node.style.bottom = "";
      }
      if (node.textContent !== box.text) node.textContent = box.text;
    }
  }

  return {
    mount: (els) => {
      elements = els;
      els.pane.classList.add(LOAD_PANE_CLASS);
      const doc = els.body.ownerDocument;
      const box = doc.createElement("div");
      box.className = BAND_CLASS;
      box.setAttribute("role", "img");
      Object.assign(box.style, {
        position: "relative",
        width: "100%",
        height: "100%",
        overflow: "hidden",
        // Chrome, not a target: a press over the band reaches the chart behind it.
        pointerEvents: "none",
      });
      const cv = doc.createElement("canvas");
      Object.assign(cv.style, { display: "block", width: "100%", height: "100%" });
      box.appendChild(cv);
      els.body.appendChild(box);
      container = box;
      canvas = cv;

      // The view plugin publishes no columns-changed callback; a contribution that must repaint on
      // a width change observes its OWN columns. The observer's contentRect is also the width
      // cache, so `measure()` never forces layout with per-frame `getBoundingClientRect` reads.
      if (typeof globalThis.ResizeObserver === "function") {
        observer = new globalThis.ResizeObserver((entries) => {
          if (Array.isArray(entries)) {
            for (const entry of entries) {
              const width = entry?.contentRect?.width;
              if (typeof width !== "number") continue;
              if (entry.target === els.body) bodyWidth = width;
              else if (entry.target === els.gutter) gutterWidth = width;
            }
          }
          deps.onResize();
        });
        observer.observe(els.body);
        observer.observe(els.gutter);
      }
    },

    measure: () => {
      if (elements === null) return null;
      return {
        width: Number.isFinite(bodyWidth) ? bodyWidth : elements.body.getBoundingClientRect().width,
        gutterWidth: Number.isFinite(gutterWidth)
          ? gutterWidth
          : elements.gutter.getBoundingClientRect().width,
      };
    },

    render: (content) => {
      const cv = canvas;
      const els = elements;
      if (cv === null || els === null) return;
      const width = Math.max(0, Math.floor(content.width));
      const height = Math.max(0, Math.floor(content.height));
      const dpr =
        typeof globalThis.devicePixelRatio === "number" && globalThis.devicePixelRatio > 0
          ? globalThis.devicePixelRatio
          : 1;
      if (cv.width !== Math.round(width * dpr)) cv.width = Math.round(width * dpr);
      if (cv.height !== Math.round(height * dpr)) cv.height = Math.round(height * dpr);
      const ctx = cv.getContext("2d");
      if (ctx === null || width <= 0 || height <= 0) return;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, width, height);

      const gutterHosted = deps.axisLabels && content.gutterWidth > 0;
      const projection = paintBand(ctx, {
        results: content.results,
        width,
        height,
        xOf: content.xOf,
        colors: content.colors,
        valueLabels: deps.valueLabels,
        gridlines: deps.axisLabels,
        // The in-plot overlay is the zero-width-gutter fallback (the chart-only view mode).
        axisInPlot: deps.axisLabels && !gutterHosted,
        font: content.font,
        ...(content.durationScale
          ? { durationScale: true, formatValue: content.formatDuration }
          : {}),
      });

      if (deps.axisLabels) {
        if (gutterHosted) {
          ctx.font = content.font;
          syncAxisGutter(
            els.gutter,
            axisLabelBoxes(projection, {
              height,
              durationScale: content.durationScale,
              ...(content.durationScale ? { formatValue: content.formatDuration } : {}),
            }),
          );
          if (axisHost !== null) axisHost.style.color = content.colors.axisText;
          if (axisHost !== null) axisHost.style.font = content.font;
        } else if (axisHost !== null) {
          // A presentation switch (the gutter collapsing to zero width) moves the axis in-plot;
          // the previous frame's gutter-hosted axis must not linger.
          axisHost.remove();
          axisHost = null;
          axisNodes.length = 0;
        }
      }
    },

    describe: (ariaLabel) => {
      if (container === null || ariaLabel === lastAriaLabel) return;
      lastAriaLabel = ariaLabel;
      container.setAttribute("aria-label", ariaLabel);
    },

    dispose: () => {
      observer?.disconnect();
      observer = null;
      axisHost?.remove();
      axisHost = null;
      axisNodes.length = 0;
      container?.remove();
      container = null;
      canvas = null;
      if (elements !== null) {
        elements.pane.classList.remove(LOAD_PANE_CLASS);
        elements = null;
      }
    },
  };
}

/* ------------------------------------------------------------------ *
 * The export surface
 * ------------------------------------------------------------------ */

/** What the band's `export/auxiliarySurfaces` contribution reads from its surroundings. */
export interface BandExportDeps {
  /** The band pipeline's own aggregation of a range — bucketing, allowlist, Σ mode, fallback. */
  buckets(from: number, to: number): readonly BucketResult[];
  /** The peak of the WHOLE exported span, memoized by the caller so tiles share one y-scale. */
  peak(from: number, to: number): number;
  colors(): BandColors;
  font(): string;
  valueLabels: boolean;
  /** Whether the band is currently summing the per-resource matrix. */
  durationScale(): boolean;
  formatDuration(ms: number): string;
  /** The live band's height; `0` while it is hidden, which makes this surface inert. */
  height(): number;
}

/**
 * The band's one `export/auxiliarySurfaces` contribution: `side: "bottom"`, the aggregate band
 * only, redrawn FROM DATA through the very band pipeline for each tile.
 *
 * The height follows the live band's, so a hidden band contributes a height-0 surface —
 * export-image drops those, and the exported image reproduces the screen.
 */
export function createBandExportSurface(deps: BandExportDeps): AuxiliarySurfaceContribution {
  function optionsFor(tile: ExportTile): BandPaintOptions {
    const span = tile.end - tile.start;
    const sigma = deps.durationScale();
    return {
      results: deps.buckets(tile.start, tile.end),
      width: tile.width,
      height: tile.height,
      xOf: (t) => (span > 0 ? ((t - tile.start) / span) * tile.width : 0),
      colors: deps.colors(),
      valueLabels: deps.valueLabels,
      // The exported band carries bars, overload segments and the capacity line; the axis and the
      // value labels stay on screen.
      gridlines: false,
      axisInPlot: false,
      // The step-first projection over the EXPORTED SPAN's own maximum (`rangeStart`/`rangeEnd`,
      // never this tile's own bounds), so the bars stay continuous across tile seams.
      scaleMax: deps.peak(tile.rangeStart, tile.rangeEnd),
      font: deps.font(),
      ...(sigma ? { durationScale: true as const, formatValue: deps.formatDuration } : {}),
    };
  }

  return {
    side: "bottom",
    get height() {
      return deps.height();
    },
    drawTile: (ctx, tile) => {
      paintBand(ctx, optionsFor(tile));
    },
    // No canvas to measure against here, and the exported band draws no value labels anyway.
    drawTileSVG: (tile) => bandTileSVG(optionsFor(tile), () => Number.POSITIVE_INFINITY),
  };
}

/** The plain numeric label form, re-exported so the aggregator's consumers agree on it. */
export { formatTick };
