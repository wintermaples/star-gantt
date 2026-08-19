// docs/specs/architecture.md §1.4
/**
 * Internal kernel contracts — deliberately NOT re-exported from the package entry.
 * Plugins reach the kernel only through `PluginContext`, application code only through
 * `GanttInstance` ("no back-door API").
 */
import type {
  AnyPlugin,
  CommandRunner,
  Commands,
  Disposable,
  Events,
  ExtensionPoint,
  PluginState,
  Services,
} from "../index";

export interface PluginHost {
  readonly root: HTMLElement;
  // docs/specs/architecture.md §1.4
  /** The normalized `GanttOptions.locale`; copied onto every `PluginContext`. */
  readonly locale: string;
  // docs/specs/architecture.md §1.4 — the former dormant `config?: unknown` parameter
  // does not exist: the host always passes `undefined` to `setup()`.
  register(plugin: AnyPlugin): void;
  // docs/specs/architecture.md §1.4
  /** Topo-sort + pre/normal/post + synchronous setup(); a setup() throw fails create(). */
  start(): void;
  stateOf(pluginId: string): PluginState | undefined;
  dispose(): void;
}

export interface ServiceRegistry {
  provide<K extends keyof Services>(providerPluginId: string, key: K, impl: Services[K]): void;
  // docs/specs/architecture.md §1.4
  /** consumerPluginId enforces the "declared dependency only" rule; null = app code. */
  get<K extends keyof Services>(consumerPluginId: string | null, key: K): Services[K];
  getOptional<K extends keyof Services>(
    consumerPluginId: string | null,
    key: K,
  ): Services[K] | undefined;
}

export interface EventBus {
  on<K extends keyof Events>(
    ownerPluginId: string | null,
    key: K,
    fn: (e: Events[K]) => void,
  ): Disposable;
  emit<K extends keyof Events>(key: K, e: Events[K]): void;
}

export interface CommandBus {
  register<K extends keyof Commands>(ownerPluginId: string, key: K, run: CommandRunner<K>): void;
  dispatch<K extends keyof Commands>(key: K, payload: Commands[K]): void;
}

export interface ExtensionPointRegistry {
  define<T, R>(ownerPluginId: string, key: string, reduce: (inputs: T[]) => R): ExtensionPoint<T, R>;
  // docs/specs/architecture.md §1.4 — the discarded `contributorPluginId` argument and
  // the never-invoked thunk contribution form are removed.
  contribute<T>(key: string, value: T): void;
}

export interface DisposableLedger {
  own(ownerPluginId: string, d: Disposable): void;
  releaseAll(ownerPluginId: string): void;
}

// docs/specs/architecture.md §1.4
/** Per-plugin dependency declarations, consulted by the service registry. */
export interface PluginDeps {
  hard: Set<string>;
  soft: Set<string>;
}
