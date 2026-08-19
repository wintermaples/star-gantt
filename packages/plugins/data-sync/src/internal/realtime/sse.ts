// docs/specs/plugins/data-sync.md §5.5
/**
 * Server-Sent-Events transport helper: maps an EventSource's events onto the transport handler
 * interface and decodes event data as JSON. The source's native retry is left running; only a
 * terminally closed source is reported as a close. Hostless.
 */
import type { EventSourceLike, RealtimeTransport, SseTransportConfig } from "../../types";
import { decodeFrame } from "./websocket";

/** `EventSource.CLOSED` — referenced numerically so the module needs no platform global. */
const CLOSED = 2;

/**
 * Creates a transport over a Server-Sent-Events stream at `config.url`, decoding the data of each
 * event of the configured name (default `"message"`) as one JSON message. Without a usable URL or
 * EventSource constructor (config-injected or the platform global) the returned transport is
 * inert and never opens.
 */
export function sseTransport(config?: SseTransportConfig): RealtimeTransport {
  const cfg = config !== null && typeof config === "object" ? config : {};
  const url = typeof cfg.url === "string" && cfg.url !== "" ? cfg.url : undefined;
  const Ctor =
    typeof cfg.eventSource === "function"
      ? cfg.eventSource
      : (globalThis as { EventSource?: new (url: string, init?: { withCredentials?: boolean }) => EventSourceLike })
          .EventSource;
  const eventName = typeof cfg.eventName === "string" && cfg.eventName !== "" ? cfg.eventName : "message";

  let source: EventSourceLike | undefined;
  return {
    connect(handlers) {
      if (url === undefined || typeof Ctor !== "function") return;
      const es = new Ctor(url, { withCredentials: cfg.withCredentials === true });
      source = es;
      es.addEventListener("open", () => handlers.onOpen());
      es.addEventListener(eventName, (event) => {
        const message = decodeFrame(event.data);
        if (message !== undefined) handlers.onMessage(message);
      });
      es.addEventListener("error", (event) => {
        if (source !== es) return;
        if (es.readyState === CLOSED) {
          // Terminal failure: the source will not retry by itself; hand over to the plugin.
          source = undefined;
          handlers.onClose(event);
        } else {
          // Transient: the source's native retry keeps running.
          handlers.onError(event);
        }
      });
    },
    disconnect() {
      const es = source;
      source = undefined;
      if (es !== undefined) es.close();
    },
  };
}
