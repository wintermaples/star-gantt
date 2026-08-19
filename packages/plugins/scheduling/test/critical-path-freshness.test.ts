/**
 * The five-rule lazy freshness contract of `CriticalPathService.analysis` (docs/specs/plugins/
 * scheduling.md §1.3), backed by a `Store` rather than a plain per-call cache. Exercised
 * directly against `createCriticalPathAnalysisStore` (`src/internal/critical-path/service.ts`):
 * fully hostless, no `ctx`, no data store, no DOM — a counting spy stands in for the CPM pass so
 * "zero CPM work" is an assertable fact, not an inference.
 */
import { describe, expect, it } from "vitest";
import {
  createCriticalPathAnalysisStore,
  createCriticalPathShorthands,
} from "../src/internal/critical-path/service";
import { emptyAnalysis } from "../src/internal/critical-path/analysis";
import type { CriticalPathAnalysis } from "../src/internal/critical-path/analysis";

/** A distinct analysis object per call, so `toBe` identity checks are meaningful. */
function fakeAnalysis(tag: number): CriticalPathAnalysis {
  const a = emptyAnalysis();
  // Piggy-back a tag on an otherwise-empty analysis via the floats map, so two calls are both
  // referentially distinct (fresh objects) and distinguishable by content.
  (a.floats as unknown as Map<string, unknown>).set("tag", tag);
  return a;
}

/** A `recompute` spy that counts its own calls and returns a fresh, tagged analysis each time. */
function countingRecompute(): { recompute: () => CriticalPathAnalysis; count(): number } {
  let calls = 0;
  return {
    recompute: () => {
      calls += 1;
      return fakeAnalysis(calls);
    },
    count: () => calls,
  };
}

describe("rule 1 — initial value", () => {
  it("starts as the empty analysis, with zero recompute calls", () => {
    const { recompute, count } = countingRecompute();
    const store = createCriticalPathAnalysisStore(recompute, () => false);
    expect(store.analysis.get()).toEqual(emptyAnalysis());
    expect(count()).toBe(0);
  });
});

describe("rule 5 — dormant zero-compute", () => {
  it("markDirty + recomputeIfActive costs nothing with no visual active and no subscriber", () => {
    const { recompute, count } = countingRecompute();
    const store = createCriticalPathAnalysisStore(recompute, () => false);
    for (let i = 0; i < 5; i += 1) {
      store.markDirty();
      store.recomputeIfActive();
    }
    expect(count()).toBe(0);
  });

  it("stays at zero compute across repeated dirty marks even without ever reading", () => {
    const { recompute, count } = countingRecompute();
    const store = createCriticalPathAnalysisStore(recompute, () => false);
    store.markDirty();
    store.recomputeIfActive();
    store.markDirty();
    store.recomputeIfActive();
    expect(count()).toBe(0);
    // The stale-but-clean initial value is still what a caller would see if they never demand-read.
  });
});

describe("rule 3 — on-demand recompute at get() / shorthands", () => {
  it("get() recomputes exactly once for one dirty mark, however many times it is called after", () => {
    const { recompute, count } = countingRecompute();
    const store = createCriticalPathAnalysisStore(recompute, () => false);
    store.markDirty();
    store.recomputeIfActive(); // no-op: not active, no subscriber (rule 5)
    expect(count()).toBe(0);

    const first = store.analysis.get();
    expect(count()).toBe(1);
    const second = store.analysis.get();
    expect(count()).toBe(1); // clean now — no second recompute
    expect(second).toBe(first);
  });

  it("the three shorthand members trigger the same on-demand recompute", () => {
    const { recompute, count } = countingRecompute();
    const store = createCriticalPathAnalysisStore(recompute, () => false);
    const service = {
      analysis: store.analysis,
      ...createCriticalPathShorthands(store.analysis),
    };
    store.markDirty();
    service.paths();
    expect(count()).toBe(1);
    service.floatOf("x");
    service.criticalityOf("x");
    expect(count()).toBe(1); // still clean
  });
});

describe("rule 3 — immediate recompute when a visual is active", () => {
  it("recomputeIfActive recomputes synchronously within the notification when visualsActive() is true", () => {
    const { recompute, count } = countingRecompute();
    const store = createCriticalPathAnalysisStore(recompute, () => true);
    store.markDirty();
    store.recomputeIfActive();
    expect(count()).toBe(1);
    // get() afterward is clean — no second compute.
    store.analysis.get();
    expect(count()).toBe(1);
  });
});

describe("rule 3 — immediate recompute with a live subscriber, even with no visual active", () => {
  it("recomputeIfActive recomputes once a subscriber is attached", () => {
    const { recompute, count } = countingRecompute();
    const store = createCriticalPathAnalysisStore(recompute, () => false);
    const seen: CriticalPathAnalysis[] = [];
    const sub = store.analysis.subscribe((next) => seen.push(next));

    store.markDirty();
    store.recomputeIfActive();
    expect(count()).toBe(1);
    expect(seen).toHaveLength(1);

    sub.dispose();
    store.markDirty();
    store.recomputeIfActive();
    // No subscriber left, no visual active: back to dormant (rule 5).
    expect(count()).toBe(1);
  });
});

describe("rule 3, second clause — dirty subscribe() recomputes before registering the newcomer", () => {
  it("a subscribe() made while dirty gets no immediate callback for its own recompute", () => {
    const { recompute } = countingRecompute();
    const store = createCriticalPathAnalysisStore(recompute, () => false);
    store.markDirty();

    const calls: CriticalPathAnalysis[] = [];
    const sub = store.analysis.subscribe((next) => calls.push(next));
    // The core's no-callback-on-subscribe contract: this subscription's own registration must not
    // itself have produced a call, even though the recompute+set it triggered happened synchronously
    // one line above.
    expect(calls).toHaveLength(0);
    // The recompute did happen (on demand, per rule 3) — a fresh value is available immediately.
    expect(store.analysis.get()).not.toEqual(emptyAnalysis());
    sub.dispose();
  });

  it("an existing subscriber DOES observe the recompute a later dirty subscribe() triggers", () => {
    const { recompute } = countingRecompute();
    const store = createCriticalPathAnalysisStore(recompute, () => false);

    const earlyCalls: CriticalPathAnalysis[] = [];
    const early = store.analysis.subscribe((next) => earlyCalls.push(next));
    expect(earlyCalls).toHaveLength(0); // subscribing while clean: no immediate callback either

    store.markDirty();
    expect(earlyCalls).toHaveLength(0); // marking dirty alone does not notify

    const lateCalls: CriticalPathAnalysis[] = [];
    const late = store.analysis.subscribe((next) => lateCalls.push(next));
    // Rule 4: the internal `set` follows the core store contract (sync notification), so the
    // demand-triggered recompute at this subscribe() call notifies the EXISTING subscriber...
    expect(earlyCalls).toHaveLength(1);
    // ...but never the newcomer, whose own subscription registers only after that set completes.
    expect(lateCalls).toHaveLength(0);

    early.dispose();
    late.dispose();
  });
});

// B3 (P4 review ruling) — the store now WRAPS the core's `createStore` rather than hand-rolling its
// own notification loop, so a throwing subscriber is contained exactly like any other core store:
// its own error is swallowed (reported, never rethrown to the caller of `get()`/a dirty
// `subscribe()`), and every sibling subscriber still gets its turn in the same dispatch.
describe("B3 — throwing-subscriber containment (wraps the core Store contract)", () => {
  it("a throwing subscriber does not stop a sibling subscriber from observing the same recompute", () => {
    const { recompute } = countingRecompute();
    const store = createCriticalPathAnalysisStore(recompute, () => false);

    const seenBefore: CriticalPathAnalysis[] = [];
    const before = store.analysis.subscribe((next) => seenBefore.push(next));
    const thrower = store.analysis.subscribe(() => {
      throw new Error("boom");
    });
    const seenAfter: CriticalPathAnalysis[] = [];
    const after = store.analysis.subscribe((next) => seenAfter.push(next));

    store.markDirty();
    // The demand-triggered recompute+set below must not throw out of `get()` even though one of
    // the three subscribers above throws synchronously during the dispatch.
    expect(() => store.analysis.get()).not.toThrow();
    expect(seenBefore).toHaveLength(1);
    expect(seenAfter).toHaveLength(1);

    before.dispose();
    thrower.dispose();
    after.dispose();
  });

  it("does not escape a dirty subscribe() either", () => {
    const { recompute } = countingRecompute();
    const store = createCriticalPathAnalysisStore(recompute, () => false);
    store.markDirty();
    const thrower = store.analysis.subscribe(() => {
      throw new Error("boom");
    });
    // `subscribe()` itself triggers the demand recompute (rule 3, second clause) — the SAME
    // synchronous call that registers `thrower`, so nothing here is notified by its own
    // registration, but a later dirty mark must still not leak the throw out of `get()`.
    store.markDirty();
    expect(() => store.analysis.get()).not.toThrow();
    thrower.dispose();
  });

  it("preserves the core store's fault-channel marker so ctx.own routes a throwing subscriber to core/pluginError", () => {
    // The core marks its subscription Disposables with an internal symbol that `ctx.own()` reads
    // to bind the fault channel. A plain `{ dispose }` wrapper drops it (the round-2 major): the
    // wrapper must prototype-delegate to the core disposable. The symbol is deliberately not
    // exported, so this asserts structurally: the core's own subscription disposable sits on the
    // prototype chain, and its symbol keys resolve through delegation.
    const { recompute } = countingRecompute();
    const store = createCriticalPathAnalysisStore(recompute, () => false);
    const sub = store.analysis.subscribe(() => undefined);
    const proto = Object.getPrototypeOf(sub) as object | null;
    // Not a plain object literal: the prototype is the core store's disposable, not Object.prototype.
    expect(proto).not.toBe(Object.prototype);
    expect(proto).not.toBeNull();
    // The core disposable carries at least one symbol key (the fault-channel marker), reachable
    // through the wrapper by delegation.
    const symbols = Object.getOwnPropertySymbols(proto as object);
    expect(symbols.length).toBeGreaterThan(0);
    sub.dispose();
  });
});

describe("rule 4 — subscribers observe exactly one fresh analysis per consumed data change", () => {
  it("one markDirty + one active recompute yields exactly one notification", () => {
    const { recompute } = countingRecompute();
    const store = createCriticalPathAnalysisStore(recompute, () => true);
    const seen: CriticalPathAnalysis[] = [];
    const sub = store.analysis.subscribe((next) => seen.push(next));

    store.markDirty();
    store.recomputeIfActive();
    expect(seen).toHaveLength(1);

    store.markDirty();
    store.recomputeIfActive();
    expect(seen).toHaveLength(2);
    expect(seen[0]).not.toBe(seen[1]);
    sub.dispose();
  });

  it("passes (next, prev) exactly like a core Store set", () => {
    const { recompute } = countingRecompute();
    const store = createCriticalPathAnalysisStore(recompute, () => false);
    const initial = store.analysis.get(); // recomputes once, becomes the "prev" of the next change
    let observedPrev: CriticalPathAnalysis | undefined;
    let observedNext: CriticalPathAnalysis | undefined;
    const sub = store.analysis.subscribe((next, prev) => {
      observedNext = next;
      observedPrev = prev;
    });
    store.markDirty();
    store.recomputeIfActive(); // dormant, no-op
    const grabbed = store.analysis.get(); // on-demand recompute now notifies the subscriber above
    expect(observedPrev).toBe(initial);
    expect(observedNext).toBe(grabbed);
    sub.dispose();
  });
});
