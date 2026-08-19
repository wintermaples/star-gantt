// @vitest-environment happy-dom
/**
 * The composed plugin: what it contributes to `grid/columns`, the services it publishes, and the
 * mechanical `dependsOn` / `ctx.use()` consistency check.
 *
 * The services this plugin consumes are supplied as mocks — the real providers are composed only
 * in the integration phase.
 */
import { describe, expect, it, afterEach } from "vitest";
import type { AnyPlugin, PluginContext } from "@stargantt/core";
import { createTestHost, expectDepsConsistency, mockStore } from "@stargantt/sdk";
import type {
  CustomFieldValue,
  FieldsService,
  ResolvedCustomField,
  TaskId,
} from "@stargantt/plugin-data-store";
import { treeGrid } from "../src/index";
import type { TreeGridConfig } from "../src/index";
import type { ColumnDef, GridService, RowsService } from "../src/types";
import { fakeData, task } from "./_data";

/** The service id → providing plugin id map of the architecture's service table. */
const SERVICE_PROVIDERS = {
  "stargantt.data": "stargantt.data-store",
  "stargantt.fields": "stargantt.data-store",
  "stargantt.view": "stargantt.view",
  "stargantt.timeline": "stargantt.view",
  "stargantt.theme": "stargantt.view",
};

const TREE = [task("p0", null), task("c0", "p0"), task("p1", null)];

function viewMock(element: HTMLElement): unknown {
  return {
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
  };
}

function timelineMock(): unknown {
  return {
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
  };
}

function themeMock(): unknown {
  return {
    get: () => "",
    audit: () => [],
    setPreset: () => {},
    preset: () => null,
    presets: () => [],
    setColorScheme: () => {},
    colorScheme: () => "auto",
    refresh: () => {},
    tokens: mockStore({}),
  };
}

function field(key: string, extra: Partial<ResolvedCustomField> = {}): ResolvedCustomField {
  return {
    key,
    type: "text",
    label: key,
    width: 110,
    options: [],
    formula: "",
    column: true,
    ...extra,
  };
}

function fieldsMock(definitions: readonly ResolvedCustomField[]): FieldsService {
  return {
    definitions: () => definitions,
    valueOf: (): CustomFieldValue | undefined => undefined,
    setValue: () => {},
    setValues: () => {},
    displayValue: () => "",
  };
}

/**
 * Wraps a plugin so every `grid/columns` contribution is recorded, using only the public
 * `PluginContext` surface the real core hands to `setup()`.
 */
function recordColumns(plugin: AnyPlugin, out: ColumnDef[]): AnyPlugin {
  return {
    meta: plugin.meta,
    setup(ctx: PluginContext, config: unknown): void | (() => void) {
      const proxy = new Proxy(ctx, {
        get(target, property, receiver): unknown {
          if (property === "contribute") {
            return (point: string, value: unknown): void => {
              if (point === "grid/columns") out.push(value as ColumnDef);
              (target.contribute as (p: string, v: unknown) => void)(point, value);
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
  rows: RowsService;
  grid: GridService;
  toggle(id: TaskId, expanded?: boolean): void;
  dispose(): void;
}

let booted: Booted | undefined;

afterEach(() => {
  booted?.dispose();
  booted = undefined;
});

function boot(config?: TreeGridConfig, fields?: FieldsService): Booted {
  const element = document.createElement("div");
  document.body.appendChild(element);
  const columns: ColumnDef[] = [];
  const services: Record<string, unknown> = {
    "stargantt.data": fakeData(TREE),
    "stargantt.view": viewMock(element),
    "stargantt.timeline": timelineMock(),
    "stargantt.theme": themeMock(),
  };
  if (fields !== undefined) services["stargantt.fields"] = fields;
  // The declared providers are present as empty plugins so the host's `dependsOn` resolution
  // succeeds; the services themselves come from the mocks above.
  const provider = (id: string): AnyPlugin => ({ meta: { id }, setup: () => {} });
  const host = createTestHost({
    plugins: [
      provider("stargantt.data-store"),
      provider("stargantt.view"),
      recordColumns(treeGrid(config), columns),
    ],
    element,
    services,
  });
  const result: Booted = {
    columns,
    rows: host.host.service("stargantt.rows"),
    grid: host.host.service("stargantt.grid"),
    toggle: (id, expanded) =>
      host.host.dispatch(
        "view/rowToggle",
        expanded === undefined ? { id } : { id, expanded },
      ),
    dispose: () => {
      host.dispose();
      element.remove();
    },
  };
  booted = result;
  return result;
}

describe("composition without a task-bars or side-panel owner", () => {
  it("boots with both feature nests on, buffering the contributions the composition cannot take", () => {
    const element = document.createElement("div");
    document.body.appendChild(element);
    const provider = (id: string): AnyPlugin => ({ meta: { id }, setup: () => {} });
    const host = createTestHost({
      plugins: [
        provider("stargantt.data-store"),
        provider("stargantt.view"),
        // Registered unwrapped, so the real `PluginContext` methods are exercised as methods.
        treeGrid({ taskFields: {}, conditionalFormat: { legend: true, overdue: true } }),
      ],
      element,
      services: {
        "stargantt.data": fakeData(TREE),
        "stargantt.view": viewMock(element),
        "stargantt.timeline": timelineMock(),
        "stargantt.theme": themeMock(),
      },
    });
    expect(host.host.service("stargantt.rows").rowCount()).toBe(3);
    expect(element.querySelector(".sg-cf-legend")).not.toBeNull();
    host.dispose();
    element.remove();
  });
});

describe("dependency declaration", () => {
  it("declares exactly the providers its hard `ctx.use()` calls imply", () => {
    expectDepsConsistency(treeGrid(), SERVICE_PROVIDERS);
  });
});

describe("`grid/columns` composition", () => {
  it("contributes the four built-in columns by default", () => {
    const b = boot();
    expect(b.columns.map((c) => c.id)).toEqual(["name", "start", "end", "progress"]);
  });

  it("prepends the WBS column when the option is on", () => {
    const b = boot({ wbs: true });
    expect(b.columns.map((c) => c.id)).toEqual(["wbs", "name", "start", "end", "progress"]);
  });

  it("adds the nine standard field columns when the nest names them all", () => {
    const b = boot({
      taskFields: {
        columns: [
          "id",
          "status",
          "priority",
          "tags",
          "assignees",
          "deadline",
          "actualStart",
          "actualEnd",
          "duration",
        ],
      },
    });
    expect(b.columns.map((c) => c.id)).toEqual([
      "name",
      "start",
      "end",
      "progress",
      "taskfields-id",
      "taskfields-status",
      "taskfields-priority",
      "taskfields-tags",
      "taskfields-assignees",
      "taskfields-deadline",
      "taskfields-actualStart",
      "taskfields-actualEnd",
      "taskfields-duration",
    ]);
  });

  it("contributes the three default field columns when the nest is present but empty", () => {
    const b = boot({ taskFields: {} });
    expect(b.columns.map((c) => c.id).slice(4)).toEqual([
      "taskfields-status",
      "taskfields-priority",
      "taskfields-deadline",
    ]);
  });

  it("contributes no field column while the nest is omitted", () => {
    const b = boot();
    expect(b.columns.some((c) => c.id.startsWith("taskfields-"))).toBe(false);
  });

  it("adds one column per user-defined field with `column` enabled", () => {
    const b = boot(undefined, fieldsMock([field("risk"), field("hidden", { column: false })]));
    expect(b.columns.map((c) => c.id)).toEqual([
      "name",
      "start",
      "end",
      "progress",
      "customfields-risk",
    ]);
  });

  it("composes the built-in, standard-field and user-defined columns together", () => {
    const b = boot({ taskFields: {} }, fieldsMock([field("risk")]));
    expect(b.columns.map((c) => c.id)).toEqual([
      "name",
      "start",
      "end",
      "progress",
      "customfields-risk",
      "taskfields-status",
      "taskfields-priority",
      "taskfields-deadline",
    ]);
  });

  it("replaces the built-ins wholesale when `columns` is supplied", () => {
    const only: ColumnDef = {
      id: "only",
      header: "Only",
      render: () => {},
      getValue: () => "",
    };
    const b = boot({ columns: [only] });
    expect(b.columns.map((c) => c.id)).toEqual(["only"]);
  });
});

describe("published services", () => {
  it("publishes the row set as a store", () => {
    const b = boot();
    expect(b.rows.rows.get()).toEqual({ taskIds: ["p0", "c0", "p1"], totalHeight: 3 * 28 });
  });

  it("republishes the row set once per effective collapse, and not at all for a no-op", () => {
    const b = boot();
    const seen: TaskId[][] = [];
    b.rows.rows.subscribe((next) => seen.push([...next.taskIds]));
    b.toggle("p0");
    b.toggle("p0", false); // already collapsed: nothing changes, so nothing is published
    expect(seen).toEqual([["p0", "p1"]]);
    expect(b.rows.rowCount()).toBe(2);
    expect(b.rows.isExpanded("p0")).toBe(false);
  });

  it("starts with no active sort and an empty width map", () => {
    const b = boot();
    expect(b.grid.sort.get()).toBeNull();
    expect(b.grid.columnWidths.get().get("name")).toBe(220);
  });
});
