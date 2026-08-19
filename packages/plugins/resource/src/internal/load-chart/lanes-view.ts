// docs/specs/plugins/resource.md §3.6 — the resource lanes strip (§3.2).
/**
 * The lanes are the `view/bottomPanes` contribution `stargantt.load-chart:lanes`: one histogram lane
 * per roster resource on the band's own (uncoarsened) bucket grid, drawn into a vertically
 * scrollable canvas that fills the BODY column, with the resource names hosted in the GUTTER column
 * (in-plot fallback when that column has no width).
 *
 * The scroll surface is a `tabindex="0"` element so the lanes are scrollable keyboard-only; its
 * accessible name is `lanesLabel` and each lane carries a `role="img"` proxy named by `laneLabel`,
 * so a screen reader hears what is drawn. Overload is drawn as colour PLUS the diagonal hatch, and
 * the per-bucket reference line is dashed — neither signal rides on colour alone.
 */
import type { BottomPaneElements } from "@stargantt/plugin-view";
import {
  CAPACITY_LINE_THICKNESS,
  LANE_PAD_BOTTOM,
  LANE_PAD_TOP,
  paintHatch,
  projectLane,
} from "./geometry";
import type { LaneModel, LaneRow } from "./lanes-model";
import { LOAD_PANE_CLASS } from "./band-view";

/** The lanes container class. */
export const LANES_CLASS = "sg-load-lanes";

/** How many lanes above and below the visible window are drawn, so a scroll never shows a gap. */
const LANE_OVERSCAN = 2;

/**
 * Draws one in-plot label over a translucent backdrop, vertically centred on `y`.
 *
 * A lane label sits ON the bars, so it needs a backdrop to stay legible — translucent rather than
 * opaque, so the bar underneath still reads (the same 78%-alpha backdrop the band uses).
 */
function paintLabel(
  ctx: CanvasRenderingContext2D,
  text: string,
  x: number,
  y: number,
  width: number,
  colors: LaneColors,
): void {
  ctx.globalAlpha = 0.78;
  ctx.fillStyle = colors.bg;
  ctx.fillRect(x - 2, y - 7, width + 4, 14);
  ctx.globalAlpha = 1;
  ctx.fillStyle = colors.text;
  ctx.fillText(text, x, y);
}

/** Resolved lane colours for one paint, read from the `--sg-load-*` tokens. */
export interface LaneColors {
  fill: string;
  overFill: string;
  reference: string;
  bg: string;
  zebra: string;
  separator: string;
  text: string;
}

/** Resolves the lanes' colours from the theme, with fixed values as fallbacks. */
export function resolveLaneColors(token: (name: string) => string): LaneColors {
  return {
    fill: token("--sg-load-fill") || "#6f90c0",
    overFill: token("--sg-load-over-fill") || "#d9534f",
    // ≥ 3:1 against the lane background — the reference line is a UI graphic, not decoration.
    reference: token("--sg-load-lane-reference") || "#2b3240",
    bg: token("--sg-load-bg") || "#f7f8fa",
    zebra: token("--sg-load-lane-zebra") || "rgba(43, 50, 64, 0.05)",
    separator: token("--sg-load-lane-separator") || "rgba(43, 50, 64, 0.16)",
    text: token("--sg-muted-fg") || "#3c4350",
  };
}

/** Everything one repaint of the lanes needs. */
export interface LanesContent {
  model: LaneModel;
  /** The strip's body-column width in CSS px. */
  width: number;
  /** The strip's current height in CSS px. */
  height: number;
  /** The gutter column's width, deciding the name-column presentation. */
  gutterWidth: number;
  /** Content x of a time, local to the body column (`tToX(t) - scrollLeft`). */
  xOf(t: number): number;
  colors: LaneColors;
  font: string;
  /** One lane's accessible name. */
  laneLabel(row: LaneRow, model: LaneModel): string;
  /** The whole strip's accessible name. */
  lanesLabel(model: LaneModel): string;
  /** Renders a lane run's value as label text under the active scale. */
  formatValue(value: number): string;
}

export interface LanesViewDeps {
  /** One lane's height in CSS px — the `--sg-load-lane-height` token, resolved once. */
  laneHeight(): number;
  laneValueLabels: boolean;
  /** Invoked when the strip's body column resizes, or the surface scrolls. */
  onResize(): void;
}

export interface LanesView {
  mount(elements: BottomPaneElements): void;
  /** The strip's current column widths, or `null` before `mount`. */
  measure(): { width: number; gutterWidth: number } | null;
  render(content: LanesContent): void;
  /**
   * Scrolls the lane of `resourceId` into view. `smooth` is the caller's own reduced-motion
   * decision — under `prefers-reduced-motion` the jump is instant.
   */
  reveal(resourceId: string | number, smooth: boolean): void;
  dispose(): void;
}

/** Creates the lanes view. DOM exists only after the view plugin calls `mount`. */
export function createLanesView(deps: LanesViewDeps): LanesView {
  let elements: BottomPaneElements | null = null;
  let scroller: HTMLElement | null = null;
  let sizer: HTMLElement | null = null;
  let canvas: HTMLCanvasElement | null = null;
  let observer: ResizeObserver | null = null;
  let scrollListener: (() => void) | null = null;
  let namesHost: HTMLElement | null = null;
  let lastAriaLabel = "";
  let bodyWidth = Number.NaN;
  let gutterWidth = Number.NaN;
  /** Row index of each rendered lane, so `reveal` can place one without re-measuring. */
  const laneIndex = new Map<string, number>();
  /** The row list `laneIndex` was built from, so a scroll repaint never rebuilds it. */
  let indexedRows: readonly LaneRow[] | null = null;
  /** Reused per-lane accessible proxies and gutter name nodes — no per-frame allocation. */
  const ariaNodes: HTMLElement[] = [];
  const nameNodes: HTMLElement[] = [];

  function ensureNodes(pool: HTMLElement[], host: HTMLElement, count: number, cls: string): void {
    while (pool.length < count) {
      const node = host.ownerDocument.createElement("div");
      node.className = cls;
      Object.assign(node.style, {
        position: "absolute",
        left: "0",
        right: "0",
        overflow: "hidden",
        whiteSpace: "nowrap",
        textOverflow: "ellipsis",
        pointerEvents: "none",
      });
      host.appendChild(node);
      pool.push(node);
    }
  }

  return {
    mount: (els) => {
      elements = els;
      els.pane.classList.add(LOAD_PANE_CLASS);
      const doc = els.body.ownerDocument;

      const surface = doc.createElement("div");
      surface.className = LANES_CLASS;
      surface.setAttribute("role", "group");
      // A scrollable region must be reachable and scrollable keyboard-only (WCAG 2.2 §2.1.1); the
      // UA focus ring is left intact so focus stays visible.
      surface.setAttribute("tabindex", "0");
      Object.assign(surface.style, {
        position: "relative",
        width: "100%",
        height: "100%",
        overflowY: "auto",
        overflowX: "hidden",
      });

      const inner = doc.createElement("div");
      inner.className = "sg-load-lanes__sizer";
      Object.assign(inner.style, { position: "relative", width: "100%", height: "0px" });

      const cv = doc.createElement("canvas");
      Object.assign(cv.style, { position: "absolute", top: "0", left: "0", display: "block" });
      inner.appendChild(cv);
      surface.appendChild(inner);
      els.body.appendChild(surface);

      scroller = surface;
      sizer = inner;
      canvas = cv;

      const onScroll = (): void => {
        // The canvas follows the scroll synchronously so it never visually detaches, and the
        // repaint that re-windows the lanes is coalesced onto the next frame.
        cv.style.transform = `translateY(${String(surface.scrollTop)}px)`;
        if (namesHost !== null) {
          namesHost.style.transform = `translateY(${String(-surface.scrollTop)}px)`;
        }
        deps.onResize();
      };
      surface.addEventListener("scroll", onScroll);
      scrollListener = onScroll;

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
      const surface = scroller;
      const inner = sizer;
      const cv = canvas;
      const els = elements;
      if (surface === null || inner === null || cv === null || els === null) return;

      const rows = content.model.rows;
      const laneHeight = deps.laneHeight();
      const width = Math.max(0, Math.floor(content.width));
      const height = Math.max(0, Math.floor(content.height));
      const total = rows.length * laneHeight;
      inner.style.height = `${String(total)}px`;

      const label = content.lanesLabel(content.model);
      if (label !== lastAriaLabel) {
        lastAriaLabel = label;
        surface.setAttribute("aria-label", label);
      }

      const dpr =
        typeof globalThis.devicePixelRatio === "number" && globalThis.devicePixelRatio > 0
          ? globalThis.devicePixelRatio
          : 1;
      cv.style.width = `${String(width)}px`;
      cv.style.height = `${String(height)}px`;
      if (cv.width !== Math.round(width * dpr)) cv.width = Math.round(width * dpr);
      if (cv.height !== Math.round(height * dpr)) cv.height = Math.round(height * dpr);
      const ctx = cv.getContext("2d");
      if (ctx === null || width <= 0 || height <= 0) return;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, width, height);
      ctx.fillStyle = content.colors.bg;
      ctx.fillRect(0, 0, width, height);
      ctx.font = content.font;
      ctx.textBaseline = "middle";

      const scrollTop = surface.scrollTop;
      cv.style.transform = `translateY(${String(scrollTop)}px)`;
      const first = Math.max(0, Math.floor(scrollTop / laneHeight) - LANE_OVERSCAN);
      const last = Math.min(
        rows.length - 1,
        Math.ceil((scrollTop + height) / laneHeight) + LANE_OVERSCAN,
      );

      // Rebuilt only when the roster itself moved: a scroll repaint must not walk every resource.
      if (indexedRows !== rows) {
        indexedRows = rows;
        laneIndex.clear();
        for (let i = 0; i < rows.length; i += 1) {
          laneIndex.set(String((rows[i] as LaneRow).resourceId), i);
        }
      }

      const plotHeight = Math.max(0, laneHeight - LANE_PAD_TOP - LANE_PAD_BOTTOM);
      const gutterHosted = content.gutterWidth > 0;

      // The accessible proxies and the gutter names are virtualized alongside the paint.
      const visible = Math.max(0, last - first + 1);
      ensureNodes(ariaNodes, inner, visible, "sg-load-lanes__lane");
      if (gutterHosted) {
        if (namesHost === null) {
          const host = els.gutter.ownerDocument.createElement("div");
          host.className = "sg-load-lanes__names";
          host.setAttribute("aria-hidden", "true");
          Object.assign(host.style, {
            position: "relative",
            width: "100%",
            height: "100%",
            overflow: "hidden",
            pointerEvents: "none",
          });
          els.gutter.appendChild(host);
          namesHost = host;
        }
        namesHost.style.font = content.font;
        namesHost.style.color = content.colors.text;
        // Mirrors the surface's own scroll, so every name stays beside its lane.
        namesHost.style.transform = `translateY(${String(-scrollTop)}px)`;
        ensureNodes(nameNodes, namesHost, visible, "sg-load-lanes__label");
      } else if (namesHost !== null) {
        namesHost.remove();
        namesHost = null;
        nameNodes.length = 0;
      }

      for (let slot = 0; slot < ariaNodes.length; slot += 1) {
        const node = ariaNodes[slot] as HTMLElement;
        const index = first + slot;
        const row = index <= last ? rows[index] : undefined;
        const nameNode = nameNodes[slot];
        if (row === undefined) {
          node.style.display = "none";
          if (nameNode !== undefined) nameNode.style.display = "none";
          continue;
        }
        node.style.display = "block";
        node.style.top = `${String(index * laneHeight)}px`;
        node.style.height = `${String(laneHeight)}px`;
        node.setAttribute("role", "img");
        node.setAttribute("aria-label", content.laneLabel(row, content.model));
        if (nameNode !== undefined) {
          nameNode.style.display = "block";
          nameNode.style.top = `${String(index * laneHeight)}px`;
          nameNode.style.height = `${String(laneHeight)}px`;
          nameNode.style.lineHeight = `${String(laneHeight)}px`;
          if (nameNode.textContent !== row.resourceName) nameNode.textContent = row.resourceName;
        }

        // --- the lane's own paint, in canvas coordinates -----------------------------------
        const top = index * laneHeight - scrollTop;
        if (top + laneHeight < 0 || top > height) continue;

        // Zebra striping: alternating row background, kept well below the bars in contrast.
        if (index % 2 === 1) {
          ctx.fillStyle = content.colors.zebra;
          ctx.fillRect(0, top, width, laneHeight);
        }

        const projection = projectLane({
          results: row.results,
          threshold: row.lineValue,
          plotHeight,
          xOf: content.xOf,
          ...(content.model.sharedMax === undefined ? {} : { scaleMax: content.model.sharedMax }),
          ...(deps.laneValueLabels
            ? {
                valueLabels: {
                  format: content.formatValue,
                  measure: (text: string) => ctx.measureText(text).width,
                  plotWidth: width,
                },
              }
            : {}),
        });

        for (const box of projection.boxes) {
          ctx.fillStyle = content.colors.fill;
          ctx.fillRect(box.x, top + box.top, box.width, box.height);
          if (box.over !== undefined) {
            ctx.fillStyle = content.colors.overFill;
            ctx.fillRect(box.x, top + box.over.top, box.width, box.over.height);
            paintHatch(
              ctx,
              box.x,
              top + box.over.top,
              box.width,
              box.over.height,
              content.colors.bg,
            );
          }
        }

        // The dashed stepped per-bucket reference line.
        if (projection.referenceSegments.length > 0) {
          ctx.save();
          ctx.strokeStyle = content.colors.reference;
          ctx.lineWidth = CAPACITY_LINE_THICKNESS;
          ctx.setLineDash([3, 3]);
          ctx.beginPath();
          for (const segment of projection.referenceSegments) {
            const y = Math.round(top + segment.top) + 0.5;
            ctx.moveTo(segment.x, y);
            ctx.lineTo(segment.x + segment.width, y);
          }
          ctx.stroke();
          ctx.restore();
        }

        if (deps.laneValueLabels) {
          for (const box of projection.boxes) {
            const boxLabel = box.label;
            if (boxLabel === undefined) continue;
            paintLabel(
              ctx,
              boxLabel.text,
              boxLabel.x,
              top + laneHeight - LANE_PAD_BOTTOM - 6,
              boxLabel.width,
              content.colors,
            );
          }
        }

        // The in-plot name fallback, for a composition whose gutter column has no width.
        if (!gutterHosted) {
          paintLabel(
            ctx,
            row.resourceName,
            4,
            top + laneHeight / 2,
            ctx.measureText(row.resourceName).width,
            content.colors,
          );
        }

        // The lane separator, drawn last so nothing paints over it.
        ctx.strokeStyle = content.colors.separator;
        ctx.lineWidth = 1;
        ctx.beginPath();
        const sepY = Math.round(top + laneHeight) - 0.5;
        ctx.moveTo(0, sepY);
        ctx.lineTo(width, sepY);
        ctx.stroke();
      }
    },

    reveal: (resourceId, smooth) => {
      const surface = scroller;
      if (surface === null) return;
      const index = laneIndex.get(String(resourceId));
      if (index === undefined) return;
      const laneHeight = deps.laneHeight();
      const height = surface.clientHeight;
      const top = index * laneHeight;
      const current = surface.scrollTop;
      let target = current;
      if (top < current) target = top;
      else if (top + laneHeight > current + height) target = top + laneHeight - height;
      if (target === current) return;
      if (namesHost !== null) namesHost.style.transform = `translateY(${String(-target)}px)`;
      if (smooth && typeof surface.scrollTo === "function") {
        surface.scrollTo({ top: target, behavior: "smooth" });
        return;
      }
      surface.scrollTop = target;
    },

    dispose: () => {
      observer?.disconnect();
      observer = null;
      if (scroller !== null && scrollListener !== null) {
        scroller.removeEventListener("scroll", scrollListener);
      }
      scrollListener = null;
      namesHost?.remove();
      namesHost = null;
      nameNodes.length = 0;
      ariaNodes.length = 0;
      scroller?.remove();
      scroller = null;
      sizer = null;
      canvas = null;
      laneIndex.clear();
      if (elements !== null) {
        elements.pane.classList.remove(LOAD_PANE_CLASS);
        elements = null;
      }
    },
  };
}
