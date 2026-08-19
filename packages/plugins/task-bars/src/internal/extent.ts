/**
 * The store walk behind this plugin's horizontal `renderer/contentExtent` contribution: the latest
 * instant any task reaches, cached.
 */
import type { TaskStoreReader } from "./deps";

/** The cached maximum task instant of one plugin instance. */
export interface MaxTaskEnd {
  /** The latest instant any task reaches, or `null` when the store holds no task. */
  get(): number | null;
  /** Drops the cached value, so the next `get()` walks the store again. */
  invalidate(): void;
}

// `measure()` is invoked at every clamp (a wheel tick, a `scrollTo`, a resize), so a full scan of
// the store on every call would not meet this library's performance targets at 100k tasks. The
// maximum is cached and invalidated only by a data change.
/** Builds the cached maximum-instant reader over a data store. */
export function createMaxTaskEnd(data: TaskStoreReader): MaxTaskEnd {
  // `undefined` marks the cache stale; `null` means the store holds no task.
  let cache: number | null | undefined;
  return {
    get(): number | null {
      if (cache === undefined) {
        let max = -Infinity;
        for (const id of data.taskIds()) {
          const task = data.getTask(id);
          if (task === undefined) continue;
          if (task.start > max) max = task.start;
          if (task.end > max) max = task.end;
        }
        cache = Number.isFinite(max) ? max : null;
      }
      return cache;
    },
    invalidate(): void {
      cache = undefined;
    },
  };
}
