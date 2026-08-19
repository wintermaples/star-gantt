/**
 * A recording `PluginContext` double, for testing `setup()` in isolation — no kernel, no sibling
 * plugins.
 *
 * Pattern precedent: `packages/plugins/tree-grid/test/_harness/stubs.ts`'s `fakePluginContext()`.
 * Not published from `@stargantt/sdk/testing` (that package's own recording context, used by
 * `expectDepsConsistency`, is private to that one check), so each plugin's test suite that wants
 * this level of control keeps its own small copy.
 */
import type { Disposable, PluginContext } from "@stargantt/core";

/** Everything a `fakePluginContext()` records, in call order per list. */
export interface ContextLog {
  provided: { key: string; impl: unknown }[];
  used: string[];
  usedOptional: string[];
  defined: { key: string; reduce: (inputs: never[]) => unknown }[];
  contributed: { key: string; value: unknown }[];
  subscribed: { key: string; fn: (e: never) => void }[];
  emitted: { key: string; payload: unknown }[];
  registered: { key: string; run: (payload: never) => void }[];
  dispatched: { key: string; payload: unknown }[];
  owned: Disposable[];
}

export interface FakeContext {
  /** The double to hand to `plugin.setup()`. */
  ctx: PluginContext;
  log: ContextLog;
  /** Contributions to one extension-point key, in contribution order. */
  contributionsTo(key: string): unknown[];
  /** Invokes the plugin's own listeners for `key`, as an emit from elsewhere would. */
  fireEvent(key: string, payload: unknown): void;
  /** Invokes a command runner the plugin registered; throws when it registered none for `key`. */
  runCommand(key: string, payload: unknown): void;
}

export interface FakeContextOptions {
  root?: unknown;
  locale?: string;
  /** Service implementations `use()` / `useOptional()` hand back, keyed by service key. */
  services?: Record<string, unknown>;
}

/**
 * A recording `PluginContext` for testing a plugin's `setup()` in isolation.
 *
 * `use()` throws for a service that was not supplied (mirroring the "declared dependency only"
 * rule closely enough to catch a missing stub); `useOptional()` returns `undefined` instead.
 * Extension-point contributions are recorded but never reduced: the point owner is not present, so
 * the test asserts on the contributions themselves.
 */
export function fakePluginContext(options: FakeContextOptions = {}): FakeContext {
  const log: ContextLog = {
    provided: [],
    used: [],
    usedOptional: [],
    defined: [],
    contributed: [],
    subscribed: [],
    emitted: [],
    registered: [],
    dispatched: [],
    owned: [],
  };
  const services = new Map<string, unknown>(Object.entries(options.services ?? {}));

  const ctx = {
    provide(key: string, impl: unknown): void {
      log.provided.push({ key, impl });
      services.set(key, impl);
    },
    use(key: string): unknown {
      log.used.push(key);
      if (!services.has(key)) {
        throw new Error(`test harness: no stub for service "${key}"`);
      }
      return services.get(key);
    },
    useOptional(key: string): unknown {
      log.usedOptional.push(key);
      return services.get(key);
    },
    defineExtensionPoint(key: string, reduce: (inputs: never[]) => unknown): unknown {
      log.defined.push({ key, reduce });
      return {
        key,
        get: () => reduce(log.contributed.filter((c) => c.key === key).map((c) => c.value) as never[]),
      };
    },
    contribute(key: string, value: unknown): void {
      log.contributed.push({ key, value });
    },
    on(key: string, fn: (e: never) => void): Disposable {
      const entry = { key, fn };
      log.subscribed.push(entry);
      return {
        dispose: (): void => {
          const i = log.subscribed.indexOf(entry);
          if (i >= 0) log.subscribed.splice(i, 1);
        },
      };
    },
    emit(key: string, payload: unknown): void {
      log.emitted.push({ key, payload });
    },
    registerCommand(key: string, run: (payload: never) => void): void {
      log.registered.push({ key, run });
    },
    dispatch(key: string, payload: unknown): void {
      log.dispatched.push({ key, payload });
    },
    own(d: Disposable): void {
      log.owned.push(d);
    },
    root: options.root ?? {},
    locale: options.locale ?? "en",
  } as unknown as PluginContext;

  return {
    ctx,
    log,
    contributionsTo: (key) => log.contributed.filter((c) => c.key === key).map((c) => c.value),
    fireEvent(key, payload): void {
      for (const s of [...log.subscribed]) {
        if (s.key === key) (s.fn as (e: unknown) => void)(payload);
      }
    },
    runCommand(key, payload): void {
      const entry = [...log.registered].reverse().find((r) => r.key === key);
      if (entry === undefined) {
        throw new Error(`test harness: no command runner registered for "${key}"`);
      }
      (entry.run as (p: unknown) => void)(payload);
    },
  };
}
