/**
 * `@stargantt/core` — the kernel.
 *
 * Six responsibilities only: PluginHost, ServiceRegistry, ExtensionPoint,
 * EventBus, CommandBus, Disposable management.
 * The core knows no Gantt concept and does not reference `Date`.
 *
 * This module is the package entry: the four declaration-merging surfaces
 * (`Services` / `Events` / `Commands` / `ExtensionPoints`) are declared *here* so that
 * `declare module "@stargantt/core" { interface Services { ... } }` merges into them.
 */
import { PluginHostImpl } from "./internal/host";

export { createStore } from "./internal/store";

/* ------------------------------------------------------------------ *
 * Disposable and resource ownership
 * ------------------------------------------------------------------ */

export interface Disposable {
  dispose(): void;
}

/* ------------------------------------------------------------------ *
 * Stores — the shape every stateful service exposes its state through
 * ------------------------------------------------------------------ */

/** Read side of a store: the current state, plus notification when it is replaced. */
export interface Store<T> {
  /**
   * The current state. Treat it as an immutable snapshot — never mutate what it returns.
   *
   * Called from inside a subscriber (or anything a subscriber invokes) it already returns the new
   * value: the store commits before it notifies.
   */
  get(): T;
  /**
   * Registers `fn` to run on every state replacement, with the new and previous values.
   *
   * Notification is synchronous and un-coalesced: one call per `set()`, even when the new state
   * equals the old one. Dispose the returned `Disposable` to unsubscribe — pass it to `ctx.own()`
   * so the core releases it with the rest of the plugin's resources. A subscription added while a
   * notification is in flight is first called by the *next* state change; one disposed while a
   * notification is in flight is not called again, not even by that notification. An exception
   * thrown by `fn` does not stop the remaining subscribers or reach the caller of `set()`: it is
   * reported as `core/pluginError` when the subscription is owned by a plugin, and through
   * `console.error` otherwise.
   */
  subscribe(fn: (next: T, prev: T) => void): Disposable;
}

/** Write side of a store, held by the service that owns the state. */
export interface WritableStore<T> extends Store<T> {
  /**
   * Replaces the state with `next` and notifies every current subscriber before returning.
   *
   * Throws when called while this same store is notifying — a subscriber must never write back
   * into the store it is reacting to. The in-flight notification is unaffected and runs to
   * completion; writing to a *different* store is allowed.
   */
  set(next: T): void;
  /** `set(fn(get()))`, for deriving the next state from the current one. */
  update(fn: (prev: T) => T): void;
}

/* ------------------------------------------------------------------ *
 * Declaration-merging surfaces
 * ------------------------------------------------------------------ */

export interface Services {}

export interface Events {
  // docs/specs/architecture.md §1.4
  /** Fired once after every plugin's setup() completes. Render plugins first-paint on this. */
  "lifecycle/ready": void;
  // docs/specs/architecture.md §1.4 (fault barrier) / §1.2 (the optional `level` field)
  /** Fault barrier — a plugin callback threw; other plugins keep running. */
  "core/pluginError": { pluginId: string; error: unknown; level?: "warning" };
}

export interface Commands {}

export interface ExtensionPoints {}

/** Phantom carrier used by `ExtensionPoints` entries. Never instantiated at runtime. */
export interface ExtensionPointDecl<TContribution, TResult> {
  readonly contribution: TContribution;
  readonly result: TResult;
}

export type ContributionOf<K extends keyof ExtensionPoints> =
  ExtensionPoints[K] extends ExtensionPointDecl<infer T, unknown> ? T : never;

export type ResultOf<K extends keyof ExtensionPoints> =
  ExtensionPoints[K] extends ExtensionPointDecl<unknown, infer R> ? R : never;

// docs/specs/architecture.md §1.4 — the key space
// is closed over `keyof ExtensionPoints`; the former "undeclared key → `unknown`" escape hatch
// is gone. `ContributionOf`/`ResultOf` are the extractors over `ExtensionPointDecl`, while
// `ContributionFor`/`ResultFor` are the names the published `PluginContext` signatures use — both
// pairs survive so no published signature changes shape.
/**
 * The contribution type declared for an extension-point key. Only keys declared on the
 * `ExtensionPoints` interface (via declaration merging) are accepted; passing any other string is
 * a compile-time error.
 */
export type ContributionFor<K extends keyof ExtensionPoints> = ContributionOf<K>;

/** The reduced-result type declared for an extension-point key; same key rules as `ContributionFor`. */
export type ResultFor<K extends keyof ExtensionPoints> = ResultOf<K>;

/* ------------------------------------------------------------------ *
 * EventBus conventions
 * ------------------------------------------------------------------ */

// docs/specs/architecture.md §1.4
/** Shape shared by every cancelable "will" pre-event payload. */
export interface Cancelable {
  preventDefault(): void;
}

/* ------------------------------------------------------------------ *
 * Extension points and the three merge strategies
 * ------------------------------------------------------------------ */

// docs/specs/architecture.md §1.4 — the former
// `ExtensionPointKey<T>` alias is removed: it was a plain `string` alias whose type parameter
// carried nothing. The contribution type is carried by the `ExtensionPoints` declaration-merging
// surface, not by the key value.
export interface ExtensionPoint<TContribution, TResult> {
  readonly key: string;
  /**
   * The reduced value.
   *
   * For the `collect` and `reduce` strategies this is reference-stable: while the contribution set
   * is unchanged, repeated calls return the same reference, so a consumer may compare with `===` to
   * skip recomputation. A new contribution (or a redefinition of the key) may produce a fresh
   * value.
   */
  get(): TResult;
}

/** Merge strategy `collect`: all contributions as an array, in startup order. */
export function collect<T>(): (inputs: readonly T[]) => T[] {
  // docs/specs/architecture.md §1.4
  return (inputs) => inputs.slice();
}

/**
 * Merge strategy `first`. Contributions are functions of a common signature; the reduced value is a
 * composite of the same signature that calls each contribution in startup order and returns the
 * first non-`undefined` result.
 *
 * The per-contribution calls are the point-owning plugin's responsibility to guard — this
 * composite deliberately does not try/catch.
 */
export function first<A extends readonly unknown[], R>(): (
  inputs: readonly ((...args: A) => R | undefined)[],
) => (...args: A) => R | undefined {
  // docs/specs/architecture.md §1.4 — strategy and fault-barrier ownership
  return (inputs) =>
    (...args) => {
      for (const fn of inputs) {
        const r = fn(...args);
        if (r !== undefined) return r;
      }
      return undefined;
    };
}

/** Merge strategy `reduce`: arbitrary fold of the contributions to a single value. */
export function reduce<T, R>(
  fold: (acc: R, input: T) => R,
  seed: R,
): (inputs: readonly T[]) => R {
  // docs/specs/architecture.md §1.4
  return (inputs) => inputs.reduce<R>((acc, input) => fold(acc, input), seed);
}

/* ------------------------------------------------------------------ *
 * Arbitration — order-key, key and slot registries
 * ------------------------------------------------------------------ */

/** The answer to a `claimSlot` request. */
export interface SlotGrant {
  /** Whether the requested slot is now held by the claiming plugin. */
  granted: boolean;
  /**
   * A free slot to fall back to when the requested one was taken: the lexicographically smallest
   * slot name the group knows about that nobody occupies. Absent when the group has no free known
   * slot left, and when the claim was granted.
   */
  alternative?: string;
}

/** One entry of an order scope, as reported by the instance handle's `orders()`. */
export interface OrderRegistration {
  readonly key: string;
  readonly order: number;
  readonly pluginId: string;
}

/* ------------------------------------------------------------------ *
 * Commands
 * ------------------------------------------------------------------ */

export type CommandRunner<K extends keyof Commands> = (payload: Commands[K]) => void;

/* ------------------------------------------------------------------ *
 * Plugin definition and lifecycle
 * ------------------------------------------------------------------ */

export interface PluginMeta {
  id: string;
  dependsOn?: string[];
  optional?: string[];
  order?: "pre" | "normal" | "post";
}

export interface Plugin<Config = void> {
  meta: PluginMeta;
  /** Returned function is an ADDITIONAL teardown; ctx-registered resources are freed regardless. */
  setup(ctx: PluginContext, config: Config): void | (() => void);
}

export type AnyPlugin = Plugin<any>;

/** Identity function, purely for type inference of a plugin's config type. No runtime behavior. */
export function definePlugin<Config = void>(def: Plugin<Config>): Plugin<Config> {
  // docs/specs/architecture.md §1.4
  return def;
}

// docs/specs/architecture.md §1.4
/** Lifecycle state of a registered plugin. */
export type PluginState = "registered" | "resolved" | "active" | "disposed";

/* ------------------------------------------------------------------ *
 * PluginContext — the only surface a plugin touches
 * ------------------------------------------------------------------ */

export interface PluginContext {
  // --- services ---
  provide<K extends keyof Services>(key: K, impl: Services[K]): void;
  // docs/specs/architecture.md §1.4
  /** Throws at runtime if `key`'s provider is not among this plugin's declared `dependsOn`. */
  use<K extends keyof Services>(key: K): Services[K];
  useOptional<K extends keyof Services>(key: K): Services[K] | undefined;

  // --- extension points ---
  // docs/specs/architecture.md §1.4 (keys closed over `keyof ExtensionPoints`) and
  // plain contribution values only — the `() => T` thunk form does not exist.
  /**
   * Declares an extension point owned by this plugin and returns a handle to its reduced value.
   * `key` must be a key declared on the `ExtensionPoints` interface.
   */
  defineExtensionPoint<K extends keyof ExtensionPoints>(
    key: K,
    reduce: (inputs: ContributionFor<K>[]) => ResultFor<K>,
  ): ExtensionPoint<ContributionFor<K>, ResultFor<K>>;

  /**
   * Adds a contribution to an extension point. The point need not be declared yet — contributions
   * made first are buffered and delivered, in order, when the owning plugin declares the point.
   */
  contribute<K extends keyof ExtensionPoints>(point: K, value: ContributionFor<K>): void;

  // --- events ---
  on<K extends keyof Events>(key: K, fn: (e: Events[K]) => void): Disposable;
  emit<K extends keyof Events>(key: K, e: Events[K]): void;

  // --- commands ---
  registerCommand<K extends keyof Commands>(key: K, run: CommandRunner<K>): void;
  dispatch<K extends keyof Commands>(key: K, payload: Commands[K]): void;

  // --- arbitration ---
  /**
   * Declares that this plugin owns `key` at position `order` within `scope`, so that ordered
   * shared resources (render layers, toolbar rows, and the like) are arbitrated in code instead of
   * by a table in a document.
   *
   * A scope admits each key once and each order once. A claim that duplicates either is dropped
   * and reported as `core/pluginError` against this plugin; a claim with a fresh key and a fresh
   * order always registers. Read the result back through the instance handle's `orders(scope)`.
   */
  claimOrder(scope: string, key: string, order: number): void;

  /**
   * Declares that this plugin owns `key` inside the named `bag` — a shared string-keyed namespace
   * such as a metadata record.
   *
   * A second claim of the same pair is dropped and reported as `core/pluginError` against the
   * later claimant. The claim is a conflict-detection declaration only: the core never intercepts
   * reads or writes, and keys nobody claimed stay free for anyone to use.
   */
  claimKey(bag: string, key: string): void;

  /**
   * Requests exclusive use of `slot` within `group` — one of a small set of named positions, such
   * as the corners of an overlay.
   *
   * A free slot is granted. An occupied one is not reassigned: the result reports the refusal and,
   * where one exists, proposes a free alternative, while the attempt is reported as a
   * warning-level `core/pluginError`. Honouring the proposal is up to the caller. Pass the group's
   * full vocabulary as `candidates` — the core has no slot names of its own, and can only propose
   * names some claimant has mentioned.
   */
  claimSlot(group: string, slot: string, candidates?: readonly string[]): SlotGrant;

  // --- resource ownership ---
  own(d: Disposable): void;
  /** Gantt root element. Layout below it is the plugin's responsibility. */
  root: HTMLElement;

  // docs/specs/architecture.md §1.4
  /**
   * The language tag this chart was created with, as a BCP-47 string such as `"en"` or `"ja-JP"`.
   *
   * It is whatever `GanttOptions.locale` carried, or `"en"` when the option was omitted. The core
   * neither parses nor validates it — pass it to `Intl` formatters, or use it to pick a message
   * catalog. It never changes for the lifetime of the instance.
   */
  readonly locale: string;
}

/* ------------------------------------------------------------------ *
 * Public entry points
 * ------------------------------------------------------------------ */

export interface GanttOptions {
  element: HTMLElement;
  plugins: readonly AnyPlugin[];
  /**
   * BCP-47 language tag for this chart, e.g. `"ja-JP"`. Defaults to `"en"`.
   *
   * Plugins read it as `PluginContext.locale` and use it for `Intl` formatting; it does not by
   * itself translate any text, which is what each plugin's message catalog is for.
   */
  locale?: string;
}

export interface GanttInstance {
  dispatch<K extends keyof Commands>(cmd: K, payload: Commands[K]): void;
  on<K extends keyof Events>(event: K, fn: (e: Events[K]) => void): Disposable;
  // docs/specs/architecture.md §1.4
  /** Application-code service lookup; plugins use `ctx.use` instead. */
  service<K extends keyof Services>(key: K): Services[K];
  // docs/specs/architecture.md §1.4
  /**
   * The service registered under `key`, or `undefined` when no plugin in this composition
   * provides it. Never throws.
   *
   * Use this when the plugin set varies — a chart composed from user settings, an optional
   * feature, a build that ships different tiers — so that "not composed" is an answer rather than
   * an exception. Use `service()` instead when a missing service means the code is wrong.
   */
  getService<K extends keyof Services>(key: K): Services[K] | undefined;
  /**
   * A snapshot of every `claimOrder` registration in `scope`, ascending by order — the source for
   * generated ordering documentation and for debugging a composition's layer stack. Unknown or
   * empty scopes yield an empty array, and the array never updates itself.
   */
  orders(scope: string): readonly OrderRegistration[];
  // docs/specs/architecture.md §1.4 — registry clearing + post-dispose no-ops.
  /**
   * Tears the chart down: plugins release their DOM, listeners and other resources, and every
   * registry — event subscriptions (including ones made through `on` here), services, extension
   * points and commands — is cleared, so the instance retains no memory. Calling this instance
   * afterwards never throws and behaves as if nothing were registered: `dispatch` acts as an
   * unknown command, `on` registers nothing and returns an inert `Disposable`, `service()`
   * throws its usual missing-service error and `getService()` returns `undefined`. Calling
   * `dispose()` again does nothing.
   */
  dispose(): void;
}

export const Gantt: { create(opts: GanttOptions): GanttInstance } = {
  create(opts: GanttOptions): GanttInstance {
    const host = new PluginHostImpl(opts.element, opts.locale);
    for (const plugin of opts.plugins) host.register(plugin);
    host.start();

    const instance: GanttInstance = {
      dispatch<K extends keyof Commands>(cmd: K, payload: Commands[K]): void {
        host.commands.dispatch(cmd, payload);
      },
      on<K extends keyof Events>(event: K, fn: (e: Events[K]) => void): Disposable {
        return host.bus.on(null, event, fn);
      },
      service<K extends keyof Services>(key: K): Services[K] {
        return host.services.get(null, key);
      },
      getService<K extends keyof Services>(key: K): Services[K] | undefined {
        // The same registry read, with `null` as the consumer so the dependsOn allowlist
        // (a plugin-to-plugin rule) is not applied to application code.
        return host.services.getOptional(null, key);
      },
      orders(scope: string): readonly OrderRegistration[] {
        return host.arbiter.orders(scope);
      },
      dispose(): void {
        host.dispose();
      },
    };
    return instance;
  },
};
