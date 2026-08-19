import type { Disposable, Events } from "../index";
import type { EventBus } from "./kernel";

// docs/specs/architecture.md §1.4
/**
 * Re-emit during emit is allowed; the emit that would *reach* nesting depth 32 throws
 * (loop detection), so at most 31 emits are ever in flight. Internal constant, not exported.
 */
const LIMIT = 32;

interface Sub {
  owner: string | null;
  fn: (e: unknown) => void;
  disposed: boolean;
}

export class EventBusImpl implements EventBus {
  private _subs = new Map<string, Sub[]>();
  private _depth = 0;
  private _inFault = false;
  private _cleared = false;

  on<K extends keyof Events>(
    ownerPluginId: string | null,
    key: K,
    fn: (e: Events[K]) => void,
  ): Disposable {
    // docs/specs/architecture.md §1.4 — post-dispose on() registers nothing and
    // hands back an inert Disposable.
    if (this._cleared) return { dispose(): void {} };
    const k = key as unknown as string;
    const existing = this._subs.get(k);
    const list = existing ?? [];
    if (!existing) this._subs.set(k, list);
    const sub: Sub = { owner: ownerPluginId, fn: fn as (e: unknown) => void, disposed: false };
    list.push(sub);
    return {
      dispose(): void {
        if (sub.disposed) return;
        sub.disposed = true;
        const i = list.indexOf(sub);
        if (i >= 0) list.splice(i, 1);
      },
    };
  }

  emit<K extends keyof Events>(key: K, e: Events[K]): void {
    const k = key as unknown as string;
    if (this._depth >= LIMIT - 1) {
      throw new Error(`stargantt: event recursion depth ${LIMIT} reached while emitting "${k}"`);
    }
    this._depth++;
    try {
      this._deliver(k, e);
    } finally {
      this._depth--;
    }
  }

  /**
   * Fault-barrier reporting channel. Delivered without the depth check so that a
   * loop-detection throw is still reported, and re-entry is suppressed so a failing
   * `core/pluginError` listener cannot loop.
   */
  fault(pluginId: string, error: unknown, level?: "warning"): void {
    // docs/specs/architecture.md §1.4
    if (this._inFault) return;
    this._inFault = true;
    try {
      // docs/specs/architecture.md §1.2 — an absent `level` means error-level; the field is only
      // present on warning-level reports (duplicate slot occupancy).
      this._deliver("core/pluginError", level ? { pluginId, error, level } : { pluginId, error });
    } finally {
      this._inFault = false;
    }
  }

  // docs/specs/architecture.md §1.4
  /** Drops every subscription and makes future on()/emit() calls empty no-ops. */
  clear(): void {
    this._cleared = true;
    this._subs.clear();
  }

  private _deliver(k: string, e: unknown): void {
    const list = this._subs.get(k);
    if (!list || list.length === 0) return;
    for (const sub of list.slice()) {
      if (sub.disposed) continue;
      try {
        sub.fn(e);
      } catch (err) {
        // docs/specs/architecture.md §1.4 — fault barrier: report and keep running the
        // remaining listeners.
        // docs/specs/architecture.md §1.4 — an app-code listener (null owner) is
        // reported with the sentinel plugin ID "app", never the empty string.
        this.fault(sub.owner ?? "app", err);
      }
    }
  }
}
