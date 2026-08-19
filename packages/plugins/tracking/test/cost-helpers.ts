/**
 * Shared boot helpers for the cost-area suites.
 *
 * Deliberate AREA-level isolation, so a failure here always points at the cost area alone (root
 * `index.ts`'s own headless composition coverage lives in `test/headless.test.ts`): these suites
 * wire the cost area exactly the way the root does — one probe plugin calls `wireCost(deps)` with
 * the real resolved config, the real message catalog and the real `stargantt.data` service, over a
 * real `@stargantt/core` host booted by `sdk/testing`'s `createTestHost`.
 *
 * `stargantt.view` (the panel gate) and `stargantt.theme` (the panel tokens) are injected as mock
 * services rather than by booting the whole chart stack: the cost area only ever asks whether view
 * RESOLVES and what a theme token reads, never for geometry.
 */
import { definePlugin } from "@stargantt/core";
import type { AnyPlugin, PluginContext } from "@stargantt/core";
import { dataStore } from "@stargantt/plugin-data-store";
import type {
  Assignment,
  DataService,
  ReadonlyDataView,
  Task,
  TaskId,
} from "@stargantt/plugin-data-store";
import { createTestHost } from "@stargantt/sdk";
import type { TestHost } from "@stargantt/sdk";
import { resolveConfig } from "../src/config";
import type { TrackingConfig } from "../src/config";
import { resolveMessages } from "../src/internal/messages";
import type { TrackingMessages } from "../src/internal/messages";
import { wireCost } from "../src/internal/cost/wire";
import type { CostService } from "../src/types";

export const DAY = 86_400_000;

/** The default catalog, resolved with no overrides — what the built-in panels render with. */
export function defaultMessages(): TrackingMessages {
  return resolveMessages(undefined, () => undefined);
}

/** One reported fault: `reportError(where, error)`'s two arguments. */
export interface ReportedFault {
  where: string;
  error: unknown;
}

export interface CostBoot {
  host: TestHost;
  data: DataService;
  service: CostService;
  /** Every `reportError` call the area made, in order. */
  faults: ReportedFault[];
  /** Every `core/pluginError` the host saw (the same faults, as the plugin root would emit them). */
  pluginErrors: { pluginId: string; error: unknown }[];
  /** The gantt root — the panels' host element. */
  root: HTMLElement;
  /** Moves the injected clock; the status-date fallback re-reads it per call. */
  setNow(t: number): void;
  dispose(): void;
}

export interface BootOptions {
  /** Injected `now()`. Default 0 (so the UTC-day fallback lands on the epoch day). */
  now?: number;
  /** Provide a `stargantt.view` mock, which is what un-gates the panels. Default `false`. */
  view?: boolean;
  /** Provide a `stargantt.theme` mock with this token lookup. */
  theme?: (token: string) => string;
  /** A `stargantt.resource-pool` mock (the §2.8 optional rate fallback). */
  resourcePool?: { get(resourceId: string | number): { costRate?: number } | undefined };
  /** Extra plugins to boot alongside. */
  extra?: readonly AnyPlugin[];
}

const TRACKING_PLUGIN_ID = "stargantt.tracking";

/** Boots the cost area over a real core host. */
export function bootCost(config: TrackingConfig = {}, options: BootOptions = {}): CostBoot {
  let service: CostService | undefined;
  const faults: ReportedFault[] = [];
  const pluginErrors: { pluginId: string; error: unknown }[] = [];
  let now = options.now ?? 0;

  const probe = definePlugin({
    meta: { id: "test.cost-area", dependsOn: ["stargantt.data-store"] },
    setup(ctx: PluginContext): void {
      const reportError = (where: string, error: unknown): void => {
        faults.push({ where, error });
        ctx.emit("core/pluginError", {
          pluginId: TRACKING_PLUGIN_ID,
          error: { where, cause: error },
        });
      };
      const messages = resolveMessages(config.messages, (key, error) =>
        reportError(`messages.${key}`, error),
      );
      service = wireCost({
        ctx,
        config: resolveConfig(config),
        messages,
        data: ctx.use("stargantt.data"),
        now: () => now,
        reportError,
      });
    },
  });

  const services: Record<string, unknown> = {};
  if (options.view === true) services["stargantt.view"] = { invalidate: () => undefined };
  if (options.theme !== undefined) services["stargantt.theme"] = { get: options.theme };
  if (options.resourcePool !== undefined) {
    services["stargantt.resource-pool"] = options.resourcePool;
  }

  const host = createTestHost({
    plugins: [dataStore(), probe, ...(options.extra ?? [])],
    ...(Object.keys(services).length > 0 ? { services } : {}),
  });
  host.host.on("core/pluginError", (e) => void pluginErrors.push(e));

  if (service === undefined) throw new Error("wireCost did not run");

  return {
    host,
    data: host.host.service("stargantt.data"),
    service,
    faults,
    pluginErrors,
    root: host.ctxOf("test.cost-area").root,
    setNow(t: number): void {
      now = t;
    },
    dispose: () => host.dispose(),
  };
}

/** A plain task spanning `[start, end)` in epoch ms. */
export function task(id: TaskId, start: number, end: number, over: Partial<Task> = {}): Task {
  return { id, parentId: null, name: `task ${String(id)}`, start, end, ...over };
}

/**
 * A hand-built `ReadonlyDataView` — the only input `createCostWorld` takes, so the world-level unit
 * tests need neither the store, the core, nor a DOM.
 */
export function viewOf(
  tasks: readonly Task[],
  assignments: readonly Assignment[] = [],
): ReadonlyDataView {
  const byId = new Map<TaskId, Task>();
  const children = new Map<TaskId | null, TaskId[]>();
  const assignmentsByTask = new Map<TaskId, Assignment[]>();
  for (const t of tasks) {
    byId.set(t.id, t);
    const bucket = children.get(t.parentId) ?? [];
    bucket.push(t.id);
    children.set(t.parentId, bucket);
  }
  for (const a of assignments) {
    const bucket = assignmentsByTask.get(a.taskId) ?? [];
    bucket.push(a);
    assignmentsByTask.set(a.taskId, bucket);
  }
  return {
    byId,
    children,
    linksByTask: new Map(),
    calendars: new Map(),
    resources: new Map(),
    assignmentsByTask,
  };
}
