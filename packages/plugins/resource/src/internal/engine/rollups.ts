// docs/specs/plugins/resource.md §2.6 — the rollups, as pure folds over the matrix.
/**
 * The trend / role / team folds, the peak ratio and the interval-overlap test.
 *
 * Role and team are ROSTER METADATA, not engine inputs — the engine never needed them (§2.6) — so
 * each fold takes the caller's own `role` / `team` beside the row's cells. Every quantity is
 * working milliseconds over the analysis range, and every fold reads the POST-HOOK numbers,
 * because that is what `computeUtilization` already sealed into the cells.
 *
 * Headless: no DOM, no service reference.
 */

/** The cell members a fold reads — structurally satisfied by `UtilizationCell` and its subsets. */
export interface RollupCell {
  readonly start: number;
  readonly end: number;
  readonly allocated: number;
  readonly capacity: number;
  readonly ratio: number | null;
  readonly overallocated: boolean;
}

/** One bucket of the demand vs supply trend (§1.2). */
export interface TrendPoint {
  readonly start: number;
  readonly end: number;
  /** Σ allocated working ms over the aggregated resources in the bucket. */
  readonly demand: number;
  /** Σ capacity working ms over the aggregated resources in the bucket. */
  readonly supply: number;
}

/** Demand rolled up by role (§1.2). */
export interface RoleDemand {
  readonly role: string;
  readonly demand: number;
  readonly capacity: number;
  readonly ratio: number | null;
}

/** Capacity rolled up by team (§1.2). */
export interface TeamCapacitySummary {
  readonly team: string;
  readonly allocated: number;
  readonly capacity: number;
  /** `max(0, capacity − allocated)`. */
  readonly available: number;
  readonly resourceCount: number;
  /** Resources of the team with at least one over-allocated bucket in the range. */
  readonly overallocatedCount: number;
}

/** One roster row as a fold sees it: the caller's metadata plus that row's sealed cells. */
export interface RollupMember {
  /** `undefined` omits the row from the role rollup. */
  readonly role?: string | undefined;
  /** `undefined` omits the row from the team rollup. */
  readonly team?: string | undefined;
  readonly cells: readonly RollupCell[];
}

/** Whether any of the intervals overlaps the half-open span. */
export function overlaps(
  intervals: readonly { start: number; end: number }[],
  start: number,
  end: number,
): boolean {
  for (const i of intervals) {
    if (i.start < end && i.end > start) return true;
  }
  return false;
}

/** The largest ratio among the cells, or `null` when none has one. */
export function peakRatio(cells: readonly RollupCell[]): number | null {
  let peak: number | null = null;
  for (const cell of cells) {
    if (cell.ratio !== null && (peak === null || cell.ratio > peak)) peak = cell.ratio;
  }
  return peak;
}

/**
 * Zips per-resource cell series — all over the same range and width, which is what one
 * `computeUtilization` build guarantees — into trend points.
 */
export function trendPoints(series: readonly (readonly RollupCell[])[]): TrendPoint[] {
  const first = series.find((s) => s.length > 0);
  if (first === undefined) return [];
  return first.map((template, i) => {
    let demand = 0;
    let supply = 0;
    for (const s of series) {
      const cell = s[i];
      if (cell === undefined) continue;
      demand += cell.allocated;
      supply += cell.capacity;
    }
    return { start: template.start, end: template.end, demand, supply };
  });
}

function totalsOf(cells: readonly RollupCell[]): {
  allocated: number;
  capacity: number;
  over: boolean;
} {
  let allocated = 0;
  let capacity = 0;
  let over = false;
  for (const cell of cells) {
    allocated += cell.allocated;
    capacity += cell.capacity;
    if (cell.overallocated) over = true;
  }
  return { allocated, capacity, over };
}

/** Rolls rows up by role, in first-appearance order; roleless rows are omitted. */
export function roleDemands(members: readonly RollupMember[]): RoleDemand[] {
  const byRole = new Map<string, { demand: number; capacity: number }>();
  for (const member of members) {
    if (member.role === undefined) continue;
    const totals = totalsOf(member.cells);
    const acc = byRole.get(member.role) ?? { demand: 0, capacity: 0 };
    acc.demand += totals.allocated;
    acc.capacity += totals.capacity;
    byRole.set(member.role, acc);
  }
  return [...byRole].map(([role, t]) => ({
    role,
    demand: t.demand,
    capacity: t.capacity,
    ratio: t.capacity > 0 ? t.demand / t.capacity : null,
  }));
}

/** Rolls rows up by team, in first-appearance order; teamless rows are omitted. */
export function teamSummaries(members: readonly RollupMember[]): TeamCapacitySummary[] {
  const byTeam = new Map<
    string,
    { allocated: number; capacity: number; count: number; over: number }
  >();
  for (const member of members) {
    if (member.team === undefined) continue;
    const totals = totalsOf(member.cells);
    const acc = byTeam.get(member.team) ?? { allocated: 0, capacity: 0, count: 0, over: 0 };
    acc.allocated += totals.allocated;
    acc.capacity += totals.capacity;
    acc.count += 1;
    if (totals.over) acc.over += 1;
    byTeam.set(member.team, acc);
  }
  return [...byTeam].map(([team, t]) => ({
    team,
    allocated: t.allocated,
    capacity: t.capacity,
    available: Math.max(0, t.capacity - t.allocated),
    resourceCount: t.count,
    overallocatedCount: t.over,
  }));
}
