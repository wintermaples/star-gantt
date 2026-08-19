// docs/specs/plugins/data-store.md — Data model: sibling order is kept via `orderKey`
// (fractional-indexing string) to avoid renumbering all rows on insert.
/**
 * Fractional index keys: sibling order is held by an `orderKey` string, so inserting a row never
 * renumbers the rows around it.
 *
 * A key is read as a base-62 fraction `0.<digits>` over an alphabet whose character order is the
 * same as its digit order. For two keys of **distinct value**, lexicographic string order equals
 * numeric order, so the store can keep siblings sorted by plain string comparison. `midKey` always
 * returns a value strictly between its neighbours, so sibling key values stay distinct.
 */

const DIGITS = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";
const BASE = DIGITS.length; // 62
const WIDTH = 6;
/** The middle digit of the alphabet — the same value `midKey` carries out of a half-step. */
const MID_DIGIT = DIGITS.charAt(BASE / 2);

function toDigits(key: string): number[] {
  const out: number[] = [];
  for (const ch of key) {
    const d = DIGITS.indexOf(ch);
    out.push(d < 0 ? 0 : d);
  }
  return out;
}

/**
 * Trailing zero digits do not change a key's value ("1" and "10" are both 1/62), but they do make
 * two equal-valued keys compare as distinct strings. Averaging is done on the trimmed form so the
 * "did the average land back on `prev`?" check below is a value comparison.
 */
function trimTrailingZeros(digits: number[]): number[] {
  let end = digits.length;
  while (end > 0 && digits[end - 1] === 0) end--;
  digits.length = end;
  return digits;
}

function fromDigits(digits: readonly number[]): string {
  let end = digits.length;
  while (end > 0 && digits[end - 1] === 0) end--;
  let s = "";
  for (let i = 0; i < end; i++) s += DIGITS[digits[i] ?? 0];
  return s;
}

/**
 * An `orderKey` that sorts strictly between `prev` and `next`.
 *
 * Sibling order in the store is held by each task's `orderKey` string and compared with plain
 * string comparison, so inserting a row between two others is a matter of minting a key that lies
 * between their keys — no surrounding row is renumbered. This is the store's own arithmetic:
 * plugins that insert, paste or reorder rows call it instead of re-implementing it, so every key
 * in a chart comes from one implementation and cannot drift.
 *
 * Pass `""` as `prev` when there is no preceding sibling and `undefined` as `next` when there is
 * no following sibling. The keys must be given in order (`prev` lower than `next`); the returned
 * key is always distinct from `prev`, so two siblings never end up sharing one.
 */
export function midKey(prev: string, next: string | undefined): string {
  const a = trimTrailingZeros(toDigits(prev));
  const b = next === undefined ? [BASE] : trimTrailingZeros(toDigits(next));
  const n = Math.max(a.length, b.length);

  // sum = a + b, as a base-62 fraction with a 0/1 integer carry
  const sum = new Array<number>(n).fill(0);
  let carry = 0;
  for (let i = n - 1; i >= 0; i--) {
    const s = (a[i] ?? 0) + (b[i] ?? 0) + carry;
    sum[i] = s % BASE;
    carry = s >= BASE ? 1 : 0;
  }

  // out = sum / 2 (long division, most-significant first)
  const out: number[] = [];
  let rem = carry;
  for (let i = 0; i < n; i++) {
    const cur = rem * BASE + (sum[i] ?? 0);
    out.push(Math.floor(cur / 2));
    rem = cur % 2;
  }
  if (rem === 1) out.push(BASE / 2);

  const key = fromDigits(out);
  // `prev` and `next` can be numerically equal while lexicographically distinct — user-supplied
  // keys reach `midKey` through `load()` and `task/add`, and e.g. `midKey("1", "10")` averages back
  // onto `prev`. Descending one digit keeps the returned key distinct from `prev`, so two siblings
  // never share a key.
  return key === fromDigits(a) ? key + MID_DIGIT : key;
}

/**
 * The `i`-th key of a monotonically increasing sequence, used to give load()ed tasks that carry no
 * `orderKey` of their own a stable one (the store's sibling order is defined by `orderKey` alone,
 * so every stored task must have one). Encodes `i + 1` so that the smallest value is still strictly
 * greater than the empty key.
 */
export function sequenceKey(i: number): string {
  let n = Math.max(0, Math.floor(i)) + 1;
  const digits = new Array<number>(WIDTH).fill(0);
  for (let k = WIDTH - 1; k >= 0 && n > 0; k--) {
    digits[k] = n % BASE;
    n = Math.floor(n / BASE);
  }
  let s = "";
  for (const d of digits) s += DIGITS[d];
  return s;
}
