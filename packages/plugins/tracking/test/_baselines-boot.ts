/**
 * Shared test-only harness for the `internal/baselines/` area's test files (own doubles, prefixed
 * `baselines-*`, not imported by any sibling area's tests). Boots a real `@stargantt/plugin-data-
 * store` `DataService` alongside a minimal test-only plugin whose `setup()` hands the real
 * `PluginContext` + `DataService` to a caller-supplied `run` — the pattern the task brief calls for
 * ("a real `PluginContext` obtained via `createTestHost`'s `ctxOf`, wrapped with your own mock
 * data/messages/now/reportError"), simplified: since `createTestHost` already boots a REAL
 * `dataStore()` plugin, there is no need to hand-roll a `DataService` double at all — `run` gets the
 * genuine service, so `task/update` dispatches (baselines' `setActual`) are exercised end to end.
 */
import { definePlugin } from "@stargantt/core";
import type { AnyPlugin, PluginContext } from "@stargantt/core";
import { createTestHost } from "@stargantt/sdk";
import type { TestHost } from "@stargantt/sdk";
import { dataStore } from "@stargantt/plugin-data-store";
import type { DataService, Link, LinkType, Task, TaskId } from "@stargantt/plugin-data-store";
import { resolveMessages } from "../src/internal/messages";
import type { TrackingMessages } from "../src/internal/messages";

export const DAY = 86_400_000;

export function task(id: TaskId, start: number, end: number, over: Partial<Task> = {}): Task {
  return { id, parentId: null, name: `task ${String(id)}`, start, end, ...over };
}

export function link(
  id: string,
  sourceId: TaskId,
  targetId: TaskId,
  type: LinkType = "FS",
  lag?: number,
): Link {
  const l: Link = { id, sourceId, targetId, type };
  if (lag !== undefined) l.lag = lag;
  return l;
}

/** The resolved default catalog, or with per-key overrides — never latches in tests (no-op `onFault`). */
export function messages(overrides?: Partial<TrackingMessages>): TrackingMessages {
  return resolveMessages(overrides, () => {});
}

/**
 * Boots `dataStore()` plus a test-only plugin that runs `build(ctx, data)` at `setup()` time and
 * keeps its result. `extra` plugins (e.g. mock service providers) may be composed alongside.
 */
export function bootWithData<T>(
  build: (ctx: PluginContext, data: DataService) => T,
  extra: readonly AnyPlugin[] = [],
  services?: Record<string, unknown>,
): { host: TestHost; data: DataService; result: T } {
  let result: T | undefined;
  const harness: AnyPlugin = definePlugin({
    meta: {
      id: "test.baselines-harness",
      dependsOn: ["stargantt.data-store"],
      optional: [
        "stargantt.view",
        "stargantt.timeline",
        "stargantt.theme",
        "stargantt.task-bars",
        "stargantt.rows",
      ],
    },
    setup(ctx) {
      const data = ctx.use("stargantt.data");
      result = build(ctx, data);
    },
  });
  const host = createTestHost({
    plugins: [dataStore(), harness, ...extra],
    ...(services !== undefined ? { services } : {}),
  });
  return { host, data: host.host.service("stargantt.data"), result: result as T };
}
