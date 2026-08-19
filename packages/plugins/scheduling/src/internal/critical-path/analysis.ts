// docs/specs/plugins/scheduling.md §7.1–§7.2 — float quantification, classification and
// parallel-path detection. Pure and hostless: everything the pass needs comes in as arguments, so
// this module is unit-testable without booting a chart. The backward pass and the link-constraint
// algebra come from this repo's `@stargantt/sdk` (`sdk/cpm`) rather than a bundled toolkit —
// same algorithm, same cycle-omission rule (§7.1), so the CPM expected values match the
// reference implementation byte for byte (verified in test/critical-path-analysis.test.ts).
import { latestTimes, linkSlack } from "@stargantt/sdk";
import type { Link, LinkId, ReadonlyDataView, Task, TaskId } from "@stargantt/plugin-data-store";

export { linkSlack };

/* ------------------------------------------------------------------ *
 * Public types (docs/specs/plugins/scheduling.md §1.3) — defined here rather than in a package-root
 * `types.ts` (this task's file scope does not include one); `service.ts` re-exports them for the
 * area's own public surface, and `src/index.ts` re-exporting them onward is the reported diff.
 * ------------------------------------------------------------------ */

/** Which criticality class a task falls in. */
export type Criticality = "critical" | "nearCritical" | "negativeFloat";

/** A task's slack, in milliseconds of elapsed time. */
export interface TaskFloat {
  /**
   * How far the finish can slip without moving the project finish; negative when the current
   * dates already violate a successor requirement.
   */
  totalFloat: number;
  /** How far the finish can slip without moving any successor's current dates. */
  freeFloat: number;
}

/** One maximal chain of critical tasks connected by critical links. */
export interface CriticalPath {
  /** Member tasks, ordered by start date (ties by id order of discovery). */
  tasks: readonly TaskId[];
  /** The critical links joining the member tasks. */
  links: readonly LinkId[];
}

/** The full result of one analysis pass. */
export interface CriticalPathAnalysis {
  /** Float per analyzable task (summaries and cycle members carry no entry — §7.1). */
  floats: ReadonlyMap<TaskId, TaskFloat>;
  /** Criticality class per classified task; tasks above every threshold have no entry. */
  classes: ReadonlyMap<TaskId, Criticality>;
  /**
   * Links whose both endpoints are critical/negative-float and whose own slack is within the
   * critical threshold.
   */
  criticalLinks: ReadonlySet<LinkId>;
  /** Every parallel critical path, ordered by earliest member start. */
  paths: readonly CriticalPath[];
}

/** The slice of `sdk/cpm`'s backward pass this module reads. */
export type LatestTimesMap = ReadonlyMap<TaskId, { latestStart: number; latestFinish: number }>;

/**
 * The `sdk/cpm` backward pass over the view's analyzable tasks and their links (§7.1 — NOT
 * `SchedulerService.latestTimes()`, whose engine-own cycle handling differs, §1.1/§2.8). Cycle
 * members — and predecessors whose only chain to the project end runs through a cycle member — are
 * omitted from the map, so `analyze` skips them entirely: no float entry, no class, no path
 * membership.
 */
export function latestTimesOf(view: ReadonlyDataView): LatestTimesMap {
  const tasks: Task[] = [];
  for (const task of view.byId.values()) if (analyzable(task)) tasks.push(task);
  const links: Link[] = [];
  // Each link appears exactly once in its source's `out` bucket, so this walk sees no duplicates.
  for (const buckets of view.linksByTask.values()) for (const link of buckets.out) links.push(link);
  return latestTimes(tasks, links) as LatestTimesMap;
}

export interface AnalyzeOptions {
  /** Total float at or below this (ms) counts as critical. */
  criticalMs: number;
  /** Width of the near-critical band above the critical threshold (ms); 0 = off. */
  nearMs: number;
}

/** Tasks whose dates are rollups are excluded from the analysis (§7.1). */
function analyzable(task: Readonly<Task>): boolean {
  return task.type !== "summary";
}

/** The latest finish among the analyzable tasks; `-Infinity` when there are none. */
function projectFinishOf(view: ReadonlyDataView): number {
  let projectFinish = Number.NEGATIVE_INFINITY;
  for (const task of view.byId.values()) {
    if (analyzable(task) && task.end > projectFinish) projectFinish = task.end;
  }
  return projectFinish;
}

/**
 * The smallest slack over the task's outgoing links to analyzable successors, or `+Infinity` when
 * it has none (the caller falls back to the distance to the project finish).
 */
function freeFloatOf(view: ReadonlyDataView, task: Readonly<Task>): number {
  let freeFloat = Number.POSITIVE_INFINITY;
  for (const link of view.linksByTask.get(task.id)?.out ?? []) {
    const successor = view.byId.get(link.targetId);
    if (successor === undefined || !analyzable(successor)) continue;
    const slack = linkSlack(link, task, successor);
    if (slack < freeFloat) freeFloat = slack;
  }
  return freeFloat;
}

/** The §7.2 class of one total float, or `undefined` when the task is comfortably slack. */
function classify(totalFloat: number, options: AnalyzeOptions): Criticality | undefined {
  if (totalFloat < 0) return "negativeFloat";
  if (totalFloat <= options.criticalMs) return "critical";
  if (options.nearMs > 0 && totalFloat <= options.criticalMs + options.nearMs) return "nearCritical";
  return undefined;
}

/** §7.1–§7.2: total and free float per analyzable task, plus the classes those floats imply. */
function computeFloats(
  view: ReadonlyDataView,
  latest: LatestTimesMap,
  options: AnalyzeOptions,
): { floats: Map<TaskId, TaskFloat>; classes: Map<TaskId, Criticality> } {
  const floats = new Map<TaskId, TaskFloat>();
  const classes = new Map<TaskId, Criticality>();
  const projectFinish = projectFinishOf(view);
  for (const task of view.byId.values()) {
    if (!analyzable(task)) continue;
    const lt = latest.get(task.id);
    // A task the backward pass omitted sits in a link cycle (or reaches the project end only
    // through one) — excluded (§7.1).
    if (lt === undefined) continue;
    const totalFloat = lt.latestFinish - task.end;
    const free = freeFloatOf(view, task);
    floats.set(task.id, {
      totalFloat,
      freeFloat: Number.isFinite(free) ? free : projectFinish - task.end,
    });
    const cls = classify(totalFloat, options);
    if (cls !== undefined) classes.set(task.id, cls);
  }
  return { floats, classes };
}

/** Union-find over task ids, with path compression. Only added ids may be looked up. */
interface UnionFind {
  add(id: TaskId): void;
  find(id: TaskId): TaskId;
  union(a: TaskId, b: TaskId): void;
  /** Every added id, in insertion order. */
  members(): Iterable<TaskId>;
}

function createUnionFind(): UnionFind {
  const parent = new Map<TaskId, TaskId>();
  const find = (id: TaskId): TaskId => {
    let root = id;
    while (parent.get(root) !== root) root = parent.get(root) as TaskId;
    // Path compression.
    let cur = id;
    while (cur !== root) {
      const next = parent.get(cur) as TaskId;
      parent.set(cur, root);
      cur = next;
    }
    return root;
  };
  return {
    add: (id) => void parent.set(id, id),
    find,
    union: (a, b) => {
      const ra = find(a);
      const rb = find(b);
      if (ra !== rb) parent.set(ra, rb);
    },
    members: () => parent.keys(),
  };
}

/**
 * Walks every link between two on-path tasks, keeping the ones whose slack is within the critical
 * threshold: those become critical links, merge their endpoints' components, and are recorded
 * against their source so the path they belong to can list them.
 */
function collectCriticalLinks(
  view: ReadonlyDataView,
  options: AnalyzeOptions,
  onPath: (id: TaskId) => boolean,
  components: UnionFind,
): { criticalLinks: Set<LinkId>; memberLinks: Map<TaskId, Link[]> } {
  const criticalLinks = new Set<LinkId>();
  const memberLinks = new Map<TaskId, Link[]>();
  for (const [id, links] of view.linksByTask) {
    if (!onPath(id)) continue;
    for (const link of links.out) {
      if (link.sourceId !== id || !onPath(link.targetId)) continue;
      const source = view.byId.get(link.sourceId);
      const target = view.byId.get(link.targetId);
      if (source === undefined || target === undefined) continue;
      if (linkSlack(link, source, target) > options.criticalMs) continue;
      criticalLinks.add(link.id);
      components.union(link.sourceId, link.targetId);
      const bucket = memberLinks.get(link.sourceId);
      if (bucket === undefined) memberLinks.set(link.sourceId, [link]);
      else bucket.push(link);
    }
  }
  return { criticalLinks, memberLinks };
}

/**
 * Groups the on-path members per component root, ordering tasks by start date within each path and
 * the paths themselves by earliest member start.
 */
function buildPaths(
  view: ReadonlyDataView,
  components: UnionFind,
  memberLinks: ReadonlyMap<TaskId, Link[]>,
): CriticalPath[] {
  const grouped = new Map<TaskId, { tasks: TaskId[]; links: LinkId[]; earliest: number }>();
  for (const id of components.members()) {
    const root = components.find(id);
    let comp = grouped.get(root);
    if (comp === undefined) {
      comp = { tasks: [], links: [], earliest: Number.POSITIVE_INFINITY };
      grouped.set(root, comp);
    }
    comp.tasks.push(id);
    const start = view.byId.get(id)?.start ?? Number.POSITIVE_INFINITY;
    if (start < comp.earliest) comp.earliest = start;
    for (const link of memberLinks.get(id) ?? []) comp.links.push(link.id);
  }

  const startOf = (id: TaskId): number => view.byId.get(id)?.start ?? 0;
  return [...grouped.values()]
    .sort((a, b) => a.earliest - b.earliest)
    .map((comp) => ({
      tasks: comp.tasks.sort((a, b) => startOf(a) - startOf(b)),
      links: comp.links,
    }));
}

/**
 * The critical `Link` objects behind each analysis, keyed by the analysis identity. Kept out of the
 * public `CriticalPathAnalysis` shape: only the paint path needs the objects, and it needs them
 * without re-scanning every link of the store per frame.
 */
const linkObjects = new WeakMap<CriticalPathAnalysis, readonly Link[]>();

/** The `Link` objects of `analysis.criticalLinks`; empty for an analysis this pass never saw. */
export function criticalLinkObjects(analysis: CriticalPathAnalysis): readonly Link[] {
  return linkObjects.get(analysis) ?? [];
}

export function analyze(
  view: ReadonlyDataView,
  latest: LatestTimesMap,
  options: AnalyzeOptions,
): CriticalPathAnalysis {
  const { floats, classes } = computeFloats(view, latest, options);

  /** On-path classes: near-critical tasks never join a path (§7.2). */
  const onPath = (id: TaskId): boolean => {
    const cls = classes.get(id);
    return cls === "critical" || cls === "negativeFloat";
  };

  const components = createUnionFind();
  for (const id of classes.keys()) if (onPath(id)) components.add(id);
  const { criticalLinks, memberLinks } = collectCriticalLinks(view, options, onPath, components);
  const paths = buildPaths(view, components, memberLinks);

  const result: CriticalPathAnalysis = { floats, classes, criticalLinks, paths };
  // Every critical link was recorded against its source exactly once, so the flattened buckets are
  // the critical-link objects with no duplicates.
  const flat: Link[] = [];
  for (const bucket of memberLinks.values()) for (const link of bucket) flat.push(link);
  linkObjects.set(result, flat);
  return result;
}

/**
 * A fresh empty analysis, built per call so no chart instance can observe (or, by casting away the
 * readonly types, corrupt) another instance's empty state through a shared module-level object.
 */
// §1.3 rule 1 — the store's initial value, and the per-instance answer while the store is empty.
export function emptyAnalysis(): CriticalPathAnalysis {
  return {
    floats: new Map(),
    classes: new Map(),
    criticalLinks: new Set(),
    paths: [],
  };
}
