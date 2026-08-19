// docs/specs/plugins/data-sync.md §4.4
/**
 * Wraps a persisted-document reader as a `DataSourceAdapter`: every `fetch` reads the current
 * persisted snapshot (an empty task list when nothing is persisted). The adapter is read-only —
 * it offers no delta or push capability; writing back happens through the offline area's own
 * `save()`/auto-save.
 */
import type { DataSourceAdapter, FetchResult, PersistedDocument } from "../../types";

export function offlineAdapter(read: () => Promise<PersistedDocument | undefined>): DataSourceAdapter {
  return {
    async fetch(): Promise<FetchResult> {
      const doc = await read();
      if (doc === undefined) return { tasks: [] };
      return {
        tasks: doc.tasks,
        links: doc.links,
        resources: doc.resources,
        assignments: doc.assignments,
      };
    },
  };
}
