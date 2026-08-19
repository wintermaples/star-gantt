/**
 * Shared boot helpers for the grid-lines suites.
 *
 * Three shapes are offered, for the three questions the package's tests have to answer:
 *
 * - {@link boot} runs a real `Gantt.create()` with the render, theme and timeline modules beside
 *   the grid-lines module, so the body grid and the chart header can be compared against each
 *   other on one painted frame. The six formerly-separate modules merged into one, so booting the whole `view()`
 *   factory would also raise the pane row and the today line — neither of which these tests are
 *   about, and both of which would move the DOM they inspect. The module factories are the seam
 *   that keeps the module isolation: `createRenderModule` / `createThemeModule` / `createTimelineModule`
 *   / `createGridLinesModule` are called directly from one harness plugin published under the real
 *   `stargantt.view` plugin id, and their handles are provided under the real service keys, so the
 *   probes below read exactly the surface a third-party plugin reads.
 * - {@link calendar} boots the same real time scale only to hand back its `unitBoundaries`
 *   function, so the leaner unit suites can drive the grid-lines module through a synthetic scale
 *   (their own `pxPerMs` and zoom level) while the boundary instants still come from the one
 *   calendar the timeline module is in charge of.
 * - {@link mountGridLinesModule}, {@link makeRenderStub}, {@link makeRowGeometry} and
 *   {@link calendarSource} are the hostless doubles those same unit suites drive
 *   `createGridLinesModule` with directly, with no DOM and no `Gantt.create()` at all — the module
 *   takes its render/theme/timeline/data dependencies as plain constructor arguments now, rather
 *   than looking them up through `ctx.use`, so a unit test's "plugin context" only has to answer
 *   `contribute` / `own` / `claimOrder`.
 */
import { Gantt, createStore, definePlugin } from "@stargantt/core";
import type { AnyPlugin, Disposable, GanttInstance, PluginContext, Store } from "@stargantt/core";
import type { CalendarDef, CalendarId, Task, TaskId } from "@stargantt/plugin-data-store";
import { normalizeViewConfig } from "../../src/config";
import type { GridLinesConfig } from "../../src/config";
import { createGridLinesModule } from "../../src/internal/grid-lines/index";
import type { GridLinesDataSource } from "../../src/internal/grid-lines/index";
import { createRenderModule } from "../../src/internal/render/index";
import type { LayerContribution, RenderModule, RowGeometryProvider, Viewport } from "../../src/internal/render/index";
import { createThemeModule } from "../../src/internal/theme/index";
import type { ThemeService } from "../../src/internal/theme/index";
import { createTimelineModule } from "../../src/internal/timeline/index";
import type { TimelineService, TimelineConfig } from "../../src/internal/timeline/index";
import type { ViewService } from "../../src/index";
import { asElement, installDom } from "../_utils/index";
import type { DomHarness, DomOptions, FakeCanvas } from "../_utils/index";

/** A weekday index as `firstDayOfWeek` accepts it: 0 = Sunday … 6 = Saturday. */
export type Weekday = 0 | 1 | 2 | 3 | 4 | 5 | 6;

/* ------------------------------------------------------------------ *
 * Real-DOM boot (contrast.test.ts, header-agreement.test.ts)
 * ------------------------------------------------------------------ */

export interface Booted {
  dom: DomHarness;
  gantt: GanttInstance;
  scale: TimelineService;
  /** The timeline module's own header canvas, where the header's ticks land. */
  header: FakeCanvas;
  /** The render module's background canvas, where this module's grid lands. */
  background: FakeCanvas;
  /** Runs the queued frames, i.e. performs one paint pass of header and body. */
  paint(): void;
  dispose(): void;
}

/**
 * A `GridLinesDataSource` over an in-memory list of calendars — the double for what is, in a full
 * composition, `DataService.query().calendars`.
 */
export function calendarSource(calendars: readonly CalendarDef[] = []): GridLinesDataSource {
  const byId = new Map<CalendarId, CalendarDef>(calendars.map((c) => [c.id, c]));
  return { calendar: (id) => byId.get(id) };
}

/** The render, theme and timeline modules, wired together and published exactly as `setupView` does. */
interface CoreModules {
  render: RenderModule;
  theme: ThemeService;
  timeline: TimelineService;
}

/**
 * Builds and publishes the render, theme and timeline modules a grid-lines composition needs,
 * under their real service keys — the same three calls `internal/wiring.ts`'s `setupView` makes,
 * minus the pane row and the today line this suite has no use for.
 */
function buildCoreModules(ctx: PluginContext, timelineConfig: TimelineConfig): CoreModules {
  const render = createRenderModule(ctx, normalizeViewConfig().render);
  const theme = createThemeModule(ctx, {}, render);
  // The origin guard's data source: an empty task store is enough for every grid-lines suite,
  // none of which touches task-driven origin extension.
  const tasks: Store<ReadonlyMap<TaskId, Readonly<Task>>> = createStore(new Map());
  const timeline = createTimelineModule(ctx, timelineConfig, render, theme, {
    tasks,
    getTask: () => undefined,
  });

  const view: ViewService = {
    invalidate: render.invalidate,
    refreshInsets: render.refreshInsets,
    direction: render.direction,
    reducedMotion: render.reducedMotion,
    textWidth: render.textWidth,
    bidiIsolate: render.bidiIsolate,
    firstPaintMs: render.firstPaintMs,
    batchRead: render.batchRead,
    batchWrite: render.batchWrite,
    predictedViewport: render.predictedViewport,
    chartPaneElement: render.chartPaneElement,
    wheelSpeedFactor: render.wheelSpeedFactor,
    scrollTo: render.scrollTo,
    renderTo: render.renderTo,
    viewport: render.viewport,
    // `viewMode` belongs to the panes module, which this harness does not build; nothing in these
    // suites reads it, so it is stubbed with an inert store exactly as `test/render/_boot.ts` does.
    viewMode: { get: () => "split", subscribe: () => ({ dispose: () => {} }) },
  };
  ctx.provide("stargantt.view", view);
  ctx.provide("stargantt.timeline", timeline);
  ctx.provide("stargantt.theme", theme);

  return { render, theme, timeline };
}

/** The plugin the render/theme/timeline/grid-lines modules are published from, under the real id. */
function harnessPlugin(
  gridLinesConfig: GridLinesConfig | undefined,
  timelineConfig: TimelineConfig,
  data: GridLinesDataSource,
): AnyPlugin {
  return definePlugin({
    meta: { id: "stargantt.view" },
    setup(ctx: PluginContext): void {
      const { render, theme, timeline } = buildCoreModules(ctx, timelineConfig);
      const gridLinesOptions = normalizeViewConfig({ gridLines: gridLinesConfig }).gridLines;
      createGridLinesModule(ctx, gridLinesOptions, render, theme, timeline, data);
    },
  });
}

/**
 * Boots render + theme + timeline + grid-lines over the shared fake DOM.
 *
 * The axis origin is pinned to the epoch so every pixel assertion is independent of the day the
 * suite runs (the default origin is the start of the current UTC day).
 */
export function boot(
  config?: GridLinesConfig,
  options: DomOptions = {},
  firstDayOfWeek: Weekday = 1,
  extra: AnyPlugin[] = [],
  // The calendar options that reshape a level's rows (a fiscal year anchors its stepped rows on
  // `stepOffset`) belong to the axis, and the body grid has to follow them, so the suite must be
  // able to set them.
  scale: Omit<TimelineConfig, "origin" | "firstDayOfWeek"> = {},
  data: GridLinesDataSource = calendarSource(),
): Booted {
  const dom = installDom(options);
  const gantt = Gantt.create({
    element: asElement(dom.root),
    plugins: [harnessPlugin(config, { ...scale, origin: 0, firstDayOfWeek }, data), ...extra],
  });

  const header = dom.root.children.find(
    (c) => c.getAttribute("data-sg-header") === "timeline-scale",
  );
  if (header === undefined) throw new Error("header canvas was not created");
  const pane = dom.root.children[0];
  if (pane === undefined) throw new Error("chart pane was not created");
  const background = pane.children.find((c) => c.getAttribute("data-layer") === "background");
  if (background === undefined) throw new Error("background canvas was not created");

  return {
    dom,
    gantt,
    scale: gantt.service("stargantt.timeline"),
    header: header as FakeCanvas,
    background: background as FakeCanvas,
    paint: () => void dom.flushAllFrames(),
    dispose(): void {
      gantt.dispose();
      dom.restore();
    },
  };
}

const calendars = new Map<Weekday, TimelineService["unitBoundaries"]>();

/**
 * The real time scale's `unitBoundaries`, for a chart whose week starts on `firstDayOfWeek`.
 *
 * The chart is booted, the function captured and the chart torn down again: the enumeration is
 * pure calendar arithmetic over the captured week start, so it keeps answering afterwards, and no
 * fake DOM stays installed for the caller to trip over. Memoized per week start.
 */
export function calendar(firstDayOfWeek: Weekday = 1): TimelineService["unitBoundaries"] {
  const cached = calendars.get(firstDayOfWeek);
  if (cached !== undefined) return cached;
  const dom = installDom();
  const gantt = Gantt.create({
    element: asElement(dom.root),
    plugins: [
      definePlugin({
        meta: { id: "stargantt.view" },
        setup: (ctx) => void buildCoreModules(ctx, { origin: 0, firstDayOfWeek }),
      }),
    ],
  });
  const scale: TimelineService = gantt.service("stargantt.timeline");
  const fn: TimelineService["unitBoundaries"] = (unit, fromMs, toMs, step, stepOffset) =>
    scale.unitBoundaries(unit, fromMs, toMs, step, stepOffset);
  gantt.dispose();
  dom.restore();
  calendars.set(firstDayOfWeek, fn);
  return fn;
}

/** One recorded straight line, in the coordinate space the canvas was painted in. */
export interface Line {
  x1: number;
  y1: number;
  x2: number;
  y2: number;
  stroke: string;
}

/**
 * Every `moveTo`+`lineTo` pair recorded on a fake canvas, as lines.
 *
 * Both the header and the grid batch their strokes into paths of `moveTo`/`lineTo` pairs, so the
 * pairs can be read back without knowing which path each belonged to.
 */
export function lines(canvas: FakeCanvas): Line[] {
  const out: Line[] = [];
  const ops = canvas.context?.ops ?? [];
  for (let i = 1; i < ops.length; i += 1) {
    const from = ops[i - 1];
    const to = ops[i];
    if (from === undefined || to === undefined) continue;
    if (from.op !== "moveTo" || to.op !== "lineTo") continue;
    const [x1, y1] = from.args;
    const [x2, y2] = to.args;
    if (x1 === undefined || y1 === undefined || x2 === undefined || y2 === undefined) continue;
    out.push({ x1, y1, x2, y2, stroke: to.stroke });
  }
  return out;
}

/** The x coordinates of the vertical lines on a canvas, in draw order. */
export function verticalXs(canvas: FakeCanvas, stroke?: string): number[] {
  return lines(canvas)
    .filter((l) => l.x1 === l.x2 && (stroke === undefined || l.stroke === stroke))
    .map((l) => l.x1);
}

/* ------------------------------------------------------------------ *
 * Hostless module doubles (grid-lines.test.ts, shading.test.ts)
 * ------------------------------------------------------------------ */

/** Uniform-height rows — all the horizontal, stripe and hover passes need. */
export function makeRowGeometry(count: number, rowHeight = 30): RowGeometryProvider {
  return {
    rowCount: () => count,
    rowAtY: (y) => Math.min(count - 1, Math.max(0, Math.floor(y / rowHeight))),
    yOf: (row) => row * rowHeight,
    rowHeight: () => rowHeight,
  };
}

/** The subset of `RenderModule` a `makeRenderStub` caller may want to control. */
export interface RenderStubOptions {
  invalidate?(layer: string, rect?: unknown): void;
  chartPaneElement?(): HTMLElement;
  rowGeometry?(): RowGeometryProvider | undefined;
  viewport?: Readonly<Viewport>;
  /**
   * Where the module's fault barrier reports to. The default rethrows, so a test that does not
   * expect a fault fails loudly on one; a test *about* the barrier passes a recorder instead.
   */
  fault?(error: unknown): void;
}

/**
 * A `RenderModule` double for the hostless grid-lines suites: every member the module never calls
 * in the case under test is a harmless no-op, and the handful it does call — `invalidate`,
 * `rowGeometry`, `chartPaneElement`, `viewport` — are the ones a caller overrides.
 */
export function makeRenderStub(opts: RenderStubOptions = {}): RenderModule {
  const viewport = createStore<Readonly<Viewport>>(
    opts.viewport ?? { scrollTop: 0, scrollLeft: 0, width: 0, height: 0 },
  );
  return {
    invalidate: opts.invalidate ?? ((): void => {}),
    refreshInsets: (): void => {},
    direction: () => "ltr",
    reducedMotion: () => false,
    textWidth: () => 0,
    bidiIsolate: (text) => text,
    firstPaintMs: () => undefined,
    batchRead: (fn) => fn(),
    batchWrite: (fn) => fn(),
    predictedViewport: () => undefined,
    chartPaneElement:
      opts.chartPaneElement ??
      ((): HTMLElement => {
        throw new Error("chartPaneElement was not stubbed for this test");
      }),
    wheelSpeedFactor: () => 1,
    scrollTo: (): void => {},
    renderTo: (): void => {},
    viewport,
    rowGeometry: opts.rowGeometry ?? ((): RowGeometryProvider | undefined => undefined),
    fault:
      opts.fault ??
      ((error: unknown): never => {
        throw error instanceof Error ? error : new Error(String(error));
      }),
  } as RenderModule;
}

/** What one `createGridLinesModule(ctx, …)` call did to its fake `PluginContext`. */
export interface MountedGridLines {
  /** The one `renderer/layers` contribution, or `undefined` when `anything` was false. */
  layer: LayerContribution | undefined;
  /** Every `ctx.own()` disposable the module registered. */
  owned: Disposable[];
  /** Every `ctx.claimOrder()` call the module made. */
  claims: { scope: string; key: string; order: number }[];
}

/**
 * Drives `createGridLinesModule` directly, with a fake `PluginContext` that answers only
 * `contribute` / `own` / `claimOrder` — the module takes its render, theme, timeline and data
 * dependencies as plain arguments rather than looking them up, so nothing else of `PluginContext`
 * is ever touched.
 */
export function mountGridLinesModule(
  config: GridLinesConfig | undefined,
  render: RenderModule,
  theme: Pick<ThemeService, "get">,
  scale: TimelineService,
  data: GridLinesDataSource = calendarSource(),
): MountedGridLines {
  let layer: LayerContribution | undefined;
  const owned: Disposable[] = [];
  const claims: { scope: string; key: string; order: number }[] = [];
  const ctx = {
    contribute: (point: string, value: unknown): void => {
      if (point !== "renderer/layers") throw new Error(`unexpected contribute(${point})`);
      layer = value as LayerContribution;
    },
    own: (d: Disposable): void => void owned.push(d),
    claimOrder: (scope: string, key: string, order: number): void => {
      claims.push({ scope, key, order });
    },
    root: undefined,
    locale: "en",
  } as unknown as PluginContext;

  const opt = normalizeViewConfig({ gridLines: config }).gridLines;
  createGridLinesModule(ctx, opt, render, theme as ThemeService, scale, data);
  return { layer, owned, claims };
}
