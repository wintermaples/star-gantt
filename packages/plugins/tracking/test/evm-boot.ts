/**
 * Boot helper for the EVM-area suites (`src/internal/evm/`).
 *
 * `wireEvm` is exercised DIRECTLY — a tiny probe plugin hands it a real `PluginContext`, the real
 * data store and hand-built `EvmAreaExtras` stand-ins — rather than booting the whole tracking
 * plugin: deliberate AREA-level isolation, so a failure here always points at the EVM area alone
 * (root `index.ts`'s own real fan-in — cost's `costOf` and baselines' `snapshotOf` wired in as the
 * live `EvmAreaExtras` — has its own headless composition coverage in `test/headless.test.ts`).
 * This mirrors `@stargantt/plugin-scheduling`'s `test/critical-path-freshness.test.ts` convention
 * of testing one area's wiring in isolation.
 *
 * The `extras` stand-ins are plain maps: nothing here imports any sibling area's service type or
 * module, exactly as the area's own sources do not.
 */
import { definePlugin } from "@stargantt/core";
import type { AnyPlugin, GanttInstance } from "@stargantt/core";
import { createTestHost } from "@stargantt/sdk";
import { dataStore } from "@stargantt/plugin-data-store";
import type { DataService, Task, TaskId } from "@stargantt/plugin-data-store";
import type { EvmConfig, ProgressConfig } from "../src/config";
import { resolveConfig } from "../src/config";
import type { TrackingMessages } from "../src/internal/messages";
import { resolveMessages } from "../src/internal/messages";
import type { BaselineTaskSnapshot, EvmService, TaskCost } from "../src/types";
import { wireEvm } from "../src/internal/evm/wire";
import type { EvmAreaExtras } from "../src/internal/evm/wire";

export const MS_DAY = 86_400_000;

/** A plain task spanning `[start, end)` in epoch ms. */
export function task(id: TaskId, start: number, end: number, over: Partial<Task> = {}): Task {
  return { id, parentId: null, name: `task ${String(id)}`, start, end, ...over };
}

/** A full `TaskCost` around the two members the EVM fallback actually reads. */
export function taskCost(id: TaskId, estimated: number, actual: number): TaskCost {
  return { id, labor: 0, fixed: estimated, variable: 0, material: 0, estimated, actual };
}

/** One reported host fault, as `deps.reportError` saw it. */
export interface ReportedFault {
  where: string;
  error: unknown;
}

export interface EvmBoot {
  gantt: GanttInstance;
  data: DataService;
  service: EvmService;
  /** The gantt root — every dialog's host (§2.16). */
  root: HTMLElement;
  /** Every `deps.reportError(where, error)` call, in order. */
  faults: ReportedFault[];
  /** `where` strings only, the shape most assertions want. */
  wheres(): string[];
  /** The cost area's stand-in: what `extras.costOf` answers from. */
  costs: Map<TaskId, TaskCost>;
  /** The baselines area's stand-in: what `extras.baselineSnapshotOf` answers from. */
  baselineSnapshots: Map<TaskId, BaselineTaskSnapshot>;
  /** Every `extras.costOf` / `extras.baselineSnapshotOf` call, for fan-in assertions. */
  extrasCalls: string[];
  dispose(): void;
}

export interface EvmBootOptions {
  /** The `evm` config nest. Omitted entirely = the nest is DORMANT (§5 presence semantics). */
  evm?: EvmConfig;
  /** The `progress` nest — only its `statusDate` matters to this area (§2.14's middle link). */
  progress?: ProgressConfig;
  messages?: Partial<TrackingMessages>;
  /** The indirected clock behind the "current UTC day" fallbacks. */
  now?: () => number;
  /** The chart root. Omitted, `createTestHost` supplies a detached div (or a stand-in headless). */
  element?: HTMLElement;
  /** Mock services, e.g. `stargantt.view` to let the panels open. */
  services?: Record<string, unknown>;
  /** Extra plugins, registered after the probe. */
  extra?: readonly AnyPlugin[];
}

/** Boots the EVM area over a real data store and returns its service plus the test seams. */
export function bootEvm(options: EvmBootOptions = {}): EvmBoot {
  const faults: ReportedFault[] = [];
  const costs = new Map<TaskId, TaskCost>();
  const baselineSnapshots = new Map<TaskId, BaselineTaskSnapshot>();
  const extrasCalls: string[] = [];

  const extras: EvmAreaExtras = {
    costOf(id) {
      extrasCalls.push(`costOf:${String(id)}`);
      return costs.get(id);
    },
    baselineSnapshotOf(id) {
      extrasCalls.push(`baselineSnapshotOf:${String(id)}`);
      return baselineSnapshots.get(id);
    },
  };

  const config = resolveConfig({
    ...(options.evm === undefined ? {} : { evm: options.evm }),
    ...(options.progress === undefined ? {} : { progress: options.progress }),
  });
  const messages = resolveMessages(options.messages, (key, error) =>
    faults.push({ where: `messages.${key}`, error }),
  );

  let service: EvmService | undefined;
  let data: DataService | undefined;
  let root: HTMLElement | undefined;

  const probe = definePlugin({
    meta: { id: "test.evm-area", dependsOn: ["stargantt.data-store"] },
    setup(ctx) {
      data = ctx.use("stargantt.data");
      root = ctx.root;
      service = wireEvm(
        {
          ctx,
          config,
          messages,
          data,
          now: options.now ?? Date.now,
          reportError: (where, error) => faults.push({ where, error }),
        },
        extras,
      );
    },
  });

  const host = createTestHost({
    plugins: [dataStore(), probe, ...(options.extra ?? [])],
    ...(options.element === undefined ? {} : { element: options.element }),
    ...(options.services === undefined ? {} : { services: options.services }),
  });

  if (service === undefined || data === undefined || root === undefined) {
    throw new Error("evm-boot: the probe plugin never ran");
  }

  return {
    gantt: host.host,
    data,
    service,
    root,
    faults,
    wheres: () => faults.map((f) => f.where),
    costs,
    baselineSnapshots,
    extrasCalls,
    dispose: () => host.dispose(),
  };
}

/** A `stargantt.view` stand-in — the panels only ask whether it resolves (§2.16). */
export function viewStub(): Record<string, unknown> {
  return { invalidate: () => undefined };
}

/** A `stargantt.theme` stand-in answering `tokens`, `""` for anything else. */
export function themeStub(tokens: Record<string, string>): Record<string, unknown> {
  return { get: (token: string) => tokens[token] ?? "" };
}
