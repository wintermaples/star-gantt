// @vitest-environment happy-dom
/**
 * The standard-field feature's wiring: which columns it contributes, whether it hands over a bar
 * overlay renderer and a side-panel section, and where the column headers come from.
 */
import { describe, expect, it, afterEach } from "vitest";
import type { AnyPlugin, PluginContext } from "@stargantt/core";
import { createTestHost, mockStore } from "@stargantt/sdk";
import { treeGrid } from "../src/index";
import type { TreeGridConfig } from "../src/index";
import type { ColumnDef } from "../src/types";
import { upwardProbe } from "./_upward";
import type { UpwardProbe } from "./_upward";
import { fakeData, task } from "./_data";

const TASKS = [task("a", null)];

function serviceMocks(element: HTMLElement): Record<string, unknown> {
  return {
    "stargantt.data": fakeData(TASKS),
    "stargantt.view": {
      invalidate: () => {},
      refreshInsets: () => {},
      direction: () => "ltr",
      reducedMotion: () => false,
      textWidth: () => 0,
      bidiIsolate: (text: string) => text,
      firstPaintMs: () => undefined,
      batchRead: (fn: () => void) => fn(),
      batchWrite: (fn: () => void) => fn(),
      predictedViewport: () => undefined,
      chartPaneElement: () => element,
      wheelSpeedFactor: () => 1,
      scrollTo: () => {},
      renderTo: () => {},
      viewport: mockStore({ scrollTop: 0, scrollLeft: 0, width: 800, height: 600 }),
      viewMode: mockStore("split"),
    },
    "stargantt.timeline": {
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
      zoomLevel: mockStore({ id: "day", pxPerDay: 24, scales: [] }),
    },
    "stargantt.theme": {
      get: () => "",
      audit: () => [],
      setPreset: () => {},
      preset: () => null,
      presets: () => [],
      setColorScheme: () => {},
      colorScheme: () => "auto",
      refresh: () => {},
      tokens: mockStore({}),
    },
  };
}

/** Records every `grid/columns` contribution through the real `PluginContext`. */
function recordColumns(plugin: AnyPlugin, out: ColumnDef[]): AnyPlugin {
  return {
    meta: plugin.meta,
    setup(ctx: PluginContext, config: unknown): void | (() => void) {
      const proxy = new Proxy(ctx, {
        get(target, property, receiver): unknown {
          if (property === "contribute") {
            return (point: string, value: unknown): void => {
              if (point === "grid/columns") out.push(value as ColumnDef);
              (target.contribute as (p: string, v: unknown) => void).call(target, point, value);
            };
          }
          const value = Reflect.get(target, property, receiver) as unknown;
          return typeof value === "function" ? value.bind(target) : value;
        },
      });
      return plugin.setup(proxy as PluginContext, config as never);
    },
  };
}

interface Booted {
  columns: ColumnDef[];
  probe: UpwardProbe;
  dispose(): void;
}

let booted: Booted | undefined;

afterEach(() => {
  booted?.dispose();
  booted = undefined;
});

function boot(config?: TreeGridConfig): Booted {
  const element = document.createElement("div");
  document.body.appendChild(element);
  const columns: ColumnDef[] = [];
  const probe = upwardProbe();
  const provider = (id: string): AnyPlugin => ({ meta: { id }, setup: () => {} });
  const host = createTestHost({
    plugins: [
      provider("stargantt.data-store"),
      provider("stargantt.view"),
      recordColumns(treeGrid(config), columns),
      probe.plugin,
    ],
    element,
    services: serviceMocks(element),
  });
  const result: Booted = {
    columns,
    probe,
    dispose: () => {
      host.dispose();
      element.remove();
    },
  };
  booted = result;
  return result;
}

/** Only the columns the standard-field feature contributed, in contribution order. */
function fieldColumns(b: Booted): string[] {
  return b.columns.map((c) => c.id).filter((id) => id.startsWith("taskfields-"));
}

describe("standard-field wiring", () => {
  it("contributes the default columns, a bar overlay and a panel section", () => {
    const b = boot({ taskFields: {} });
    expect(fieldColumns(b)).toEqual([
      "taskfields-status",
      "taskfields-priority",
      "taskfields-deadline",
    ]);
    expect(b.probe.overlays()).toHaveLength(1);
    expect(b.probe.panels()).toHaveLength(1);
  });

  it("contributes nothing at all while the nest is omitted", () => {
    const b = boot();
    expect(fieldColumns(b)).toEqual([]);
    expect(b.probe.overlays()).toHaveLength(0);
    expect(b.probe.panels()).toHaveLength(0);
  });

  it("`columns: []` contributes none; unknown ids are dropped", () => {
    const none = boot({ taskFields: { columns: [] } });
    expect(fieldColumns(none)).toHaveLength(0);
    none.dispose();
    booted = undefined;

    const some = boot({ taskFields: { columns: ["id", "duration", "bogus" as never] } });
    expect(fieldColumns(some)).toEqual(["taskfields-id", "taskfields-duration"]);
  });

  it("disabling every bar visual and the panel section removes those contributions", () => {
    const b = boot({
      taskFields: {
        showStatusOnBars: false,
        showDeadlineWarnings: false,
        showAssigneeAvatars: false,
        detailFields: false,
      },
    });
    expect(b.probe.overlays()).toHaveLength(0);
    expect(b.probe.panels()).toHaveLength(0);
  });

  it("column headers come from the message catalog", () => {
    const b = boot({
      taskFields: { columns: ["status"] },
      messages: { statusColumn: "Zustand" },
    });
    expect(b.columns.find((c) => c.id === "taskfields-status")?.header).toBe("Zustand");
  });
});
