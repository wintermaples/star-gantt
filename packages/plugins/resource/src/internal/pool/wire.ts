// docs/specs/plugins/resource.md §3.1 / §3.2 — the resource-pool ledger.
/**
 * Entry point of the pool area: the entry/booking ledger, per-resource calendars and time off, the
 * three consistent-by-construction working-time surfaces (§1.1), and the optional one-way store
 * mirror of `pool.syncToStore`.
 *
 * The `stargantt.resource-pool` service is provided UNCONDITIONALLY (§6's presence rule: the two
 * services stay provided even with every nest omitted — the `pool` nest gates only the config seed
 * and the mirror), so the nest guard lives inside this function rather than at the call site.
 *
 * Publishes the pool as the shared `WorkingIntervalCache`'s source (`deps.bindIntervalSource`) and
 * owns that cache's one invalidation edge: wholesale, on every `resources` store notification
 * (§2.3 — a task edit cannot move working time; nothing else invalidates it). Service assembly
 * itself lives in `./service.ts` (`createPoolServiceHost`); this module only loads the config seed
 * (batched into at most one store write each — §6.1) and drives the `pool.syncToStore` mirror.
 */
import type { ResourceId } from "@stargantt/plugin-data-store";
import type { ResourceAreaDeps } from "../areas";
import { createPoolServiceHost } from "./service";
import { planSync } from "./sync";

/** Wires the pool area. */
export function wirePool(deps: ResourceAreaDeps): void {
  const { ctx, config, data } = deps;
  const pool = config.pool;
  const syncEnabled = pool?.syncToStore === true;
  let owned: ReadonlySet<ResourceId> = new Set();

  function sync(): void {
    if (!syncEnabled) return;
    const plan = planSync(host.entries.entries(), data.query().resources.values(), owned);
    owned = plan.owned;
    for (const step of plan.steps) {
      if (step.op === "add") {
        ctx.dispatch("resource/add", { resource: step.resource, origin: "stargantt.resource/pool-sync" });
      } else if (step.op === "update") {
        ctx.dispatch("resource/update", {
          id: step.id,
          after: step.after,
          origin: "stargantt.resource/pool-sync",
        });
      } else {
        ctx.dispatch("resource/remove", { ids: step.ids, origin: "stargantt.resource/pool-sync" });
      }
    }
  }

  // §3.1 — "reconciled after the seed load and after every entry mutation": the mirror rides the
  // same `onChanged` signal a config-time batch load uses, and the shared interval cache is
  // invalidated wholesale on that identical edge (§2.3).
  const host = createPoolServiceHost(() => {
    sync();
    deps.intervals.invalidate();
  });

  deps.bindIntervalSource(host.workingTimeSource);
  ctx.provide("stargantt.resource-pool", host.service);
  deps.bindResourcePool(host.service);

  /* --- §6.1 config seed: at most one `resources` write and one `bookings` write, at setup ---- */

  let anyEntryLoaded = false;
  for (const init of pool?.resources ?? []) {
    const result = host.entries.upsert(init);
    if (result !== undefined && result.changed) anyEntryLoaded = true;
  }
  let anyBookingLoaded = false;
  for (const init of pool?.bookings ?? []) {
    const id = host.bookingsLedger.book(init, (rid) => host.entries.has(rid));
    if (id !== undefined) anyBookingLoaded = true;
  }
  if (anyEntryLoaded) host.commitEntries();
  else deps.intervals.invalidate();
  if (anyBookingLoaded) host.commitBookings();

  if (syncEnabled) {
    // A store already populated when this plugin starts up must be reconciled too, seed or not.
    sync();
    // `ctx.on()` already auto-owns its own subscription (`packages/core/src/internal/context.ts`);
    // the `ctx.own()` wrap is stylistic consistency with the other `ctx.on` call sites across this
    // plugin's five areas, not a functional requirement.
    ctx.own(ctx.on("lifecycle/ready", () => sync()));
  }
}
