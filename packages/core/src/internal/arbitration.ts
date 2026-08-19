import type { OrderRegistration, SlotGrant } from "../index";
import type { EventBusImpl } from "./events";

interface SlotGroup {
  /** slot -> occupying plugin id */
  taken: Map<string, string>;
  /** every slot name ever mentioned for this group: claimed, requested or offered as a candidate */
  known: Set<string>;
}

// docs/specs/architecture.md §1.2 — the three arbitration mechanisms are one generic form, a
// namespaced token-ownership registry. Claims are registration-time declarations of ownership for
// conflict detection and introspection; they are never access control, and they carry no
// Gantt-specific concept.
export class ArbitrationRegistryImpl {
  private _orders = new Map<string, OrderRegistration[]>();
  private _keys = new Map<string, Set<string>>();
  private _slots = new Map<string, SlotGroup>();

  constructor(private _bus: EventBusImpl) {}

  claimOrder(pluginId: string, scope: string, key: string, order: number): void {
    let list = this._orders.get(scope);
    if (!list) this._orders.set(scope, (list = []));
    for (const e of list) {
      // A duplicate is not recorded; the conflict is attributed to the later claimant.
      if (e.order === order || e.key === key) {
        this._bus.fault(
          pluginId,
          new Error(
            `stargantt: order claim ${scope}/"${key}"=${order} conflicts with ` +
              `"${e.key}"=${e.order} of "${e.pluginId}"`,
          ),
        );
        return;
      }
    }
    list.push({ key, order, pluginId });
  }

  claimKey(pluginId: string, bag: string, key: string): void {
    let keys = this._keys.get(bag);
    if (!keys) this._keys.set(bag, (keys = new Set()));
    if (keys.has(key)) {
      this._bus.fault(
        pluginId,
        new Error(`stargantt: key ${bag}/"${key}" is already claimed`),
      );
      return;
    }
    keys.add(key);
  }

  claimSlot(
    pluginId: string,
    group: string,
    slot: string,
    candidates?: readonly string[],
  ): SlotGrant {
    let g = this._slots.get(group);
    if (!g) this._slots.set(group, (g = { taken: new Map(), known: new Set() }));
    g.known.add(slot);
    if (candidates) for (const c of candidates) g.known.add(c);

    const holder = g.taken.get(slot);
    if (holder === undefined) {
      g.taken.set(slot, pluginId);
      return { granted: true };
    }

    // Occupancy is unchanged, and the core cannot police where the claimant actually renders, so
    // the duplicate attempt is a warning-level report plus a proposal: the lexicographically
    // smallest known slot still free, by plain UTF-16 code-unit ordering.
    let alternative: string | undefined;
    for (const k of g.known) {
      if (!g.taken.has(k) && (alternative === undefined || k < alternative)) alternative = k;
    }
    this._bus.fault(
      pluginId,
      new Error(
        `stargantt: slot ${group}/"${slot}" is occupied by "${holder}"` +
          (alternative === undefined ? "" : `; try "${alternative}"`),
      ),
      "warning",
    );
    return alternative === undefined ? { granted: false } : { granted: false, alternative };
  }

  /** Snapshot of every registration in `scope`, ascending by order. */
  orders(scope: string): readonly OrderRegistration[] {
    const list = this._orders.get(scope);
    return list ? list.slice().sort((a, b) => a.order - b.order) : [];
  }

  /** Drops every claim, so a disposed instance retains no registration. */
  clear(): void {
    this._orders.clear();
    this._keys.clear();
    this._slots.clear();
  }
}
