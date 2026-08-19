import type { Disposable, WritableStore } from "../index";

// docs/specs/architecture.md §1.1-3 — `createStore` is context-free: a bare store knows no host
// and no plugin. A subscription learns its owner only when its `Disposable` reaches `ctx.own()`,
// which calls this hook. The symbol is internal (never re-exported from the package entry), so
// nothing outside the core can bind a fault channel.
export const BIND_FAULT: unique symbol = Symbol("stargantt.store.bind");

/** Reports a contained subscriber fault as `core/pluginError` on behalf of `pluginId`. */
export type FaultReporter = (pluginId: string, error: unknown) => void;

/** Stamps an owner plugin id and its fault channel onto a store subscription. */
export type FaultBinder = (pluginId: string, report: FaultReporter) => void;

interface Sub<T> {
  fn: (next: T, prev: T) => void;
  disposed: boolean;
  owner: string;
  report?: FaultReporter;
}

/** Creates a store holding `initial`. The store itself belongs to no plugin. */
export function createStore<T>(initial: T): WritableStore<T> {
  let value = initial;
  // docs/specs/architecture.md §1.1-2 — the re-entrancy guard is an O(1) boolean shipped in
  // every build; there is no dev/prod split and no environment detection.
  let dispatching = false;
  const subs: Sub<T>[] = [];

  const set = (next: T): void => {
    if (dispatching) {
      throw new Error("stargantt: re-entrant store set() during notification");
    }
    const prev = value;
    // docs/specs/architecture.md §1.1-1 — committed before the first subscriber runs, so a get()
    // from inside a subscriber returns `next`.
    value = next;
    dispatching = true;
    try {
      // docs/specs/architecture.md §1.1-4 — dispatch over a snapshot: a subscription added
      // during the dispatch is not notified by it, and one disposed during it is skipped.
      for (const sub of subs.slice()) {
        if (sub.disposed) continue;
        try {
          sub.fn(next, prev);
        } catch (err) {
          // docs/specs/architecture.md §1.1-3 — contained: the dispatch continues either way.
          if (sub.report) sub.report(sub.owner, err);
          else console.error(err);
        }
      }
    } finally {
      dispatching = false;
    }
  };

  return {
    get: (): T => value,
    set,
    update: (fn: (prev: T) => T): void => set(fn(value)),
    subscribe(fn: (next: T, prev: T) => void): Disposable {
      const sub: Sub<T> = { fn, disposed: false, owner: "" };
      subs.push(sub);
      const d: Disposable & Record<typeof BIND_FAULT, FaultBinder> = {
        dispose(): void {
          if (sub.disposed) return;
          sub.disposed = true;
          const i = subs.indexOf(sub);
          if (i >= 0) subs.splice(i, 1);
        },
        // docs/specs/architecture.md §1.1-3 — the first ctx.own() that receives this Disposable
        // stamps the owner plugin id and the host's fault channel; later ones are ignored.
        [BIND_FAULT](pluginId: string, report: FaultReporter): void {
          if (sub.report) return;
          sub.owner = pluginId;
          sub.report = report;
        },
      };
      return d;
    },
  };
}
