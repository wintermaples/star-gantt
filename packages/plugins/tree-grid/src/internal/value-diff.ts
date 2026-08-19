/**
 * The value comparison an inline-edit commit diffs a task against.
 *
 * A `setValue` that rebuilds an object- or array-valued field always produces a fresh reference, so
 * comparing references would report a change for a commit that changed nothing — and with it
 * dispatch a no-op `task/update` and a phantom undo entry.
 */
// docs/specs/plugins/tree-grid.md § Commands — the commit path this guards.

/** A non-null object whose prototype is the plain `Object.prototype` (or `null`), not a class instance. */
function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== "object") return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

/**
 * Whether two field values are equal by value, to a bounded depth.
 *
 * `Object.is` covers primitives (including `NaN`) and identical references; arrays and plain objects
 * are compared element- and key-wise. Anything past the depth cap is treated as changed, degrading
 * to plain reference equality rather than risking a cyclic structure hanging the diff.
 */
export function sameValue(a: unknown, b: unknown, depth = 0): boolean {
  if (Object.is(a, b)) return true;
  if (depth >= 8) return false;
  if (Array.isArray(a) && Array.isArray(b)) {
    if (a.length !== b.length) return false;
    for (let i = 0; i < a.length; i += 1) {
      if (!sameValue(a[i], b[i], depth + 1)) return false;
    }
    return true;
  }
  if (isPlainObject(a) && isPlainObject(b)) {
    const keysA = Object.keys(a);
    const keysB = Object.keys(b);
    if (keysA.length !== keysB.length) return false;
    for (const key of keysA) {
      if (!Object.prototype.hasOwnProperty.call(b, key)) return false;
      if (!sameValue(a[key], b[key], depth + 1)) return false;
    }
    return true;
  }
  return false;
}
