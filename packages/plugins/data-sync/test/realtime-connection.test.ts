/**
 * §5.2 connection lifecycle (the `realtime.status` store) and §5.3 reconnection (capped
 * exponential backoff with full jitter, the stability window). The store-shaped status replaces
 * the abolished `realtime/statusChanged` event.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { boot, scriptedTransport } from "./_helpers";

beforeEach(() => {
  vi.useFakeTimers();
  // Full jitter draws the actual delay uniformly from [0, nominal]; pin it to the
  // nominal ceiling so `advanceTimersByTime` assertions stay deterministic.
  vi.spyOn(Math, "random").mockReturnValue(1);
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

function statuses(ds: ReturnType<typeof boot>["ds"]) {
  const log: unknown[] = [];
  ds.realtime.status.subscribe((next) => log.push(next));
  return log;
}

describe("realtime area — connection lifecycle, the status store (§5.2)", () => {
  it("the initial value is {status:'disconnected'} with no cause", () => {
    const { ds } = boot();
    expect(ds.realtime.status.get()).toEqual({ status: "disconnected" });
  });

  it("walks connect -> connecting -> connected and reports the transport", () => {
    const { ds } = boot();
    const transport = scriptedTransport();
    ds.realtime.transports.register("ws", transport);
    const log = statuses(ds);
    ds.realtime.connect("ws");
    expect(ds.realtime.status.get()).toEqual({ status: "connecting", cause: "connect", transport: "ws" });
    transport.open();
    expect(ds.realtime.status.get()).toEqual({ status: "connected", cause: "open", transport: "ws" });
    expect(log).toEqual([
      { status: "connecting", cause: "connect", transport: "ws" },
      { status: "connected", cause: "open", transport: "ws" },
    ]);
  });

  it("connect() returns false for an unregistered name and changes nothing", () => {
    const { ds } = boot();
    ds.realtime.transports.register("", scriptedTransport()); // empty name — ignored
    ds.realtime.transports.register("bad", { connect: "nope" } as never); // no connect/disconnect — ignored
    expect(ds.realtime.transports.names()).toEqual([]);
    expect(ds.realtime.connect("nowhere")).toBe(false);
    expect(ds.realtime.status.get().status).toBe("disconnected");
  });

  it("disconnect() closes the live connection and suppresses automatic reconnection until the next connect()", () => {
    const { ds } = boot();
    const transport = scriptedTransport();
    ds.realtime.transports.register("ws", transport);
    ds.realtime.connect("ws");
    transport.open();
    ds.realtime.disconnect();
    expect(ds.realtime.status.get()).toEqual({ status: "disconnected", cause: "disconnect", transport: "ws" });
    expect(transport.disconnectCalls).toBe(1);
    vi.advanceTimersByTime(100_000);
    expect(transport.connectCalls).toBe(1); // no reconnect attempt was scheduled
  });

  it("connect() while another connection is live first closes it (disconnect-cause) and resets attempts", () => {
    const { ds } = boot();
    const a = scriptedTransport();
    const b = scriptedTransport();
    ds.realtime.transports.register("a", a);
    ds.realtime.transports.register("b", b);
    ds.realtime.connect("a");
    a.open();
    ds.realtime.connect("b");
    expect(a.disconnectCalls).toBe(1);
    expect(ds.realtime.status.get()).toEqual({ status: "connecting", cause: "connect", transport: "b" });
  });

  it("replacing the currently connected transport in the registry does not affect the live connection", () => {
    const { ds } = boot();
    const a1 = scriptedTransport();
    const a2 = scriptedTransport();
    ds.realtime.transports.register("a", a1);
    ds.realtime.connect("a");
    a1.open();
    ds.realtime.transports.register("a", a2); // replace
    expect(ds.realtime.status.get().status).toBe("connected");
    expect(a2.connectCalls).toBe(0);
  });

  it("a throw inside transport.connect() is reported and treated as a close", () => {
    const { ds, collected } = boot();
    const transport = scriptedTransport();
    transport.connectError = new Error("boom");
    ds.realtime.transports.register("a", transport);
    ds.realtime.connect("a");
    expect(collected.errors.length).toBe(1);
    // autoReconnect (default true) schedules a retry after the close.
    expect(ds.realtime.status.get().status).toBe("connecting");
  });
});

describe("realtime area — reconnection (§5.3)", () => {
  it("reconnects after an unexpected close with exponential backoff, doubling per attempt", () => {
    const { ds } = boot({ realtime: { reconnectDelayMs: 500 } });
    const transport = scriptedTransport();
    ds.realtime.transports.register("ws", transport);
    ds.realtime.connect("ws");
    transport.open();
    transport.close();
    expect(ds.realtime.status.get().status).toBe("connecting");
    expect(ds.realtime.status.get().cause).toBe("reconnect");
    expect(transport.connectCalls).toBe(1);
    vi.advanceTimersByTime(500); // attempt 1: nominal = base
    expect(transport.connectCalls).toBe(2);
    transport.close(); // never stayed open — attempts is not reset
    vi.advanceTimersByTime(999);
    expect(transport.connectCalls).toBe(2);
    vi.advanceTimersByTime(1); // attempt 2: nominal = 2 * base = 1000
    expect(transport.connectCalls).toBe(3);
  });

  it("caps the backoff at 30× reconnectDelayMs — doubling does not grow unbounded (§5.3)", () => {
    const { ds } = boot({ realtime: { reconnectDelayMs: 100, maxReconnectAttempts: 20 } });
    const transport = scriptedTransport();
    ds.realtime.transports.register("ws", transport);
    ds.realtime.connect("ws");
    transport.open();
    transport.close(); // -> retry 1 scheduled, nominal = base = 100
    // nominal = min(30*base, base*2^(n-1)): 100, 200, 400, 800, 1600, then capped at 3000 forever
    // (attempt 6's uncapped value would be 3200, which already exceeds the 3000 cap).
    const nominalDelays = [100, 200, 400, 800, 1600, 3000, 3000, 3000];
    let calls = transport.connectCalls; // 1 (the initial connect() above)
    for (const nominal of nominalDelays) {
      vi.advanceTimersByTime(nominal - 1);
      expect(transport.connectCalls).toBe(calls); // not yet — below this attempt's (possibly capped) delay
      vi.advanceTimersByTime(1);
      calls += 1;
      expect(transport.connectCalls).toBe(calls);
      transport.close(); // never stays open — schedules the next retry
    }
  });

  it("resets the attempts counter only after the stability window (§5.3)", () => {
    const { ds } = boot({ realtime: { reconnectDelayMs: 500 } });
    const transport = scriptedTransport();
    ds.realtime.transports.register("ws", transport);
    ds.realtime.connect("ws");
    transport.open();
    vi.advanceTimersByTime(30_000); // the stability window elapses — attempts resets to 0
    transport.close();
    vi.advanceTimersByTime(500); // attempt 1 again: nominal = base (not doubled)
    expect(transport.connectCalls).toBe(2);
  });

  it("a flapping connection (never stable) keeps accumulating attempts and exhausts the budget", () => {
    const { ds, collected } = boot({ realtime: { reconnectDelayMs: 100, maxReconnectAttempts: 3 } });
    const transport = scriptedTransport();
    ds.realtime.transports.register("ws", transport);
    ds.realtime.connect("ws");
    transport.close(); // close 1 -> retry 1 (nominal 100)
    for (let i = 0; i < 3; i += 1) {
      vi.advanceTimersByTime(3000); // capped nominal ceiling; uncapped growth would exceed this
      transport.close(); // never opens — always flaps immediately
    }
    expect(ds.realtime.status.get()).toEqual({ status: "disconnected", cause: "close", transport: "ws" });
    expect(collected.errors).toEqual([]); // exhaustion itself is not a fault
  });

  it("reconnectDelayMs: 0 always retries on the next macrotask", () => {
    const { ds } = boot({ realtime: { reconnectDelayMs: 0 } });
    const transport = scriptedTransport();
    ds.realtime.transports.register("ws", transport);
    ds.realtime.connect("ws");
    transport.open();
    transport.close();
    expect(transport.connectCalls).toBe(1);
    vi.advanceTimersByTime(0);
    expect(transport.connectCalls).toBe(2);
  });

  it("autoReconnect: false — with a close, immediately disconnected with cause close", () => {
    const { ds } = boot({ realtime: { autoReconnect: false } });
    const transport = scriptedTransport();
    ds.realtime.transports.register("ws", transport);
    ds.realtime.connect("ws");
    transport.open();
    transport.close();
    expect(ds.realtime.status.get()).toEqual({ status: "disconnected", cause: "close", transport: "ws" });
  });

  it("disconnect() and disposal cancel any pending retry", () => {
    const { ds, host } = boot({ realtime: { reconnectDelayMs: 500 } });
    const transport = scriptedTransport();
    ds.realtime.transports.register("ws", transport);
    ds.realtime.connect("ws");
    transport.open();
    transport.close();
    host.dispose();
    vi.advanceTimersByTime(100_000);
    expect(transport.connectCalls).toBe(1); // the scheduled retry never ran
  });
});
