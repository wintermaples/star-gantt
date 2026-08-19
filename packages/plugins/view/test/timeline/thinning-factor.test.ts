/**
 * Fit-based label thinning, pinned against a brute-force reference.
 *
 *
 * `thinningFactor` used to test every candidate against every factor — quadratic in the number of
 * visible boundaries, of which a header row can hold up to `MAX_TICKS` (4096). It now reduces each
 * candidate to the least factor that fits it and walks the multiples of each factor instead. The
 * definition it implements is unchanged, so the reference below — the literal "smallest n at which
 * every selected candidate fits" search — must agree with it on every input, including the
 * degenerate ones (empty cells, gaps left by a throwing `format`, stepped rows, negative calendar
 * indices, non-finite geometry).
 */
import { describe, expect, it } from "vitest";
import { thinningFactor } from "../../src/internal/timeline/header-labels";
import type { LabelCandidate } from "../../src/internal/timeline/header-labels";

/**
 * The definition, evaluated directly: the smallest factor at which every candidate whose
 * step-normalized calendar index is a multiple of it holds its label in that many of its own cells,
 * rejecting a factor that would select nothing at all.
 *
 * Deliberately self-contained — it shares no helper with the implementation, so the step
 * normalization is spelled out here too (`Math.floor`, which is what anchors the labelled set for a
 * pre-epoch, i.e. negative, calendar index; `Math.trunc` would round the wrong way there).
 */
function referenceThinningFactor(
  candidates: LabelCandidate[],
  labelPadding: number,
  step: number,
): number {
  for (let n = 1; n <= candidates.length; n++) {
    let fitsAll = true;
    let anySelected = false;
    for (const c of candidates) {
      if (Math.floor(c.calIndex / step) % n !== 0) continue;
      anySelected = true;
      if (c.width + 2 * labelPadding > n * c.cellWidth) {
        fitsAll = false;
        break;
      }
    }
    if (fitsAll && anySelected) return n;
  }
  return candidates.length;
}

/** A deterministic 32-bit PRNG, so a failing case is reproducible from its seed alone. */
function rng(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state * 1_664_525 + 1_013_904_223) >>> 0;
    return state / 0x1_0000_0000;
  };
}

interface RowShape {
  /** Boundaries in the row, i.e. candidates before any are dropped. */
  count: number;
  /** Cell width in CSS px — the density under test. */
  cellWidth: number;
  /** Label width in CSS px. */
  width: number;
  /** The row's `step`. */
  step?: number;
  /** Calendar index of the first boundary. */
  firstIndex?: number;
}

function row(shape: RowShape): LabelCandidate[] {
  const step = shape.step ?? 1;
  const first = shape.firstIndex ?? 0;
  const out: LabelCandidate[] = [];
  for (let i = 0; i < shape.count; i++) {
    out.push({
      x: i * shape.cellWidth,
      text: `label ${i}`,
      width: shape.width,
      cellWidth: shape.cellWidth,
      calIndex: (first + i) * step,
    });
  }
  return out;
}

const PADDING = 4;

function expectAgreement(candidates: LabelCandidate[], step: number, padding = PADDING): number {
  const actual = thinningFactor(candidates, padding, step);
  expect(actual).toBe(referenceThinningFactor(candidates, padding, step));
  return actual;
}

describe("thinningFactor agrees with the definition", () => {
  it("labels every boundary when the labels fit", () => {
    // A `day` row at the built-in 40 px/day with a label that fits: no thinning at all.
    expect(expectAgreement(row({ count: 200, cellWidth: 40, width: 14 }), 1)).toBe(1);
  });

  it("thins an hour row whose labels are wider than their cells", () => {
    // 20 px cells, 28 px labels + 8 px padding: two cells are not enough, three are.
    expect(expectAgreement(row({ count: 300, cellWidth: 20, width: 28 }), 1)).toBe(2);
  });

  it.each([0.5, 1, 1.6, 4, 12, 20, 40, 96, 480])(
    "agrees at %s px per cell across a full row",
    (cellWidth) => {
      for (const width of [0, 6, 13.5, 41, 200]) {
        expectAgreement(row({ count: 400, cellWidth, width }), 1);
      }
    },
  );

  it("agrees on stepped rows, whose indices advance by the step", () => {
    for (const step of [2, 3, 10]) {
      for (const cellWidth of [1.6, 12, 60]) {
        expectAgreement(row({ count: 240, cellWidth, width: 33, step, firstIndex: 7 }), step);
      }
    }
  });

  it("agrees when the calendar indices are negative (pre-epoch spans)", () => {
    expectAgreement(row({ count: 180, cellWidth: 9, width: 30, firstIndex: -95 }), 1);
    expectAgreement(row({ count: 180, cellWidth: 9, width: 30, step: 3, firstIndex: -31 }), 3);
  });

  it("agrees on indices that straddle the epoch and do not divide evenly by the step", () => {
    // `Math.floor` and `Math.trunc` part ways for a negative index that is not a multiple of the
    // step (`floor(-7 / 3) = -3` versus `trunc(-7 / 3) = -2`), which selects a different set and can
    // resolve a different factor. Each row below is a `[calIndex, width, cellWidth]` triple set for
    // which the two conventions genuinely disagree, so the oracle pins the sign convention rather
    // than inheriting it from the implementation.
    const fixtures: { step: number; rows: [number, number, number][] }[] = [
      {
        step: 4,
        rows: [
          [10, 43, 17],
          [-2, 27, 6],
          [14, 40, 16],
          [9, 23, 28],
          [-6, 9, 21],
          [11, 21, 24],
        ],
      },
      {
        step: 2,
        rows: [
          [8, 24, 26],
          [-5, 32, 7],
          [-6, 52, 24],
          [1, 50, 21],
        ],
      },
      {
        step: 5,
        rows: [
          [7, 50, 0],
          [-16, 3, 26],
          [15, 33, 17],
          [10, 11, 18],
          [-13, 54, 4],
          [-7, 34, 14],
          [7, 36, 15],
        ],
      },
      {
        step: 3,
        rows: [
          [18, 13, 15],
          [1, 49, 28],
          [-1, 53, 13],
          [11, 27, 26],
          [-1, 39, 19],
          [14, 35, 20],
          [0, 2, 17],
          [-8, 2, 20],
          [-6, 41, 13],
          [-14, 0, 23],
          [6, 33, 24],
        ],
      },
    ];
    for (const { step, rows } of fixtures) {
      expectAgreement(
        rows.map(([calIndex, width, cellWidth], i) => ({
          x: i * cellWidth,
          text: `t${i}`,
          width,
          cellWidth,
          calIndex,
        })),
        step,
      );
    }
  });

  it("agrees when a throwing format left gaps in the candidate run", () => {
    const random = rng(0x5eed);
    for (let trial = 0; trial < 40; trial++) {
      const all = row({ count: 150, cellWidth: 11, width: 26, firstIndex: 3 });
      // `labelCandidates` skips a boundary whose `format` threw, so the surviving step-normalized
      // indices are not consecutive — a factor may then select nothing at all.
      const kept = all.filter(() => random() > 0.4);
      expectAgreement(kept, 1);
    }
  });

  it("agrees on randomly mixed widths and cell widths", () => {
    const random = rng(0xc0ffee);
    for (let trial = 0; trial < 60; trial++) {
      const count = 1 + Math.floor(random() * 120);
      const candidates: LabelCandidate[] = [];
      for (let i = 0; i < count; i++) {
        candidates.push({
          x: i,
          text: `t${i}`,
          width: random() * 80,
          cellWidth: random() * 30,
          calIndex: Math.floor(random() * 40) + i * 2,
        });
      }
      expectAgreement(candidates, 1, random() * 6);
    }
  });

  it("agrees on degenerate geometry", () => {
    const shapes: LabelCandidate[][] = [
      [],
      row({ count: 1, cellWidth: 40, width: 10 }),
      // A zero-width cell can never hold a label with padding, so no factor qualifies.
      row({ count: 8, cellWidth: 0, width: 10 }),
      // A zero-width label in a zero-width cell fits exactly, with no padding.
      row({ count: 8, cellWidth: 0, width: 0 }),
      // Cells to the left of the surface (a reversed axis) never fit.
      row({ count: 8, cellWidth: -20, width: 10 }),
      row({ count: 6, cellWidth: Number.NaN, width: 10 }),
      row({ count: 6, cellWidth: 20, width: Number.NaN }),
      row({ count: 6, cellWidth: Number.POSITIVE_INFINITY, width: 10 }),
      row({ count: 6, cellWidth: 20, width: Number.POSITIVE_INFINITY }),
      row({ count: 6, cellWidth: 1e-9, width: 10 }),
    ];
    for (const candidates of shapes) {
      expectAgreement(candidates, 1, 0);
      expectAgreement(candidates, 1);
    }
  });

  it("agrees at the tick cap, the widest row a header can build", () => {
    // `MAX_TICKS` boundaries at a density where nothing fits: the case that made the old quadratic
    // search do ~16 million comparisons.
    expectAgreement(row({ count: 4096, cellWidth: 0.5, width: 30 }), 1);
    expectAgreement(row({ count: 4096, cellWidth: 60, width: 30 }), 1);
  });
});
