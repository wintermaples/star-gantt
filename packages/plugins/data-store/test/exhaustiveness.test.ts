import { describe, expect, it } from "vitest";
import { PATCH_OPS, invertPatch } from "../src/ops";
import { changedTaskIds } from "../src/patch";
import { Store } from "../src/store";
import type { Patch } from "../src/types";

/**
 * Compile-time proof that the `Patch` union cannot grow a member that some dispatch site silently
 * ignores. Every question the system asks about a patch — apply, invert, changed ids — is answered by
 * one table keyed on `Patch["op"]`, so the check below is the check for all of them.
 */

/** Invariant type equality: fails for a missing member *and* for a stale extra one. */
type Exact<A, B> = (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2
  ? true
  : false;
type Assert<T extends true> = T;

// The table covers exactly the union as it stands today.
export type _TableCoversUnion = Assert<Exact<keyof typeof PATCH_OPS, Patch["op"]>>;

/** A hypothetical extra op, standing in for any future extension of the union. */
type ExtendedPatch = Patch | { op: "calendar/add"; calendar: { id: string } };

// @ts-expect-error -- the table has no `calendar/add` row, so extending the union stops the build.
export type _NewOpBreaksTheBuild = Assert<Exact<keyof typeof PATCH_OPS, ExtendedPatch["op"]>>;

describe("patch-op table — exhaustiveness", () => {
  it("has exactly one row per patch op", () => {
    expect(Object.keys(PATCH_OPS).sort()).toEqual(
      [
        "assignment/add",
        "assignment/remove",
        "assignment/update",
        "link/add",
        "link/remove",
        "link/update",
        "resource/add",
        "resource/remove",
        "resource/update",
        "task/add",
        "task/remove",
        "task/update",
      ].sort(),
    );
  });

  // An op with no row is a programming error and is reported as one. Silently ignoring it is the
  // failure mode the table exists to prevent: the patch would vanish from an apply, an inversion
  // or a changed-id set without a trace.
  it("names the op when asked to handle one it does not know", () => {
    const bogus = { op: "calendar/add" } as unknown as Patch;
    const store = new Store();
    expect(() => store.applyPatch(bogus)).toThrow(
      'stargantt: unknown patch op "calendar/add"',
    );
    expect(() => invertPatch(bogus)).toThrow('stargantt: unknown patch op "calendar/add"');
    expect(() => changedTaskIds([bogus])).toThrow('stargantt: unknown patch op "calendar/add"');
  });

  it("gives every row all four handlers", () => {
    for (const row of Object.values(PATCH_OPS)) {
      expect(typeof row.apply).toBe("function");
      expect(typeof row.invert).toBe("function");
      expect(typeof row.changedIds).toBe("function");
      expect(typeof row.classify).toBe("function");
    }
  });
});
