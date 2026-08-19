// docs/specs/plugins/data-sync.md §2.7
/**
 * The local-data adapter: serves an in-memory document (e.g. parsed local JSON) through the
 * common `DataSourceAdapter` interface, so a static backend is switch-compatible with REST.
 */
import type { DataSourceAdapter, LocalDocument } from "../../types";

/**
 * Creates an adapter over an in-memory document. Every `fetch` resolves with the document's
 * current lists (read at fetch time, so replacing the document's lists and calling `load()`
 * again picks up the new content); there is no delta or push capability.
 */
export function localAdapter(document?: LocalDocument): DataSourceAdapter {
  const doc = document !== null && typeof document === "object" ? document : {};
  return {
    fetch: () =>
      Promise.resolve({
        tasks: Array.isArray(doc.tasks) ? [...doc.tasks] : [],
        ...(Array.isArray(doc.links) ? { links: [...doc.links] } : {}),
        ...(Array.isArray(doc.resources) ? { resources: [...doc.resources] } : {}),
        ...(Array.isArray(doc.assignments) ? { assignments: [...doc.assignments] } : {}),
        ...(doc.mapping !== undefined ? { mapping: doc.mapping } : {}),
      }),
  };
}
