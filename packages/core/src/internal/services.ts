import type { Services } from "../index";
import type { PluginDeps, ServiceRegistry } from "./kernel";

interface Entry {
  provider: string;
  impl: unknown;
}

export class ServiceRegistryImpl implements ServiceRegistry {
  private _services = new Map<string, Entry>();

  /** `_deps` is owned by the host and filled at registration time. */
  constructor(private _deps: Map<string, PluginDeps>) {}

  provide<K extends keyof Services>(providerPluginId: string, key: K, impl: Services[K]): void {
    this._services.set(key as unknown as string, { provider: providerPluginId, impl });
  }

  get<K extends keyof Services>(consumerPluginId: string | null, key: K): Services[K] {
    const k = key as unknown as string;
    const e = this._services.get(k);
    if (!e) throw new Error(`stargantt: service "${k}" is not provided`);
    if (consumerPluginId !== null && !this._declared(consumerPluginId, e.provider, false)) {
      throw new Error(
        `stargantt: plugin "${consumerPluginId}" used service "${k}" provided by "${e.provider}", which is not in its dependsOn`,
      );
    }
    return e.impl as Services[K];
  }

  getOptional<K extends keyof Services>(
    consumerPluginId: string | null,
    key: K,
  ): Services[K] | undefined {
    const e = this._services.get(key as unknown as string);
    if (!e) return undefined;
    if (consumerPluginId !== null && !this._declared(consumerPluginId, e.provider, true)) {
      return undefined;
    }
    return e.impl as Services[K];
  }

  // docs/specs/architecture.md §1.4
  /** Drops every provided service; later lookups report absence as usual. */
  clear(): void {
    this._services.clear();
  }

  private _declared(consumer: string, provider: string, soft: boolean): boolean {
    if (consumer === provider) return true;
    const d = this._deps.get(consumer);
    if (!d) return false;
    return d.hard.has(provider) || (soft && d.soft.has(provider));
  }
}
