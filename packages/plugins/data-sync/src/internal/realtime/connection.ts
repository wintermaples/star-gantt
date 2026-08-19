// docs/specs/plugins/data-sync.md §5.2 / §5.3
/**
 * Single-owner connection state machine: at most one live transport session, epoch-guarded
 * callbacks (a superseded session cannot resurrect a closed connection), and capped automatic
 * reconnection with one swap-on-re-arm retry timer. Hostless — the plugin owns disposal and
 * translates `onStatus` into the `realtime.status` store (§5.2).
 */
import type { RealtimeStatus, RealtimeStatusCause, RealtimeTransport } from "../../types";

export interface ManagerOptions {
  autoReconnect: boolean;
  reconnectDelayMs: number;
  maxReconnectAttempts: number;
}

export interface ManagerCallbacks {
  onMessage(message: unknown): void;
  /**
   * `transport` names the channel the status applies to. For `close`/`disconnect` it names the
   * transport that just dropped, passed explicitly by the manager rather than read back through
   * `connectedTransport()` (which already reports `undefined` once the status is terminal).
   */
  onStatus(status: RealtimeStatus, cause: RealtimeStatusCause, transport: string | undefined): void;
  onError(where: string, error: unknown): void;
}

interface Session {
  name: string;
  transport: RealtimeTransport;
  closed: boolean;
}

function isTransport(value: unknown): value is RealtimeTransport {
  return (
    value !== null &&
    typeof value === "object" &&
    typeof (value as RealtimeTransport).connect === "function" &&
    typeof (value as RealtimeTransport).disconnect === "function"
  );
}

/** Reconnect delay is capped at this multiple of `reconnectDelayMs`. */
const BACKOFF_CAP_FACTOR = 30;
/** A live connection must stay open this long before the attempts counter resets. */
const STABLE_CONNECTION_MS = 30_000;

export class ConnectionManager {
  private readonly registry = new Map<string, RealtimeTransport>();
  private session: Session | undefined;
  private currentName: string | undefined;
  private statusValue: RealtimeStatus = "disconnected";
  private attempts = 0;
  private timer: ReturnType<typeof setTimeout> | undefined;
  // Separate timer from the reconnect `timer`: armed on `onOpen`, it resets `attempts` to 0 once
  // the connection has stayed open long enough to be considered stable. A flapping socket that
  // never stays open this long keeps accumulating attempts across reconnects, so it still
  // exhausts `maxReconnectAttempts` instead of retrying forever.
  private stableTimer: ReturnType<typeof setTimeout> | undefined;
  private disposed = false;

  constructor(
    private readonly opts: ManagerOptions,
    private readonly cb: ManagerCallbacks,
  ) {}

  registerTransport(name: string, transport: RealtimeTransport): void {
    if (typeof name !== "string" || name === "" || !isTransport(transport)) return;
    this.registry.set(name, transport);
  }

  transports(): string[] {
    return [...this.registry.keys()];
  }

  status(): RealtimeStatus {
    return this.statusValue;
  }

  connectedTransport(): string | undefined {
    return this.statusValue === "disconnected" ? undefined : this.currentName;
  }

  connect(name: string): boolean {
    if (this.disposed || !this.registry.has(name)) return false;
    this.disconnect();
    this.attempts = 0;
    this.currentName = name;
    this.open(name, "connect");
    return true;
  }

  disconnect(): void {
    this.cancelTimer();
    this.cancelStableTimer();
    const session = this.session;
    this.session = undefined;
    if (session !== undefined) {
      session.closed = true;
      try {
        session.transport.disconnect();
      } catch (error) {
        this.cb.onError("disconnect", error);
      }
    }
    const droppedName = this.currentName;
    this.currentName = undefined;
    if (this.statusValue !== "disconnected") this.setStatus("disconnected", "disconnect", droppedName);
  }

  /** Silently closes everything; no further status events. Called from the plugin's owned disposable. */
  dispose(): void {
    this.disposed = true;
    this.cancelTimer();
    this.cancelStableTimer();
    const session = this.session;
    this.session = undefined;
    if (session !== undefined) {
      session.closed = true;
      try {
        session.transport.disconnect();
      } catch {
        // Disposal is best-effort; the host is tearing the instance down.
      }
    }
  }

  private cancelTimer(): void {
    if (this.timer !== undefined) {
      clearTimeout(this.timer);
      this.timer = undefined;
    }
  }

  private cancelStableTimer(): void {
    if (this.stableTimer !== undefined) {
      clearTimeout(this.stableTimer);
      this.stableTimer = undefined;
    }
  }

  /**
   * Capped exponential backoff with full jitter: the nominal delay doubles per attempt up to a
   * cap of `BACKOFF_CAP_FACTOR × reconnectDelayMs`, and the actual delay is drawn uniformly from
   * `[0, nominal]`. `attempts` is 1 for the first retry.
   */
  private backoffDelay(attempts: number): number {
    const base = this.opts.reconnectDelayMs;
    const cap = base * BACKOFF_CAP_FACTOR;
    const nominal = Math.min(cap, base * 2 ** (attempts - 1));
    return Math.random() * nominal;
  }

  /**
   * `explicitTransport`, when supplied, is reported verbatim (used by the `close`/`disconnect`
   * terminal transitions, whose dropped transport is captured before `currentName` is cleared).
   * Otherwise the transport name falls back to `connectedTransport()`, which still resolves the
   * live/reconnecting name for non-terminal statuses.
   */
  private setStatus(status: RealtimeStatus, cause: RealtimeStatusCause, explicitTransport?: string): void {
    if (this.disposed) return;
    this.statusValue = status;
    const transport = explicitTransport !== undefined ? explicitTransport : this.connectedTransport();
    this.cb.onStatus(status, cause, transport);
  }

  private open(name: string, cause: RealtimeStatusCause): void {
    const transport = this.registry.get(name);
    if (transport === undefined) {
      this.currentName = undefined;
      this.setStatus("disconnected", "close", name);
      return;
    }
    const session: Session = { name, transport, closed: false };
    this.session = session;
    this.setStatus("connecting", cause);
    const guard = (): boolean => session.closed || this.session !== session || this.disposed;
    try {
      transport.connect({
        onOpen: () => {
          if (guard()) return;
          // The attempts counter is not reset here: a connection that opens and drops again right
          // away (flapping) must not get a fresh attempts budget every time, or it would retry
          // forever instead of exhausting `maxReconnectAttempts`. It resets only once
          // this session has stayed open for `STABLE_CONNECTION_MS`.
          this.cancelStableTimer();
          this.stableTimer = setTimeout(() => {
            this.stableTimer = undefined;
            if (guard()) return;
            this.attempts = 0;
          }, STABLE_CONNECTION_MS);
          this.setStatus("connected", "open");
        },
        onMessage: (message) => {
          if (guard()) return;
          this.cb.onMessage(message);
        },
        onClose: () => {
          if (guard()) return;
          session.closed = true;
          this.session = undefined;
          this.handleClose(name);
        },
        onError: (error) => {
          if (guard()) return;
          this.cb.onError("transport", error);
        },
      });
    } catch (error) {
      this.cb.onError("connect", error);
      session.closed = true;
      this.session = undefined;
      this.handleClose(name);
    }
  }

  private handleClose(name: string): void {
    if (this.disposed) return;
    this.cancelStableTimer();
    if (this.opts.autoReconnect && this.attempts < this.opts.maxReconnectAttempts) {
      this.attempts += 1;
      this.setStatus("connecting", "reconnect");
      // One retry timer at a time: re-arming swaps the variable, disposal clears the current one.
      this.cancelTimer();
      this.timer = setTimeout(() => {
        this.timer = undefined;
        if (this.disposed || this.session !== undefined) return;
        this.open(name, "reconnect");
      }, this.backoffDelay(this.attempts));
    } else {
      this.currentName = undefined;
      this.setStatus("disconnected", "close", name);
    }
  }
}
