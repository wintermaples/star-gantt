// docs/specs/plugins/tracking.md §2.8 — the rate master: session-local per-resource standard /
// overtime hourly rates, seeded from `cost.rates`, plus the OPTIONAL `stargantt.resource-pool`
// fallback `rateOf` consults when the master has no entry.
//
// §2.8's resolution order, verbatim: master entry first; else — with `stargantt.resource-pool`
// resolvable AND its entry carrying a `costRate` — `{ standard: costRate }`; else `undefined`.
// The master never writes to the pool.
import type { PluginContext } from "@stargantt/core";
import type { ResourceId } from "@stargantt/plugin-data-store";
// Type-only: `@stargantt/plugin-resource`. This also carries the package's
// `declare module "@stargantt/core"` augmentation into this
// program, which is what makes `"stargantt.resource-pool"` a valid key of `keyof Services` below —
// erased at emit, no runtime dependency added (the package is a `devDependency`, so type-only
// imports carry no runtime dependency).
import type { ResourcePoolService } from "@stargantt/plugin-resource";
import type { CostRate, CostRateInit } from "../../types";
import { usableAmount } from "./values";

/* ------------------------------------------------------------------ *
 * The optional resource-pool edge (§8: "resource-pool (resource, L7, same-layer optional)")
 * ------------------------------------------------------------------ */

/**
 * The one `ctx.useOptional("stargantt.resource-pool")` call this area makes — a VISIBLE, literal
 * member-expression call (never aliased, bound or cast on the `ctx.useOptional` expression itself),
 * so `tools/lint-deps.mjs`'s static scanner sees it exactly like any other service lookup. Same-layer
 * `useOptional` is the documented escape hatch (architecture ch. 5; `meta.optional` already lists
 * `stargantt.resource`), so this call is legal and lint-clean as written — hiding it behind an
 * aliased/bound reference bought no lint relief and is exactly what the scanner exists to catch.
 *
 * `"stargantt.resource-pool"` is now a declared key of `keyof Services` (see the type-only import
 * above), so this is a genuine `Services`-typed lookup — no structural shim, no cast.
 */
export function lookupResourcePool(ctx: PluginContext): ResourcePoolService | undefined {
  return ctx.useOptional("stargantt.resource-pool");
}

/* ------------------------------------------------------------------ *
 * The rate master
 * ------------------------------------------------------------------ */

/** Session-local rate master. */
export interface RateStore {
  /** A fresh snapshot of the master, for `CostState.rates`. */
  entries(): ReadonlyMap<ResourceId, Readonly<CostRate>>;
  /** The master entry, or `undefined`. */
  get(resourceId: ResourceId): CostRate | undefined;
  /** Registers or updates a rate; `true` when something changed. */
  set(resourceId: ResourceId, rate: { standard?: number; overtime?: number }): boolean;
  /** Removes an entry; `true` when one was removed. */
  remove(resourceId: ResourceId): boolean;
}

function usableId(v: unknown): v is ResourceId {
  return (typeof v === "string" && v !== "") || typeof v === "number";
}

/** Creates the rate store, loading usable config seed entries (unusable ones are dropped). */
export function createRateStore(seed: readonly CostRateInit[] | undefined): RateStore {
  const rates = new Map<ResourceId, CostRate>();

  function set(resourceId: ResourceId, rate: { standard?: number; overtime?: number }): boolean {
    if (!usableId(resourceId) || typeof rate !== "object" || rate === null) return false;
    const current = rates.get(resourceId);
    // A member-wise update: an unusable member keeps whatever the entry already carried.
    const standard = usableAmount(rate.standard) ? rate.standard : current?.standard;
    if (standard === undefined) return false;
    const overtime = usableAmount(rate.overtime) ? rate.overtime : current?.overtime;
    if (current?.standard === standard && current?.overtime === overtime) return false;
    const next: CostRate = overtime === undefined ? { standard } : { standard, overtime };
    rates.set(resourceId, next);
    return true;
  }

  if (Array.isArray(seed)) {
    for (const init of seed) {
      if (typeof init !== "object" || init === null) continue;
      if (init.resourceId !== undefined) set(init.resourceId, init);
    }
  }

  return {
    entries: () => new Map(rates),
    get: (resourceId) => rates.get(resourceId),
    set,
    remove: (resourceId) => rates.delete(resourceId),
  };
}

/** What `computeTaskCost` and the world are handed: one resource id in, its rates out. */
export type RateLookup = (resourceId: ResourceId) => CostRate | undefined;

/**
 * Builds §2.8's `rateOf`: master first, then the resource-pool `costRate` fallback.
 *
 * `resolvePool` is invoked FRESH on every call — the §8 "resolved per use, never latched into
 * variables at setup" rule. A pool that activates after this plugin's own `setup()`, or a
 * `costRate` edited after an earlier read, is therefore always seen.
 */
export function createRateResolver(
  rates: RateStore,
  // `Pick<ResourcePoolService, "get">`, not the whole service: this is the one member the cost
  // area consumes from the `resource-pool` plugin (see the module doc above), and it
  // is what a test double needs to implement — derived from the real, published type rather than
  // a hand-copied sibling shape.
  resolvePool: () => Pick<ResourcePoolService, "get"> | undefined,
): RateLookup {
  return (resourceId) => {
    const master = rates.get(resourceId);
    if (master !== undefined) return master;
    const pool = resolvePool();
    if (pool === undefined) return undefined;
    const costRate = pool.get(resourceId)?.costRate;
    return costRate === undefined ? undefined : { standard: costRate };
  };
}
