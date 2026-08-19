import type { AnyPlugin, PluginState } from "../index";
import { ArbitrationRegistryImpl } from "./arbitration";
import { CommandBusImpl } from "./commands";
import { PluginContextImpl } from "./context";
import { DisposableLedgerImpl } from "./disposable";
import { EventBusImpl } from "./events";
import { ExtensionPointRegistryImpl } from "./extensions";
import type { PluginDeps, PluginHost } from "./kernel";
import { ServiceRegistryImpl } from "./services";

interface Rec {
  id: string;
  plugin: AnyPlugin;
  // docs/specs/architecture.md §1.4
  /** registration index — the tie-breaker inside a topology tier */
  regIndex: number;
  state: PluginState;
  teardown?: () => void;
}

const rank = (r: Rec): number => {
  const o = r.plugin.meta.order;
  return o === "pre" ? 0 : o === "post" ? 2 : 1;
};

const deps = (r: Rec): readonly string[] => r.plugin.meta.dependsOn ?? [];

export class PluginHostImpl implements PluginHost {
  readonly bus = new EventBusImpl();
  // docs/specs/architecture.md §1.4 — a throwing dispose() is reported as core/pluginError
  // and the remaining owned resources are still released (docs/specs/architecture.md §1.4).
  readonly ledger = new DisposableLedgerImpl((id, err) => this.bus.fault(id, err));
  readonly arbiter: ArbitrationRegistryImpl;
  readonly commands: CommandBusImpl;
  readonly points: ExtensionPointRegistryImpl;
  readonly services: ServiceRegistryImpl;

  private _recs: Rec[] = [];
  private _byId = new Map<string, Rec>();
  private _deps = new Map<string, PluginDeps>();
  private _started: Rec[] = [];
  private _sealed = false;
  private _disposed = false;
  // Survives dispose(): stateOf() must keep answering "disposed" for known ids even after
  // _recs/_byId are cleared and their plugin/teardown closures dropped.
  private _disposedStates = new Map<string, PluginState>();

  readonly locale: string;

  constructor(
    readonly root: HTMLElement,
    locale?: string,
  ) {
    // docs/specs/architecture.md §1.4 — an opaque tag: kept verbatim when it holds any
    // non-whitespace character, "en" otherwise (absent, empty or blank).
    this.locale = typeof locale === "string" && locale.trim() !== "" ? locale : "en";
    this.arbiter = new ArbitrationRegistryImpl(this.bus);
    this.commands = new CommandBusImpl(this.bus);
    this.points = new ExtensionPointRegistryImpl(this.bus);
    this.services = new ServiceRegistryImpl(this._deps);
  }

  // docs/specs/architecture.md §1.4 — no `config` parameter: the `Plugin<Config>`
  // channel stays in the published plugin types but is dormant, so the host always
  // passes `undefined` to `setup()`.
  register(plugin: AnyPlugin): void {
    if (this._sealed || this._disposed) {
      throw new Error(
        this._disposed
          ? "stargantt: register() called after dispose()"
          : "stargantt: register() called after start()",
      );
    }
    const id = plugin.meta.id;
    if (this._byId.has(id)) throw new Error(`stargantt: duplicate plugin id "${id}"`);
    const rec: Rec = { id, plugin, regIndex: this._recs.length, state: "registered" };
    this._recs.push(rec);
    this._byId.set(id, rec);
    this._deps.set(id, {
      hard: new Set(plugin.meta.dependsOn ?? []),
      soft: new Set(plugin.meta.optional ?? []),
    });
  }

  start(): void {
    if (this._sealed || this._disposed) {
      throw new Error(
        this._disposed
          ? "stargantt: start() called after dispose()"
          : "stargantt: start() called after start()",
      );
    }
    // Resolve *before* sealing: a resolve() throw must leave the host retryable.
    const order = this._resolve();
    this._sealed = true;
    for (const r of order) r.state = "resolved";
    try {
      for (const r of order) {
        const ctx = new PluginContextImpl(r.id, this.root, this.locale, this);
        // A plugin may have registered resources through ctx before throwing, so it joins the
        // teardown list *before* setup() runs — dispose() must be able to release them.
        this._started.push(r);
        // docs/specs/architecture.md §1.4 — a throw inside setup() is the one fatal case:
        // it fails Gantt.create().
        const teardown = r.plugin.setup(ctx, undefined);
        if (teardown) r.teardown = teardown;
        r.state = "active";
      }
      // docs/specs/architecture.md §1.4
      this.bus.emit("lifecycle/ready", undefined);
    } catch (err) {
      // docs/specs/architecture.md §1.4 — startup failed, so the core releases everything
      // it already owns: teardowns and ledger entries of the started plugins, including the one
      // that threw.
      this.dispose();
      throw err;
    }
  }

  stateOf(pluginId: string): PluginState | undefined {
    return this._byId.get(pluginId)?.state ?? this._disposedStates.get(pluginId);
  }

  dispose(): void {
    if (this._disposed) return;
    this._disposed = true;
    // docs/specs/architecture.md §1.4 — teardown in reverse startup order, then release all
    // own() registrations. A throwing teardown is reported and the sweep continues.
    for (let i = this._started.length - 1; i >= 0; i--) {
      const r = this._started[i]!;
      if (r.teardown) this._guard(r.id, r.teardown);
    }
    for (let i = this._started.length - 1; i >= 0; i--) this.ledger.releaseAll(this._started[i]!.id);
    // docs/specs/architecture.md §1.4 — clear every registry so the disposed
    // instance retains no plugin graph or app closures, and post-dispose calls are empty no-ops.
    // stateOf() must still answer "disposed" for previously known plugin ids, so a bare id→state
    // map survives; the plugin objects and teardown closures themselves are dropped.
    for (const r of this._recs) this._disposedStates.set(r.id, "disposed");
    this._recs = [];
    this._byId.clear();
    this._started.length = 0;
    this._deps.clear();
    this.arbiter.clear();
    this.services.clear();
    this.points.clear();
    this.commands.clear();
    // The event bus goes last: a throwing teardown above still reports via core/pluginError.
    this.bus.clear();
  }

  /** Fault barrier: report a throwing plugin callback via `core/pluginError` and keep going. */
  private _guard(pluginId: string, fn: () => void): void {
    try {
      fn();
    } catch (err) {
      this.bus.fault(pluginId, err);
    }
  }

  /** Topological sort of `dependsOn`; within a tier `pre → normal → post`, then reg. order. */
  private _resolve(): Rec[] {
    // docs/specs/architecture.md §1.4
    for (const r of this._recs) {
      for (const d of deps(r)) {
        if (!this._byId.has(d)) {
          throw new Error(`stargantt: plugin "${r.id}" depends on unregistered plugin "${d}"`);
        }
      }
    }

    const order: Rec[] = [];
    const done = new Set<string>();
    let rest = this._recs;
    while (rest.length > 0) {
      const tier = rest.filter((r) => deps(r).every((d) => done.has(d)));
      if (tier.length === 0) {
        throw new Error(`stargantt: plugin dependency cycle: ${this._chain(rest)}`);
      }
      tier.sort((a, b) => rank(a) - rank(b) || a.regIndex - b.regIndex);
      for (const r of tier) order.push(r);
      for (const r of tier) done.add(r.id);
      rest = rest.filter((r) => !done.has(r.id));
    }
    return order;
  }

  /** Builds the offending plugin-ID chain required in the cycle error message. */
  private _chain(rest: Rec[]): string {
    // docs/specs/architecture.md §1.4
    const remaining = new Map(rest.map((r) => [r.id, r] as const));
    const path: string[] = [];
    const seen = new Set<string>();
    let cur: Rec | undefined = rest[0];
    while (cur && !seen.has(cur.id)) {
      seen.add(cur.id);
      path.push(cur.id);
      const next: string | undefined = deps(cur).find((d) => remaining.has(d));
      cur = next === undefined ? undefined : remaining.get(next);
    }
    if (cur) path.push(cur.id);
    return path.join(" -> ");
  }
}
