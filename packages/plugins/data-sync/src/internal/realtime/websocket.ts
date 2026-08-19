// docs/specs/plugins/data-sync.md §5.5
/**
 * WebSocket transport helper: maps a socket's events onto the transport handler interface and
 * decodes string frames as JSON. No reconnection of its own — the connection manager owns retry
 * policy (§5.3). Hostless.
 */
import type { RealtimeTransport, WebSocketLike, WebSocketTransportConfig } from "../../types";

/** Parses a JSON string, yielding `undefined` for anything unparsable or non-string. */
export function decodeFrame(data: unknown): unknown {
  if (typeof data !== "string") return undefined;
  try {
    return JSON.parse(data) as unknown;
  } catch {
    return undefined;
  }
}

/**
 * Creates a transport over a WebSocket connection to `config.url`, decoding each string frame as
 * one JSON message. Without a usable URL or WebSocket constructor (config-injected or the
 * platform global) the returned transport is inert and never opens.
 */
export function webSocketTransport(config?: WebSocketTransportConfig): RealtimeTransport {
  const cfg = config !== null && typeof config === "object" ? config : {};
  const url = typeof cfg.url === "string" && cfg.url !== "" ? cfg.url : undefined;
  const Ctor =
    typeof cfg.webSocket === "function"
      ? cfg.webSocket
      : (globalThis as { WebSocket?: new (url: string, protocols?: string | string[]) => WebSocketLike }).WebSocket;
  const protocols = typeof cfg.protocols === "string" || Array.isArray(cfg.protocols) ? cfg.protocols : undefined;

  let socket: WebSocketLike | undefined;
  return {
    connect(handlers) {
      if (url === undefined || typeof Ctor !== "function") return;
      const ws = protocols === undefined ? new Ctor(url) : new Ctor(url, protocols);
      socket = ws;
      ws.onopen = () => handlers.onOpen();
      // Binary frames (ArrayBuffer/Blob payloads) are intentionally dropped rather than parsed:
      // this transport only understands JSON text frames, so a non-string frame decodes to
      // `undefined` and is silently ignored instead of being surfaced as a message or an error.
      ws.onmessage = (event) => {
        const message = decodeFrame(event.data);
        if (message !== undefined) handlers.onMessage(message);
      };
      ws.onclose = (event) => {
        if (socket === ws) {
          socket = undefined;
          handlers.onClose(event);
        }
      };
      ws.onerror = (event) => {
        if (socket === ws) handlers.onError(event);
      };
    },
    disconnect() {
      const ws = socket;
      socket = undefined;
      if (ws !== undefined) ws.close();
    },
  };
}
