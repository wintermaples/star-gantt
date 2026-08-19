/**
 * Shared test harness for the four areas (`formats`, `msproject`, `excel`, `embed`): a real
 * `@stargantt/core` host with a real `@stargantt/plugin-data-store` composed alongside
 * `exportPlugin`, plus minimal structural mocks for the hard `view`/`timeline`/`theme`
 * dependencies (none of the four areas call anything on them; they exist only so `setup()`'s
 * unconditional `ctx.use(...)` calls resolve).
 *
 * Real data-store composition (not a mock) is deliberate: the harvest-and-cancel batch (§1.5) and
 * the read-only veto (§2.1) both live on the store's own `data/willApplyTransaction` /
 * `data/didApplyTransaction` events, and only the real plugin implements that contract.
 */
import { definePlugin } from "@stargantt/core";
import type { AnyPlugin, Disposable } from "@stargantt/core";
import { createTestHost } from "@stargantt/sdk";
import type { TestHost } from "@stargantt/sdk";
import { dataStore } from "@stargantt/plugin-data-store";
import type {
  Assignment,
  DataService,
  Link,
  Resource,
  Task,
  Transaction,
} from "@stargantt/plugin-data-store";
import { exportPlugin } from "../src/index";
import type { ExportConfig } from "../src/config";
import type {
  ImportApplyCause,
  ImportApplyResult,
  MsProjectApplyResult,
  ExportService,
  ReadOnlyCause,
  SnapshotSource,
} from "../src/types";

export const DAY = 86_400_000;

export interface BootOptions {
  config?: ExportConfig;
  tasks?: readonly Task[];
  links?: readonly Link[];
  resources?: readonly Resource[];
  assignments?: readonly Assignment[];
  /** Extra plugins composed alongside the harness (e.g. a synthetic `stargantt.baselines` stub). */
  extra?: readonly AnyPlugin[];
}

export interface Booted {
  testHost: TestHost;
  root: HTMLElement;
  chartPane: HTMLElement;
  service: ExportService;
  data: DataService;
  errors: { pluginId: string; error: unknown }[];
  /** Every settled transaction, in emission order (`data/didApplyTransaction`). */
  transactions: Transaction[];
  /** `importexport/applied` payloads, in emission order. */
  applied: { result: ImportApplyResult; cause: ImportApplyCause }[];
  /** `msprojectio/applied` payloads, in emission order. */
  msApplied: { result: MsProjectApplyResult }[];
  /** `viewerembed/readOnlyChanged` payloads, in emission order. */
  readOnlyChanges: { readOnly: boolean; cause: ReadOnlyCause }[];
  /** `viewerembed/snapshotApplied` payloads, in emission order. */
  snapshotApplied: { source: SnapshotSource; droppedTasks: number }[];
  dispatch: TestHost["host"]["dispatch"];
  on: TestHost["host"]["on"];
  dispose(): void;
}

/** Four tasks over one root, plus a resource and an assignment, to export and diff against. */
export function sampleData(): {
  tasks: Task[];
  resources: Resource[];
  assignments: Assignment[];
} {
  const t = (
    id: string,
    parentId: string | null,
    name: string,
    day: number,
    days: number,
    extra: Partial<Task> = {},
  ): Task => ({ id, parentId, name, start: day * DAY, end: (day + days) * DAY, ...extra });
  return {
    tasks: [
      t("a", null, "Design phase", 0, 10, { type: "summary" }),
      t("a1", "a", "Wireframes", 0, 3, { progress: 1 }),
      t("a2", "a", 'Visual, "final" design', 3, 5, { progress: 0.4 }),
      t("m1", null, "Launch", 10, 0, { type: "milestone" }),
    ],
    resources: [{ id: "r1", name: "Alice" }],
    assignments: [{ taskId: "a1", resourceId: "r1", units: 1 }],
  };
}

export function boot(options: BootOptions = {}): Booted {
  const doc = document;
  const root = doc.createElement("div");
  const chartPane = doc.createElement("div");
  chartPane.className = "sg-pane sg-pane--chart";
  root.appendChild(chartPane);
  doc.body.appendChild(root);

  const errors: { pluginId: string; error: unknown }[] = [];
  const transactions: Transaction[] = [];
  const applied: { result: ImportApplyResult; cause: ImportApplyCause }[] = [];
  const msApplied: { result: MsProjectApplyResult }[] = [];
  const readOnlyChanges: { readOnly: boolean; cause: ReadOnlyCause }[] = [];
  const snapshotApplied: { source: SnapshotSource; droppedTasks: number }[] = [];

  const collector = definePlugin({
    meta: { id: "test.collector" },
    setup(ctx) {
      ctx.on("core/pluginError", (e) => void errors.push(e));
      ctx.on("data/didApplyTransaction", (e) => void transactions.push(e.transaction));
      ctx.on("importexport/applied", (e) => void applied.push(e));
      ctx.on("msprojectio/applied", (e) => void msApplied.push(e));
      ctx.on("viewerembed/readOnlyChanged", (e) => void readOnlyChanges.push(e));
      ctx.on("viewerembed/snapshotApplied", (e) => void snapshotApplied.push(e));
    },
  });

  const services: Record<string, unknown> = {
    "stargantt.view": {
      viewport: { get: () => ({ scrollLeft: 0, scrollTop: 0, width: 800, height: 600 }) },
      chartPaneElement: () => chartPane,
      renderTo: (): void => {},
    },
    "stargantt.timeline": {
      tToX: (t: number) => t,
      xToT: (x: number) => x,
      unitBoundaries: (): number[] => [],
    },
    "stargantt.theme": {
      colorScheme: () => "light" as const,
      setColorScheme: (): void => {},
    },
  };

  const seed = definePlugin({
    meta: { id: "test.seed", dependsOn: ["stargantt.data-store"] },
    setup(ctx): void {
      const data = ctx.use("stargantt.data");
      if (
        options.tasks !== undefined ||
        options.links !== undefined ||
        options.resources !== undefined ||
        options.assignments !== undefined
      ) {
        data.load({
          tasks: [...(options.tasks ?? [])],
          links: [...(options.links ?? [])],
          resources: [...(options.resources ?? [])],
          assignments: [...(options.assignments ?? [])],
        });
      }
    },
  });

  const testHost = createTestHost({
    element: root,
    services,
    plugins: [
      collector,
      dataStore(),
      // `exportPlugin` hard-depends on `stargantt.view` by plugin id; the mock provider above
      // publishes the *service* under a synthetic id, so a real (empty) plugin must still claim
      // the "stargantt.view" id for the dependency graph to resolve.
      idStub("stargantt.view"),
      seed,
      ...(options.extra ?? []),
      exportPlugin(options.config),
    ],
  });

  return {
    testHost,
    root,
    chartPane,
    service: testHost.host.service("stargantt.export"),
    data: testHost.host.service("stargantt.data"),
    errors,
    transactions,
    applied,
    msApplied,
    readOnlyChanges,
    snapshotApplied,
    dispatch: testHost.host.dispatch.bind(testHost.host),
    on: testHost.host.on.bind(testHost.host),
    dispose: () => {
      testHost.dispose();
      root.remove();
    },
  };
}

/** A no-dependency plugin that provides a bare `id` string, standing in for a hard dependency. */
export function idStub(id: string): AnyPlugin {
  return definePlugin({ meta: { id }, setup: (): void => {} });
}

export type { Disposable };
