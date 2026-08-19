/**
 * `internal/evm/scurve.ts` — the cumulative S-curve (docs/specs/plugins/tracking.md §2.15), plus
 * `internal/evm/panels.ts`'s `curveGeometry` mapping.
 *
 * Covers the `scurvePoints` behavior. Hostless: pure functions over hand-built fixtures, no DOM.
 */
import { describe, expect, it } from "vitest";
import { interpolate, pvSeries, scurvePoints } from "../src/internal/evm/scurve";
import type { CurveTask } from "../src/internal/evm/scurve";
import { curveGeometry } from "../src/internal/evm/panels";

const DAY = 86_400_000;
const tasks: CurveTask[] = [{ plannedStart: 0, plannedEnd: 10 * DAY, bac: 100 }];

describe("scurvePoints (§2.15)", () => {
  it("is empty without tasks", () => {
    expect(scurvePoints([], [], 5 * DAY, 0, 0)).toEqual([]);
  });

  it("samples boundaries + status date; EV/AC ramp to the current value and stop there", () => {
    const points = scurvePoints(tasks, [], 5 * DAY, 40, 60);
    expect(points.map((p) => p.t)).toEqual([0, 5 * DAY, 10 * DAY]);
    const mid = points[1];
    expect(mid?.pv).toBeCloseTo(50);
    expect(mid?.ev).toBeCloseTo(40);
    expect(mid?.ac).toBeCloseTo(60);
    expect(points[0]?.ev).toBe(0);
    // Past the status date the plugin draws no EV/AC guess.
    expect(points[2]?.ev).toBeUndefined();
    expect(points[2]?.ac).toBeUndefined();
  });

  it("interpolates over recorded snapshots", () => {
    const snapshots = [{ t: 2 * DAY, ev: 30, ac: 10 }];
    const points = scurvePoints(tasks, snapshots, 4 * DAY, 50, 50);
    expect(points.find((p) => p.t === DAY)).toBeUndefined(); // day 1 is not a sample time
    expect(points.find((p) => p.t === 2 * DAY)?.ev).toBe(30);
    expect(points.find((p) => p.t === 4 * DAY)?.ev).toBe(50);
  });

  it("keeps a snapshot past the status date as a sample time, without EV/AC", () => {
    const snapshots = [{ t: 7 * DAY, ev: 70, ac: 80 }];
    const points = scurvePoints(tasks, snapshots, 5 * DAY, 40, 60);
    const at7 = points.find((p) => p.t === 7 * DAY);
    expect(at7).toBeDefined();
    expect(at7?.pv).toBeCloseTo(70);
    // Not an interpolation anchor: no EV/AC guess past the status date.
    expect(at7?.ev).toBeUndefined();
    expect(at7?.ac).toBeUndefined();
  });

  /* --- the zero-anchor-drop edge case (the subtle, load-bearing rule) ----- */

  it("drops the zero anchor when a seeded snapshot sits at or before it, staying monotonic", () => {
    const snapshots = [{ t: -2 * DAY, ev: 20, ac: 15 }];
    const points = scurvePoints(tasks, snapshots, 5 * DAY, 40, 60);
    const atSnap = points.find((p) => p.t === -2 * DAY);
    expect(atSnap?.ev).toBe(20);
    expect(atSnap?.ac).toBe(15);
    // The zero anchor is dropped: the curve never dips back toward 0 after the early point.
    const evs = points.filter((p) => p.ev !== undefined).map((p) => p.ev as number);
    expect([...evs].sort((a, b) => a - b)).toEqual(evs);
    expect(points.find((p) => p.t === 0)?.ev).toBeGreaterThanOrEqual(20);
  });

  it("drops the zero anchor for a snapshot sitting exactly ON it", () => {
    // `base` is min(earliest planned start, status date) = 0 here, and the snapshot is at 0 —
    // `a.t <= base`, so the tie is resolved by dropping the zero anchor, not by reporting 0.
    const snapshots = [{ t: 0, ev: 25, ac: 12 }];
    const points = scurvePoints(tasks, snapshots, 5 * DAY, 40, 60);
    expect(points.find((p) => p.t === 0)?.ev).toBe(25);
    expect(points.find((p) => p.t === 0)?.ac).toBe(12);
  });

  it("reports the current EV/AC (not 0) when the status date is at or before the earliest start", () => {
    // No snapshots: without the drop, the duplicate zero/final anchor tie at t = statusDate would
    // resolve to the zero anchor first, silently reporting ev/ac = 0 here.
    const points = scurvePoints(tasks, [], -1 * DAY, 12, 7);
    const atStatus = points.find((p) => p.t === -1 * DAY);
    expect(atStatus?.ev).toBe(12);
    expect(atStatus?.ac).toBe(7);

    // Status date exactly at the earliest planned start: same tie, same fix.
    const atStart = scurvePoints(tasks, [], 0, 5, 3).find((p) => p.t === 0);
    expect(atStart?.ev).toBe(5);
    expect(atStart?.ac).toBe(3);
  });

  it("keeps the zero anchor when every snapshot sits strictly after it", () => {
    const snapshots = [{ t: 2 * DAY, ev: 30, ac: 10 }];
    const points = scurvePoints(tasks, snapshots, 5 * DAY, 50, 50);
    // The curve still starts at 0 on the earliest planned start.
    expect(points.find((p) => p.t === 0)?.ev).toBe(0);
    expect(points.find((p) => p.t === 0)?.ac).toBe(0);
  });

  /* --- the PV sweep ------------------------------------------------------- */

  // The slope-sweep `pv` computation replaced an O(times × tasks) `pvAt(tasks, t)` sum per sample.
  // This reimplements that naive form as the reference and checks the two agree on a fixture mixing
  // overlapping, non-overlapping and zero-span tasks (§2.15).
  it("agrees with the naive per-sample pvAt sum on a mixed fixture", () => {
    function naivePvFraction(start: number, end: number, t: number): number {
      const span = end - start;
      if (span <= 0) return t >= start ? 1 : 0;
      return Math.min(Math.max((t - start) / span, 0), 1);
    }
    function naivePvAt(ts: readonly CurveTask[], t: number): number {
      let total = 0;
      for (const item of ts) {
        if (item.bac === 0) continue;
        total += item.bac * naivePvFraction(item.plannedStart, item.plannedEnd, t);
      }
      return total;
    }

    const fixture: CurveTask[] = [
      { plannedStart: 0, plannedEnd: 10 * DAY, bac: 100 },
      { plannedStart: 3 * DAY, plannedEnd: 3 * DAY, bac: 40 }, // zero-span milestone
      { plannedStart: 5 * DAY, plannedEnd: 20 * DAY, bac: 300 },
      { plannedStart: 8 * DAY, plannedEnd: 8 * DAY, bac: 0 }, // zero bac, ignored
      { plannedStart: -2 * DAY, plannedEnd: 6 * DAY, bac: 60 },
    ];
    const points = scurvePoints(fixture, [], 12 * DAY, 0, 0);
    for (const p of points) expect(p.pv).toBeCloseTo(naivePvAt(fixture, p.t));

    const allBoundaries = scurvePoints(fixture, [], 30 * DAY, 0, 0);
    for (const t of [-2 * DAY, 0, 3 * DAY, 5 * DAY, 6 * DAY, 8 * DAY, 10 * DAY, 20 * DAY]) {
      expect(allBoundaries.find((p) => p.t === t)?.pv).toBeCloseTo(naivePvAt(fixture, t));
    }
  });

  it("pvSeries steps whole for a zero span and ramps for a positive one", () => {
    const series = pvSeries(
      [
        { plannedStart: 0, plannedEnd: 4 * DAY, bac: 400 },
        { plannedStart: 2 * DAY, plannedEnd: 2 * DAY, bac: 50 },
      ],
      [0, 2 * DAY, 4 * DAY],
    );
    expect(series).toEqual([0, 200 + 50, 400 + 50]);
  });
});

describe("interpolate", () => {
  const anchors = [
    { t: 0, ev: 0, ac: 0 },
    { t: 10, ev: 100, ac: 50 },
  ];

  it("clamps at both ends and interpolates linearly between", () => {
    expect(interpolate(anchors, -5)).toEqual({ ev: 0, ac: 0 });
    expect(interpolate(anchors, 15)).toEqual({ ev: 100, ac: 50 });
    expect(interpolate(anchors, 5)).toEqual({ ev: 50, ac: 25 });
  });

  it("resolves an exact-`t` tie at the FIRST anchor against that anchor — the drop rule's reason", () => {
    // `t <= first.t` short-circuits before the segment walk, so a zero anchor tied with the final
    // `(statusDate, currentEv, currentAc)` anchor would silently answer 0. That is exactly why
    // `scurvePoints` drops the zero anchor rather than letting the tie stand.
    const tied = [
      { t: 5, ev: 0, ac: 0 },
      { t: 5, ev: 40, ac: 60 },
    ];
    expect(interpolate(tied, 5)).toEqual({ ev: 0, ac: 0 });
    // With the zero anchor dropped there is no tie left and the real figures answer.
    expect(interpolate([{ t: 5, ev: 40, ac: 60 }], 5)).toEqual({ ev: 40, ac: 60 });
  });
});

describe("curveGeometry (§2.15's canvas mapping)", () => {
  it("maps into canvas space with EV/AC polylines cut at the status date", () => {
    const points = scurvePoints(tasks, [], 5 * DAY, 40, 60);
    const g = curveGeometry(points, 360, 140);
    expect(g.pv).toHaveLength(3);
    expect(g.ev).toHaveLength(2);
    expect(g.ac).toHaveLength(2);
  });

  it("is empty for no points, and keeps a flat all-zero series inside the box", () => {
    expect(curveGeometry([], 360, 140)).toEqual({ pv: [], ev: [], ac: [] });
    const flat = curveGeometry([{ t: 0, pv: 0 }, { t: 10, pv: 0 }], 360, 140);
    for (const p of flat.pv) {
      expect(p.x).toBeGreaterThanOrEqual(4);
      expect(p.x).toBeLessThanOrEqual(356);
      expect(p.y).toBeGreaterThanOrEqual(4);
      expect(p.y).toBeLessThanOrEqual(136);
    }
  });
});
