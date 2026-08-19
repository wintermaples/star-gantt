// docs/specs/plugins/data-sync.md §6.1
/**
 * Machinery shared by every area: the §6.1 bulk-replacement detector, the machine-origin
 * prefix predicate (and the four origin strings themselves), and a tiny per-key pending counter
 * used to build each area's §6.2 `sync/activity` emission.
 */
import type { PluginContext } from "@stargantt/core";
import type { DataService } from "@stargantt/plugin-data-store";

export const PLUGIN_ID = "stargantt.data-sync";

/** The one origin prefix every transaction this plugin dispatches carries. */
export const ORIGIN_PREFIX = "stargantt.data-sync/";

export const ORIGIN_SYNC = "stargantt.data-sync/sync";
export const ORIGIN_ROLLBACK = "stargantt.data-sync/rollback";
export const ORIGIN_LAZY = "stargantt.data-sync/lazy";
export const ORIGIN_REALTIME = "stargantt.data-sync/realtime";

/** The machine-origin predicate: a prefix test, not a fixed set. */
export function isMachineOrigin(origin: string): boolean {
  return typeof origin === "string" && origin.startsWith(ORIGIN_PREFIX);
}

/**
 * The §6.1 bulk-replacement detector: classifies `data.tasks` store notifications by the
 * transaction bracket depth. Subscribes to `data/willApplyTransaction` / `data/didApplyTransaction`
 * once, via `ctx.own()`; every area that needs the bulk/transactional distinction calls
 * `isBulk()` synchronously from inside its own `data.tasks` subscription.
 *
 * Depth increments on will, decrements (floored at 0) on did. Each will-event also schedules one
 * microtask that resets the depth to 0, reconciling a transaction that was cancelled in the will
 * phase or whose atomic apply threw (no burst, no did-event, depth would otherwise stay stale).
 * The synchronous apply flow (will → burst → did) always unwinds before that microtask runs, so it
 * can never misclassify a genuine burst.
 */
export interface BulkDetector {
  /** True when a `data.tasks` notification firing right now is a bulk (no-transaction) replacement. */
  isBulk(): boolean;
}

export function createBulkDetector(ctx: PluginContext): BulkDetector {
  let depth = 0;
  ctx.own(
    ctx.on("data/willApplyTransaction", () => {
      depth += 1;
      queueMicrotask(() => {
        depth = 0;
      });
    }),
  );
  ctx.own(
    ctx.on("data/didApplyTransaction", () => {
      depth = Math.max(0, depth - 1);
    }),
  );
  return { isBulk: () => depth === 0 };
}

/**
 * Subscribes `onBulk` to run whenever a `data.tasks` notification is classified as a bulk
 * replacement by `detector`. One `ctx.own()`-managed subscription per caller.
 */
export function onBulkReplacement(ctx: PluginContext, data: DataService, detector: BulkDetector, onBulk: () => void): void {
  ctx.own(
    data.tasks.subscribe(() => {
      if (detector.isBulk()) onBulk();
    }),
  );
}

/** `core/pluginError` reporter, tagged with `where` (the §"Error discipline" barrier shape). */
export function makeFault(ctx: PluginContext): (where: string, error: unknown) => void {
  return (where: string, error: unknown): void => {
    ctx.emit("core/pluginError", { pluginId: PLUGIN_ID, error: { where, cause: error } });
  };
}

/** A per-key in-flight counter for §6.2 `sync/activity`: `inc`/`dec` return the new count. */
export function createPendingCounter<K extends string>(): {
  inc(key: K): number;
  dec(key: K): number;
} {
  const counts = new Map<K, number>();
  return {
    inc(key: K): number {
      const next = (counts.get(key) ?? 0) + 1;
      counts.set(key, next);
      return next;
    },
    dec(key: K): number {
      const next = Math.max(0, (counts.get(key) ?? 0) - 1);
      counts.set(key, next);
      return next;
    },
  };
}
