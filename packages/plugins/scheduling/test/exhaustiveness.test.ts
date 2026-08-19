import type { Patch } from "@stargantt/plugin-data-store";
import { describe, expect, it } from "vitest";
import { PROJECTION_OPS, Projection } from "../src/engine/projection";
import { SEED_OPS, collectSeeds } from "../src/engine/seeds";

/**
 * Compile-time proof that both places where this plugin reads a patch — the projected view it hands
 * the engine, and the propagation seeds it derives — classify every member of the `Patch` union. A
 * variant added to the union without a row is a build error rather than an edit that silently
 * propagates nothing or projects nothing.
 */
// docs/specs/plugins/scheduling.md §2.1

/** Invariant type equality: fails for a missing member *and* for a stale extra one. */
type Exact<A, B> = (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2
  ? true
  : false;
type Assert<T extends true> = T;

export type _SeedTableCoversUnion = Assert<Exact<keyof typeof SEED_OPS, Patch["op"]>>;
export type _ProjectionTableCoversUnion = Assert<Exact<keyof typeof PROJECTION_OPS, Patch["op"]>>;

/** A hypothetical thirteenth op, standing in for any future extension of the union. */
type ExtendedPatch = Patch | { op: "calendar/add"; calendar: { id: string } };

// @ts-expect-error -- the seed table has no `calendar/add` row, so extending the union stops the build.
export type _NewOpBreaksSeeds = Assert<Exact<keyof typeof SEED_OPS, ExtendedPatch["op"]>>;
// @ts-expect-error -- likewise for the projection table.
export type _NewOpBreaksProjection = Assert<Exact<keyof typeof PROJECTION_OPS, ExtendedPatch["op"]>>;

const OPS = [
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
].sort();

describe("patch classification tables — exhaustiveness", () => {
  it("classify exactly the patch ops", () => {
    expect(Object.keys(SEED_OPS).sort()).toEqual(OPS);
    expect(Object.keys(PROJECTION_OPS).sort()).toEqual(OPS);
  });

  // An op with no row is a programming error and is reported as one. Ignoring it would leave the
  // projection disagreeing with the store's post-transaction state and the edit propagating
  // nothing, both without a trace.
  it("names the op when asked to classify one it does not know", () => {
    const bogus = { op: "calendar/add" } as unknown as Patch;
    expect(() => collectSeeds(bogus, new Set())).toThrow(
      'stargantt: unknown patch op "calendar/add"',
    );
    const projection = new Projection({
      byId: new Map(),
      children: new Map(),
      linksByTask: new Map(),
      calendars: new Map(),
      resources: new Map(),
      assignmentsByTask: new Map(),
    });
    expect(() => projection.apply(bogus)).toThrow('stargantt: unknown patch op "calendar/add"');
  });

  it("seeds nothing for a resource-only patch", () => {
    // The engine reads none of the resource model, so a capacity edit must not start a propagation
    // pass.
    const seeds = new Set<string | number>();
    collectSeeds({ op: "resource/add", resource: { id: "r1", name: "R1" } }, seeds);
    collectSeeds(
      { op: "assignment/add", assignment: { taskId: "a", resourceId: "r1", units: 1 } },
      seeds,
    );
    expect(seeds.size).toBe(0);
  });
});
