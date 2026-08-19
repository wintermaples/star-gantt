// docs/specs/plugins/scheduling.md §7.3 — the two `renderer/layers` passes: critical-link emphasis
// (order 72) and free-float extension bars (order 56). Hostless: every canvas and lookup is
// injected. The bar overlay half is in `./overlays.ts` per this package's file plan, §13.
import type { Link, TaskId } from "@stargantt/plugin-data-store";
import { forEachVisibleRow } from "@stargantt/sdk";
import type { BarBox, TaskBarsService } from "@stargantt/plugin-task-bars";
import type { RowsService } from "@stargantt/plugin-tree-grid";
import type { Viewport } from "@stargantt/plugin-view";
import type { CriticalPathAnalysis } from "./analysis";
import type { ColorResolver } from "./colors";

/** The one member this area's paint passes read from `stargantt.task-bars`. */
type TaskBarsReader = Pick<TaskBarsService, "barRect">;

export interface LinkLayerDeps {
  /** The critical `Link` objects of the current analysis — cached with it, never a store scan. */
  criticalLinks(): readonly Link[];
  /** `TaskBarsService.barRect` — content-coordinate box, answers for off-screen bars too. */
  bars: TaskBarsReader;
  colors: ColorResolver;
}

/** The two anchor points a link's type dictates, in content coordinates. */
function anchors(
  link: Readonly<Link>,
  source: Readonly<BarBox>,
  target: Readonly<BarBox>,
): { sx: number; sy: number; tx: number; ty: number } {
  const fromEnd = link.type === "FS" || link.type === "FF";
  const toEnd = link.type === "FF" || link.type === "SF";
  return {
    sx: fromEnd ? source.x + source.width : source.x,
    sy: source.y + source.height / 2,
    tx: toEnd ? target.x + target.width : target.x,
    ty: target.y + target.height / 2,
  };
}

/**
 * `renderer/layers` draw (order 72, §3.2): a 2.5px elbow polyline in the critical color over every
 * critical link. The route is this area's own simple elbow; pixel coincidence with §5's routing is
 * not contracted, and the layer draws whether or not the links UI is showing (§7.3).
 */
export function createLinkLayer(
  deps: LinkLayerDeps,
): (g: CanvasRenderingContext2D, vp: Readonly<Viewport>) => void {
  const STUB = 8;
  return (g, vp) => {
    // The critical links only, cached alongside the analysis — never a scan over every link.
    const criticalLinks = deps.criticalLinks();
    if (criticalLinks.length === 0) return;

    g.strokeStyle = deps.colors.critical();
    g.lineWidth = 2.5;
    g.lineJoin = "round";

    for (const link of criticalLinks) {
      const source = deps.bars.barRect(link.sourceId);
      const target = deps.bars.barRect(link.targetId);
      if (source === undefined || target === undefined) continue;
      const a = anchors(link, source, target);
      const sx = a.sx - vp.scrollLeft;
      const sy = a.sy - vp.scrollTop;
      const tx = a.tx - vp.scrollLeft;
      const ty = a.ty - vp.scrollTop;
      // Cull: skip links entirely outside the viewport.
      const minX = Math.min(sx, tx) - STUB;
      const maxX = Math.max(sx, tx) + STUB;
      const minY = Math.min(sy, ty);
      const maxY = Math.max(sy, ty);
      if (maxX < 0 || minX > vp.width || maxY < 0 || minY > vp.height) continue;

      const dir = tx >= sx ? 1 : -1;
      g.beginPath();
      g.moveTo(sx, sy);
      g.lineTo(sx + STUB * dir, sy);
      g.lineTo(sx + STUB * dir, ty);
      g.lineTo(tx, ty);
      g.stroke();
    }
  };
}

export interface FloatLayerDeps {
  analysis(): CriticalPathAnalysis;
  bars: TaskBarsReader;
  /** The row model, when tree-grid is composed — lets paint walk only the visible rows. */
  rows(): RowsService | undefined;
  /** The live px-per-ms conversion factor. */
  pxPerMs(): number;
  colors: ColorResolver;
}

/**
 * `renderer/layers` draw (order 56, §3.2/§7.3): each visible task's free float as a slim
 * translucent extension bar after the bar's right edge, closed by a 1px end tick flush at the
 * band's outer end, spanning the full bar height inset 2px top and bottom.
 */
export function createFloatLayer(
  deps: FloatLayerDeps,
): (g: CanvasRenderingContext2D, vp: Readonly<Viewport>) => void {
  return (g, vp) => {
    const { floats } = deps.analysis();
    if (floats.size === 0) return;
    const pxPerMs = deps.pxPerMs();
    if (!(pxPerMs > 0)) return;

    g.fillStyle = deps.colors.float();
    const paintOne = (id: TaskId, f: { freeFloat: number }): void => {
      if (!(f.freeFloat > 0)) return;
      const bar = deps.bars.barRect(id);
      if (bar === undefined) return;
      const x = bar.x + bar.width - vp.scrollLeft;
      const width = f.freeFloat * pxPerMs;
      const y = bar.y - vp.scrollTop;
      if (x > vp.width || x + width < 0 || y > vp.height || y + bar.height < 0) return;
      const stripHeight = Math.max(4, bar.height / 3);
      const stripY = y + (bar.height - stripHeight) / 2;
      g.fillRect(x, stripY, width, stripHeight);
      // End tick: full bar height inset 2px top/bottom, marks where the float runs out.
      g.fillRect(x + width - 1, y + 2, 1, bar.height - 4);
    };

    // Walk only the visible row range when a row model is composed, so a 100k-task chart pays for
    // the rows on screen, not every float in the map (§7.3).
    const rows = deps.rows();
    if (rows !== undefined) {
      forEachVisibleRow(rows, vp, (row) => {
        const id = rows.taskIdAt(row);
        if (id === undefined) return;
        const f = floats.get(id);
        if (f !== undefined) paintOne(id, f);
      });
      return;
    }
    for (const [id, f] of floats) paintOne(id, f);
  };
}
