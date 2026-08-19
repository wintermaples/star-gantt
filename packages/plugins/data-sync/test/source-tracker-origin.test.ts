/**
 * §2.3 the change tracker: machine-origin exclusion (prefix rule), coalescing across repeated
 * edits, and the §6.1 bulk-replacement clear.
 */
import { describe, expect, it } from "vitest";
import { boot, scriptedAdapter, task } from "./_helpers";

describe("source area — pending-change tracker (§2.3)", () => {
  it("records non-machine-origin edits as pending, coalesced per task", () => {
    const { ds, host } = boot();
    const data = host.host.service("stargantt.data");
    data.load({ tasks: [task("t1", 0, 1)] });
    host.host.dispatch("task/update", { id: "t1", after: { name: "A" } });
    host.host.dispatch("task/update", { id: "t1", after: { name: "B" } }); // coalesces
    expect(ds.pending()).toEqual({ creates: 0, updates: 1, removes: 0 });
  });

  it("does NOT record a transaction whose origin carries the machine prefix (echo-loop prevention)", () => {
    const { ds, host } = boot();
    const data = host.host.service("stargantt.data");
    data.load({ tasks: [task("t1", 0, 1)] });
    host.host.dispatch("task/update", { id: "t1", after: { name: "Machine" }, origin: "stargantt.data-sync/sync" });
    expect(ds.pending()).toEqual({ creates: 0, updates: 0, removes: 0 });
  });

  it("DOES record a transaction from an unrelated custom origin (positive control for the prefix test)", () => {
    const { ds, host } = boot();
    const data = host.host.service("stargantt.data");
    data.load({ tasks: [task("t1", 0, 1)] });
    host.host.dispatch("task/update", { id: "t1", after: { name: "Imported" }, origin: "import" });
    expect(ds.pending()).toEqual({ creates: 0, updates: 1, removes: 0 });
  });

  it("a bulk replacement (DataService.load()) clears the pending set (§6.1)", () => {
    const { ds, host } = boot();
    const data = host.host.service("stargantt.data");
    data.load({ tasks: [task("t1", 0, 1)] });
    host.host.dispatch("task/update", { id: "t1", after: { name: "Edited" } });
    expect(ds.pending().updates).toBe(1);
    data.load({ tasks: [task("t2", 0, 1)] }); // bulk replacement, no transaction
    expect(ds.pending()).toEqual({ creates: 0, updates: 0, removes: 0 });
  });

  it("materializeChildren() (also a bulk path) clears the pending set", () => {
    const { ds, host } = boot();
    const data = host.host.service("stargantt.data");
    data.load({
      tasks: [task("parent", 0, 5, { type: "summary" })],
      deferredTasks: [{ parentId: "parent", rows: [task("child", 0, 1)] }],
    });
    host.host.dispatch("task/update", { id: "parent", after: { name: "Edited" } });
    expect(ds.pending().updates).toBe(1);
    data.materializeChildren("parent");
    expect(ds.pending()).toEqual({ creates: 0, updates: 0, removes: 0 });
  });

  it("create-then-remove locally cancels out (nothing pending, nothing to push)", async () => {
    const { ds, host, adapter } = await seededWithPush();
    host.host.dispatch("task/add", { task: { id: "new", name: "New" } });
    expect(ds.pending()).toEqual({ creates: 1, updates: 0, removes: 0 });
    host.host.dispatch("task/remove", { ids: ["new"] });
    expect(ds.pending()).toEqual({ creates: 0, updates: 0, removes: 0 });
    await ds.flush();
    expect(adapter.pushCalls.length).toBe(0); // nothing was pending, so flush() called nothing
  });
});

async function seededWithPush() {
  const h = boot();
  const adapter = scriptedAdapter();
  adapter.nextFetch = { tasks: [task("t1", 0, 1)], syncToken: "tok" };
  h.ds.sources.register("a", adapter);
  h.ds.sources.activate("a");
  await h.ds.load();
  return { ...h, adapter };
}
