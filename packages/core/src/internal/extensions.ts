import type { ExtensionPoint } from "../index";
import type { EventBusImpl } from "./events";
import type { ExtensionPointRegistry } from "./kernel";

interface Point {
  // docs/specs/architecture.md §1.4
  /** owner plugin id — the fault-barrier attribution for the reducer call */
  owner: string;
  reducer: (inputs: unknown[]) => unknown;
  /** contributions, in registration (= startup) order */
  contributions: unknown[];
  // docs/specs/architecture.md §1.4 — the cache is what makes `get()` reference-stable
  // for an unchanged contribution set.
  /** reduced-value cache validity */
  cacheValid: boolean;
  /** a reduce() call is in flight — guards re-entrant get() from recursing forever */
  reducing: boolean;
  cached: unknown;
}

export class ExtensionPointRegistryImpl implements ExtensionPointRegistry {
  private _points = new Map<string, Point>();
  /** contribute-before-define: contributions buffered until the matching define() */
  private _buf = new Map<string, unknown[]>();

  constructor(private _bus: EventBusImpl) {}

  define<T, R>(
    ownerPluginId: string,
    key: string,
    reduce: (inputs: T[]) => R,
  ): ExtensionPoint<T, R> {
    const r = reduce as unknown as (inputs: unknown[]) => unknown;
    let point = this._points.get(key);
    if (point) {
      // docs/specs/architecture.md §1.4 — last registration wins: the second define()
      // replaces reducer and owner attribution alike and keeps the key's contributions.
      point.owner = ownerPluginId;
      point.reducer = r;
      point.cacheValid = false;
    } else {
      point = {
        owner: ownerPluginId,
        reducer: r,
        contributions: this._buf.get(key) ?? [],
        cacheValid: false,
        reducing: false,
        cached: undefined,
      };
      this._buf.delete(key);
      this._points.set(key, point);
    }
    const p = point;
    const bus = this._bus;
    return {
      key,
      get(): R {
        if (!p.cacheValid) {
          if (p.reducing) {
            // Re-entrant get() from inside the reducer: there is no reduced value to hand back,
            // so report it as a fault of the point's owner rather than recursing forever.
            bus.fault(
              p.owner,
              new Error(`stargantt: re-entrant get() on extension point "${key}"`),
            );
            return undefined as R;
          }
          p.reducing = true;
          try {
            // docs/specs/architecture.md §1.4 — fault barrier around the reducer, attributed
            // to the point's owner.
            p.cached = p.reducer(p.contributions.slice());
            // Cache only a successful reduction: a faulting reducer is retried on the next get().
            p.cacheValid = true;
          } catch (err) {
            bus.fault(p.owner, err);
          } finally {
            p.reducing = false;
          }
        }
        return p.cached as R;
      },
    };
  }

  // docs/specs/architecture.md §1.4
  /** Drops every point definition and buffered contribution. */
  clear(): void {
    this._points.clear();
    this._buf.clear();
  }

  // docs/specs/architecture.md §1.4
  // There is no contributor-id argument and no lazy () => T contribution form.
  /**
   * Contributions are stored verbatim and never auto-invoked by the core; function values
   * are treated as data like any other contribution.
   */
  contribute<T>(key: string, value: T): void {
    const point = this._points.get(key);
    if (point) {
      point.contributions.push(value);
      point.cacheValid = false;
      return;
    }
    const buf = this._buf.get(key);
    if (buf) buf.push(value);
    else this._buf.set(key, [value]);
  }
}
