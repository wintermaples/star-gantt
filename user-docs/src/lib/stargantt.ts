import type { StarGanttApi } from "../content/types";

/**
 * Loads the shipped bundle, once per page load.
 *
 * The library is the single largest thing this site depends on, and no page needs it before its
 * first chart mounts — the landing page, the search box and every page's prose render without it.
 * Importing it dynamically puts it in its own chunk, so it is fetched alongside the page's content
 * rather than ahead of everything.
 *
 * The promise is cached at module scope rather than the module: `import()` already de-duplicates,
 * but holding the promise means callers that race each other on the same frame share one await
 * instead of each scheduling their own microtask chain.
 */
let pending: Promise<StarGanttApi> | undefined;

export function loadStarGantt(): Promise<StarGanttApi> {
  pending ??= import("stargantt");
  return pending;
}
