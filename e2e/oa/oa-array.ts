/*
 * e2e/oa/oa-array.ts — the orthogonal array the combination suite runs.
 *
 * Pure, no I/O.
 *
 * OA(729, 3^111, strength 2) for the 111 config factors, Rao-Hamming over GF(3): the 729 runs are
 * the points of GF(3)^6 and each factor owns one proportionality class of non-zero coefficient
 * vectors, so run `x` puts factor `j` at level `dot(x, column_j) mod 3`. Every ordered level pair
 * of any two factors then appears in exactly 81 runs, which is what buys pairwise coverage from 729
 * of the 3^111 possible configurations.
 *
 * Level 0 means "the config key is omitted" — run 1 (the all-zero point) is therefore the
 * all-defaults baseline.
 */
const K = 6;
const BASE = 3;

export const RUNS = BASE ** K; // 729

/** Canonical representatives of the 364 proportionality classes, in lexicographic order. */
function canonicalColumns(): number[][] {
  const cols: number[][] = [];
  const digits = (n: number): number[] => {
    const out: number[] = [];
    for (let i = 0; i < K; i++) out.push(Math.floor(n / BASE ** (K - 1 - i)) % BASE);
    return out;
  };
  for (let n = 1; n < BASE ** K; n++) {
    const v = digits(n);
    if (v.find((x) => x !== 0) === 1) cols.push(v);
  }
  return cols;
}

const COLUMNS = canonicalColumns();

/** The point of GF(3)^K a run number (1-based) stands for. */
function runPoint(run: number): number[] {
  const n = run - 1;
  const out: number[] = [];
  for (let i = 0; i < K; i++) out.push(Math.floor(n / BASE ** (K - 1 - i)) % BASE);
  return out;
}

/**
 * The level index (0, 1 or 2) of every factor in a run, in catalog order. `factorCount` must not
 * exceed the 364 columns the construction provides.
 */
export function levelsForRun(run: number, factorCount: number): number[] {
  if (run < 1 || run > RUNS) throw new Error(`run ${run} outside 1..${RUNS}`);
  if (factorCount > COLUMNS.length) {
    throw new Error(`${factorCount} factors exceeds the ${COLUMNS.length} available columns`);
  }
  const x = runPoint(run);
  return COLUMNS.slice(0, factorCount).map((col) => {
    let dot = 0;
    for (let i = 0; i < K; i++) dot += x[i]! * col[i]!;
    return dot % BASE;
  });
}

/** The runs one shard owns, with shards numbered from 1. Contiguous blocks, near-equal sizes. */
export function shardRuns(shard: number, shards: number): number[] {
  if (shard < 1 || shard > shards) throw new Error(`shard ${shard} outside 1..${shards}`);
  const size = Math.ceil(RUNS / shards);
  const start = (shard - 1) * size + 1;
  const end = Math.min(RUNS, start + size - 1);
  const out: number[] = [];
  for (let r = start; r <= end; r++) out.push(r);
  return out;
}
