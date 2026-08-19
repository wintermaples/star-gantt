// docs/specs/plugins/portfolio.md §3.6, §3.7 — the dashboard panel: a dialog overlay of KPI cards
// over the gantt root. Hostless: built off a host element and callbacks. Charts (donut, burndown)
// are canvases with role="img" labels plus text equivalents, so no meaning is carried by color or
// the drawing alone; bar comparisons are DOM meters with role="progressbar".
//
// The chrome (header, body, drag, resize, Escape, pointerdown containment) comes from
// `sdk/dialog`'s `createDialog`; only the widget grid and its content are this module's own.
import { createDialog } from "@stargantt/sdk";
import type { TaskId } from "@stargantt/plugin-data-store";
import type { DashboardWidgetId, DashboardWidgetRenderContext, StatusCounts } from "../../types";
import type { PortfolioMessages } from "../messages";
import { currentDpr, syncChartBacking, watchDpr, watchResize } from "./canvas-backing";
import type { DashboardModel } from "./model";

/** A 0..1 fraction as a whole-percent label. */
export function percent(p: number): string {
  return `${Math.round(p * 100)}%`;
}

export interface PanelCallbacks {
  close(): void;
  /** The overdue rows' quick-complete action. */
  markDone(taskId: TaskId): void;
  /**
   * The host's `renderWidget` seam, already wrapped in the §3.7 latched fault barrier
   * (`sdk/dom`'s `latchedSeam`) by the wiring closure that owns its "faulted" flag for the
   * instance's life — `undefined` when `config.dashboard.renderWidget` was not supplied. Returns
   * whether the call ran without throwing (a `false` — either a fresh throw or an already-latched
   * decline — means the caller must fall back to the built-in body).
   */
  renderWidget?: ((host: HTMLElement, ctx: DashboardWidgetRenderContext) => boolean) | undefined;
}

export interface DashboardPanel {
  root: HTMLElement;
  /** Re-renders the widget cards from a fresh model. */
  update(model: DashboardModel): void;
  /** Moves focus into the panel (its first focusable element, or the box itself). */
  focus(): void;
  /** Removes the panel and every listener it attached. Idempotent. */
  dispose(): void;
}

/**
 * A panel-scoped listener bag for the widget **content** the grid re-renders on every
 * `update()`: the dialog's own chrome listeners (header drag, Escape, containment) are owned by
 * `createDialog` itself and drained by its `dispose()`, but a re-rendered widget's buttons come
 * and go without the dialog being torn down, so they need a bag of their own — not `ctx.own()`,
 * which would otherwise grow the plugin's owned-resource list by one entry per render. The plugin
 * owns exactly one disposable ("dispose the current panel") that drains this bag.
 */
interface ListenerBag {
  add(target: EventTarget, type: string, fn: (e: Event) => void): void;
  /**
   * Registers a non-listener disposable — a chart's `devicePixelRatio`/resize subscription — to
   * run at `drain()`, alongside the event listeners this bag already tracks (§3.6).
   */
  own(dispose: () => void): void;
  drain(): void;
}

function listenerBag(): ListenerBag {
  const entries: { target: EventTarget; type: string; fn: EventListener }[] = [];
  const disposers: (() => void)[] = [];
  return {
    add(target, type, fn) {
      const handler = fn as EventListener;
      target.addEventListener(type, handler);
      entries.push({ target, type, fn: handler });
    },
    own(dispose) {
      disposers.push(dispose);
    },
    drain() {
      for (const e of entries) e.target.removeEventListener(e.type, e.fn);
      entries.length = 0;
      for (const dispose of disposers.splice(0)) dispose();
    },
  };
}

const CARD_STYLE =
  "border:1px solid var(--sg-panel-border, #c8d0da);border-radius:6px;padding:8px;" +
  "display:flex;flex-direction:column;gap:4px;min-width:0;";

// Fallback CSS width for the burndown chart's very first paint, before it is attached to the
// document and a real `getBoundingClientRect()` reading is available (§3.6) — the
// `ResizeObserver` set up in `drawBurndown` corrects this to the card's real width right after
// mount, exactly as a real `ResizeObserver`'s own initial callback would.
const CHART_W_FALLBACK = 280;
const CHART_H = 96;
// The donut's CSS size is fixed and square (§3.6) — no `ResizeObserver` is needed for it, only
// the `devicePixelRatio` watcher every chart canvas gets.
const DONUT_SIZE = 128;

export const STATUS_COLORS: readonly string[] = ["#8892a0", "#2f6fed", "#2e9e5b"];

/** The donut's segments: label, count, and share of the total (0..1). */
export function donutSegments(
  counts: StatusCounts,
  messages: PortfolioMessages,
): { label: string; count: number; share: number }[] {
  const rows = [
    { label: messages.statusNotStarted, count: counts.notStarted },
    { label: messages.statusInProgress, count: counts.inProgress },
    { label: messages.statusCompleted, count: counts.completed },
  ];
  const total = rows.reduce((acc, r) => acc + r.count, 0);
  return rows.map((r) => ({ ...r, share: total > 0 ? r.count / total : 0 }));
}

type Doc = Document;

function el(doc: Doc, tag: string, style?: string, text?: string): HTMLElement {
  const node = doc.createElement(tag);
  if (style !== undefined) node.setAttribute("style", style);
  if (text !== undefined) node.textContent = text;
  return node;
}

function card(doc: Doc, title: string): HTMLElement {
  const root = el(doc, "section", CARD_STYLE);
  root.appendChild(el(doc, "h3", "margin:0;font-size:13px;font-weight:600;", title));
  return root;
}

function textList(doc: Doc, lines: readonly string[], empty: string): HTMLElement {
  if (lines.length === 0) return el(doc, "div", undefined, empty);
  const list = el(doc, "ul", "margin:0;padding-left:16px;max-height:140px;overflow-y:auto;");
  for (const line of lines) list.appendChild(el(doc, "li", undefined, line));
  return list;
}

/**
 * A horizontal bar row: label, an inline meter, and the value as text.
 *
 * The track carries `role="progressbar"` / `aria-valuenow` / `aria-valuemin="0"` /
 * `aria-valuemax="100"` — `aria-valuenow` is the same rounded percentage the bar's width encodes
 * (§3.6), so assistive tech announces a value even where the adjacent text does not read as a
 * percentage (e.g. workload's "3.2d").
 */
function barRow(doc: Doc, label: string, fraction: number, valueText: string): HTMLElement {
  const row = el(doc, "div", "display:flex;align-items:center;gap:8px;");
  row.appendChild(
    el(doc, "span", "flex:0 0 120px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;", label),
  );
  const track = el(doc, "span", "flex:1;height:10px;background:var(--sg-panel-border, #e3e8ee);border-radius:5px;overflow:hidden;");
  const clamped = fraction < 0 ? 0 : fraction > 1 ? 1 : fraction;
  const pct = Math.round(clamped * 100);
  track.setAttribute("role", "progressbar");
  track.setAttribute("aria-valuenow", String(pct));
  track.setAttribute("aria-valuemin", "0");
  track.setAttribute("aria-valuemax", "100");
  track.appendChild(el(doc, "span", `display:block;height:100%;width:${pct}%;background:#2f6fed;`));
  row.appendChild(track);
  row.appendChild(el(doc, "span", "flex:0 0 auto;font-variant-numeric:tabular-nums;", valueText));
  return row;
}

// §3.6 — "the donut has an explicit square CSS size; the burndown tracks its card's width" and "a
// chart canvas is never CSS-upscaled from a smaller backing". Both charts below give the canvas
// an explicit CSS size (so the flex column's default `align-items: stretch` cannot inflate a
// canvas past its intrinsic width/height attributes) and size the backing store to CSS size ×
// `devicePixelRatio`, redrawing in CSS coordinates after `ctx.scale(dpr, dpr)`.

function paintDonut(
  doc: Doc,
  canvas: HTMLCanvasElement,
  g: CanvasRenderingContext2D,
  segments: readonly { share: number }[],
): void {
  if (!syncChartBacking(canvas, g, DONUT_SIZE, DONUT_SIZE, currentDpr(doc))) return;
  const cx = DONUT_SIZE / 2;
  const r = DONUT_SIZE / 2 - 4;
  let angle = -Math.PI / 2;
  segments.forEach((s, i) => {
    if (s.share <= 0) return;
    const sweep = s.share * 2 * Math.PI;
    g.beginPath();
    g.moveTo(cx, cx);
    g.arc(cx, cx, r, angle, angle + sweep);
    g.closePath();
    g.fillStyle = STATUS_COLORS[i] ?? "#8892a0";
    g.fill();
    angle += sweep;
  });
  // Punch a genuinely transparent hole for the donut shape, so the panel's own
  // `var(--sg-panel-bg, …)` background shows through and the chart follows the theme.
  g.globalCompositeOperation = "destination-out";
  g.beginPath();
  g.arc(cx, cx, r * 0.55, 0, 2 * Math.PI);
  g.fill();
  g.globalCompositeOperation = "source-over";
}

function drawDonut(
  doc: Doc,
  counts: StatusCounts,
  messages: PortfolioMessages,
  bag: ListenerBag,
): HTMLElement | undefined {
  const canvas = doc.createElement("canvas") as HTMLCanvasElement;
  canvas.setAttribute(
    "style",
    `display:block;width:${DONUT_SIZE}px;height:${DONUT_SIZE}px;align-self:center;`,
  );
  const segments = donutSegments(counts, messages);
  canvas.setAttribute("role", "img");
  canvas.setAttribute("aria-label", segments.map((s) => `${s.label}: ${s.count}`).join("; "));
  const g = typeof canvas.getContext === "function" ? canvas.getContext("2d") : null;
  if (g === null || g === undefined) return undefined;
  paintDonut(doc, canvas, g, segments);
  // `devicePixelRatio` can change under a mounted panel (a monitor move, a browser zoom); the
  // backing is resynced and the chart redrawn in place — the canvas node itself is never
  // recreated.
  bag.own(watchDpr(doc, () => paintDonut(doc, canvas, g, segments)).dispose);
  return canvas;
}

function paintBurndown(
  doc: Doc,
  canvas: HTMLCanvasElement,
  g: CanvasRenderingContext2D,
  model: DashboardModel,
  cssWidth: number,
): void {
  if (!syncChartBacking(canvas, g, cssWidth, CHART_H, currentDpr(doc))) return;
  const { planned, actual, taskCount } = model.burndown;
  const all = [...planned, ...actual];
  // No points to plot: bail before the min/max reduction below, which would otherwise leave
  // `minDate`/`maxDate` at their `Infinity`/`-Infinity` seeds and produce NaN coordinates.
  if (all.length === 0) return;
  // Plain loops, not `Math.min(...all.map(...))` / `Math.max(...)` — spreading a burndown series
  // that can run into the hundreds of thousands of points blows the call stack.
  let minDate = Infinity;
  let maxDate = -Infinity;
  let top = Math.max(1, taskCount);
  for (const p of all) {
    if (p.date < minDate) minDate = p.date;
    if (p.date > maxDate) maxDate = p.date;
    if (p.remaining > top) top = p.remaining;
  }
  const span = Math.max(1, maxDate - minDate);
  const margin = 4;
  const x = (date: number): number =>
    margin + ((date - minDate) / span) * (cssWidth - 2 * margin);
  const y = (remaining: number): number =>
    margin + (1 - remaining / top) * (CHART_H - 2 * margin);
  const stroke = (points: readonly { date: number; remaining: number }[], color: string): void => {
    if (points.length === 0) return;
    g.beginPath();
    points.forEach((p, i) => {
      if (i === 0) g.moveTo(x(p.date), y(p.remaining));
      else g.lineTo(x(p.date), y(p.remaining));
    });
    g.strokeStyle = color;
    g.lineWidth = 1.5;
    g.stroke();
  };
  stroke(planned, "#8892a0");
  stroke(actual, "#2f6fed");
}

// §3.6 — the burndown's text equivalent: the task-count clause (mirrors the "planned" series)
// followed, when a snapshot exists, by the last-remaining clause (mirrors the "actual" series).
// Shared by the chart's aria-label and the caption line below it so the two never drift apart.
function burndownCaptionLines(model: DashboardModel, messages: PortfolioMessages): string[] {
  const lines: string[] = [];
  const last = model.burndown.actual[model.burndown.actual.length - 1];
  lines.push(`${messages.widgetTitle("summary")}: ${messages.burndownPlanned(model.burndown.taskCount)}`);
  if (last !== undefined) lines.push(messages.burndownRemaining(last.remaining));
  return lines;
}

function drawBurndown(
  doc: Doc,
  model: DashboardModel,
  messages: PortfolioMessages,
  bag: ListenerBag,
): HTMLElement | undefined {
  const { planned, actual } = model.burndown;
  if (planned.length === 0 && actual.length === 0) return undefined;
  const canvas = doc.createElement("canvas") as HTMLCanvasElement;
  canvas.setAttribute("style", `display:block;width:100%;height:${CHART_H}px;`);
  canvas.setAttribute("role", "img");
  canvas.setAttribute("aria-label", burndownCaptionLines(model, messages).join("; "));
  const g = typeof canvas.getContext === "function" ? canvas.getContext("2d") : null;
  if (g === null || g === undefined) return undefined;
  // `getBoundingClientRect()` can report 0 for a beat after a `ResizeObserver` fires; falling
  // back to `CHART_W_FALLBACK` for that reading tolerates the race instead of painting a
  // zero-width chart — the next real `ResizeObserver` callback corrects it.
  const measure = (): number => {
    const w = canvas.getBoundingClientRect().width;
    return w > 0 ? w : CHART_W_FALLBACK;
  };
  const repaint = (): void => paintBurndown(doc, canvas, g, model, measure());
  repaint();
  // The card's width — and so the canvas's real CSS width, which is `100%` of it — changes
  // whenever the dialog is resized without the panel re-rendering (that only happens on a data
  // change, §3.8); a `ResizeObserver` keeps the backing in step.
  bag.own(watchResize(doc, canvas, () => repaint()).dispose);
  // `devicePixelRatio` changes independently of size; resynced the same way as the donut.
  bag.own(watchDpr(doc, () => repaint()).dispose);
  return canvas;
}

/** What one widget body needs to fill its card. */
interface WidgetContext {
  doc: Doc;
  model: DashboardModel;
  messages: PortfolioMessages;
  cb: PanelCallbacks;
  bag: ListenerBag;
}

/** Fills one widget's card, below the title `renderWidgets` already put there. */
type WidgetBody = (box: HTMLElement, ctx: WidgetContext) => void;

/** Appends the empty-state line; returns whether the widget has nothing else to show. */
function appendEmpty(box: HTMLElement, ctx: WidgetContext): void {
  box.appendChild(el(ctx.doc, "div", undefined, ctx.messages.emptyLabel));
}

function bodySummary(box: HTMLElement, { doc, model, messages }: WidgetContext): void {
  box.appendChild(el(doc, "div", "font-size:22px;font-weight:700;", percent(model.summary.progress)));
  box.appendChild(el(doc, "div", undefined, messages.summaryText(model.summary)));
}

function bodyOverdue(box: HTMLElement, ctx: WidgetContext): void {
  const { doc, model, messages, cb, bag } = ctx;
  if (model.overdue.length === 0) {
    appendEmpty(box, ctx);
    return;
  }
  const list = el(doc, "ul", "margin:0;padding:0;list-style:none;max-height:160px;overflow-y:auto;display:flex;flex-direction:column;gap:4px;");
  for (const entry of model.overdue) {
    const row = el(doc, "li", "display:flex;align-items:center;gap:8px;");
    row.appendChild(el(doc, "span", "flex:1;min-width:0;", messages.overdueLine(entry)));
    const done = el(doc, "button", "min-height:24px;min-width:24px;padding:2px 8px;cursor:pointer;", messages.markDoneLabel) as HTMLButtonElement;
    done.setAttribute("type", "button");
    // §3.5 — one undo step per press.
    bag.add(done, "click", () => cb.markDone(entry.id));
    row.appendChild(done);
    list.appendChild(row);
  }
  box.appendChild(list);
}

function bodyBurndown(box: HTMLElement, { doc, model, messages, bag }: WidgetContext): void {
  const chart = drawBurndown(doc, model, messages, bag);
  if (chart !== undefined) box.appendChild(chart);
  // `burndownCaptionLines` always pushes its task-count clause unconditionally, so `lines` is
  // never empty here — no empty-state fallback is reachable through this call site.
  const label = burndownCaptionLines(model, messages).join("; ");
  box.appendChild(el(doc, "div", undefined, label));
}

function bodyWorkload(box: HTMLElement, ctx: WidgetContext): void {
  const { doc, model } = ctx;
  if (model.workload.length === 0) {
    appendEmpty(box, ctx);
    return;
  }
  // A plain loop, not `Math.max(...spread)` — a large workload list would risk the same
  // call-stack blowup as the burndown min/max above.
  let max = 1;
  for (const w of model.workload) if (w.personDays > max) max = w.personDays;
  for (const w of model.workload) {
    box.appendChild(barRow(doc, w.name, w.personDays / max, `${w.personDays.toFixed(1)}d`));
  }
}

function bodyStatus(box: HTMLElement, { doc, model, messages, bag }: WidgetContext): void {
  const chart = drawDonut(doc, model.status, messages, bag);
  if (chart !== undefined) box.appendChild(chart);
  const lines = donutSegments(model.status, messages).map((s) => `${s.label}: ${s.count}`);
  box.appendChild(textList(doc, lines, messages.emptyLabel));
}

function bodyMilestones(box: HTMLElement, { doc, model, messages }: WidgetContext): void {
  const stateOf = (m: DashboardModel["milestones"][number]): string =>
    m.reached ? messages.milestoneReached : m.overdue ? messages.milestoneOverdue : messages.milestonePending;
  const lines = model.milestones.map(
    (m) => `${m.name} — ${new Date(m.date).toISOString().slice(0, 10)} (${stateOf(m)})`,
  );
  box.appendChild(textList(doc, lines, messages.emptyLabel));
}

function bodyGoals(box: HTMLElement, ctx: WidgetContext): void {
  const { doc, model } = ctx;
  if (model.goals.length === 0) {
    appendEmpty(box, ctx);
    return;
  }
  for (const goal of model.goals) {
    const value = `${percent(goal.progress)} / ${percent(goal.target)}`;
    box.appendChild(barRow(doc, goal.name, goal.progress, value));
  }
}

function bodyPortfolio(box: HTMLElement, { doc, model, messages }: WidgetContext): void {
  const lines = model.portfolio.map((row) => messages.portfolioRow(row));
  box.appendChild(textList(doc, lines, messages.emptyLabel));
}

function bodyGroups(box: HTMLElement, ctx: WidgetContext): void {
  const { doc, model } = ctx;
  if (model.groups.length === 0) {
    appendEmpty(box, ctx);
    return;
  }
  for (const group of model.groups) {
    const value = `${percent(group.progress)} (${group.taskCount})`;
    box.appendChild(barRow(doc, group.group, group.progress, value));
  }
}

function bodyFormulas(box: HTMLElement, ctx: WidgetContext): void {
  const { doc, model } = ctx;
  if (model.formulas.length === 0) {
    appendEmpty(box, ctx);
    return;
  }
  for (const formula of model.formulas) {
    const row = el(doc, "div", "display:flex;justify-content:space-between;gap:8px;");
    row.appendChild(el(doc, "span", undefined, formula.label));
    row.appendChild(el(doc, "span", "font-weight:600;font-variant-numeric:tabular-nums;", formula.text));
    box.appendChild(row);
  }
}

// One entry per widget id (a closed union), so a new widget without a body is a compile error.
const WIDGET_BODIES = {
  summary: bodySummary,
  overdue: bodyOverdue,
  burndown: bodyBurndown,
  workload: bodyWorkload,
  status: bodyStatus,
  milestones: bodyMilestones,
  goals: bodyGoals,
  portfolio: bodyPortfolio,
  groups: bodyGroups,
  formulas: bodyFormulas,
} satisfies Record<DashboardWidgetId, WidgetBody>;

// §3.7 — the `renderWidget` seam. `host` is the same element `WIDGET_BODIES[widget]` fills,
// already carrying the title `card()` appended. A seam that returns without appending anything is
// not a fallback signal — the empty body is what the host asked for; only a throw falls back.
// `cb.renderWidget` is already latched (one report for the life of the plugin instance), so a call
// that declines here either just faulted or faulted on an earlier widget/render — either way the
// built-in body runs.
function renderWidgets(
  doc: Doc,
  grid: HTMLElement,
  model: DashboardModel,
  messages: PortfolioMessages,
  cb: PanelCallbacks,
  bag: ListenerBag,
): void {
  const ctx: WidgetContext = { doc, model, messages, cb, bag };
  for (const widget of model.widgets) {
    const box = card(doc, messages.widgetTitle(widget));
    let handled = false;
    if (cb.renderWidget !== undefined) {
      const titleCount = box.children.length; // the title `card()` already appended.
      const seamCtx: DashboardWidgetRenderContext = {
        widget,
        model,
        markDone: (taskId) => cb.markDone(taskId),
      };
      handled = cb.renderWidget(box, seamCtx);
      if (!handled) {
        // A throw may have appended partial content before it happened — clear back to just the
        // title so the built-in body starts from the same empty box a fresh render would.
        while (box.children.length > titleCount) box.removeChild(box.lastChild as ChildNode);
      }
    }
    if (!handled) WIDGET_BODIES[widget](box, ctx);
    grid.appendChild(box);
  }
}

export function createDashboardPanel(
  host: HTMLElement,
  model: DashboardModel,
  messages: PortfolioMessages,
  cb: PanelCallbacks,
): DashboardPanel {
  const doc = host.ownerDocument;

  // §3.6 — chrome, drag, resize, Escape and pointerdown containment all come from the shared
  // dialog; this module only fills `dialog.body`.
  const dialog = createDialog({
    host,
    className: "sg-dashboard",
    label: messages.panelTitle,
    width: "min(680px,92%)",
    top: 16,
    maxHeight: "85%",
    closeButton: messages.closeLabel,
    resizable: true,
    onClose: () => cb.close(),
  });

  const grid = el(
    doc,
    "div",
    "display:grid;grid-template-columns:repeat(auto-fill,minmax(280px,1fr));gap:8px;overflow-y:auto;",
  );
  grid.className = "sg-dashboard__grid";
  dialog.body.appendChild(grid);
  const contentBag = listenerBag();
  renderWidgets(doc, grid, model, messages, cb, contentBag);

  let disposed = false;
  return {
    root: dialog.root,
    update(next: DashboardModel): void {
      if (disposed) return;
      contentBag.drain();
      while (grid.firstChild !== null) grid.removeChild(grid.firstChild as ChildNode);
      renderWidgets(doc, grid, next, messages, cb, contentBag);
    },
    focus(): void {
      dialog.focus();
    },
    dispose(): void {
      if (disposed) return;
      disposed = true;
      contentBag.drain();
      dialog.dispose();
    },
  };
}
