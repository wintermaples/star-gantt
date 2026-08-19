/**
 * §5.5 the WebSocket and SSE transport factories.
 */
import { describe, expect, it } from "vitest";
import { sseTransport, webSocketTransport } from "../src/index";
import type { EventSourceLike, RealtimeTransportHandlers, WebSocketLike } from "../src/index";

function handlerLog(): { handlers: RealtimeTransportHandlers; log: string[] } {
  const log: string[] = [];
  const handlers: RealtimeTransportHandlers = {
    onOpen: () => log.push("open"),
    onMessage: (m) => log.push(`message:${JSON.stringify(m)}`),
    onClose: () => log.push("close"),
    onError: () => log.push("error"),
  };
  return { handlers, log };
}

class FakeSocket implements WebSocketLike {
  static last: FakeSocket | undefined;
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: unknown }) => void) | null = null;
  onclose: ((event: unknown) => void) | null = null;
  onerror: ((event: unknown) => void) | null = null;
  closed = false;
  constructor(
    public url: string,
    public protocols?: string | string[],
  ) {
    FakeSocket.last = this;
  }
  close(): void {
    this.closed = true;
  }
}

describe("webSocketTransport (§5.5)", () => {
  it("opens new WebSocket(url, protocols) and maps events; JSON.parse's each string frame", () => {
    const transport = webSocketTransport({ url: "wss://example.com", protocols: "v1", webSocket: FakeSocket });
    const { handlers, log } = handlerLog();
    transport.connect(handlers);
    const created = FakeSocket.last!;
    expect(created.url).toBe("wss://example.com");
    expect(created.protocols).toBe("v1");
    created.onopen?.();
    created.onmessage?.({ data: JSON.stringify({ type: "changes", changes: [] }) });
    expect(log).toEqual(["open", 'message:{"type":"changes","changes":[]}']);
  });

  it("an unparsable string frame is dropped silently; a binary frame is dropped too", () => {
    const transport = webSocketTransport({ url: "wss://x", webSocket: FakeSocket });
    const { handlers, log } = handlerLog();
    transport.connect(handlers);
    const created = FakeSocket.last!;
    created.onmessage?.({ data: "not json" });
    created.onmessage?.({ data: new ArrayBuffer(4) });
    expect(log).toEqual([]);
  });

  it("disconnect() closes the socket WITHOUT reporting a close", () => {
    const transport = webSocketTransport({ url: "wss://x", webSocket: FakeSocket });
    const { handlers, log } = handlerLog();
    transport.connect(handlers);
    const created = FakeSocket.last!;
    transport.disconnect();
    expect(created.closed).toBe(true);
    created.onclose?.({}); // the underlying socket fires its native close event anyway
    expect(log).toEqual([]); // must NOT surface as a close through the transport
  });

  it("without a usable url or constructor, the transport is inert: connect does nothing", () => {
    const transport = webSocketTransport({});
    const { handlers, log } = handlerLog();
    expect(() => transport.connect(handlers)).not.toThrow();
    expect(log).toEqual([]);
    expect(() => transport.disconnect()).not.toThrow();
  });

  it("performs no reconnection of its own — a close is reported once, verbatim", () => {
    const transport = webSocketTransport({ url: "wss://x", webSocket: FakeSocket });
    const { handlers, log } = handlerLog();
    transport.connect(handlers);
    FakeSocket.last!.onclose?.({ code: 1006 });
    expect(log).toEqual(["close"]);
  });
});

class FakeEventSource implements EventSourceLike {
  static last: FakeEventSource | undefined;
  readyState = 0;
  listeners = new Map<string, ((event: { data?: unknown }) => void)[]>();
  closed = false;
  constructor(
    public url: string,
    public init?: { withCredentials?: boolean },
  ) {
    FakeEventSource.last = this;
  }
  addEventListener(type: string, listener: (event: { data?: unknown }) => void): void {
    const list = this.listeners.get(type) ?? [];
    list.push(listener);
    this.listeners.set(type, list);
  }
  fire(type: string, event: { data?: unknown } = {}): void {
    for (const l of this.listeners.get(type) ?? []) l(event);
  }
  close(): void {
    this.closed = true;
  }
}

describe("sseTransport (§5.5)", () => {
  it("opens new EventSource(url, {withCredentials}) and listens for open/eventName/error", () => {
    const transport = sseTransport({ url: "https://example.com/stream", withCredentials: true, eventSource: FakeEventSource });
    const { handlers, log } = handlerLog();
    transport.connect(handlers);
    const created = FakeEventSource.last!;
    expect(created.url).toBe("https://example.com/stream");
    expect(created.init).toEqual({ withCredentials: true });
    created.fire("open");
    created.fire("message", { data: JSON.stringify({ type: "resync" }) });
    expect(log).toEqual(["open", 'message:{"type":"resync"}']);
  });

  it("a custom eventName is listened for instead of the default", () => {
    const transport = sseTransport({ url: "https://x", eventName: "task-update", eventSource: FakeEventSource });
    const { handlers, log } = handlerLog();
    transport.connect(handlers);
    const created = FakeEventSource.last!;
    created.fire("message", { data: JSON.stringify({ type: "resync" }) }); // default name — NOT listened
    created.fire("task-update", { data: JSON.stringify({ type: "resync" }) });
    expect(log).toEqual(['message:{"type":"resync"}']);
  });

  it("an error while readyState is CLOSED is reported as a close; otherwise it's a transient onError", () => {
    const transport = sseTransport({ url: "https://x", eventSource: FakeEventSource });
    const { handlers, log } = handlerLog();
    transport.connect(handlers);
    const created = FakeEventSource.last!;
    created.readyState = 1; // CONNECTING — transient
    created.fire("error", {});
    expect(log).toEqual(["error"]);
    created.readyState = 2; // CLOSED — terminal
    created.fire("error", {});
    expect(log).toEqual(["error", "close"]);
  });

  it("disconnect() closes the source without reporting a close", () => {
    const transport = sseTransport({ url: "https://x", eventSource: FakeEventSource });
    const { handlers, log } = handlerLog();
    transport.connect(handlers);
    const created = FakeEventSource.last!;
    transport.disconnect();
    expect(created.closed).toBe(true);
    created.fire("error", {}); // stale source's own events must not surface anymore
    expect(log).toEqual([]);
  });

  it("without a usable url or constructor, the transport is inert", () => {
    const transport = sseTransport({});
    const { handlers, log } = handlerLog();
    expect(() => transport.connect(handlers)).not.toThrow();
    expect(log).toEqual([]);
  });
});
