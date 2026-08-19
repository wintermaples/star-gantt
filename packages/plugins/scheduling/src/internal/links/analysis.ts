// docs/specs/plugins/scheduling.md §5.5
/**
 * Link analysis: whether a link's date constraint is violated by the STORED dates (a "conflicting"
 * link), whether it is the one that exactly determines its successor's date (a "driving" link),
 * and which links lie on the upstream/downstream dependency path of a set of tasks.
 *
 * Pure arithmetic over the store's own types — no services, no canvas, no scheduler — so the
 * classification works identically with propagation absent, disabled or active, and the rules are
 * unit-testable without a host.
 */
import type { Link, LinkId, ReadonlyDataView, Task, TaskId } from "@stargantt/plugin-data-store";

// §5.5 — the constraint a link imposes is read from the two ends its type names: FS/FF constrain
// from the source's finish, SS/SF from its start; FS/SS constrain the target's start, FF/SF its
// finish. Lag (negative = lead) shifts the constraint.
/** The time a link requires of its target end, and the time that end actually has. */
export function linkTimes(
  link: Link,
  source: Readonly<Task>,
  target: Readonly<Task>,
): { required: number; actual: number } {
  const lag = link.lag ?? 0;
  const from = link.type === "FS" || link.type === "FF" ? source.end : source.start;
  const actual = link.type === "FS" || link.type === "SS" ? target.start : target.end;
  return { required: from + lag, actual };
}

/** How a link relates to the stored dates of its two tasks. */
export interface LinkStatus {
  /** The target end sits earlier than the link requires — the constraint is violated. */
  conflicting: boolean;
  /** The target end sits exactly where the link requires — this link determines the date. */
  driving: boolean;
}

/**
 * Classifies one link against the stored dates of its two tasks.
 *
 * `conflicting` when the target end is strictly earlier than the constrained time (negative
 * float); `driving` when it is exactly equal, i.e. this predecessor is the one pinning the
 * successor where it is — ties all read as driving. Both are millisecond-exact comparisons over
 * the stored dates.
 */
export function linkStatus(link: Link, source: Readonly<Task>, target: Readonly<Task>): LinkStatus {
  const { required, actual } = linkTimes(link, source, target);
  return { conflicting: actual < required, driving: actual === required };
}

/**
 * Every link on the dependency path of the seed tasks: all links reachable walking predecessors
 * (incoming links, transitively upstream) and successors (outgoing links, transitively downstream)
 * from each seed. Seeds with no entry in the link index contribute nothing.
 */
export function pathLinkIds(
  view: Pick<ReadonlyDataView, "linksByTask">,
  seeds: Iterable<TaskId>,
): Set<LinkId> {
  const out = new Set<LinkId>();
  const walk = (start: TaskId, dir: "in" | "out"): void => {
    const visited = new Set<TaskId>([start]);
    const queue: TaskId[] = [start];
    while (queue.length > 0) {
      const id = queue.pop();
      if (id === undefined) break;
      const entry = view.linksByTask.get(id);
      if (entry === undefined) continue;
      for (const link of entry[dir]) {
        out.add(link.id);
        const next = dir === "in" ? link.sourceId : link.targetId;
        if (visited.has(next)) continue;
        visited.add(next);
        queue.push(next);
      }
    }
  };
  for (const seed of seeds) {
    walk(seed, "in");
    walk(seed, "out");
  }
  return out;
}
