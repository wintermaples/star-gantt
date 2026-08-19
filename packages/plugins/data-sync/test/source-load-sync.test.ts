/**
 * §2.1 `load()` (full snapshot) and §2.2 `sync()` (delta / fallback-to-full), plus the source
 * registry's unusable-argument silence and same-named-replace rules.
 */
import { describe, expect, it } from "vitest";
import { boot, DAY, scriptedAdapter, task } from "./_helpers";

describe("source area — registry", () => {
  it("register/activate/names/active follow unusable-argument silence", () => {
    const { ds } = boot();
    const a = scriptedAdapter();
    ds.sources.register("", a); // empty name — ignored
    ds.sources.register("x", {} as never); // no fetch — ignored
    expect(ds.sources.names()).toEqual([]);
    ds.sources.register("a", a);
    expect(ds.sources.names()).toEqual(["a"]);
    expect(ds.sources.activate("missing")).toBe(false);
    expect(ds.sources.activate("a")).toBe(true);
    expect(ds.sources.active()).toBe("a");
  });

  it("a same-named registration replaces the adapter without reordering names()", () => {
    const { ds } = boot();
    const a1 = scriptedAdapter();
    const a2 = scriptedAdapter();
    ds.sources.register("b", scriptedAdapter());
    ds.sources.register("a", a1);
    ds.sources.register("a", a2); // replace, same position
    expect(ds.sources.names()).toEqual(["b", "a"]);
    ds.sources.activate("a");
    void ds.load();
    expect(a2.fetchCalls.length).toBe(1);
    expect(a1.fetchCalls.length).toBe(0);
  });
});

describe("source area — load()", () => {
  it("replaces the store, clears the sync token slot default, and reports the loaded count", async () => {
    const { ds, host, collected } = boot();
    const adapter = scriptedAdapter({ delta: false, push: false });
    adapter.nextFetch = { tasks: [task("t1", 0, 1), task("t2", 1, 1)], syncToken: "tok-1" };
    ds.sources.register("a", adapter);
    ds.sources.activate("a");
    const result = await ds.load();
    expect(result).toEqual({ ok: true, tasks: 2 });
    const data = host.host.service("stargantt.data");
    expect(data.query().byId.size).toBe(2);
    expect(collected.synced).toEqual([
      { source: "a", mode: "full", applied: { added: 2, updated: 0, removed: 0 } },
    ]);
  });

  it("forwards links/resources/assignments and passes the mapping through to DataService.load() (§2.1)", async () => {
    const { ds, host } = boot();
    const adapter = scriptedAdapter({ delta: false, push: false });
    adapter.nextFetch = {
      // Raw task rows use `title`, not `name` — only reachable if the mapping is genuinely
      // forwarded into `DataService.load()`, not merely accepted and dropped.
      tasks: [{ id: "t1", title: "Raw Title", start: 0, end: DAY }],
      links: [{ id: "l1", sourceId: "t1", targetId: "t1", type: "FS" }],
      resources: [{ id: "r1", name: "Alice" }],
      assignments: [{ taskId: "t1", resourceId: "r1", units: 1 }],
      mapping: { task: { name: "title" } },
    };
    ds.sources.register("a", adapter);
    ds.sources.activate("a");
    const result = await ds.load();
    expect(result.ok).toBe(true);
    const data = host.host.service("stargantt.data");
    expect(data.getTask("t1")?.name).toBe("Raw Title"); // the mapping was actually applied
    const json = data.toJSON();
    expect(json.links).toEqual([expect.objectContaining({ sourceId: "t1", targetId: "t1", type: "FS" })]);
    expect(json.resources).toEqual([expect.objectContaining({ name: "Alice" })]);
    expect(json.assignments).toEqual([expect.objectContaining({ taskId: "t1", resourceId: "r1", units: 1 })]);
  });

  it("links/resources/assignments absent from the reply are simply omitted (no forwarding of undefined/non-array values)", async () => {
    const { ds, host } = boot();
    const adapter = scriptedAdapter({ delta: false, push: false });
    adapter.nextFetch = { tasks: [task("t1", 0, 1)] }; // no links/resources/assignments at all
    ds.sources.register("a", adapter);
    ds.sources.activate("a");
    await ds.load();
    const json = host.host.service("stargantt.data").toJSON();
    expect(json.links).toEqual([]);
    expect(json.resources).toEqual([]);
    expect(json.assignments).toEqual([]);
  });

  it("a result without a tasks array resolves ok:false and leaves the store untouched", async () => {
    const { ds, host } = boot();
    const adapter = scriptedAdapter({ delta: false, push: false });
    // @ts-expect-error deliberately malformed for the test
    adapter.nextFetch = { notTasks: [] };
    ds.sources.register("a", adapter);
    ds.sources.activate("a");
    const data = host.host.service("stargantt.data");
    data.load({ tasks: [task("seed", 0, 1)] });
    const result = await ds.load();
    expect(result.ok).toBe(false);
    expect(data.query().byId.size).toBe(1); // untouched
  });

  it("no active source resolves ok:false without calling anything", async () => {
    const { ds } = boot();
    expect(await ds.load()).toEqual({ ok: false });
  });
});

describe("source area — sync()", () => {
  it("falls back to a full load when no sync token is held yet", async () => {
    const { ds } = boot();
    const adapter = scriptedAdapter();
    adapter.nextFetch = { tasks: [task("t1", 0, 1)] }; // no syncToken in the reply either
    ds.sources.register("a", adapter);
    ds.sources.activate("a");
    const result = await ds.sync();
    expect(result).toEqual({ ok: true, mode: "full" });
    expect(adapter.fetchCalls.length).toBe(1);
    expect(adapter.deltaCalls.length).toBe(0);
  });

  it("falls back to a full load when the adapter has no fetchDelta", async () => {
    const { ds } = boot();
    const adapter = scriptedAdapter({ delta: false });
    adapter.nextFetch = { tasks: [task("t1", 0, 1)], syncToken: "tok" };
    ds.sources.register("a", adapter);
    ds.sources.activate("a");
    await ds.load(); // establishes a token, but the adapter still has no fetchDelta
    const result = await ds.sync();
    expect(result.mode).toBe("full");
  });

  it("applies a delta: add/update/remove, converge-exactly clearing of dropped optional fields", async () => {
    const { ds, host, collected } = boot();
    const adapter = scriptedAdapter();
    adapter.nextFetch = { tasks: [task("keep", 0, 1, { progress: 0.5 })], syncToken: "tok-1" };
    ds.sources.register("a", adapter);
    ds.sources.activate("a");
    await ds.load();

    adapter.nextDelta = {
      syncToken: "tok-2",
      changes: [
        { type: "upsert", task: task("new", 5, 1) },
        // "keep"'s row here drops `progress` — must be cleared, not left stale.
        { type: "upsert", task: { id: "keep", parentId: null, name: "Keep", start: 0, end: DAY } },
      ],
    };
    const result = await ds.sync();
    expect(result.ok).toBe(true);
    expect(result.mode).toBe("delta");
    expect(result.applied).toEqual({ added: 1, updated: 1, removed: 0 });

    const data = host.host.service("stargantt.data");
    expect(data.getTask("new")).toBeDefined();
    expect(data.getTask("keep")?.progress).toBeUndefined();
    expect(collected.synced.at(-1)).toMatchObject({ source: "a", mode: "delta" });

    // A second sync uses the advanced token.
    adapter.nextDelta = { syncToken: "tok-3", changes: [{ type: "remove", id: "new" }] };
    const second = await ds.sync();
    expect(second.applied).toEqual({ added: 0, updated: 0, removed: 1 });
    expect(adapter.deltaCalls[1]?.syncToken).toBe("tok-2");
    expect(data.getTask("new")).toBeUndefined();
  });

  it("no active source resolves ok:false", async () => {
    const { ds } = boot();
    expect(await ds.sync()).toEqual({ ok: false });
  });
});

