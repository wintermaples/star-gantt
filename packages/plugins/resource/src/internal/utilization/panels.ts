// docs/specs/plugins/resource.md §3.5 — the summary and trend panels.
/**
 * Two `sdk/dialog` panels hosted by the gantt root while `stargantt.view` resolves (the tracking
 * `cost/wire.ts` `panelHost()` precedent — gated per call, never latched): the team-capacity
 * summary and the demand-vs-supply trend graph. Content re-renders on the data/pool notifications
 * that already drive this area's `state` (both panels count toward `visualsActive()`, §1.2).
 */
import { createDialog } from "@stargantt/sdk";
import type { Dialog } from "@stargantt/sdk";
import type { Store } from "@stargantt/core";
// Type-only import: loads `@stargantt/plugin-view`'s `declare module "@stargantt/core"`
// augmentation (`stargantt.view`, `stargantt.theme`) so the `ctx.useOptional` calls below check
// against the real declarations. Erased at emit.
import type { ThemeService, ViewService } from "@stargantt/plugin-view";
import type { ResourceAreaDeps } from "../areas";
import type { RoleDemand, TeamCapacitySummary, TrendPoint } from "../engine/rollups";
import type { UtilizationState } from "./service";

export interface PanelsDeps {
  demandByRole(): readonly RoleDemand[];
  teamSummary(): readonly TeamCapacitySummary[];
  trend(): readonly TrendPoint[];
  /** Subscribed to re-render whichever panel is currently open (§3.5: "re-renders on the data/pool
   *  notifications"). */
  state: Store<UtilizationState>;
}

export interface PanelsHandle {
  /** Opens (or re-renders an already-open) summary panel; `false` = `stargantt.view` unresolved. */
  openSummary(): boolean;
  closeSummary(): void;
  openTrend(): boolean;
  closeTrend(): void;
}

const DEMAND_COLOR_FALLBACK = "#1d4ed8";
const SUPPLY_COLOR_FALLBACK = "#2e7d32";

function panelHost(deps: ResourceAreaDeps): HTMLElement | undefined {
  const view: ViewService | undefined = deps.ctx.useOptional("stargantt.view");
  return view === undefined ? undefined : deps.ctx.root;
}

function renderSummaryBody(body: HTMLElement, deps: ResourceAreaDeps, panels: PanelsDeps): void {
  const { messages } = deps;
  body.textContent = "";
  const doc = body.ownerDocument;
  for (const team of panels.teamSummary()) {
    const line = doc.createElement("div");
    line.className = "sg-ru-summary__team";
    line.textContent = messages.teamCardLine(team);
    body.appendChild(line);
  }
  const roles = panels.demandByRole();
  if (roles.length > 0) {
    const heading = doc.createElement("div");
    heading.className = "sg-ru-summary__role-title";
    heading.style.fontWeight = "600";
    heading.style.marginTop = "8px";
    heading.textContent = messages.roleTitle;
    body.appendChild(heading);
    for (const role of roles) {
      const line = doc.createElement("div");
      line.className = "sg-ru-summary__role";
      line.textContent = messages.roleLine(role);
      body.appendChild(line);
    }
  }
}

function drawTrendGraph(canvas: HTMLCanvasElement, points: readonly TrendPoint[], demandColor: string, supplyColor: string): void {
  const g = canvas.getContext("2d");
  if (g === null) return;
  const width = canvas.width;
  const height = canvas.height;
  g.clearRect(0, 0, width, height);
  if (points.length === 0) return;
  let max = 0;
  for (const p of points) {
    if (p.demand > max) max = p.demand;
    if (p.supply > max) max = p.supply;
  }
  if (max <= 0) return;
  const stepX = points.length > 1 ? width / (points.length - 1) : 0;
  const yOf = (v: number): number => height - (v / max) * height;

  const drawLine = (values: readonly number[], color: string, dashed: boolean): void => {
    g.beginPath();
    g.strokeStyle = color;
    g.lineWidth = 2;
    g.setLineDash(dashed ? [4, 3] : []);
    values.forEach((v, i) => {
      const x = i * stepX;
      const y = yOf(v);
      if (i === 0) g.moveTo(x, y);
      else g.lineTo(x, y);
    });
    g.stroke();
    g.setLineDash([]);
  };
  drawLine(points.map((p) => p.demand), demandColor, false);
  drawLine(points.map((p) => p.supply), supplyColor, true);
}

function renderTrendBody(body: HTMLElement, deps: ResourceAreaDeps, panels: PanelsDeps): void {
  const { messages } = deps;
  body.textContent = "";
  const doc = body.ownerDocument;
  const points = panels.trend();
  const theme: ThemeService | undefined = deps.ctx.useOptional("stargantt.theme");
  const demandColor = theme?.get("--sg-ru-demand") || DEMAND_COLOR_FALLBACK;
  const supplyColor = theme?.get("--sg-ru-supply") || SUPPLY_COLOR_FALLBACK;

  const canvas = doc.createElement("canvas");
  canvas.width = 280;
  canvas.height = 120;
  canvas.setAttribute("role", "img");
  let peakDemand = 0;
  let peakSupply = 0;
  for (const p of points) {
    if (p.demand > peakDemand) peakDemand = p.demand;
    if (p.supply > peakSupply) peakSupply = p.supply;
  }
  const first = points[0];
  const last = points[points.length - 1];
  canvas.setAttribute(
    "aria-label",
    messages.trendLabel({
      bucketCount: points.length,
      rangeStart: first?.start ?? 0,
      rangeEnd: last?.end ?? 0,
      peakDemand,
      peakSupply,
    }),
  );
  body.appendChild(canvas);
  drawTrendGraph(canvas, points, demandColor, supplyColor);

  const legend = doc.createElement("div");
  legend.className = "sg-ru-trend__legend";
  legend.style.display = "flex";
  legend.style.gap = "12px";
  legend.style.marginTop = "6px";
  const demandLegend = doc.createElement("span");
  demandLegend.textContent = messages.demandLegend;
  demandLegend.style.color = demandColor;
  const supplyLegend = doc.createElement("span");
  supplyLegend.textContent = messages.supplyLegend;
  supplyLegend.style.color = supplyColor;
  legend.appendChild(demandLegend);
  legend.appendChild(supplyLegend);
  body.appendChild(legend);
}

/**
 * Wires the two panels; opens/closes are driven by `UtilizationService` (`./wire.ts`).
 *
 * §1.2's lazy freshness contract ("a composition with the utilization ... nest dormant, no
 * subscriber, and no reader pays ... ZERO aggregation work") extends to THIS module: `wirePanels`
 * itself is called unconditionally from `wireUtilization` (its returned handle is what
 * `openSummaryPanel`/`openTrendPanel` call even when no panel has ever opened), so it must not
 * subscribe to `panels.state` until a panel is actually open — an unconditional `state.subscribe`
 * at wire time would silently hold `state`'s own `subscriberCount` above zero forever, forcing
 * every data/pool notification into an eager recompute for the whole life of a composition that
 * never opens either panel. The subscription is armed on the first open and released once BOTH
 * panels are closed, re-arming on the next open — the "swap a variable, never re-own" idiom over
 * one stable owned wrapper, so the plugin's `ctx.own()` bag grows by exactly one entry regardless
 * of how many times a reader opens and closes a panel.
 */
export function wirePanels(deps: ResourceAreaDeps, panels: PanelsDeps): PanelsHandle {
  let summary: Dialog | undefined;
  let trend: Dialog | undefined;
  let stateSub: { dispose(): void } | undefined;

  function ensureSubscribed(): void {
    if (stateSub !== undefined) return;
    stateSub = panels.state.subscribe(() => {
      if (summary !== undefined) renderSummaryBody(summary.body, deps, panels);
      if (trend !== undefined) renderTrendBody(trend.body, deps, panels);
    });
  }
  function releaseIfIdle(): void {
    if (summary === undefined && trend === undefined && stateSub !== undefined) {
      stateSub.dispose();
      stateSub = undefined;
    }
  }

  deps.ctx.own({
    dispose: () => {
      summary?.dispose();
      trend?.dispose();
      stateSub?.dispose();
    },
  });

  return {
    openSummary(): boolean {
      const host = panelHost(deps);
      if (host === undefined) return false;
      summary?.dispose();
      ensureSubscribed();
      summary = createDialog({
        host,
        className: "sg-ru-panel sg-ru-summary",
        label: deps.messages.summaryTitle,
        closeButton: deps.messages.closeLabel,
        onClose: () => {
          summary?.dispose();
          summary = undefined;
          releaseIfIdle();
        },
        top: 24,
        minWidth: "260px",
        maxWidth: "min(320px, 92%)",
        maxHeight: "70%",
      });
      renderSummaryBody(summary.body, deps, panels);
      return true;
    },
    closeSummary(): void {
      summary?.dispose();
      summary = undefined;
      releaseIfIdle();
    },
    openTrend(): boolean {
      const host = panelHost(deps);
      if (host === undefined) return false;
      trend?.dispose();
      ensureSubscribed();
      trend = createDialog({
        host,
        className: "sg-ru-panel sg-ru-trend",
        label: deps.messages.trendTitle,
        closeButton: deps.messages.closeLabel,
        onClose: () => {
          trend?.dispose();
          trend = undefined;
          releaseIfIdle();
        },
        top: 72,
        offsetX: 48,
        minWidth: "320px",
        maxWidth: "min(360px, 92%)",
      });
      renderTrendBody(trend.body, deps, panels);
      return true;
    },
    closeTrend(): void {
      trend?.dispose();
      trend = undefined;
      releaseIfIdle();
    },
  };
}
