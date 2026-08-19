// docs/specs/plugins/scheduling.md §1.3 — the store-shaped `CriticalPathService` and its five-rule
// lazy freshness contract. The earlier `stargantt.critical-path` used a plain per-call cache;
// this module adapts that laziness to the core `Store<T>` contract so an idle composition (no
// visual active, no subscriber) pays a dirty-flag write per data change and zero CPM work (§1.3
// rule 5).
//
// The lazy-recompute machinery WRAPS the core's own `createStore` rather than hand-rolling a
// second store implementation (P4 review ruling, B3): per-subscriber try/catch containment (a
// throwing subscriber neither stops its siblings nor escapes `get()`/`set()`), the disposed-mid-
// notification guard and the re-entrant-`set()` guard all come from `@stargantt/core` for free and
// stay in lockstep with every other store in this codebase. Only the ON-DEMAND recompute — WHEN
// `set()` gets called, driven by the dirty flag rather than by a caller pushing a new value in — is
// this module's own addition.
import { createStore } from "@stargantt/core";
import type { Disposable, Store, WritableStore } from "@stargantt/core";
import type { TaskId } from "@stargantt/plugin-data-store";
import type {
  Criticality,
  CriticalPath,
  CriticalPathAnalysis,
  TaskFloat,
} from "./analysis";
import { emptyAnalysis } from "./analysis";

export type { Criticality, CriticalPath, CriticalPathAnalysis, TaskFloat };

/**
 * Read access to the slack (float) analysis: per-task total and free float, criticality classes,
 * critical links and every parallel critical path (§1.3).
 */
export interface CriticalPathService {
  /**
   * The current analysis. Satisfies the core `Store` contract (get/subscribe); freshness follows
   * the five-rule contract below.
   */
  readonly analysis: Store<CriticalPathAnalysis>;
  /** Shorthand for `analysis.get().floats.get(id)`. */
  floatOf(id: TaskId): TaskFloat | undefined;
  /** Shorthand for `analysis.get().classes.get(id)` — `undefined` means "not critical". */
  criticalityOf(id: TaskId): Criticality | undefined;
  /** Shorthand for `analysis.get().paths`. */
  paths(): readonly CriticalPath[];
}

/**
 * Builds the store-shaped service and the dirty-flag machinery of §1.3.
 *
 * `recompute` is the one CPM pass (`analyze(data.query(), latestTimesOf(...), options)` in
 * production; a counting spy in tests — see `test/critical-path-freshness.test.ts`).
 * `visualsActive` is a static (setup-time) answer — whether any §7.3 visual is configured on — and
 * is read once per data notification, never recomputed per frame.
 */
export function createCriticalPathAnalysisStore(
  recompute: () => CriticalPathAnalysis,
  visualsActive: () => boolean,
): {
  analysis: Store<CriticalPathAnalysis>;
  /** Rule 2 — call on every `data.tasks` notification. */
  markDirty(): void;
  /**
   * Rule 3, first clause — call right after `markDirty()` on every `data.tasks` notification: it
   * recomputes+sets immediately when `visualsActive()` or a subscriber is already attached, and is
   * a no-op otherwise (the dirty flag alone carries the "there is unseen new data" fact until the
   * next `get()` / shorthand / dirty `subscribe()`).
   */
  recomputeIfActive(): void;
} {
  // rule 1 — the empty analysis, with zero recompute calls; owns no plugin, exactly like every
  // other bare `createStore` in this codebase (architecture.md §1.1-3).
  const store: WritableStore<CriticalPathAnalysis> = createStore(emptyAnalysis());
  let dirty = false; // rule 1 — nothing to recompute before the first data change
  let subscriberCount = 0;

  /** Rule 3/4 — the one recompute+set path; every freshness moment funnels through this. */
  function ensureFresh(): void {
    if (!dirty) return;
    dirty = false;
    // `store.set()` is the core `Store` contract verbatim: committed before the first subscriber
    // runs, dispatched over a snapshot, and every subscriber's own throw is contained there —
    // reported rather than propagated here or left to break a sibling subscriber's turn.
    store.set(recompute());
  }

  const analysis: Store<CriticalPathAnalysis> = {
    get(): CriticalPathAnalysis {
      ensureFresh(); // rule 3 — on-demand recompute at get()
      return store.get();
    },
    subscribe(fn): Disposable {
      // Rule 3, second clause: a subscribe() made while dirty recomputes and sets BEFORE this
      // subscription is registered, so the newcomer's own callback never fires for it (the core
      // store's own no-callback-on-subscribe contract) while existing subscribers still observe
      // the change.
      ensureFresh();
      subscriberCount += 1;
      const sub = store.subscribe(fn);
      let disposed = false;
      // Prototype-delegate to the core store's own Disposable rather than returning a fresh
      // object: the core marks its subscription disposables with an internal fault-channel
      // symbol that `ctx.own()` reads to route a throwing subscriber to `core/pluginError`.
      // A plain `{ dispose }` wrapper would silently drop that marker (the symbol is
      // deliberately not exported, so delegation is the only way to preserve it).
      const wrapped = Object.create(sub) as Disposable;
      wrapped.dispose = (): void => {
        if (disposed) return;
        disposed = true;
        subscriberCount -= 1;
        sub.dispose();
      };
      return wrapped;
    },
  };

  return {
    analysis,
    markDirty(): void {
      dirty = true; // rule 2
    },
    recomputeIfActive(): void {
      // Rule 3, first clause: recompute+set immediately when a visual is active per config OR the
      // store already has at least one live subscriber; otherwise stays dirty for the next demand
      // read (rule 5 — zero CPM work when neither holds).
      if (visualsActive() || subscriberCount > 0) ensureFresh();
    },
  };
}

/** Builds the three shorthand members over a `Store<CriticalPathAnalysis>` (§1.3). */
export function createCriticalPathShorthands(
  analysis: Store<CriticalPathAnalysis>,
): Pick<CriticalPathService, "floatOf" | "criticalityOf" | "paths"> {
  return {
    floatOf: (id) => analysis.get().floats.get(id),
    criticalityOf: (id) => analysis.get().classes.get(id),
    paths: () => analysis.get().paths,
  };
}
