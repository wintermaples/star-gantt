/**
 * Shared boot helper: a real `Gantt.create()` over the fake DOM, with the real data store and a
 * stand-in for the view plugin.
 *
 * The stand-in owns exactly what the grid needs from the layer below it — the three services, the
 * pane hosting, the content-extent and row-geometry points — so these suites exercise the grid
 * itself rather than another package's layout engine. Composing the real view plugin is the
 * integration phase's job.
 */
import { expect } from "vitest";
import { Gantt, collect, createStore, definePlugin } from "@stargantt/core";
import type { AnyPlugin, GanttInstance, PluginContext, WritableStore } from "@stargantt/core";
import { dataStore } from "@stargantt/plugin-data-store";
import type { DataService, Task } from "@stargantt/plugin-data-store";
import type {
  ContentExtentContribution,
  PaneContribution,
  RowGeometryProvider,
  ThemeService,
  ThemeTokens,
  TimelineService,
  ViewService,
  Viewport,
} from "@stargantt/plugin-view";
import { treeGrid } from "../src/index";
import type { TreeGridConfig } from "../src/index";
import type { GridService, RowsService } from "../src/types";
import { asElement, installDom } from "./_harness/index";
import type { DomHarness, DomOptions, FakeElement, FakeInput } from "./_harness/index";

export interface Booted {
  dom: DomHarness;
  gantt: GanttInstance;
  data: DataService;
  rows: RowsService;
  grid: GridService;
  pane: FakeElement;
  divider: FakeElement;
  header: FakeElement;
  body: FakeElement;
  editor(): FakeInput | undefined;
  /** Visible (non-hidden) row elements, in slot order. */
  visibleRows(): FakeElement[];
  /** The chart pane element the stand-in owns — where corner-anchored overlays mount. */
  chartPane: FakeElement;
  /** The shared vertical viewport the grid follows; drive it to simulate a chart-side scroll. */
  viewport: WritableStore<Readonly<Viewport>>;
  /** The theme token snapshot; set it to simulate a theme change. */
  themeTokens: WritableStore<ThemeTokens>;
  /** Every `ViewService.scrollTo` the grid requested, in order. */
  scrollRequests(): readonly number[];
  /** The layers the grid asked to have repainted, in order. */
  invalidations(): readonly string[];
  /** The composed row geometry, or `undefined` when nothing contributed one. */
  rowGeometry(): RowGeometryProvider | undefined;
  /** The composed vertical content extent. */
  contentHeight(): number;
  /** Drives the pane contribution's `onResize`, as a divider drag would. */
  paneResize(width: number): void;
}

export function probe(
  setup: (ctx: PluginContext) => void,
  id = "test.probe",
  dependsOn: string[] = ["stargantt.tree-grid"],
): AnyPlugin {
  return definePlugin({ meta: { id, dependsOn }, setup });
}

/** What `viewStub` hands back to the boot helper, so the tests can drive the layer below. */
interface ViewStubHandle {
  plugin: AnyPlugin;
  chartPane(): FakeElement;
  viewport: WritableStore<Readonly<Viewport>>;
  themeTokens: WritableStore<ThemeTokens>;
  scrollRequests: number[];
  invalidations: string[];
  panes(): readonly PaneContribution[];
  extents(): readonly ContentExtentContribution[];
  rowGeometry(): RowGeometryProvider | undefined;
  paneElements: Map<string, FakeElement>;
}

/**
 * A stand-in for `stargantt.view`: it provides the three services the grid consumes, defines the
 * three points the grid contributes to, and mounts every contributed pane on `lifecycle/ready` —
 * the grid pane before the chart pane, as in a real composition.
 */
function viewStub(): ViewStubHandle {
  const viewport = createStore<Readonly<Viewport>>({
    scrollTop: 0,
    scrollLeft: 0,
    width: 400,
    height: 300,
  });
  const themeTokens = createStore<ThemeTokens>({});
  const scrollRequests: number[] = [];
  const invalidations: string[] = [];
  const paneElements = new Map<string, FakeElement>();
  let chart: FakeElement | undefined;
  let panePoint: { get(): PaneContribution[] } | undefined;
  let extentPoint: { get(): ContentExtentContribution[] } | undefined;
  let geometryPoint: { get(): RowGeometryProvider | undefined } | undefined;

  const plugin = definePlugin({
    meta: { id: "stargantt.view" },
    setup(ctx) {
      const doc = ctx.root.ownerDocument;
      const chartPane = doc.createElement("div");
      chartPane.className = "sg-pane sg-pane--chart";
      ctx.root.appendChild(chartPane);
      chart = chartPane as unknown as FakeElement;

      const view: ViewService = {
        invalidate: (layer: string) => {
          invalidations.push(layer);
        },
        refreshInsets: () => {},
        direction: () => "ltr",
        reducedMotion: () => false,
        textWidth: (_g: unknown, text: string) => text.length * 7,
        bidiIsolate: (text: string) => text,
        firstPaintMs: () => undefined,
        batchRead: (fn: () => void) => fn(),
        batchWrite: (fn: () => void) => fn(),
        predictedViewport: () => undefined,
        chartPaneElement: () => chartPane,
        wheelSpeedFactor: () => 1,
        scrollTo: (target: { scrollTop?: number; scrollLeft?: number }) => {
          if (target.scrollTop === undefined) return;
          scrollRequests.push(target.scrollTop);
          viewport.set({ ...viewport.get(), scrollTop: target.scrollTop });
        },
        renderTo: () => {},
        viewport,
        viewMode: createStore("split"),
      } as unknown as ViewService;
      ctx.provide("stargantt.view", view);

      const timeline: TimelineService = {
        tToX: (t: number) => t,
        xToT: (x: number) => x,
        pxPerMs: 1,
        setZoomLevel: () => {},
        setOrigin: () => {},
        requestOriginExtension: () => {},
        releaseOriginExtension: () => {},
        levelMetrics: () => [],
        firstDayOfWeek: () => 1,
        unitBoundaries: () => [],
        formatDate: () => "",
        gridCellAt: (t: number) => ({ start: t, end: t + 86_400_000 }),
        zoomLevel: createStore({ id: "day", pxPerDay: 24, scales: [] }),
      } as unknown as TimelineService;
      ctx.provide("stargantt.timeline", timeline);

      const theme: ThemeService = {
        get: (token: string) => themeTokens.get()[token] ?? "",
        audit: () => [],
        setPreset: () => {},
        preset: () => null,
        presets: () => [],
        setColorScheme: () => {},
        colorScheme: () => "auto",
        refresh: () => {},
        tokens: themeTokens,
      } as unknown as ThemeService;
      ctx.provide("stargantt.theme", theme);

      panePoint = ctx.defineExtensionPoint("view/panes", collect<PaneContribution>());
      extentPoint = ctx.defineExtensionPoint(
        "renderer/contentExtent",
        collect<ContentExtentContribution>(),
      );
      geometryPoint = ctx.defineExtensionPoint(
        "renderer/rowGeometry",
        // The point's own `first` composition, over the provider objects the point collects.
        (inputs: RowGeometryProvider[]) => inputs[0],
      );

      // Panes mount once every plugin has registered its contribution, exactly as the real layout
      // does; each pane gets its own element plus the divider that resizes it.
      ctx.on("lifecycle/ready", () => {
        for (const contribution of panePoint?.get() ?? []) {
          const el = doc.createElement("div");
          el.className = "sg-pane";
          const divider = doc.createElement("div");
          divider.className = "sg-pane-divider";
          divider.setAttribute("role", "separator");
          if (contribution.label !== undefined) {
            divider.setAttribute("aria-label", contribution.label);
          }
          el.style.width = `${contribution.initialWidth}px`;
          // A left pane sits before the chart pane; a DOM double without `insertBefore` simply
          // appends, which every assertion in these suites tolerates.
          const before = (node: HTMLElement): void => {
            if (typeof ctx.root.insertBefore === "function") ctx.root.insertBefore(node, chartPane);
            else ctx.root.appendChild(node);
          };
          before(el);
          before(divider);
          paneElements.set(contribution.id, el as unknown as FakeElement);
          contribution.mount(el);
        }
      });
    },
  });

  return {
    plugin,
    chartPane: () => {
      if (chart === undefined) throw new Error("the chart pane was not created");
      return chart;
    },
    viewport,
    themeTokens,
    scrollRequests,
    invalidations,
    panes: () => panePoint?.get() ?? [],
    extents: () => extentPoint?.get() ?? [],
    rowGeometry: () => geometryPoint?.get(),
    paneElements,
  };
}

export function boot(
  extra: AnyPlugin[] = [],
  options: DomOptions = {},
  // docs/specs/plugins/tree-grid.md § Config — omitted means the built-in defaults, which is what
  // most of these suites rely on.
  config?: TreeGridConfig,
): Booted {
  // 400x300 keeps every rect-derived number in these suites at the values they were written for.
  const dom = installDom({ width: 400, height: 300, ...options });
  const stub = viewStub();
  const gantt = Gantt.create({
    element: asElement(dom.root),
    plugins: [dataStore(), stub.plugin, treeGrid(config), ...extra],
  });

  const pane = dom.root.find("sg-pane sg-pane--grid");
  if (pane === undefined) throw new Error("grid pane was not created");
  const divider = dom.root.find("sg-pane-divider");
  if (divider === undefined) throw new Error("pane divider was not created");
  const header = pane.find("sg-grid-header");
  const body = pane.find("sg-grid-body");
  if (header === undefined || body === undefined) throw new Error("grid skeleton is incomplete");

  return {
    dom,
    gantt,
    data: gantt.service("stargantt.data"),
    rows: gantt.service("stargantt.rows"),
    grid: gantt.service("stargantt.grid"),
    pane,
    divider,
    header,
    body,
    editor: () => pane.find("sg-grid-editor") as FakeInput | undefined,
    visibleRows: () => body.findAll("sg-grid-row").filter((r) => r.style["display"] !== "none"),
    chartPane: stub.chartPane(),
    viewport: stub.viewport,
    themeTokens: stub.themeTokens,
    scrollRequests: () => stub.scrollRequests,
    invalidations: () => stub.invalidations,
    rowGeometry: () => stub.rowGeometry(),
    contentHeight: () => {
      let height = 0;
      for (const contribution of stub.extents()) {
        const measured = contribution.measure().height ?? 0;
        if (measured > height) height = measured;
      }
      return height;
    },
    paneResize: (width) => {
      for (const contribution of stub.panes()) contribution.onResize?.(width);
    },
  };
}

/**
 * The horizontal interval `[left, right]` each column occupies inside one flex line — a header row
 * or a body row — accumulated from the inline widths the plugin writes.
 *
 * The indent gutter is counted as part of the column that follows it, because that is what it is:
 * the tree column pays for the toggle and the depth inset out of its own declared width, so the
 * header's `.sg-grid-header-gutter` and a row's `.sg-grid-toggle` are the same leading slice of the
 * same column. Every other column's interval is its cell's alone.
 *
 * The fake DOM does no layout, so this reads the geometry the plugin *declares*: every child of the
 * line (gutter, toggle, cells) must carry an inline width, which is true of every column that
 * declares a `ColumnDef.width` — the default composition and every composition these suites build.
 * A width-less column has nothing to read and makes the walk throw rather than silently skip.
 */
export function columnSpans(line: FakeElement): Record<string, [number, number]> {
  const spans: Record<string, [number, number]> = {};
  let x = 0;
  /** Where the run of gutter elements preceding the current cell began. */
  let pending: number | undefined;
  for (const child of line.children) {
    const width = Number.parseFloat(child.style["width"] ?? "");
    if (!Number.isFinite(width)) {
      throw new Error(`no inline width on .${child.className} — parity is unmeasurable`);
    }
    const id = child.getAttribute("data-column-id");
    if (id === null) {
      pending ??= x;
      x += width;
      continue;
    }
    const left = pending ?? x;
    pending = undefined;
    x += width;
    spans[id] = [left, x];
  }
  return spans;
}

/**
 * The header-parity invariant: `row`'s cells span exactly the intervals the header's cells span.
 *
 * At every depth, at every column width, in every composition, each displayed column's body cells
 * span exactly the horizontal interval that column's header cell spans. A row that fails this is
 * the drift the tree-column geometry exists to prevent, and it is invisible to a screenshot
 * baseline until the columns are visibly out of line.
 */
export function expectHeaderParity(b: Booted, row: FakeElement): void {
  expect(columnSpans(row)).toEqual(columnSpans(b.header));
}

export { flatTasks } from "./_harness/index";

/**
 * A two-level tree: `p0…p{parents-1}` roots, each with `perParent` children.
 * Row order after flattening is p0, p0c0…, p1, p1c0…
 */
export function treeTasks(parents: number, perParent: number): Partial<Task>[] {
  const out: Partial<Task>[] = [];
  for (let p = 0; p < parents; p += 1) {
    out.push({ id: `p${p}`, parentId: null, name: `p${p}`, start: 0, end: 1 });
    for (let c = 0; c < perParent; c += 1) {
      out.push({ id: `p${p}c${c}`, parentId: `p${p}`, name: `p${p}c${c}`, start: 0, end: 1 });
    }
  }
  return out;
}
