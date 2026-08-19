// The Critical Path Method engine (docs/specs/sdk.md, Module: sdk/cpm): the shared link-constraint
// algebra and backward-pass critical-path engine.
//
// Hostless and side-effect free. The backward pass runs in reverse topological order (Kahn over
// the successor graph), so it never loops on a dependency cycle.

/** A task id as the data store defines it. */
export type CpmTaskId = string | number;

/** The four PDM dependency kinds: finish/start of the source to start/finish of the target. */
export type CpmLinkType = "FS" | "SS" | "FF" | "SF";

/** The task shape the engine needs — live tasks and baseline snapshots alike satisfy it. */
export interface CpmTask {
  id: CpmTaskId;
  /** Start instant, epoch ms. */
  start: number;
  /** End instant, epoch ms. */
  end: number;
}

/** The link shape the engine needs. */
export interface CpmLink {
  sourceId: CpmTaskId;
  targetId: CpmTaskId;
  type: CpmLinkType;
  /** Slack the link demands between its two anchors, ms; omitted or non-finite reads as 0. */
  lag?: number;
}

/** One task's latest values under every successor's current dates and the project end. */
export interface LatestTimes {
  latestStart: number;
  latestFinish: number;
}

/** Options of {@link criticalTaskIds}. */
export interface CriticalTaskIdsOptions {
  /**
   * Total float at or under which a task counts as critical, in ms. Defaults to 1 — exact-to-the-
   * millisecond schedules only; pass a larger value to also catch tasks a rounding step away.
   */
  toleranceMs?: number;
}

/**
 * The date field each side of a link constrains, per link type: `FS` reads the source's *end*
 * against the target's *start*, `SS` start/start, `FF` end/end, `SF` start/end.
 */
export function linkAnchors(type: CpmLinkType): { source: "start" | "end"; target: "start" | "end" } {
  switch (type) {
    case "FS":
      return { source: "end", target: "start" };
    case "SS":
      return { source: "start", target: "start" };
    case "FF":
      return { source: "end", target: "end" };
    case "SF":
      return { source: "start", target: "end" };
    default: {
      const exhaustive: never = type;
      return exhaustive;
    }
  }
}

/**
 * A link's slack under its type and lag, from the current dates of its two endpoints: how far the
 * source can slip (in ms) before the link's requirement on the target's current dates is violated.
 * Zero means the link is tight; negative means it is already violated.
 */
export function linkSlack(
  link: { type: CpmLinkType; lag?: number },
  source: { start: number; end: number },
  target: { start: number; end: number },
): number {
  const lag = Number.isFinite(link.lag) ? (link.lag as number) : 0;
  const anchors = linkAnchors(link.type);
  return target[anchors.target] - lag - source[anchors.source];
}

interface Node {
  id: CpmTaskId;
  start: number;
  duration: number;
  /** Upper bound on the latest start imposed by SS/SF successors. */
  lsBound: number;
  /** Upper bound on the latest finish imposed by FS/FF successors (initially the project end). */
  leBound: number;
  /** Count of successors whose latest values are not yet final, for the Kahn ordering. */
  pending: number;
  /** Whether the backward pass finalized this node (it is on no cycle path). */
  done: boolean;
}

/** A node's latest possible start under the bounds folded in so far. */
function nodeLatestStart(node: Node): number {
  return Math.min(node.lsBound, node.leBound - node.duration);
}

/**
 * Folds one final successor's latest values into its predecessor's bounds. Constraint algebra per
 * link type `source → target` with lag L (all durations fixed):
 * FS: `target.start ≥ source.end + L`  ⇒ `source.latestFinish ≤ target.latestStart − L`;
 * SS: `target.start ≥ source.start + L` ⇒ `source.latestStart ≤ target.latestStart − L`;
 * FF: `target.end ≥ source.end + L`    ⇒ `source.latestFinish ≤ target.latestEnd − L`;
 * SF: `target.end ≥ source.start + L`  ⇒ `source.latestStart ≤ target.latestEnd − L`.
 */
function fold(source: Node, type: CpmLinkType, lag: number, targetLs: number, targetLf: number): void {
  const bound = type === "FS" || type === "FF" ? "leBound" : "lsBound";
  const limit = (type === "FS" || type === "SS" ? targetLs : targetLf) - lag;
  if (limit < source[bound]) source[bound] = limit;
}

/** Builds the graph: one node per usable task plus in-edges; returns the project end too. */
function buildGraph(
  tasks: Iterable<Readonly<CpmTask>>,
  links: Iterable<Readonly<CpmLink>>,
): {
  nodes: Map<CpmTaskId, Node>;
  inEdges: Map<Node, { source: Node; type: CpmLinkType; lag: number }[]>;
  projectEnd: number;
} {
  const nodes = new Map<CpmTaskId, Node>();
  let projectEnd = -Infinity;
  for (const task of tasks) {
    if (!Number.isFinite(task.start) || !Number.isFinite(task.end)) continue;
    if (nodes.has(task.id)) continue;
    nodes.set(task.id, {
      id: task.id,
      start: task.start,
      duration: Math.max(0, task.end - task.start),
      lsBound: Infinity,
      leBound: Infinity,
      pending: 0,
      done: false,
    });
    if (task.end > projectEnd) projectEnd = task.end;
  }
  const inEdges = new Map<Node, { source: Node; type: CpmLinkType; lag: number }[]>();
  for (const link of links) {
    const source = nodes.get(link.sourceId);
    const target = nodes.get(link.targetId);
    if (source === undefined || target === undefined || source === target) continue;
    const lag = Number.isFinite(link.lag) ? (link.lag as number) : 0;
    source.pending += 1;
    let list = inEdges.get(target);
    if (list === undefined) {
      list = [];
      inEdges.set(target, list);
    }
    list.push({ source, type: link.type, lag });
  }
  return { nodes, inEdges, projectEnd };
}

/** Runs the Kahn backward pass, marking every finalized node `done`. */
function relax(graph: ReturnType<typeof buildGraph>): void {
  for (const node of graph.nodes.values()) node.leBound = graph.projectEnd;
  const queue: Node[] = [];
  for (const node of graph.nodes.values()) if (node.pending === 0) queue.push(node);
  for (let i = 0; i < queue.length; i += 1) {
    const node = queue[i] as Node;
    node.done = true;
    const ls = nodeLatestStart(node);
    const lf = ls + node.duration;
    for (const edge of graph.inEdges.get(node) ?? []) {
      fold(edge.source, edge.type, edge.lag, ls, lf);
      edge.source.pending -= 1;
      if (edge.source.pending === 0) queue.push(edge.source);
    }
  }
}

/**
 * The latest possible start and finish of each task — the classic CPM backward pass from the
 * project end (the latest `end` among the given tasks), honoring all four link types and lag.
 *
 * Tasks with non-finite dates, links naming unknown tasks and self-links are ignored; duplicate
 * task ids keep their first occurrence. Tasks on a dependency cycle — and every predecessor whose
 * chain to the project end runs only through a cycle member — are **omitted from the map**: the
 * pass never finalizes them, so their latest values would only reflect the bounds folded in from
 * their non-cycle successors (unconstrained — up to the project end — when they have none), and
 * publishing such partial values would present them as exact. A predecessor of a cycle member
 * therefore inherits *no* constraint from the cycle.
 */
export function latestTimes(
  tasks: Iterable<Readonly<CpmTask>>,
  links: Iterable<Readonly<CpmLink>>,
): Map<CpmTaskId, LatestTimes> {
  const graph = buildGraph(tasks, links);
  relax(graph);
  const out = new Map<CpmTaskId, LatestTimes>();
  for (const node of graph.nodes.values()) {
    if (!node.done) continue;
    const ls = nodeLatestStart(node);
    out.set(node.id, { latestStart: ls, latestFinish: ls + node.duration });
  }
  return out;
}

/**
 * The ids of the critical tasks — those whose latest possible start (holding every successor's
 * dates and the project end) exceeds their current start by at most `toleranceMs` (default 1 ms) —
 * in input iteration order.
 *
 * With no links, exactly the tasks that end at the project end are critical, which is the standard
 * total-float definition. Input hygiene and cycle handling follow {@link latestTimes}: tasks the
 * backward pass cannot finalize (cycle members and predecessors constrained only through them) are
 * never reported critical.
 */
export function criticalTaskIds(
  tasks: Iterable<Readonly<CpmTask>>,
  links: Iterable<Readonly<CpmLink>>,
  options?: CriticalTaskIdsOptions,
): CpmTaskId[] {
  const toleranceMs = options?.toleranceMs ?? 1;
  const graph = buildGraph(tasks, links);
  relax(graph);
  const critical: CpmTaskId[] = [];
  for (const node of graph.nodes.values()) {
    if (node.done && nodeLatestStart(node) - node.start <= toleranceMs) critical.push(node.id);
  }
  return critical;
}
