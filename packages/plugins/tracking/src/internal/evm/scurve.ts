// docs/specs/plugins/tracking.md §2.15 (S-curve) — the hostless cumulative curve: PV at every
// planned boundary, EV/AC interpolated over the snapshot anchors up to the status date.
import type { EvmCurvePoint, EvmSnapshot } from "../../types";

/** What the curve needs to know about one task. */
export interface CurveTask {
  plannedStart: number;
  plannedEnd: number;
  bac: number;
}

/**
 * Cumulative PV at every one of `times` (already ascending and deduplicated), in one left-to-right
 * sweep instead of re-summing `pvFraction` over every task at every sample —
 * O(times + tasks log tasks) rather than O(times × tasks).
 *
 * Each task with a positive span contributes a `+bac/span` slope at its planned start and a
 * matching `-bac/span` slope at its planned end; a zero-or-negative span contributes an instant
 * `+bac` step at its planned start instead — the same two cases `pvFraction` distinguishes.
 */
export function pvSeries(tasks: readonly CurveTask[], times: readonly number[]): number[] {
  const slopeDelta = new Map<number, number>();
  const stepDelta = new Map<number, number>();
  for (const task of tasks) {
    if (task.bac === 0) continue;
    const span = task.plannedEnd - task.plannedStart;
    if (span <= 0) {
      stepDelta.set(task.plannedStart, (stepDelta.get(task.plannedStart) ?? 0) + task.bac);
    } else {
      const slope = task.bac / span;
      slopeDelta.set(task.plannedStart, (slopeDelta.get(task.plannedStart) ?? 0) + slope);
      slopeDelta.set(task.plannedEnd, (slopeDelta.get(task.plannedEnd) ?? 0) - slope);
    }
  }

  const out: number[] = [];
  let value = 0;
  let slope = 0;
  let prevT: number | undefined;
  for (const t of times) {
    if (prevT !== undefined) value += slope * (t - prevT);
    value += stepDelta.get(t) ?? 0;
    slope += slopeDelta.get(t) ?? 0;
    out.push(value);
    prevT = t;
  }
  return out;
}

/** One EV/AC interpolation anchor. */
export interface CurveAnchor {
  t: number;
  ev: number;
  ac: number;
}

/** Piecewise-linear interpolation over ascending anchors; clamped at the ends. */
export function interpolate(
  anchors: readonly CurveAnchor[],
  t: number,
): { ev: number; ac: number } {
  const first = anchors[0] as CurveAnchor;
  const last = anchors[anchors.length - 1] as CurveAnchor;
  if (t <= first.t) return { ev: first.ev, ac: first.ac };
  if (t >= last.t) return { ev: last.ev, ac: last.ac };
  // `first.t < t < last.t` here, so the segment straddling `t` always exists within the loop — no
  // fallback return is reachable after it.
  let a = first;
  let b = last;
  for (let i = 1; i < anchors.length; i += 1) {
    const candidate = anchors[i] as CurveAnchor;
    if (t > candidate.t) continue;
    b = candidate;
    a = anchors[i - 1] as CurveAnchor;
    break;
  }
  const f = b.t === a.t ? 1 : (t - a.t) / (b.t - a.t);
  return { ev: a.ev + f * (b.ev - a.ev), ac: a.ac + f * (b.ac - a.ac) };
}

/**
 * The S-curve points (§2.15): samples at every planned boundary, snapshot date and the status date;
 * `pv` everywhere, `ev`/`ac` only at times up to the status date, interpolated over
 * `(earliest planned start, 0)`, the snapshots, and `(status date, current EV/AC)`.
 */
export function scurvePoints(
  tasks: readonly CurveTask[],
  snapshots: readonly EvmSnapshot[],
  statusDate: number,
  currentEv: number,
  currentAc: number,
): EvmCurvePoint[] {
  const times = new Set<number>();
  let earliest = Infinity;
  for (const task of tasks) {
    times.add(task.plannedStart);
    times.add(task.plannedEnd);
    earliest = Math.min(earliest, task.plannedStart);
  }
  if (times.size === 0) return [];
  times.add(statusDate);

  // Every snapshot date is a sample time (§2.15), even past the status date — such a point still
  // gets a PV figure; only the EV/AC interpolation anchors are capped at the status date.
  const snapAnchors: CurveAnchor[] = [];
  for (const s of snapshots) {
    times.add(s.t);
    if (s.t <= statusDate) snapAnchors.push({ t: s.t, ev: s.ev, ac: s.ac });
  }
  // The zero anchor is dropped when a snapshot sits at or before it (so the anchor chain stays
  // ascending and the cumulative curve never dips back to 0 after an early seeded snapshot), and
  // also when its own time is at or past the status date — i.e. the status date is at or before the
  // earliest planned start, so nothing has happened yet on the schedule. Keeping it there would tie
  // it with the final `(statusDate, currentEv, currentAc)` anchor, and `interpolate` resolves an
  // exact-`t` tie against `anchors[0]` first — silently reporting 0 instead of `projectMetrics()`'s
  // real current EV/AC (§2.15).
  const base = Math.min(earliest, statusDate);
  const dropZero = base >= statusDate || snapAnchors.some((a) => a.t <= base);
  const anchors: CurveAnchor[] = dropZero ? [] : [{ t: base, ev: 0, ac: 0 }];
  anchors.push(...snapAnchors);
  anchors.sort((a, b) => a.t - b.t);
  anchors.push({ t: statusDate, ev: currentEv, ac: currentAc });

  const sortedTimes = [...times].sort((a, b) => a - b);
  const pv = pvSeries(tasks, sortedTimes);
  return sortedTimes.map((t, i) => {
    const point: EvmCurvePoint = { t, pv: pv[i] as number };
    if (t <= statusDate) {
      const { ev, ac } = interpolate(anchors, t);
      point.ev = ev;
      point.ac = ac;
    }
    return point;
  });
}
