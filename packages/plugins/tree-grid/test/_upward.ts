/**
 * A probe for the points this package contributes *upward* to — the two bar points and the side
 * panel's field sections.
 *
 * Those points are owned by plugins in higher layers, which these suites deliberately do not
 * compose: the grid's job is to hand over a provider and a renderer, and that hand-over is what is
 * asserted here. The probe defines the three points with their real merge strategies and hands the
 * collected contributions back, so a test can drive them exactly as their real owner would.
 */
import { collect, definePlugin, first } from "@stargantt/core";
import type { AnyPlugin } from "@stargantt/core";
import type { Task } from "@stargantt/plugin-data-store";
import type {
  BarBox,
  BarOverlayRenderer,
  BarStyle,
  BarStyleProvider,
  SidePanelFieldContribution,
} from "../src/internal/upward";

/** The handle a test drives the collected contributions through. */
export interface UpwardProbe {
  plugin: AnyPlugin;
  /** The composed bar-style provider, or `undefined` when nothing contributed one. */
  style(task: Readonly<Task>): BarStyle | undefined;
  /** Whether any bar-style provider was contributed at all. */
  hasStyle(): boolean;
  /** Every contributed bar overlay renderer, in contribution order. */
  overlays(): readonly BarOverlayRenderer[];
  /** Runs every contributed overlay over one bar, as the bar pass would. */
  paintOverlays(g: CanvasRenderingContext2D, bar: Readonly<BarBox>): void;
  /** Every contributed side-panel field section, in contribution order. */
  panels(): readonly SidePanelFieldContribution[];
}

/**
 * Builds the probe. Register `probe.plugin` after `treeGrid(...)` in the boot's `extra` list — it
 * declares a hard dependency on this plugin so the points exist before the contributions are
 * delivered (the core buffers them either way).
 */
export function upwardProbe(): UpwardProbe {
  let stylePoint: { get(): BarStyleProvider | undefined } | undefined;
  let overlayPoint: { get(): BarOverlayRenderer[] } | undefined;
  let panelPoint: { get(): SidePanelFieldContribution[] } | undefined;
  let styled = false;

  const plugin = definePlugin({
    meta: { id: "test.upward-probe", dependsOn: ["stargantt.tree-grid"] },
    setup(ctx) {
      stylePoint = ctx.defineExtensionPoint(
        "taskbars/style",
        (inputs: BarStyleProvider[]): BarStyleProvider => {
          styled = inputs.length > 0;
          return first<[task: Readonly<Task>], BarStyle>()(inputs);
        },
      );
      overlayPoint = ctx.defineExtensionPoint("taskbars/overlays", collect<BarOverlayRenderer>());
      // The side panel's owner does not exist yet, so its key is not on the merging surface;
      // the point is defined through the same narrow cast the contribution side uses.
      panelPoint = (
        ctx.defineExtensionPoint as unknown as (
          key: string,
          reduce: (inputs: SidePanelFieldContribution[]) => SidePanelFieldContribution[],
        ) => { get(): SidePanelFieldContribution[] }
      ).call(ctx, "sidepanel/fields", collect<SidePanelFieldContribution>());
    },
  });

  return {
    plugin,
    style: (task) => stylePoint?.get()?.(task),
    hasStyle: () => {
      stylePoint?.get();
      return styled;
    },
    overlays: () => overlayPoint?.get() ?? [],
    paintOverlays: (g, bar) => {
      for (const draw of overlayPoint?.get() ?? []) draw(g, bar);
    },
    panels: () => panelPoint?.get() ?? [],
  };
}

/** A bar box with the geometry a one-day bar on the first row gets, overridable per test. */
export function barBox(overrides: Partial<BarBox> = {}): BarBox {
  return {
    id: "t0",
    x: 0,
    y: 4,
    width: 40,
    height: 20,
    gutterStart: 0,
    gutterEnd: 0,
    ...overrides,
  };
}
