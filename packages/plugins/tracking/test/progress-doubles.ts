/**
 * Hostless doubles for the progress area's own tests (`progress-*.test.ts`), mirroring
 * `@stargantt/plugin-scheduling`'s `test/links-doubles.ts` pattern: a fake `DataService` slice and
 * a recording `PluginContext` double, so `wireProgress(deps)` can run with no core, no sibling
 * plugin and no DOM, every dispatch/contribution/owned-disposable recorded for assertion.
 *
 * Package-local to this area only — a "progress-" prefixed filename so it can never collide with
 * the baselines/cost/evm areas' own test doubles, built concurrently in sibling PRs against the
 * same `test/` directory.
 */
import type { Disposable, PluginContext } from "@stargantt/core";
import type { DataService, ReadonlyDataView, Task, TaskId } from "@stargantt/plugin-data-store";

/** A minimal, well-shaped `Task` for progress-area fixtures. */
export function stubTask(id: TaskId, start: number, end: number, over: Partial<Task> = {}): Task {
  return { id, parentId: null, name: String(id), start, end, ...over };
}

/** A store slice over a fixed task list — `getTask` + `query()` (`byId` + `children`, built from
 *  each task's `parentId`), the only two `DataService` members this area reads. */
export function fakeDataService(tasks: readonly Task[]): DataService {
  const byId = new Map<TaskId, Readonly<Task>>(tasks.map((t) => [t.id, t]));
  const children = new Map<TaskId | null, TaskId[]>();
  for (const t of tasks) {
    const list = children.get(t.parentId);
    if (list === undefined) children.set(t.parentId, [t.id]);
    else list.push(t.id);
  }
  const view: ReadonlyDataView = {
    byId,
    children: children as ReadonlyMap<TaskId | null, readonly TaskId[]>,
    linksByTask: new Map(),
    calendars: new Map(),
    resources: new Map(),
    assignmentsByTask: new Map(),
  };
  return {
    getTask: (id: TaskId) => byId.get(id),
    taskIds: () => byId.keys(),
    query: () => view,
    load: () => undefined,
    hasDeferredChildren: () => false,
    materializeChildren: () => undefined,
    toJSON: () => ({ tasks: [...byId.values()], links: [], calendars: [], resources: [], assignments: [] }),
    tasks: { get: () => byId, subscribe: () => ({ dispose: () => undefined }) },
    links: { get: () => new Map(), subscribe: () => ({ dispose: () => undefined }) },
    resources: { get: () => new Map(), subscribe: () => ({ dispose: () => undefined }) },
    assignments: { get: () => new Map(), subscribe: () => ({ dispose: () => undefined }) },
  } as unknown as DataService;
}

/** A dispatched command, as the recording context saw it. `transaction` is the (possibly
 *  handler-appended) `data/willApplyTransaction` payload this dispatch synthesized — see the
 *  `dispatch` doc below. */
export interface DispatchRecord {
  key: string;
  payload: unknown;
  transaction: { origin: string; patches: unknown[] };
}

/** What the recording context resolves `use`/`useOptional` lookups with. */
export interface ServiceTable {
  [key: string]: unknown;
}

/** Everything a wired area did against its context. */
export interface RecordingContext {
  ctx: PluginContext;
  contributions: Map<string, unknown[]>;
  dispatched: DispatchRecord[];
  handlers: Map<string, ((e: never) => void)[]>;
  owned: Disposable[];
  fire(key: string, event: unknown): void;
  contributedTo<T>(key: string): T[];
  disposeAll(): void;
}

/**
 * A `PluginContext` double that answers `use`/`useOptional` from `services` and records
 * everything else — `dispatch`, `contribute`, `on`, `own`.
 *
 * `dispatch` synchronously fires `"data/willApplyTransaction"` to every registered handler before
 * returning — mirroring the real store's synchronous transaction pipeline closely enough for
 * `createTransactionBatcher` to work against it unmodified: the batcher's own handler (registered
 * via `ctx.on` at batcher-creation time) runs and appends its pending tail patches DURING the
 * `dispatchHead` call, before its `finally { pending = undefined }` clears the batch — exactly the
 * ordering a real dispatch produces. The resulting `{ origin, patches }` is recorded on the
 * `DispatchRecord` as `transaction`, so a test reads the landed patch count directly instead of
 * calling `fire()` itself (which — after `dispatch()` already returned — would always be too late).
 */
export function recordingContext(services: ServiceTable): RecordingContext {
  const contributions = new Map<string, unknown[]>();
  const dispatched: DispatchRecord[] = [];
  const handlers = new Map<string, ((e: never) => void)[]>();
  const owned: Disposable[] = [];

  const ctx = {
    provide(): void {},
    use(key: string): unknown {
      if (!(key in services)) throw new Error(`stargantt: service "${key}" is not provided`);
      return services[key];
    },
    useOptional(key: string): unknown {
      return services[key];
    },
    defineExtensionPoint(key: string, reduce: (inputs: never[]) => unknown): unknown {
      return { key, get: () => reduce((contributions.get(key) ?? []) as never[]) };
    },
    contribute(key: string, value: unknown): void {
      const list = contributions.get(key);
      if (list === undefined) contributions.set(key, [value]);
      else list.push(value);
    },
    on(key: string, fn: (e: never) => void): Disposable {
      const list = handlers.get(key);
      if (list === undefined) handlers.set(key, [fn]);
      else list.push(fn);
      return { dispose: () => undefined };
    },
    emit(): void {},
    registerCommand(): void {},
    dispatch(key: string, payload: unknown): void {
      const origin = (payload as { origin?: string } | undefined)?.origin ?? "user";
      const transaction: { origin: string; patches: unknown[] } = { origin, patches: [] };
      for (const fn of handlers.get("data/willApplyTransaction") ?? []) {
        (fn as (e: unknown) => void)({ transaction });
      }
      dispatched.push({ key, payload, transaction });
    },
    claimOrder(): void {},
    claimKey(): void {},
    claimSlot(): { granted: boolean } {
      return { granted: true };
    },
    own(d: Disposable): void {
      owned.push(d);
    },
    root: {} as unknown as HTMLElement,
    locale: "en",
  } as unknown as PluginContext;

  return {
    ctx,
    contributions,
    dispatched,
    handlers,
    owned,
    fire(key: string, event: unknown): void {
      for (const fn of handlers.get(key) ?? []) (fn as (e: unknown) => void)(event);
    },
    contributedTo<T>(key: string): T[] {
      return (contributions.get(key) ?? []) as T[];
    },
    disposeAll(): void {
      for (const d of owned) d.dispose();
    },
  };
}
