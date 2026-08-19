/**
 * Hostless-ish integration boot for the `zoom` feature's own tests: a real `@stargantt/core` host
 * (via `createTestHost`) with service doubles for the four packages `interaction` hard-depends on,
 * scoped to exactly what zoom-controls reads (§6.6). Kept separate from `test/_fakes.ts` (shared by
 * every other feature's tests) per this task's file-scope rule: new doubles live in their own
 * prefixed file.
 */
import { createTestHost, mockStore } from "@stargantt/sdk";
import type { AnyPlugin, PluginContext } from "@stargantt/core";
import type { Task, TaskId } from "@stargantt/plugin-data-store";
import { interaction } from "../src/index";
import { rowsOf } from "./_fakes";
import { fakeDocument } from "./_zoom-dom";
import type { FakeElement } from "./_zoom-dom";

/**
 * One stand-in plugin registered under a real provider's id, publishing its services — the same
 * shape `test/wiring.test.ts` uses. `interaction`'s `dependsOn` names plugin ids, not just service
 * ids, so `createTestHost`'s generic `services` mock (which publishes under a synthetic id) cannot
 * satisfy it; these doubles must be registered under the ids the DAG actually checks.
 */
function provider(id: string, services: Record<string, unknown>): AnyPlugin {
  return {
    meta: { id },
    setup(ctx): void {
      for (const [key, impl] of Object.entries(services)) ctx.provide(key as never, impl as never);
    },
  };
}

export interface ZoomLevelSnapshot {
  id: string;
  pxPerDay: number;
  scales: { unit: string; format: () => string }[];
}

export interface BootOptions {
  config?: Parameters<typeof interaction>[0];
  tasks?: readonly Task[];
  /** Row order for `stargantt.rows`; defaults to the tasks' own declaration order. */
  rowOrder?: readonly TaskId[];
  /** The active zoom level metrics the fake `stargantt.timeline` reports. Six built-in levels by default. */
  levels?: readonly { id: string; pxPerDay: number }[];
  initialLevel?: ZoomLevelSnapshot;
  /**
   * Extra plugins with no `dependsOn` of their own, composed alongside `interaction` — always in an
   * earlier topological tier, so (e.g.) a rival `overlay-corner` claimant here always runs first.
   */
  extraPlugins?: readonly AnyPlugin[];
}

const DEFAULT_LEVELS: readonly { id: string; pxPerDay: number }[] = [
  { id: "year", pxPerDay: 0.1 },
  { id: "quarter", pxPerDay: 0.4 },
  { id: "month", pxPerDay: 1.2 },
  { id: "week", pxPerDay: 8 },
  { id: "day", pxPerDay: 24 },
  { id: "hour", pxPerDay: 240 },
];

export function boot(options: BootOptions = {}): {
  ctx: PluginContext;
  host: ReturnType<typeof createTestHost>;
  pane: FakeElement;
  toolbar(): FakeElement | null;
  button(kind: "in" | "out" | "fit" | "today" | "selection"): FakeElement | null;
  slider(): FakeElement | null;
  /** Every `scrollTo` call, in order. */
  scrolls: { scrollLeft?: number; scrollTop?: number }[];
  /** Every `setZoomLevel` call, in order. */
  zoomCalls: { id: string; anchorTime: number | undefined }[];
  faults: unknown[];
} {
  const tasks = options.tasks ?? [];
  const byId = new Map<TaskId, Task>(tasks.map((t) => [t.id, t]));
  const rowOrder = options.rowOrder ?? tasks.map((t) => t.id);
  const levels = options.levels ?? DEFAULT_LEVELS;

  // A fake `Document`/element pair, not real DOM — see `_zoom-dom.ts` for why: the toolbar's
  // `calc(var(--sg-safe-*))` corner offsets must stay observable, which a real happy-dom
  // `CSSStyleDeclaration` does not allow for the `top`/`right`/`bottom`/`left` properties.
  const pane = fakeDocument().createElement("div");
  const scrolls: { scrollLeft?: number; scrollTop?: number }[] = [];
  const zoomCalls: { id: string; anchorTime: number | undefined }[] = [];
  const faults: unknown[] = [];

  let level: ZoomLevelSnapshot = options.initialLevel ?? {
    id: "day",
    pxPerDay: 24,
    scales: [{ unit: "day", format: () => "" }],
  };
  const zoomLevel = mockStore<ZoomLevelSnapshot>(level);
  const knownIds = new Set(levels.map((l) => l.id));

  const dataStore = provider("stargantt.data-store", {
    "stargantt.data": {
      getTask: (id: TaskId) => byId.get(id),
      taskIds: () => byId.keys(),
      query: () => ({ byId, children: new Map([[null, tasks.map((t) => t.id)]]), linksByTask: new Map() }),
      tasks: mockStore<ReadonlyMap<TaskId, Task>>(byId),
      links: mockStore(new Map()),
    },
  });
  const view = provider("stargantt.view", {
    "stargantt.view": {
      invalidate: () => {},
      viewport: mockStore({ scrollLeft: 0, scrollTop: 0, width: 800, height: 600 }),
      scrollTo: (target: { scrollLeft?: number; scrollTop?: number }) => {
        scrolls.push(target);
      },
      chartPaneElement: () => pane,
    },
    "stargantt.timeline": {
      tToX: (t: number) => t * 1e-6,
      xToT: (x: number) => x / 1e-6,
      pxPerMs: 1e-6,
      zoomLevel,
      setZoomLevel: (id: string, anchorTime?: number) => {
        zoomCalls.push({ id, anchorTime });
        if (!knownIds.has(id)) throw new Error(`unknown zoom level "${id}"`);
        level = { id, pxPerDay: levels.find((l) => l.id === id)?.pxPerDay ?? 1, scales: level.scales };
        zoomLevel.set(level);
      },
      levelMetrics: () => levels,
      requestOriginExtension: () => {},
      releaseOriginExtension: () => {},
    },
    "stargantt.theme": { get: () => "" },
  });
  const treeGrid = provider("stargantt.tree-grid", {
    "stargantt.rows": rowsOf({ order: rowOrder }),
    "stargantt.grid": { setSelected: () => {} },
  });
  const taskBars = provider("stargantt.task-bars", {
    "stargantt.task-bars": { barBoxOf: () => undefined, visibleBoxes: () => [], hasOwnBar: () => false },
  });
  // Subscribes inside its own `setup()` (tier 0, no `dependsOn`) rather than on the returned handle
  // after `createTestHost` returns: `Gantt.create` runs every plugin's `setup()` synchronously
  // inside its constructor, so a post-hoc `host.host.on(...)` would miss a fault raised during
  // `interaction`'s own setup (e.g. a `claimSlot` conflict, reported synchronously — architecture.md
  // §1.2).
  const faultRecorder: AnyPlugin = {
    meta: { id: "test.fault-recorder" },
    setup(ctx): void {
      ctx.on("core/pluginError", (e) => faults.push(e.error));
    },
  };

  const host = createTestHost({
    plugins: [
      faultRecorder,
      ...(options.extraPlugins ?? []),
      dataStore,
      view,
      treeGrid,
      taskBars,
      interaction(options.config),
    ],
  });

  return {
    ctx: host.ctxOf("stargantt.interaction"),
    host,
    pane,
    toolbar: () => pane.query("sg-zoom-controls"),
    button: (kind) => pane.query(`sg-zoom-controls__${kind}`),
    slider: () => pane.query("sg-zoom-controls__slider"),
    scrolls,
    zoomCalls,
    faults,
  };
}
