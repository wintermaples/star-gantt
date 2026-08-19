// docs/specs/plugins/tracking.md §2.11 — the cumulative cost curve and its CPI-scaled S-curve
// forecast, including the pinned boundary condition below.
import type { CostCurvePoint } from "../../types";
import type { CostWorld } from "./compute";

/** What the curve needs to know about one task. */
export interface CurveTask {
  start: number;
  end: number;
  estimated: number;
  actual: number;
}

/** The curve's input: each LEAF task's span plus its estimated/actual figures (§2.9). */
export function curveTasksOf(world: CostWorld): CurveTask[] {
  // The curve accrues leaf tasks only.
  return world.leafTasks().map((task) => {
    const cost = world.costOf(task);
    return { start: task.start, end: task.end, estimated: cost.estimated, actual: cost.actual };
  });
}

/** One uniform ramp from 0 to `amount` between `start` and `end` (a step at `start` when the
 *  span is zero or negative). */
interface Ramp {
  start: number;
  end: number;
  amount: number;
}

/**
 * The ascending distinct sample times: every task boundary plus the status date.
 *
 * The point set evaluates ramps only at these times, and every ramp's own boundaries — raw or
 * status-date-clipped — are always members of this set (a clipped boundary collapses to either the
 * task's own raw boundary or the status date, both already included), so a slope sweep over these
 * times alone is sufficient to answer every ramp.
 */
function sampleTimes(tasks: readonly CurveTask[], statusDate: number): number[] {
  const set = new Set<number>();
  for (const task of tasks) {
    set.add(task.start);
    set.add(task.end);
  }
  if (set.size > 0) set.add(statusDate);
  return [...set].sort((a, b) => a - b);
}

/**
 * The cumulative value of a set of ramps at every one of the given ascending, distinct times, by a
 * single sorted-boundary slope sweep: O((ramps + times) log(ramps + times)) rather than one full
 * ramp scan per sample.
 *
 * Every ramp contributes a `+amount/span` slope event at `start` and a matching `-amount/span`
 * event at `end` (a zero-or-negative span instead contributes one step event at `start`, since the
 * value there jumps straight to `amount`). Sweeping the merged, time-sorted events once while
 * walking the query times in order reproduces the same per-ramp values a naive
 * `Σ amount·clamp((t−start)/span, 0, 1)` scan would, at lower asymptotic cost.
 */
function rampSweep(ramps: readonly Ramp[], times: readonly number[]): number[] {
  if (times.length === 0) return [];
  const events: { t: number; slope?: number; step?: number }[] = [];
  for (const ramp of ramps) {
    if (ramp.amount === 0) continue;
    const span = ramp.end - ramp.start;
    if (span <= 0) {
      events.push({ t: ramp.start, step: ramp.amount });
    } else {
      const rate = ramp.amount / span;
      events.push({ t: ramp.start, slope: rate });
      events.push({ t: ramp.end, slope: -rate });
    }
  }
  events.sort((a, b) => a.t - b.t);

  const out: number[] = new Array<number>(times.length);
  let value = 0;
  let slope = 0;
  let ei = 0;
  // Safe starting point for the integration clock: every event time is one of `times` (see
  // `sampleTimes`'s doc comment), so no event ever precedes `times[0]`.
  let prevT = times[0] ?? 0;
  for (let qi = 0; qi < times.length; qi++) {
    const t = times[qi]!;
    while (ei < events.length && events[ei]!.t <= t) {
      const e = events[ei]!;
      value += slope * (e.t - prevT);
      prevT = e.t;
      if (e.step !== undefined) value += e.step;
      if (e.slope !== undefined) slope += e.slope;
      ei++;
    }
    value += slope * (t - prevT);
    prevT = t;
    out[qi] = value;
  }
  return out;
}

/**
 * The cumulative planned/actual curve (§2.11). Empty without tasks.
 *
 * Each task's `estimated` spreads uniformly over its span (a zero span is a step at its date);
 * `actual` spreads only over the part of the span up to the status date and stays flat past it.
 */
export function costCurvePoints(
  tasks: readonly CurveTask[],
  statusDate: number,
): CostCurvePoint[] {
  const times = sampleTimes(tasks, statusDate);
  const plannedRamps: Ramp[] = tasks.map((t) => ({
    start: t.start,
    end: t.end,
    amount: t.estimated,
  }));
  // Actual cost spreads only over the part of each task's span up to the status date — modeled as
  // the same ramp shape over a status-date-clipped span.
  const actualRamps: Ramp[] = tasks.map((t) => ({
    start: Math.min(t.start, statusDate),
    end: Math.min(t.end, statusDate),
    amount: t.actual,
  }));
  const planned = rampSweep(plannedRamps, times);
  const actual = rampSweep(actualRamps, times);
  return times.map((t, i) => ({ t, planned: planned[i]!, actual: actual[i]! }));
}

/**
 * §2.11's forecast: the SAME point set as {@link costCurvePoints} — nothing is appended.
 *
 * Points strictly BEFORE the status date are returned unchanged. Every point AT OR AFTER the status
 * date — the status-date point ITSELF included (the review-fixed boundary, pinned) — additionally
 * carries
 *
 *     forecast = actualToDate + f × (planned(t) − plannedToDate),  f = actualToDate / plannedToDate
 *
 * with `f = 1` when planned-to-date is 0 — the classic CPI extrapolation, landing on
 * `f × totalPlanned`.
 */
export function costForecastPoints(
  tasks: readonly CurveTask[],
  statusDate: number,
): CostCurvePoint[] {
  const points = costCurvePoints(tasks, statusDate);
  if (points.length === 0) return points;
  // `sampleTimes` adds the status date to the set whenever there are any tasks, so it is always
  // among the points once `points` is non-empty.
  const atStatusDate = points.find((p) => p.t === statusDate);
  const plannedToDate = atStatusDate?.planned ?? 0;
  const actualToDate = atStatusDate?.actual ?? 0;
  const factor = plannedToDate > 0 ? actualToDate / plannedToDate : 1;
  return points.map((p) =>
    p.t < statusDate ? p : { ...p, forecast: actualToDate + factor * (p.planned - plannedToDate) },
  );
}
