// docs/specs/plugins/tracking.md §2.15 / §2.16 — the two on-demand EVM panels: the KPI dashboard
// and the S-curve chart, built on `sdk/dialog`'s `createDialog`.
//
// Hostless: built off a host element and callbacks, so both panels are unit-testable without
// booting a chart. The caller owns lifetime and teardown; the dialog owns its own chrome listeners
// and drains them in `dispose()`, so nothing accumulates in the plugin's `ctx.own()` bag per
// open/close cycle.
//
// §2.16 chrome/sizing: `minWidth: "360px"`, `top: 24`, `maxHeight: "80%"`, `resizable: true`, with
// header/title, scrolling body, footer buttons, drag, Escape and pointer containment all coming
// from `createDialog` verbatim.
import { createDialog } from "@stargantt/sdk";
import type { Dialog } from "@stargantt/sdk";
import type { EvmCurvePoint, EvmIndices, EvmKpiTile, EvmPanelModel } from "../../types";
import type { TrackingMessages } from "../messages";
import { formatAmount, formatIndex } from "../shared/format";

/** What a panel needs from the area's wiring. */
export interface EvmPanelCallbacks {
  close(): void;
  /** Theme lookup, resolved per use by the caller; `""` without `stargantt.theme` (§8). */
  themeGet(token: string): string;
  /**
   * The host body renderer, already contained by the §2.13 LATCHED seam: it fills `body` and
   * returns `true`, or returns `false` when there is none or it declined (a throw now, or on an
   * earlier call against either panel), in which case the caller empties the body and runs the
   * built-in rendering into it. Never throws — containment lives in the caller.
   */
  renderBody(body: HTMLElement, model: EvmPanelModel): boolean;
}

/** The curve panel additionally needs the per-point accessible text. */
export interface EvmCurveCallbacks extends EvmPanelCallbacks {
  /** Guarded catalog builder — never throws (the catalog's own resolver contains it). */
  pointText(point: Readonly<EvmCurvePoint>): string;
}

/** A mounted panel: its box, and the two things the caller does to it. */
export interface EvmPanel {
  root: HTMLElement;
  /** Moves focus into the panel (the dialog's own first-focusable rule). */
  focus(): void;
  /** Removes the panel and every listener it attached (its dialog's `dispose()`). Idempotent. */
  dispose(): void;
}

// WCAG 2.2 §2.5.8 — a 24px-tall, 64px-wide button clears the target-size minimum with room for its
// border, and the dialog's own footer supplies the 8px gap that keeps neighbours from crowding it.
const BUTTON_STYLE = "min-height:24px;min-width:64px;padding:4px 12px;cursor:pointer;font:inherit;";

// The plain-language layer. Both sizes sit at the same `opacity:.75` the tile labels
// use: over `--sg-dialog-bg` / `--sg-dialog-fg` that clears the 4.5:1 text minimum in both color
// schemes. The sizes are 12px — the gantt-ui-ux visual-design reference puts
// the practical floor for real content at 12px, and a gloss is the one thing on this panel a reader
// unfamiliar with EVM actually needs to read.
const DESCRIPTION_STYLE = "font-size:12px;line-height:1.4;opacity:.75;margin-bottom:8px;";
const GLOSS_STYLE = "font-size:12px;line-height:1.35;opacity:.75;margin-top:2px;";
const LABEL_STYLE = "font-size:12px;line-height:1.35;opacity:.75;";
const VALUE_STYLE = "font-weight:600;font-size:15px;line-height:1.3;";
const FLAG_STYLE = "font-size:12px;line-height:1.35;margin-top:2px;";

/** One dialog scaffold for both panels — the §2.16 sizing, verbatim. */
function openDialog(
  host: HTMLElement,
  className: string,
  label: string,
  onClose: () => void,
): Dialog {
  return createDialog({
    host,
    className,
    label,
    minWidth: "360px",
    top: 24,
    maxHeight: "80%",
    resizable: true,
    onClose,
  });
}

/**
 * Fills the panel's body — the one element a host `renderPanel` owns (§2.13): the shared dialog's
 * own `body`, already the scrolling flex item every panel of this plugin shares. Returning without
 * appending is not a fallback signal; a throw is.
 */
function fillBody(
  body: HTMLElement,
  model: EvmPanelModel,
  cb: EvmPanelCallbacks,
  builtIn: (body: HTMLElement) => void,
): void {
  if (cb.renderBody(body, model)) return;
  // A declining host may have appended half a body before it threw: hand the built-in rendering a
  // clean element.
  body.textContent = "";
  builtIn(body);
}

/** The panel's one-line plain-language description (§2.15). */
function description(doc: Document, body: HTMLElement, text: string): void {
  const el = doc.createElement("div");
  el.textContent = text;
  el.setAttribute("style", DESCRIPTION_STYLE);
  body.appendChild(el);
}

/**
 * Appends the Close button to `dialog.footer`. The button lives inside the dialog's own subtree, so
 * `dialog.dispose()` releases this listener with the rest.
 */
function closeButton(dialog: Dialog, label: string, cb: EvmPanelCallbacks): void {
  const doc = dialog.root.ownerDocument;
  const el = doc.createElement("button");
  el.textContent = label;
  el.setAttribute("type", "button");
  el.setAttribute("style", BUTTON_STYLE);
  el.addEventListener("click", () => cb.close());
  dialog.footer.appendChild(el);
}

/* --- KPI dashboard (§2.15) ------------------------------------------------ */

/**
 * Lays out the ten built-in KPI tiles from the project metrics (§2.15).
 *
 * Every tile carries a plain-language gloss so the panel reads without an EVM glossary,
 * and the two status flags are TEXTUAL — meaning is never carried by color alone.
 */
export function dashboardTiles(
  m: Readonly<EvmIndices>,
  messages: TrackingMessages,
): EvmKpiTile[] {
  const tiles: EvmKpiTile[] = [
    { label: messages.bacLabel, value: formatAmount(m.bac), gloss: messages.bacGloss },
    { label: messages.pvLabel, value: formatAmount(m.pv), gloss: messages.pvGloss },
    { label: messages.evLabel, value: formatAmount(m.ev), gloss: messages.evGloss },
    { label: messages.acLabel, value: formatAmount(m.ac), gloss: messages.acGloss },
    { label: messages.svLabel, value: formatAmount(m.sv), gloss: messages.svGloss },
    { label: messages.cvLabel, value: formatAmount(m.cv), gloss: messages.cvGloss },
    { label: messages.spiLabel, value: formatIndex(m.spi), gloss: messages.spiGloss },
    { label: messages.cpiLabel, value: formatIndex(m.cpi), gloss: messages.cpiGloss },
    { label: messages.eacLabel, value: formatAmount(m.eac), gloss: messages.eacGloss },
    { label: messages.etcLabel, value: formatAmount(m.etc), gloss: messages.etcGloss },
  ];
  if (m.spi !== undefined && m.spi < 1) (tiles[6] as EvmKpiTile).flag = messages.spiBehindFlag;
  if (m.cpi !== undefined && m.cpi < 1) (tiles[7] as EvmKpiTile).flag = messages.cpiOverFlag;
  return tiles;
}

/** Whether the metrics carry any figure worth a dashboard (§2.15's empty state). */
export function hasDashboardData(m: Readonly<EvmIndices>): boolean {
  return m.bac !== 0 || m.pv !== 0 || m.ev !== 0 || m.ac !== 0;
}

function dashboardBody(
  doc: Document,
  body: HTMLElement,
  tiles: readonly EvmKpiTile[],
  messages: TrackingMessages,
): void {
  description(doc, body, messages.dashboardDescription);
  if (tiles.length === 0) {
    const empty = doc.createElement("div");
    empty.textContent = messages.evmCurveEmpty;
    body.appendChild(empty);
    return;
  }
  // The tiles reflow (`auto-fit`) instead of forcing a fixed five-column width, and the body owns
  // any remaining overflow, so every tile stays reachable at the minimum 720×540 viewport where the
  // dialog can be only a few hundred px wide. The 150px track floor is what makes a gloss readable
  // there — at 96px it wrapped to five words a line.
  const grid = doc.createElement("div");
  grid.setAttribute(
    "style",
    "display:grid;grid-template-columns:repeat(auto-fit, minmax(150px, 1fr));gap:8px;",
  );
  for (const tile of tiles) {
    const card = doc.createElement("div");
    // `--sg-panel-border` is a plain CSS custom property in an inline `style` attribute,
    // NOT routed through the `themeGet(token)` seam this file uses for the curve panel's
    // canvas strokes below. That is deliberate, not an oversight (review minor): `themeGet` exists
    // because canvas drawing has no CSS access at all — a `strokeStyle` has to be resolved to a
    // concrete color string in JS. A plain DOM element like this card does not share that problem:
    // `var(--sg-panel-border, #c8d0da)` resolves through the ordinary CSS custom-property cascade
    // from whatever ancestor (the bundled default stylesheet, or a host override) defines the
    // token, with zero JS plumbing needed — funneling it through `themeGet` would only add a
    // parameter to `dashboardBody` to reproduce what the browser already does for free.
    card.setAttribute(
      "style",
      "border:1px solid var(--sg-panel-border, #c8d0da);border-radius:4px;padding:6px 8px;",
    );
    const label = doc.createElement("div");
    label.textContent = tile.label;
    label.setAttribute("style", LABEL_STYLE);
    card.appendChild(label);
    const value = doc.createElement("div");
    value.textContent = tile.value;
    value.setAttribute("style", VALUE_STYLE);
    card.appendChild(value);
    if (tile.gloss !== undefined && tile.gloss !== "") {
      const gloss = doc.createElement("div");
      gloss.textContent = tile.gloss;
      gloss.setAttribute("style", GLOSS_STYLE);
      card.appendChild(gloss);
    }
    if (tile.flag !== undefined) {
      const flag = doc.createElement("div");
      flag.textContent = `⚠ ${tile.flag}`;
      flag.setAttribute("style", FLAG_STYLE);
      card.appendChild(flag);
    }
    grid.appendChild(card);
  }
  body.appendChild(grid);
}

/** Mounts the KPI dashboard panel over `host`. */
export function createDashboardPanel(
  host: HTMLElement,
  tiles: readonly EvmKpiTile[],
  messages: TrackingMessages,
  cb: EvmPanelCallbacks,
): EvmPanel {
  const dialog = openDialog(host, "sg-evm-dashboard", messages.dashboardTitle, cb.close);
  const doc = dialog.root.ownerDocument;
  fillBody(dialog.body, { panel: "dashboard", tiles }, cb, (body) =>
    dashboardBody(doc, body, tiles, messages),
  );
  closeButton(dialog, messages.panelClose, cb);
  return { root: dialog.root, focus: () => dialog.focus(), dispose: () => dialog.dispose() };
}

/* --- S-curve panel (§2.15) ------------------------------------------------ */

export const CURVE_WIDTH = 360;
export const CURVE_HEIGHT = 140;

interface XY {
  x: number;
  y: number;
}

function polyline(g: CanvasRenderingContext2D, points: readonly XY[]): void {
  if (points.length === 0) return;
  g.beginPath();
  g.moveTo((points[0] as XY).x, (points[0] as XY).y);
  for (let i = 1; i < points.length; i += 1) g.lineTo((points[i] as XY).x, (points[i] as XY).y);
  g.stroke();
}

/** Maps curve points into canvas space: time across, cumulative amount up, 4 px margins. */
export function curveGeometry(
  points: readonly EvmCurvePoint[],
  width: number,
  height: number,
): { pv: XY[]; ev: XY[]; ac: XY[] } {
  const pv: XY[] = [];
  const ev: XY[] = [];
  const ac: XY[] = [];
  if (points.length === 0) return { pv, ev, ac };
  const first = (points[0] as EvmCurvePoint).t;
  const last = (points[points.length - 1] as EvmCurvePoint).t;
  const span = Math.max(1, last - first);
  let peak = 0;
  for (const p of points) peak = Math.max(peak, p.pv, p.ev ?? 0, p.ac ?? 0);
  const margin = 4;
  const sx = (t: number): number => margin + ((t - first) / span) * (width - 2 * margin);
  const sy = (v: number): number =>
    margin + (peak === 0 ? 1 : 1 - v / peak) * (height - 2 * margin);
  for (const p of points) {
    pv.push({ x: sx(p.t), y: sy(p.pv) });
    if (p.ev !== undefined) ev.push({ x: sx(p.t), y: sy(p.ev) });
    if (p.ac !== undefined) ac.push({ x: sx(p.t), y: sy(p.ac) });
  }
  return { pv, ev, ac };
}

function curveBody(
  doc: Document,
  body: HTMLElement,
  points: readonly EvmCurvePoint[],
  messages: TrackingMessages,
  cb: EvmCurveCallbacks,
): void {
  description(doc, body, messages.curveDescription);

  if (points.length === 0) {
    const empty = doc.createElement("div");
    empty.textContent = messages.evmCurveEmpty;
    body.appendChild(empty);
    return;
  }

  const canvas = doc.createElement("canvas") as HTMLCanvasElement;
  canvas.width = CURVE_WIDTH;
  canvas.height = CURVE_HEIGHT;
  canvas.setAttribute("role", "img");
  canvas.setAttribute("aria-label", points.map((p) => cb.pointText(p)).join("; "));
  const g = typeof canvas.getContext === "function" ? canvas.getContext("2d") : null;
  if (g !== null && g !== undefined) {
    const geometry = curveGeometry(points, CURVE_WIDTH, CURVE_HEIGHT);
    const dash = typeof g.setLineDash === "function";
    // Line STYLE, not color alone, distinguishes the three series (§2.15): PV solid, EV dashed
    // [6,3], AC dashed [2,2]. The token defaults are the §2.15 values.
    g.lineWidth = 1.5;
    g.strokeStyle = cb.themeGet("--sg-evm-pv") || "#1565c0";
    polyline(g, geometry.pv);
    g.strokeStyle = cb.themeGet("--sg-evm-ev") || "#2e7d32";
    if (dash) g.setLineDash([6, 3]);
    polyline(g, geometry.ev);
    g.strokeStyle = cb.themeGet("--sg-evm-ac") || "#c62828";
    if (dash) g.setLineDash([2, 2]);
    polyline(g, geometry.ac);
    if (dash) g.setLineDash([]);
  }
  body.appendChild(canvas);

  // The same data as text — the canvas alone would make the curve vision-dependent.
  const list = doc.createElement("ul");
  list.setAttribute("style", "margin:8px 0 0;padding-left:16px;max-height:160px;overflow-y:auto;");
  for (const p of points) {
    const item = doc.createElement("li");
    item.textContent = cb.pointText(p);
    list.appendChild(item);
  }
  body.appendChild(list);
}

/** Mounts the S-curve panel over `host`. */
export function createCurvePanel(
  host: HTMLElement,
  points: readonly EvmCurvePoint[],
  messages: TrackingMessages,
  cb: EvmCurveCallbacks,
): EvmPanel {
  const dialog = openDialog(host, "sg-evm-curve", messages.evmCurveTitle, cb.close);
  const doc = dialog.root.ownerDocument;
  fillBody(dialog.body, { panel: "curve", points }, cb, (body) =>
    curveBody(doc, body, points, messages, cb),
  );
  closeButton(dialog, messages.panelClose, cb);
  return { root: dialog.root, focus: () => dialog.focus(), dispose: () => dialog.dispose() };
}
