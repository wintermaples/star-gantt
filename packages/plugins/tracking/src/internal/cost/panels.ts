// docs/specs/plugins/tracking.md §2.10 / §2.11 / §2.13 / §2.16 — the three on-demand cost panels
// (budget-vs-actual table, cumulative cost curve, breakdown chart) and the host body seam they
// share.
//
// Hostless: each factory takes a mount element and plain callbacks — never a `PluginContext` or a
// `CostService` — so every panel is unit-testable against a real DOM with no `Gantt.create`.
//
// §2.16 chrome comes from `sdk/dialog`'s `createDialog` verbatim: role/label, scrolling body,
// footer bar, drag, resize grip, Escape, pointer containment, `--sg-dialog-*` tokens, plus the
// cost/EVM sizing (`minWidth: "360px"`, `top: 24`, `maxHeight: "80%"`, `resizable: true`).
//
// §2.13: the plugin builds the chrome and hands the seam the EMPTY scrolling body. This module runs
// exactly ONE seam call and reports its outcome; the LATCH — one seam shared by all three panels,
// first throw disabling it for the instance's life — lives in `wire.ts` (`sdk/dom`'s `latchedSeam`).
import { createDialog } from "@stargantt/sdk";
import type { Dialog } from "@stargantt/sdk";
import type { TaskId } from "@stargantt/plugin-data-store";
import type {
  BreakdownEntryData,
  CostCurvePoint,
  CostFormulaValue,
  CostPanelRenderContext,
  CostType,
  CostValues,
  TableRow,
} from "../../types";
import type { TrackingMessages } from "../messages";

/**
 * The host body seam, already wrapped in its latch by `wire.ts`.
 *
 * Returns `true` when the host rendered the body (so the built-in rendering is skipped) and `false`
 * when it threw now — or had thrown on any earlier call, in any of the three panels — in which case
 * the body is emptied and the built-in rendering takes over.
 */
export type CostPanelSeam = (host: HTMLElement, ctx: CostPanelRenderContext) => boolean;

/** What every cost panel is handed. */
export interface CostPanelCallbacks {
  close(): void;
  /** Theme lookup; absent without `stargantt.theme`, in which case the documented fallbacks apply. */
  themeGet?: ((token: string) => string) | undefined;
  /** The §2.13 seam. Absent when `cost.renderPanel` was not configured. */
  seam?: CostPanelSeam | undefined;
}

/** A mounted cost panel. */
export interface CostPanel {
  root: HTMLElement;
  /** Moves focus into the panel (the dialog's own first-focusable rule). */
  focus(): void;
  /** Removes the panel and every listener it attached. Idempotent. */
  dispose(): void;
}

/**
 * Runs the §2.13 body seam into `host` (already mounted, empty): the host renderer when one is
 * configured and un-latched, else `builtin` directly. A seam that declines (threw now, or is
 * latched off from an earlier throw) has the body emptied and `builtin` fills it instead.
 *
 * Returning without appending anything is NOT a fallback signal — an empty body is a legitimate
 * host choice.
 */
function renderPanelBody(
  host: HTMLElement,
  ctx: CostPanelRenderContext,
  cb: CostPanelCallbacks,
  builtin: (host: HTMLElement) => void,
): void {
  if (cb.seam === undefined) {
    builtin(host);
    return;
  }
  if (cb.seam(host, ctx)) return;
  while (host.firstChild !== null) host.removeChild(host.firstChild);
  builtin(host);
}

// ≥24×24 CSS px pointer target (WCAG 2.2 §2.5.8) on every button and every editable cell.
const BUTTON_STYLE = "min-height:24px;min-width:64px;padding:4px 12px;cursor:pointer;font:inherit;";

/**
 * §2.16 — one dialog scaffold for all three panels, with the cost/EVM sizing.
 *
 * `modal` by design: the table panel MUTATES task data (Apply dispatches one
 * `task/update` per changed row) and passes `true` — `aria-modal="true"` plus the Tab focus trap
 * `sdk/dialog` provides keep the interaction contained until the edit is committed or cancelled.
 * The curve and breakdown panels are read-only and pass `false` (the default).
 */
function openDialog(
  host: HTMLElement,
  className: string,
  label: string,
  onClose: () => void,
  modal = false,
): Dialog {
  return createDialog({
    host,
    className,
    label,
    modal,
    minWidth: "360px",
    top: 24,
    maxHeight: "80%",
    resizable: true,
    onClose,
  });
}

/**
 * Appends the panel's footer buttons. Listeners are attached directly to buttons living inside the
 * dialog's own subtree, so `dialog.dispose()` — which unmounts that whole subtree and drains its
 * own listener list — releases them too: nothing accumulates in the plugin's `ctx.own()` bag per
 * open/close cycle.
 */
function footerButtons(
  dialog: Dialog,
  buttons: readonly { label: string; onClick: () => void }[],
): void {
  const doc = dialog.root.ownerDocument;
  for (const b of buttons) {
    const button = doc.createElement("button");
    button.textContent = b.label;
    button.setAttribute("type", "button");
    button.setAttribute("style", BUTTON_STYLE);
    button.addEventListener("click", b.onClick);
    dialog.footer.appendChild(button);
  }
}

const panelOf = (dialog: Dialog): CostPanel => ({
  root: dialog.root,
  focus: () => dialog.focus(),
  dispose: () => dialog.dispose(),
});

/* ------------------------------------------------------------------ *
 * §2.10 budget-vs-actual table
 * ------------------------------------------------------------------ */

/** One gathered edit: only the fields whose inputs parse AND differ are present. */
export interface TableEdit {
  id: TaskId;
  fixedCost?: number;
  materialCost?: number;
  actualCost?: number;
}

export interface TableCallbacks extends CostPanelCallbacks {
  /** Commits the gathered edits — one `task/update` per changed task, each its own undo step. */
  apply(edits: readonly TableEdit[]): void;
  /** Amount renderer for the read-only cells (planned / actual / variance / totals). */
  amountText(v: number): string;
}

const CELL = "padding:2px 8px;text-align:right;white-space:nowrap;";
const INPUT_STYLE = "width:80px;min-height:24px;box-sizing:border-box;text-align:right;font:inherit;";

function parseAmount(text: string): number | undefined {
  if (text.trim() === "") return undefined;
  const v = Number(text);
  return Number.isFinite(v) && v >= 0 ? v : undefined;
}

export function createTablePanel(
  host: HTMLElement,
  rows: readonly TableRow[],
  formulas: readonly CostFormulaValue[],
  messages: TrackingMessages,
  cb: TableCallbacks,
): CostPanel {
  const dialog = openDialog(host, "sg-cost-table", messages.tableTitle, cb.close, true);
  const doc = dialog.root.ownerDocument;

  interface RowInputs {
    id: TaskId;
    values: Readonly<CostValues>;
    fixed: HTMLInputElement;
    material: HTMLInputElement;
    actual: HTMLInputElement;
  }
  // Populated by the built-in table below; stays empty when a host `renderPanel` replaced it, so
  // Apply then has nothing to gather (a custom body owns its own commit path, if any).
  const inputs: RowInputs[] = [];

  const numberInput = (value: number | undefined, label: string): HTMLInputElement => {
    const input = doc.createElement("input");
    input.setAttribute("type", "number");
    input.setAttribute("min", "0");
    // Every editable cell carries its own accessible name: the column plus the task it belongs to.
    input.setAttribute("aria-label", label);
    input.setAttribute("style", INPUT_STYLE);
    input.value = value === undefined ? "" : String(value);
    return input;
  };

  function buildTable(body: HTMLElement): void {
    const table = doc.createElement("table");
    table.setAttribute("style", "border-collapse:collapse;");
    const head = doc.createElement("tr");
    for (const text of [
      messages.tableTaskHeader,
      messages.tableEstimatedHeader,
      messages.tableActualHeader,
      messages.tableVarianceHeader,
      messages.tableFixedHeader,
      messages.tableMaterialHeader,
      messages.tableActualInputHeader,
    ]) {
      const th = doc.createElement("th");
      th.textContent = text;
      th.setAttribute("scope", "col");
      th.setAttribute("style", CELL + "font-weight:600;");
      head.appendChild(th);
    }
    table.appendChild(head);

    let totalEstimated = 0;
    let totalActual = 0;
    for (const { row, values } of rows) {
      totalEstimated += row.estimated;
      totalActual += row.actual;
      const tr = doc.createElement("tr");
      const name = doc.createElement("td");
      name.textContent = row.name;
      name.setAttribute("style", "padding:2px 8px;text-align:left;white-space:nowrap;");
      tr.appendChild(name);
      for (const text of [
        cb.amountText(row.estimated),
        cb.amountText(row.actual),
        // §2.10 — the over-budget alert is TEXTUAL, never color-only.
        cb.amountText(row.variance) + (row.over ? ` ⚠ ${messages.overBudgetFlag}` : ""),
      ]) {
        const td = doc.createElement("td");
        td.textContent = text;
        td.setAttribute("style", CELL);
        tr.appendChild(td);
      }
      const fixed = numberInput(values.fixedCost, `${messages.tableFixedHeader} — ${row.name}`);
      const material = numberInput(
        values.materialCost,
        `${messages.tableMaterialHeader} — ${row.name}`,
      );
      const actual = numberInput(
        values.actualCost,
        `${messages.tableActualInputHeader} — ${row.name}`,
      );
      for (const input of [fixed, material, actual]) {
        const td = doc.createElement("td");
        td.setAttribute("style", CELL);
        td.appendChild(input);
        tr.appendChild(td);
      }
      inputs.push({ id: row.id, values, fixed, material, actual });
      table.appendChild(tr);
    }

    const totals = doc.createElement("tr");
    const totalName = doc.createElement("td");
    totalName.textContent = messages.totalLabel;
    totalName.setAttribute("style", "padding:2px 8px;text-align:left;font-weight:600;");
    totals.appendChild(totalName);
    for (const text of [
      cb.amountText(totalEstimated),
      cb.amountText(totalActual),
      cb.amountText(totalActual - totalEstimated),
    ]) {
      const td = doc.createElement("td");
      td.textContent = text;
      td.setAttribute("style", CELL + "font-weight:600;");
      totals.appendChild(td);
    }
    table.appendChild(totals);

    // §2.12 — custom formulas render as extra rows BELOW the totals row, in configuration order,
    // spanning the read-only columns as one label cell plus the value.
    for (const formula of formulas) {
      const tr = doc.createElement("tr");
      const label = doc.createElement("td");
      label.textContent = formula.label;
      label.setAttribute("colspan", "6");
      label.setAttribute("style", "padding:2px 8px;text-align:left;");
      tr.appendChild(label);
      const value = doc.createElement("td");
      value.textContent = formula.text;
      value.setAttribute("style", CELL);
      tr.appendChild(value);
      table.appendChild(tr);
    }

    body.appendChild(table);
  }

  renderPanelBody(
    dialog.body,
    { panel: "table", model: { panel: "table", rows, formulas }, close: cb.close },
    cb,
    buildTable,
  );

  function gatherEdits(): TableEdit[] {
    const edits: TableEdit[] = [];
    for (const row of inputs) {
      const edit: TableEdit = { id: row.id };
      const fixed = parseAmount(row.fixed.value);
      const material = parseAmount(row.material.value);
      const actual = parseAmount(row.actual.value);
      if (fixed !== undefined && fixed !== row.values.fixedCost) edit.fixedCost = fixed;
      if (material !== undefined && material !== row.values.materialCost) {
        edit.materialCost = material;
      }
      if (actual !== undefined && actual !== row.values.actualCost) edit.actualCost = actual;
      if (Object.keys(edit).length > 1) edits.push(edit);
    }
    return edits;
  }

  footerButtons(dialog, [
    {
      label: messages.tableApply,
      onClick: () => {
        cb.apply(gatherEdits());
        cb.close();
      },
    },
    { label: messages.tableCancel, onClick: () => cb.close() },
  ]);

  return panelOf(dialog);
}

/* ------------------------------------------------------------------ *
 * §2.11 cumulative cost curve
 * ------------------------------------------------------------------ */

export const CURVE_WIDTH = 360;
export const CURVE_HEIGHT = 140;

export interface CurveCallbacks extends CostPanelCallbacks {
  /** The catalog's per-point text (already fault-guarded by `resolveCatalog`). */
  pointText(point: Readonly<CostCurvePoint>): string;
}

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
  points: readonly CostCurvePoint[],
  width: number,
  height: number,
): { planned: XY[]; actual: XY[]; forecast: XY[] } {
  const planned: XY[] = [];
  const actual: XY[] = [];
  const forecast: XY[] = [];
  if (points.length === 0) return { planned, actual, forecast };
  const first = (points[0] as CostCurvePoint).t;
  const last = (points[points.length - 1] as CostCurvePoint).t;
  const span = Math.max(1, last - first);
  let peak = 0;
  for (const p of points) peak = Math.max(peak, p.planned, p.actual, p.forecast ?? 0);
  const margin = 4;
  const sx = (t: number): number => margin + ((t - first) / span) * (width - 2 * margin);
  const sy = (v: number): number =>
    margin + (peak === 0 ? 1 : 1 - v / peak) * (height - 2 * margin);
  for (const p of points) {
    planned.push({ x: sx(p.t), y: sy(p.planned) });
    if (p.forecast === undefined) {
      actual.push({ x: sx(p.t), y: sy(p.actual) });
    } else {
      // The first forecast point (the status date) also ends the actual polyline, so the two lines
      // meet instead of leaving a gap.
      if (forecast.length === 0) actual.push({ x: sx(p.t), y: sy(p.actual) });
      forecast.push({ x: sx(p.t), y: sy(p.forecast) });
    }
  }
  return { planned, actual, forecast };
}

export function createCurvePanel(
  host: HTMLElement,
  points: readonly CostCurvePoint[],
  messages: TrackingMessages,
  cb: CurveCallbacks,
): CostPanel {
  const dialog = openDialog(host, "sg-cost-curve", messages.costCurveTitle, cb.close);
  const doc = dialog.root.ownerDocument;

  function buildCurve(box: HTMLElement): void {
    if (points.length === 0) {
      const empty = doc.createElement("div");
      empty.textContent = messages.costCurveEmpty;
      box.appendChild(empty);
      return;
    }
    const canvas = doc.createElement("canvas");
    canvas.width = CURVE_WIDTH;
    canvas.height = CURVE_HEIGHT;
    canvas.setAttribute("role", "img");
    canvas.setAttribute("aria-label", points.map((p) => cb.pointText(p)).join("; "));
    const g = typeof canvas.getContext === "function" ? canvas.getContext("2d") : null;
    if (g !== null && g !== undefined) {
      // §2.11 tokens, with the documented fallbacks when `stargantt.theme` is absent. Both clear
      // 3:1 against the dialog ground, and the two solid series are told apart by the accessible
      // list below as well as by color.
      g.lineWidth = 1.5;
      g.strokeStyle = (cb.themeGet?.("--sg-cost-planned") ?? "") || "#1565c0";
      polyline(g, geometryOf().planned);
      g.strokeStyle = (cb.themeGet?.("--sg-cost-actual") ?? "") || "#c62828";
      polyline(g, geometryOf().actual);
      // The forecast is DASHED: line style, not color, marks the projection.
      if (typeof g.setLineDash === "function") g.setLineDash([4, 3]);
      polyline(g, geometryOf().forecast);
      if (typeof g.setLineDash === "function") g.setLineDash([]);
    }
    box.appendChild(canvas);
    // The same data as text — the canvas alone would make the curve vision-dependent.
    const list = doc.createElement("ul");
    list.setAttribute("style", "margin:8px 0 0;padding-left:16px;max-height:160px;overflow-y:auto;");
    for (const p of points) {
      const item = doc.createElement("li");
      item.textContent = cb.pointText(p);
      list.appendChild(item);
    }
    box.appendChild(list);
  }

  // One geometry pass per open, shared by the three polylines (no per-draw recomputation).
  let geometry: ReturnType<typeof curveGeometry> | undefined;
  function geometryOf(): ReturnType<typeof curveGeometry> {
    return (geometry ??= curveGeometry(points, CURVE_WIDTH, CURVE_HEIGHT));
  }

  renderPanelBody(
    dialog.body,
    { panel: "curve", model: { panel: "curve", points }, close: cb.close },
    cb,
    buildCurve,
  );

  footerButtons(dialog, [{ label: messages.panelClose, onClick: () => cb.close() }]);
  return panelOf(dialog);
}

/* ------------------------------------------------------------------ *
 * §2.11 cost breakdown chart
 * ------------------------------------------------------------------ */

export interface BreakdownCallbacks extends CostPanelCallbacks {
  entryText(entry: Readonly<BreakdownEntryData>): string;
}

const TYPE_TOKENS: Record<CostType, { token: string; fallback: string }> = {
  labor: { token: "--sg-cost-labor", fallback: "#1565c0" },
  fixed: { token: "--sg-cost-fixed", fallback: "#6a1b9a" },
  variable: { token: "--sg-cost-variable", fallback: "#b45309" },
  material: { token: "--sg-cost-material", fallback: "#2e7d32" },
};

export function createBreakdownPanel(
  host: HTMLElement,
  entries: readonly BreakdownEntryData[],
  messages: TrackingMessages,
  cb: BreakdownCallbacks,
): CostPanel {
  const dialog = openDialog(host, "sg-cost-breakdown", messages.breakdownTitle, cb.close);
  const doc = dialog.root.ownerDocument;

  function buildBreakdown(box: HTMLElement): void {
    const nonZero = entries.filter((e) => e.amount > 0);
    if (nonZero.length === 0) {
      const empty = doc.createElement("div");
      empty.textContent = messages.costCurveEmpty;
      box.appendChild(empty);
      return;
    }
    const peak = Math.max(...nonZero.map((e) => e.amount));
    for (const entry of nonZero) {
      const row = doc.createElement("div");
      row.setAttribute("style", "display:flex;align-items:center;gap:8px;margin:4px 0;");
      const bar = doc.createElement("div");
      const colors = TYPE_TOKENS[entry.type];
      const color = (cb.themeGet?.(colors.token) ?? "") || colors.fallback;
      const width = Math.max(2, Math.round((entry.amount / peak) * 160));
      bar.setAttribute(
        "style",
        `width:${String(width)}px;height:12px;border-radius:2px;background:${color};flex:none;`,
      );
      // The bar is pure decoration — the text beside it carries every fact it encodes.
      bar.setAttribute("aria-hidden", "true");
      row.appendChild(bar);
      // §2.11 — the type name is ALWAYS printed beside the bar; meaning is never by color alone.
      const text = doc.createElement("span");
      text.textContent = cb.entryText(entry);
      row.appendChild(text);
      box.appendChild(row);
    }
  }

  renderPanelBody(
    dialog.body,
    { panel: "breakdown", model: { panel: "breakdown", entries }, close: cb.close },
    cb,
    buildBreakdown,
  );

  footerButtons(dialog, [{ label: messages.panelClose, onClick: () => cb.close() }]);
  return panelOf(dialog);
}
