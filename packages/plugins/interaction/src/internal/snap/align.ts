// docs/specs/plugins/interaction.md §6.3 — task-edge alignment arithmetic.
/**
 * Aligning an edited instant to the start/end dates of stored tasks.
 *
 * The edge set is a sorted, deduplicated snapshot built once per data change; a lookup is a binary
 * search, never a scan, so consulting it per pointer frame stays cheap at 100k tasks. Pure —
 * unit-testable without a host.
 */

/** The sorted, deduplicated finite `start`/`end` instants of every given task. */
export function taskEdges(
  tasks: Iterable<Readonly<{ start: number; end: number }>>,
): readonly number[] {
  const set = new Set<number>();
  for (const task of tasks) {
    if (Number.isFinite(task.start)) set.add(task.start);
    if (Number.isFinite(task.end)) set.add(task.end);
  }
  return Array.from(set).sort((a, b) => a - b);
}

/**
 * The edge nearest to `t` within `tolerance` milliseconds, or `undefined` when none is that close.
 *
 * Two equally near edges resolve to the later one, matching the rounding rule's upward tie. A
 * non-finite `t` or an unusable tolerance never matches.
 */
export function nearestEdge(
  edges: readonly number[],
  t: number,
  tolerance: number,
): number | undefined {
  if (edges.length === 0 || !Number.isFinite(t) || !(tolerance >= 0)) return undefined;
  // Insertion point: first index whose edge is >= t.
  let lo = 0;
  let hi = edges.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if ((edges[mid] as number) < t) lo = mid + 1;
    else hi = mid;
  }
  const after = lo < edges.length ? (edges[lo] as number) : undefined;
  const before = lo > 0 ? (edges[lo - 1] as number) : undefined;
  const afterOk = after !== undefined && after - t <= tolerance;
  const beforeOk = before !== undefined && t - before <= tolerance;
  if (afterOk && beforeOk) {
    // Ties resolve to the later edge.
    return (after as number) - t <= t - (before as number) ? after : before;
  }
  if (afterOk) return after;
  if (beforeOk) return before;
  return undefined;
}
