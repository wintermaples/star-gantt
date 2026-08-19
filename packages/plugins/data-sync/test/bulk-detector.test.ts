/**
 * §6.1 the bulk-replacement detector's normative reconciliation: a transaction cancelled in the
 * will phase produces no burst and no did-event — the will-event's own queued microtask must
 * still bring the bracket depth back to 0, so the NEXT bulk `data.tasks` notification is
 * classified correctly (never misread as "transactional", which would wrongly leave the pending
 * set / lazy bookkeeping untouched).
 */
import { describe, expect, it } from "vitest";
import type { AnyPlugin, PluginContext } from "@stargantt/core";
import { boot, task } from "./_helpers";

function bootWithCanceller() {
  const canceller: AnyPlugin = {
    meta: { id: "test.canceller", dependsOn: ["stargantt.data-store"] },
    setup(ctx: PluginContext): void {
      ctx.on("data/willApplyTransaction", (e) => {
        if (e.transaction.origin === "cancel-me") e.preventDefault();
      });
    },
  };
  return boot({}, { extraPlugins: [canceller] });
}

describe("bulk-replacement detector (§6.1) — cancelled-transaction microtask reconciliation", () => {
  it("a cancelled transaction does not leave the bracket depth stale for a bulk load right after it", async () => {
    const { ds, host } = bootWithCanceller();
    const data = host.host.service("stargantt.data");
    data.load({ tasks: [task("t1", 0, 1)] });
    host.host.dispatch("task/update", { id: "t1", after: { name: "Edited" } });
    expect(ds.pending().updates).toBe(1);

    // Cancelled in the will phase: no burst, no did-event. Without the will-event's own queued
    // microtask reset, the bracket depth would stay stuck at 1 (as if a transaction were still
    // "in flight"), and the bulk load below would be misclassified as transactional — leaving the
    // pending set (wrongly) untouched instead of cleared.
    host.host.dispatch("task/update", { id: "t1", after: { name: "Rejected" }, origin: "cancel-me" });
    expect(ds.pending().updates).toBe(1); // the cancelled dispatch itself touched nothing

    // Let the will-event's queued microtask run (resets depth to 0) before the bulk load.
    await Promise.resolve();
    await Promise.resolve();
    data.load({ tasks: [task("t2", 0, 1)] }); // bulk at depth 0 — must classify as bulk
    expect(ds.pending()).toEqual({ creates: 0, updates: 0, removes: 0 });
  });

  it("a bulk load in the SAME microtask turn as a cancelled transaction is still correctly classified", () => {
    // The apply flow is fully synchronous (will -> burst -> did, or will -> cancel, all on one
    // stack); the guarantee is that no bulk notification can ever occur ON THAT SAME STACK before
    // the cancelled transaction's dispatch call has returned — so by the time this dispatch()
    // synchronously returns, the SYNCHRONOUS part of the classification is already correct
    // (the microtask is a defense for a scenario that provably cannot occur here, but the
    // synchronous depth bookkeeping — incremented then never decremented by a did-event — is
    // exercised regardless).
    const { ds, host } = bootWithCanceller();
    const data = host.host.service("stargantt.data");
    data.load({ tasks: [task("t1", 0, 1)] });
    host.host.dispatch("task/update", { id: "t1", after: { name: "Cancelled" }, origin: "cancel-me" });
    data.load({ tasks: [task("t2", 0, 1)] }); // bulk, immediately after, same turn
    expect(data.query().byId.has("t2")).toBe(true);
    expect(data.query().byId.has("t1")).toBe(false); // the bulk load fully replaced the store
    expect(ds.pending()).toEqual({ creates: 0, updates: 0, removes: 0 });
  });

  it("an ordinary successful transaction between two bulk loads returns depth to 0 via didApplyTransaction (not only the microtask)", () => {
    const { ds, host } = boot();
    const data = host.host.service("stargantt.data");
    data.load({ tasks: [task("t1", 0, 1)] });
    host.host.dispatch("task/update", { id: "t1", after: { name: "Edited" } }); // succeeds normally
    expect(ds.pending().updates).toBe(1);
    data.load({ tasks: [task("t2", 0, 1)] }); // bulk, right after — depth must already be 0
    expect(ds.pending()).toEqual({ creates: 0, updates: 0, removes: 0 });
  });
});
