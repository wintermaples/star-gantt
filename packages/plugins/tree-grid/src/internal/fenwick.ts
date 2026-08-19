/**
 * Fenwick tree (Binary Indexed Tree) over row heights.
 *
 * Gives O(log n) `row index → y offset` (prefix sum), O(log n) `y offset → row index`
 * (binary lifting) and O(log n) single-row height updates — the structure variable row height
 * needs to stay interactive at the 100k-row target.
 *
 * `Float64Array` because row heights are CSS pixels and cumulative sums of 100k of them must not
 * lose precision the way a running `number` array rebuilt per change would cost time.
 */
export class Fenwick {
  /** Number of rows covered. */
  readonly n: number;
  /** 1-indexed BIT storage; `t[0]` is unused. */
  private readonly t: Float64Array;
  /** Highest power of two ≤ n; the first stride of the binary lifting search. */
  private readonly hb: number;

  constructor(heights: readonly number[]) {
    // docs/specs/plugins/tree-grid.md § Internal modules
    const n = heights.length;
    const t = new Float64Array(n + 1);
    for (let i = 0; i < n; i += 1) t[i + 1] = heights[i] ?? 0;
    // O(n) in-place build: each node folds into its parent exactly once.
    for (let i = 1; i <= n; i += 1) {
      const j = i + (i & -i);
      if (j <= n) t[j] = (t[j] ?? 0) + (t[i] ?? 0);
    }
    let hb = 0;
    if (n > 0) {
      hb = 1;
      while (hb * 2 <= n) hb *= 2;
    }
    this.n = n;
    this.t = t;
    this.hb = hb;
  }

  /** Adds `delta` to row `i`'s height. O(log n). */
  update(i: number, delta: number): void {
    if (i < 0 || i >= this.n || delta === 0) return;
    for (let x = i + 1; x <= this.n; x += x & -x) this.t[x] = (this.t[x] ?? 0) + delta;
  }

  /** Sum of the heights of rows `[0, count)` — i.e. the y offset of row `count`. O(log n). */
  prefix(count: number): number {
    let x = count;
    if (x > this.n) x = this.n;
    let sum = 0;
    for (; x > 0; x -= x & -x) sum += this.t[x] ?? 0;
    return sum;
  }

  /** Total height of all rows. */
  total(): number {
    return this.prefix(this.n);
  }

  /**
   * Largest `idx` with `prefix(idx) <= target` — the index of the row that contains offset
   * `target`. O(log n) via binary lifting over the BIT (no per-step `prefix` call).
   * Callers clamp the result into `[0, n - 1]`; `target >= total()` returns `n`.
   */
  findIndex(target: number): number {
    let idx = 0;
    let rem = target;
    for (let pw = this.hb; pw > 0; pw >>= 1) {
      const next = idx + pw;
      if (next > this.n) continue;
      const v = this.t[next] ?? 0;
      if (v <= rem) {
        idx = next;
        rem -= v;
      }
    }
    return idx;
  }
}
