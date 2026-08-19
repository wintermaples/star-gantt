/**
 * §5.1 the message pipeline (converge-exactly + `orderKey` exception + echo suppression) and §5.4
 * resync delegation.
 */
import { describe, expect, it } from "vitest";
import { boot, scriptedAdapter, scriptedTransport, task } from "./_helpers";

describe("realtime area — the message pipeline (§5.1)", () => {
  it("applies a changes message: converge-exactly add/update/remove, machine origin", () => {
    const { ds, host, collected } = boot();
    const data = host.host.service("stargantt.data");
    data.load({ tasks: [task("keep", 0, 1, { progress: 0.5 })] });
    const transport = scriptedTransport();
    ds.realtime.transports.register("ws", transport);
    ds.realtime.connect("ws");
    transport.open();

    transport.push({
      type: "changes",
      changes: [
        { type: "upsert", task: task("new", 5, 1) },
        // "keep"'s row drops `progress` — converge-exactly clears it (unlike lazy's minimal merge).
        { type: "upsert", task: { id: "keep", parentId: null, name: "Keep", start: 0, end: 86_400_000 } },
      ],
    });
    expect(data.getTask("new")).toBeDefined();
    expect(data.getTask("keep")?.progress).toBeUndefined();
    expect(collected.realtimeApplied).toEqual([{ applied: { added: 1, updated: 1, removed: 0 }, transport: "ws" }]);
    // Machine origin: not queued as a pending local change (§2.3).
    expect(ds.pending()).toEqual({ creates: 0, updates: 0, removes: 0 });
  });

  it("the orderKey exception: a pushed row lacking orderKey never clears it (unlike a full snapshot row)", () => {
    const { ds, host } = boot();
    const data = host.host.service("stargantt.data");
    data.load({ tasks: [task("t1", 0, 1, { orderKey: "a0" })] });
    const transport = scriptedTransport();
    ds.realtime.transports.register("ws", transport);
    ds.realtime.connect("ws");
    transport.open();
    transport.push({
      type: "changes",
      changes: [{ type: "upsert", task: { id: "t1", parentId: null, name: "Renamed", start: 0, end: 86_400_000 } }],
    });
    expect(data.getTask("t1")?.orderKey).toBe("a0"); // preserved
    expect(data.getTask("t1")?.name).toBe("Renamed");
  });

  it("orderKey DOES apply when the pushed row carries it (positive control for the exception)", () => {
    const { ds, host } = boot();
    const data = host.host.service("stargantt.data");
    data.load({ tasks: [task("t1", 0, 1, { orderKey: "a0" })] });
    const transport = scriptedTransport();
    ds.realtime.transports.register("ws", transport);
    ds.realtime.connect("ws");
    transport.open();
    transport.push({
      type: "changes",
      changes: [{ type: "upsert", task: { id: "t1", parentId: null, name: "t1", start: 0, end: 86_400_000, orderKey: "z9" } }],
    });
    expect(data.getTask("t1")?.orderKey).toBe("z9");
  });

  it("echo suppression: an upsert value-identical to the current task dispatches nothing (zero-count report)", () => {
    const { ds, host, collected } = boot();
    const data = host.host.service("stargantt.data");
    data.load({ tasks: [task("t1", 0, 1)] });
    const transport = scriptedTransport();
    ds.realtime.transports.register("ws", transport);
    ds.realtime.connect("ws");
    transport.open();
    const current = data.getTask("t1")!;
    transport.push({
      type: "changes",
      changes: [{ type: "upsert", task: { id: "t1", parentId: current.parentId, name: current.name, start: current.start, end: current.end } }],
    });
    expect(collected.realtimeApplied).toEqual([{ applied: { added: 0, updated: 0, removed: 0 }, transport: "ws" }]);
  });

  it("echo suppression is VALUE-level: a concurrent foreign edit to the same task still applies (positive control)", () => {
    const { ds, host, collected } = boot();
    const data = host.host.service("stargantt.data");
    data.load({ tasks: [task("t1", 0, 1)] });
    const transport = scriptedTransport();
    ds.realtime.transports.register("ws", transport);
    ds.realtime.connect("ws");
    transport.open();
    transport.push({
      type: "changes",
      changes: [{ type: "upsert", task: { id: "t1", parentId: null, name: "Concurrent Edit", start: 0, end: 86_400_000 } }],
    });
    expect(data.getTask("t1")?.name).toBe("Concurrent Edit");
    expect(collected.realtimeApplied).toEqual([{ applied: { added: 0, updated: 1, removed: 0 }, transport: "ws" }]);
  });

  it("a remove of an unknown id is a no-op", () => {
    const { ds, collected } = boot();
    const transport = scriptedTransport();
    ds.realtime.transports.register("ws", transport);
    ds.realtime.connect("ws");
    transport.open();
    transport.push({ type: "changes", changes: [{ type: "remove", id: "unknown" }] });
    expect(collected.realtimeApplied).toEqual([{ applied: { added: 0, updated: 0, removed: 0 }, transport: "ws" }]);
  });

  it("an unrecognized message (non-object, unknown type, non-array changes) is silently ignored", () => {
    const { ds, collected } = boot();
    const transport = scriptedTransport();
    ds.realtime.transports.register("ws", transport);
    ds.realtime.connect("ws");
    transport.open();
    transport.push(null);
    transport.push({ type: "ping" });
    transport.push({ type: "changes", changes: "not-an-array" });
    expect(collected.realtimeApplied).toEqual([]);
  });

  it("applyMessage() is directly callable and returns the same result the transport path would", () => {
    const { ds, host } = boot();
    const data = host.host.service("stargantt.data");
    data.load({ tasks: [] });
    const result = ds.realtime.applyMessage({ type: "changes", changes: [{ type: "upsert", task: task("t1", 0, 1) }] });
    expect(result).toEqual({ applied: { added: 1, updated: 0, removed: 0 }, resync: false });
  });

  it("a throw inside message application is contained; the connection stays up", () => {
    const { ds, collected } = boot({ realtime: { transports: {} } });
    const transport = scriptedTransport();
    ds.realtime.transports.register("ws", transport);
    ds.realtime.connect("ws");
    transport.open();
    // A malformed "changes" entry whose `task` is a getter that throws.
    transport.push({
      type: "changes",
      changes: [
        {
          type: "upsert",
          get task() {
            throw new Error("boom");
          },
        },
      ],
    });
    expect(collected.errors.length).toBe(1);
    expect(ds.realtime.status.get().status).toBe("connected"); // still up
  });
});

describe("realtime area — resync delegation (§5.4)", () => {
  it("resyncViaDataSource (default true) triggers sync() when a source is active; reports resync:true regardless", async () => {
    const { ds } = boot();
    const adapter = scriptedAdapter();
    adapter.nextFetch = { tasks: [task("t1", 0, 1)], syncToken: "tok" };
    ds.sources.register("a", adapter);
    ds.sources.activate("a");
    const transport = scriptedTransport();
    ds.realtime.transports.register("ws", transport);
    ds.realtime.connect("ws");
    transport.open();
    const result = ds.realtime.applyMessage({ type: "resync" });
    expect(result).toEqual({ applied: { added: 0, updated: 0, removed: 0 }, resync: true });
    await Promise.resolve();
    await Promise.resolve();
    expect(adapter.fetchCalls.length).toBe(1); // sync() fell back to a full load (no token yet)
  });

  it("without an active source, resync is ignored (but still reports resync:true)", () => {
    const { ds } = boot();
    const transport = scriptedTransport();
    ds.realtime.transports.register("ws", transport);
    ds.realtime.connect("ws");
    transport.open();
    const result = ds.realtime.applyMessage({ type: "resync" });
    expect(result.resync).toBe(true);
  });

  it("resyncViaDataSource: false ignores the message entirely (no sync() call), still resync:true", async () => {
    const { ds } = boot({ realtime: { resyncViaDataSource: false } });
    const adapter = scriptedAdapter();
    ds.sources.register("a", adapter);
    ds.sources.activate("a");
    const result = ds.realtime.applyMessage({ type: "resync" });
    expect(result.resync).toBe(true);
    await Promise.resolve();
    expect(adapter.fetchCalls.length).toBe(0);
  });

  it("coalesces bursts: an in-flight resync's trailing requests collapse into exactly one rerun", async () => {
    const { ds } = boot();
    const adapter = scriptedAdapter({ delta: false, push: false });
    let resolveFetch: (() => void) | undefined;
    let fetchCount = 0;
    adapter.fetch = () => {
      fetchCount += 1;
      return new Promise((resolve) => {
        resolveFetch = () => resolve({ tasks: [] });
      });
    };
    ds.sources.register("a", adapter);
    ds.sources.activate("a");
    ds.realtime.applyMessage({ type: "resync" }); // starts sync #1
    ds.realtime.applyMessage({ type: "resync" }); // queued as ONE trailing rerun
    ds.realtime.applyMessage({ type: "resync" }); // coalesces into the same trailing slot
    await Promise.resolve();
    expect(fetchCount).toBe(1);
    resolveFetch?.(); // settles sync #1, triggers the trailing rerun
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    expect(fetchCount).toBe(2); // exactly one rerun, not three
    resolveFetch?.();
  });
});
