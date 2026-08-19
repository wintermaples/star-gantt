import type {
  CommandRunner,
  Commands,
  ContributionFor,
  Disposable,
  Events,
  ExtensionPoint,
  ExtensionPoints,
  PluginContext,
  ResultFor,
  Services,
  SlotGrant,
} from "../index";
import type { PluginHostImpl } from "./host";
import { BIND_FAULT } from "./store";
import type { FaultBinder } from "./store";

// docs/specs/architecture.md §1.4
/** The only surface a plugin touches. Every call is stamped with the owning plugin id. */
export class PluginContextImpl implements PluginContext {
  constructor(
    private _id: string,
    public root: HTMLElement,
    public readonly locale: string,
    private _host: PluginHostImpl,
  ) {}

  provide<K extends keyof Services>(key: K, impl: Services[K]): void {
    this._host.services.provide(this._id, key, impl);
  }

  use<K extends keyof Services>(key: K): Services[K] {
    return this._host.services.get(this._id, key);
  }

  useOptional<K extends keyof Services>(key: K): Services[K] | undefined {
    return this._host.services.getOptional(this._id, key);
  }

  defineExtensionPoint<K extends keyof ExtensionPoints>(
    key: K,
    reduce: (inputs: ContributionFor<K>[]) => ResultFor<K>,
  ): ExtensionPoint<ContributionFor<K>, ResultFor<K>> {
    return this._host.points.define<ContributionFor<K>, ResultFor<K>>(
      this._id,
      key as string,
      reduce,
    );
  }

  contribute<K extends keyof ExtensionPoints>(point: K, value: ContributionFor<K>): void {
    // docs/specs/architecture.md §1.4 — the discarded contributor id argument is gone.
    this._host.points.contribute<ContributionFor<K>>(point as string, value);
  }

  on<K extends keyof Events>(key: K, fn: (e: Events[K]) => void): Disposable {
    // docs/specs/architecture.md §1.4 — the core keeps a per-plugin subscription ledger, so
    // subscriptions are auto-released.
    const d = this._host.bus.on(this._id, key, fn);
    this._host.ledger.own(this._id, d);
    return d;
  }

  emit<K extends keyof Events>(key: K, e: Events[K]): void {
    this._host.bus.emit(key, e);
  }

  registerCommand<K extends keyof Commands>(key: K, run: CommandRunner<K>): void {
    this._host.commands.register(this._id, key, run);
  }

  dispatch<K extends keyof Commands>(key: K, payload: Commands[K]): void {
    this._host.commands.dispatch(key, payload);
  }

  claimOrder(scope: string, key: string, order: number): void {
    this._host.arbiter.claimOrder(this._id, scope, key, order);
  }

  claimKey(bag: string, key: string): void {
    this._host.arbiter.claimKey(this._id, bag, key);
  }

  claimSlot(group: string, slot: string, candidates?: readonly string[]): SlotGrant {
    return this._host.arbiter.claimSlot(this._id, group, slot, candidates);
  }

  own(d: Disposable): void {
    // docs/specs/architecture.md §1.1-3 — owning a store subscription stamps this plugin's id and
    // the host's fault channel onto it, so a throwing subscriber is reported as core/pluginError.
    // Any other Disposable simply lacks the hook.
    (d as Partial<Record<typeof BIND_FAULT, FaultBinder>>)[BIND_FAULT]?.(this._id, (id, err) =>
      this._host.bus.fault(id, err),
    );
    this._host.ledger.own(this._id, d);
  }
}
